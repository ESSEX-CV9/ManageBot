// src/modules/titleGuard/services/titleGuardScheduler.ts
//
// 后台调度器。四件事：
//   1. 把刚检出、还没通知的案件发出通知
//   2. 到期复查：作者改好了就结案；没改好且能自动整改的就动手；定不了的转人工
//   3. 驱动整改队列
//   4. 限速重审核未结案件并原地修正旧通知
//
// 整改一定会在帖子里发通知，而**发消息一定会顶帖**。存量上千个帖子时
// 一口气跑完等于把论坛首页全刷成机器人翻出来的帖子，所以队列必须限速。
//
// 队列分两条，因为这两类帖子的代价不一样：
//
//   快队列  活跃帖 + 最近还有人回的归档帖。发通知不需要（或只需要瞬间）解归档，
//           作者多半还在看。**一批 50 个，然后歇 30 分钟**——限的是刷屏，不是线程配额。
//
//   慢队列  沉寂很久的老帖。发通知要先解归档，顶上来的是一个几个月没人动的帖子，
//           对首页的打扰最大。**默认 5 分钟一个**，慢慢来。

import type { Client } from 'discord.js';

import * as db from './titleGuardDatabase';
import {
    applyPlan,
    effectiveViolations,
    fetchThread,
    inspectThread,
} from './enforcer';
import { summarizeJudgement } from './llmJudge';
import { refreshNotice, sendNotice } from '../components/noticePanel';
import { buildDoneMessage, buildResolvedMessage } from './noticeContent';
import { runBackfillTick } from './backfillQueue';
import { runCaseReauditTick } from './caseReaudit';

/** 主循环间隔。到期复查本身不密集，1 分钟一次足够 */
const TICK_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let ticking = false;

