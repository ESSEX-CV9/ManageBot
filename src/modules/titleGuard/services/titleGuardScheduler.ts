// src/modules/titleGuard/services/titleGuardScheduler.ts
//
// 后台调度器。三件事：
//   1. 把刚检出、还没通知的案件发出通知
//   2. 到期复查：作者改好了就结案；没改好且能自动整改的就动手；定不了的转人工
//   3. 驱动老帖慢速队列（速率可配，默认 20 分钟一个帖子）
//
// 老帖整改会在帖子里发通知，那**一定会顶帖**。慢速队列就是用来把这个影响摊平的，
// 存量几百上千个帖子时不至于把论坛首页全刷成老帖。

import type { Client } from 'discord.js';

import * as db from './titleGuardDatabase';
import {
    applyPlan,
    effectiveViolations,
    fetchThread,
    inspectThread,
} from './enforcer';
import { disableNoticeButtons, sendNotice } from '../components/noticePanel';
import { buildDoneMessage, buildResolvedMessage } from './noticeContent';
import { runBackfillTick } from './backfillQueue';

/** 主循环间隔。到期复查本身不密集，1 分钟一次足够 */
const TICK_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let ticking = false;

/** 上次处理老帖队列的时间（按服务器各自的速率节流） */
const lastBackfill = new Map<string, number>();

// ============================================================
// 1. 发通知
// ============================================================

async function processUnnotified(client: Client): Promise<void> {
    for (const guardCase of db.listUnnotifiedCases(10)) {
        const thread = await fetchThread(client, guardCase.threadId);
        if (!thread) {
            db.closeCase(guardCase.id, 'failed');
            continue;
        }

        // 关键：这里**必须走完整检测（含 LLM）**再发通知。
        // 用 dryRun 的话拿不到 LLM 结论，方案里只会写「需要人工判断」，
        // 通知就变成了一条「我也不知道该怎么办」的骚扰。
        const inspection = await inspectThread(thread);
        const violations = effectiveViolations(inspection);

        // LLM 判定这些词不是分类标记 → 本来就没事，直接结案，别打扰作者
        if (inspection.skipped || violations.length === 0) {
            db.closeCase(guardCase.id, 'resolved');
            continue;
        }

        // 需要 LLM 定性但没拿到结论（没配 / 调用失败）→ 方案还没定，
        // 转给管理组，同样不打扰作者
        if (inspection.llmPending) {
            db.updateCase(guardCase.id, {
                state: 'pending_admin',
                deadline: null,
                violations,
                plan: inspection.plan,
            });
            await notifyAdminPending(client, guardCase, '需要语义判定但暂时无法取得结论');
            continue;
        }

        // 作者已退服/找不到人 → 跳过通知，直接进整改流程
        const authorGone = guardCase.authorId
            ? !(await thread.guild.members.fetch(guardCase.authorId).catch(() => null))
            : true;

        if (authorGone) {
            console.log(`[TitleGuard] 帖子 ${thread.id} 找不到作者，跳过通知直接进整改队列`);
            db.updateCase(guardCase.id, {
                state: 'notified',
                deadline: Date.now(),
                violations,
                plan: inspection.plan,
                llmReason: inspection.judgement?.reason ?? null,
            });
            continue;
        }

        // 到这里方案已经定了，通知里写的是确定的处理方式
        db.updateCase(guardCase.id, {
            violations,
            plan: inspection.plan,
            llmReason: inspection.judgement?.reason ?? null,
        });
        await sendNotice(thread, guardCase, violations, inspection.plan,
            inspection.detectResult?.normalized);
    }
}

// ============================================================
// 2. 到期复查
// ============================================================