/** 启动时抓取一次旧通知，之后每轮少量原地编辑，避免瞬间打满 Discord API。 */
let noticeRefreshQueue: number[] | null = null;
const NOTICE_REFRESH_BATCH_SIZE = 20;

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
                llmReason: summarizeJudgement(inspection.judgement),
            });
            continue;
        }

        // 到这里方案已经定了，通知里写的是确定的处理方式。
        // 注意要拿 updateCase **返回的**那个对象去发通知：llmReason 是这次才写进去的，
        // 用旧对象的话，AI 理由那行小字在第一条通知上永远不会出现。
        const fresh = db.updateCase(guardCase.id, {
            violations,
            plan: inspection.plan,
            llmReason: summarizeJudgement(inspection.judgement),
        }) ?? guardCase;

        await sendNotice(thread, fresh, violations, inspection.plan,
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
            // 重画而不是只撤按钮——不然通知正文还挂着「请在期限前修改」
            await refreshNotice(client, guardCase.id);
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
                llmReason: summarizeJudgement(inspection.judgement),
            });
            continue;
        }

        // LLM 判出来的违规是否需要管理组先确认
        const llmDriven = inspection.llmForced || violations.some(v => v.arbiter === 'LLM');
        if (llmDriven && settings.llmNeedsConfirm) {
            db.updateCase(guardCase.id, {
                state: 'pending_admin',
                deadline: null,
                violations,
                plan,
                llmReason: summarizeJudgement(inspection.judgement),
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
                llmReason: summarizeJudgement(inspection.judgement),
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
        await refreshNotice(client, guardCase.id);

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
// 3. 队列节流
// ============================================================

/** 快队列在本批里已经发了几个 */
const fastBatchCount = new Map<string, number>();
/** 快队列这一批是什么时候开始的 */
const fastBatchStart = new Map<string, number>();

/**
 * 一个 tick 里最多花在快队列上的时间。
 *
 * 一批 50 个，要是恰好全都需要模型定性，每个几十秒，这一批能跑掉半小时以上，
 * 而 tick 是串行的（有 ticking 锁）——那段时间里发通知、到期复查全部停摆。
 * 所以给它一个预算，用超了就把剩下的留到下一个 tick，批次计数原样带过去。
 */
const FAST_LANE_BUDGET_MS = 45_000;

/**
 * 快队列：一批 N 个，发满就歇 M 分钟。
 *
 * 计数按「批」重置而不是按滑动窗口，是因为管理组要能预期：
 * 「50 个，歇半小时，再 50 个」一句话说得清；滑动窗口说不清，出了问题也不好查。
 */
async function processFastLane(client: Client, guildId: string, now: number): Promise<void> {
    const settings = db.getSettings(guildId);
    const size = Math.max(1, settings.fastBatchSize);
    const pauseMs = Math.max(0, settings.fastBatchPauseMinutes) * 60_000;

    const started = fastBatchStart.get(guildId) ?? 0;
    let count = fastBatchCount.get(guildId) ?? 0;

    // 上一批发满了，得歇够了才开下一批
    if (count >= size) {
        if (now - started < pauseMs) return;
        count = 0;
        fastBatchCount.set(guildId, 0);
        fastBatchStart.set(guildId, now);
    }
    if (count === 0) fastBatchStart.set(guildId, now);

    // 一个 tick 里尽量把这批的额度用掉，别一分钟才发一个
    const deadline = Date.now() + FAST_LANE_BUDGET_MS;
    for (let i = count; i < size; i++) {
        const r = await runBackfillTick(client, guildId, 'fast');

        // 队列空了才收工。**「跳过」不能当成空**——
        // 跳过的项已经出队了，接着取下一个就是；
        // 把它当成空会让「一批里头一个是跳过的」变成这一分钟什么都没干
        if (r === 'empty') return;

        // 只有真发出去的才占配额。跳过的不占，否则一批 50 个可能全被
        // 「复查已合规」这类占掉，真该发的一个都没轮上
        if (r === 'done') {
            fastBatchCount.set(guildId, (fastBatchCount.get(guildId) ?? 0) + 1);
        }

        if (Date.now() > deadline) return; // 预算用完，剩下的下个 tick 接着来
    }
}

/** 慢队列：老老实实 N 分钟一个 */
async function processSlowLane(client: Client, guildId: string, now: number): Promise<void> {
    const settings = db.getSettings(guildId);
    const intervalMs = Math.max(1, settings.queueIntervalMinutes) * 60_000;
    if (now - (lastBackfill.get(guildId) ?? 0) < intervalMs) return;

    // 跳过的不算数：那没发通知，也就没顶帖，不该占掉这一轮的间隔。
    // 连着遇到跳过就继续往下取，但别在一个 tick 里耗太久
    const deadline = Date.now() + FAST_LANE_BUDGET_MS;
    for (;;) {
        const r = await runBackfillTick(client, guildId, 'slow');
        if (r === 'empty') return;        // 队列空，也不刷新计时器
        if (r === 'done') { lastBackfill.set(guildId, now); return; }
        if (Date.now() > deadline) return; // 一直在跳过，下个 tick 接着清
    }
}

async function processBackfill(client: Client): Promise<void> {
    const now = Date.now();

    for (const guild of client.guilds.cache.values()) {
        const settings = db.getSettings(guild.id);
        if (!settings.enabled || settings.queuePaused) continue;

        await processFastLane(client, guild.id, now);
        await processSlowLane(client, guild.id, now);
    }
}

// ============================================================
// 主循环
// ============================================================

async function refreshExistingNoticeBatch(client: Client): Promise<void> {
    if (noticeRefreshQueue === null) {
        noticeRefreshQueue = db.listOpenNoticeCases().map(c => c.id);
        if (noticeRefreshQueue.length > 0) {
            console.log(`[TitleGuard] 将自动刷新 ${noticeRefreshQueue.length} 条已有通知面板`);
        }
    }

    const batch = noticeRefreshQueue.splice(0, NOTICE_REFRESH_BATCH_SIZE);
    for (const caseId of batch) await refreshNotice(client, caseId);

    if (batch.length > 0 && noticeRefreshQueue.length === 0) {
        console.log('[TitleGuard] 已有通知面板刷新完成');
    }
}

async function tick(client: Client): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
        await processUnnotified(client);
        await processDue(client);
        await processBackfill(client);
        await runCaseReauditTick(client);
        await refreshExistingNoticeBatch(client);
    } catch (err) {
        console.error('[TitleGuard] 调度器出错：', err);
    } finally {
        ticking = false;
    }
}

export function startTitleGuardScheduler(client: Client): void {
    if (timer) return;
    noticeRefreshQueue = null;
    db.recoverCaseReaudits();
    const queued = db.enqueueOpenCaseReaudits(null, 'rules', 'startup');
    if (queued > 0) {
        console.log(`[TitleGuard] 已排入 ${queued} 个未结案件进行启动规则重审核`);
    }
    timer = setInterval(() => { void tick(client); }, TICK_MS);
    // 启动后先等一会儿再跑第一轮，让 guild 缓存先填好
    setTimeout(() => { void tick(client); }, 30_000);
    console.log('⏱️ 标题规范调度器已启动');
}

export function stopTitleGuardScheduler(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    noticeRefreshQueue = null;
}