async function processDue(client: Client): Promise<void> {
    const now = Date.now();

    for (const guardCase of db.listDueCases(now, 10)) {
        const thread = await fetchThread(client, guardCase.threadId);
        if (!thread) {
            db.closeCase(guardCase.id, 'failed');
            continue;
        }

        const settings = db.getSettings(guardCase.guildId);

        // 重新检测一次：作者可能已经自己改好了
        const inspection = await inspectThread(thread);
        const violations = effectiveViolations(inspection);

        if (inspection.skipped || violations.length === 0) {
            db.closeCase(guardCase.id, 'resolved');
            await disableNoticeButtons(guardCase, thread);
            await thread.send({ content: buildResolvedMessage() }).catch(() => { /* 忽略 */ });
            continue;
        }

        const plan = inspection.plan;

        // 总闸没开：只记录不动手
        if (!settings.autoFixEnabled) {
            db.updateCase(guardCase.id, {
                state: 'pending_admin',
                deadline: null,
                violations,
                plan,
                llmReason: inspection.judgement?.reason ?? null,
            });
            continue;
        }

        // LLM 判出来的违规是否需要管理组先确认
        const llmDriven = violations.some(v => v.needsLlm);
        if (llmDriven && settings.llmNeedsConfirm) {
            db.updateCase(guardCase.id, {
                state: 'pending_admin',
                deadline: null,
                violations,
                plan,
                llmReason: inspection.judgement?.reason ?? null,
            });
            await notifyAdminPending(client, guardCase, '需要管理组确认后才会执行');
            continue;
        }

        if (!plan?.autoFixable) {
            db.updateCase(guardCase.id, {
                state: 'pending_admin',
                deadline: null,
                violations,
                plan,
                llmReason: inspection.judgement?.reason ?? null,
            });
            await notifyAdminPending(client, guardCase, plan?.blockedReason ?? '无法自动判断');
            continue;
        }

        const result = await applyPlan(thread, plan, 'bot', guardCase.id);

        if (!result.ok) {
            // 改名限流之类的临时失败：往后推 15 分钟再试，不算失败
            if (result.error?.includes('限制')) {
                db.updateCase(guardCase.id, { deadline: now + 15 * 60_000 });
                continue;
            }
            db.updateCase(guardCase.id, { state: 'failed', deadline: null, plan });
            await notifyAdminPending(client, guardCase, `自动整改失败：${result.error}`);
            continue;
        }

        db.closeCase(guardCase.id, 'resolved');
        await disableNoticeButtons(guardCase, thread);

        const tagName = (id: string) =>
            (thread.parent && 'availableTags' in thread.parent
                ? thread.parent.availableTags.find(t => t.id === id)?.name
                : undefined) ?? id;

        await thread.send({
            content: buildDoneMessage({
                titleChanged: result.titleChanged,
                newTitle: plan.newTitle,
                removeTagNames: result.tagsChanged ? plan.removeTagIds.map(tagName) : [],
                addTagNames: result.tagsChanged ? plan.addTagIds.map(tagName) : [],
            }),
        }).catch(() => { /* 忽略 */ });
    }
}

async function notifyAdminPending(client: Client, guardCase: db.GuardCase, reason: string): Promise<void> {
    const settings = db.getSettings(guardCase.guildId);
    if (!settings.alertChannelId) return;
    try {
        const channel = await client.channels.fetch(settings.alertChannelId);
        if (!channel?.isTextBased() || channel.isDMBased()) return;
        await channel.send({
            content: `⚠️ 有帖子需要人工处理：<#${guardCase.threadId}>\n`
                + `标题：\`${guardCase.originalTitle}\`\n原因：${reason}`,
        });
    } catch { /* 忽略 */ }
}

// ============================================================
// 3. 老帖队列节流
// ============================================================

async function processBackfill(client: Client): Promise<void> {
    const now = Date.now();

    for (const guild of client.guilds.cache.values()) {
        const settings = db.getSettings(guild.id);
        if (!settings.enabled || settings.queuePaused) continue;

        const intervalMs = Math.max(1, settings.queueIntervalMinutes) * 60_000;
        if (now - (lastBackfill.get(guild.id) ?? 0) < intervalMs) continue;

        lastBackfill.set(guild.id, now);
        await runBackfillTick(client, guild.id);
    }
}

// ============================================================
// 主循环
// ============================================================

async function tick(client: Client): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
        await processUnnotified(client);
        await processDue(client);
        await processBackfill(client);
    } catch (err) {
        console.error('[TitleGuard] 调度器出错：', err);
    } finally {
        ticking = false;
    }
}

export function startTitleGuardScheduler(client: Client): void {
    if (timer) return;
    timer = setInterval(() => { void tick(client); }, TICK_MS);
    // 启动后先等一会儿再跑第一轮，让 guild 缓存先填好
    setTimeout(() => { void tick(client); }, 30_000);
    console.log('⏱️ 标题规范调度器已启动');
}

export function stopTitleGuardScheduler(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
}
