// src/modules/titleGuard/services/backfillQueue.ts
//
// 老帖慢速整改队列。
//
// 为什么要慢：整改老帖会在帖子里发通知，**发消息一定会顶帖**（单纯解归档/重新归档不会）。
// 存量几百上千个帖子，一口气跑完等于把论坛首页全刷成翻出来的老帖。
// 所以全局串行 + 可配速率（默认 20 分钟一个，约 72 个/天），队列持久化，重启接着跑。
//
// 扫描本身（把帖子塞进队列）不受限速影响，只有「实际发通知」这一步走队列。

import { ChannelType, type Client, type ForumChannel, type Guild } from 'discord.js';

import * as db from './titleGuardDatabase';
import {
    effectiveViolations,
    fetchThread,
    inspectThread,
    isForumThread,
    isOldPost,
} from './enforcer';

// ============================================================
// 遍历论坛帖子
// ============================================================

export interface ScanProgress {
    scanned: number;
    flagged: number;
    skipped: number;
}

/**
 * 取一个论坛下的全部帖子（活跃 + 归档）。
 * Discord 的归档帖分页要靠 before 游标，这里一次抓 100、抓到空为止。
 */
export async function collectThreads(forum: ForumChannel): Promise<string[]> {
    const ids = new Set<string>();

    try {
        const active = await forum.threads.fetchActive();
        for (const [id] of active.threads) ids.add(id);
    } catch (err) {
        console.warn(`[TitleGuard] 读取论坛 ${forum.id} 活跃帖失败：`, err);
    }

    let before: string | undefined;
    for (let page = 0; page < 200; page++) {
        try {
            const archived = await forum.threads.fetchArchived({ limit: 100, before });
            if (archived.threads.size === 0) break;

            let oldest: number | undefined;
            for (const [id, thread] of archived.threads) {
                ids.add(id);
                const ts = thread.archivedAt?.getTime() ?? thread.createdTimestamp ?? undefined;
                if (ts !== undefined && (oldest === undefined || ts < oldest)) oldest = ts;
            }

            if (!archived.hasMore || oldest === undefined) break;
            before = String(oldest);
        } catch (err) {
            console.warn(`[TitleGuard] 读取论坛 ${forum.id} 归档帖失败：`, err);
            break;
        }
    }

    return [...ids];
}

// ============================================================
// 静默扫描（只看不动）
// ============================================================

export interface ScanRow {
    forumName: string;
    threadId: string;
    threadUrl: string;
    title: string;
    tags: string;
    authorId: string;
    isOldPost: boolean;
    rules: string;
    detail: string;
    needsLlm: boolean;
    suggestedTitle: string;
    removeTags: string;
    autoFixable: boolean;
    blockedReason: string;
}

/**
 * 扫描一个论坛。dryRun=true（默认）时**不发任何通知、不改任何东西、不调 LLM**，
 * 只把结果收集成表格行，供导出 Excel 摸底用。
 *
 * dryRun=false 时把命中的老帖塞进慢速队列，新帖直接建案走正常流程。
 */
export async function scanForum(
    client: Client,
    guildId: string,
    forumId: string,
    options: { dryRun?: boolean; onProgress?: (p: ScanProgress) => void } = {},
): Promise<{ rows: ScanRow[]; progress: ScanProgress }> {
    const dryRun = options.dryRun ?? true;
    const settings = db.getSettings(guildId);

    const channel = await client.channels.fetch(forumId);
    if (!channel || channel.type !== ChannelType.GuildForum) {
        throw new Error('这个频道不是论坛频道');
    }
    const forum = channel as ForumChannel;

    const threadIds = await collectThreads(forum);
    const rows: ScanRow[] = [];
    const progress: ScanProgress = { scanned: 0, flagged: 0, skipped: 0 };

    for (const threadId of threadIds) {
        progress.scanned++;
        if (progress.scanned % 25 === 0) options.onProgress?.(progress);

        const thread = await fetchThread(client, threadId);
        if (!thread) { progress.skipped++; continue; }

        // 静默扫描不调 LLM：省钱也快，需要 LLM 定性的在表里单独标出来
        const inspection = await inspectThread(thread, { dryRun: true });
        if (inspection.skipped) { progress.skipped++; continue; }

        const violations = effectiveViolations(inspection);
        if (violations.length === 0) continue;

        progress.flagged++;

        const plan = inspection.plan;
        rows.push({
            forumName: forum.name,
            threadId: thread.id,
            threadUrl: thread.url,
            title: thread.name,
            tags: inspection.tags.map(t => t.tagName).join(' | '),
            authorId: thread.ownerId ?? '',
            isOldPost: isOldPost(thread, settings.oldPostDays),
            rules: [...new Set(violations.map(v => v.rule))].join(' '),
            detail: violations.map(v => v.message).join('；'),
            needsLlm: violations.some(v => v.needsLlm),
            suggestedTitle: plan && plan.newTitle !== plan.originalTitle ? plan.newTitle : '',
            removeTags: plan
                ? inspection.tags.filter(t => plan.removeTagIds.includes(t.tagId)).map(t => t.tagName).join(' | ')
                : '',
            autoFixable: Boolean(plan?.autoFixable),
            blockedReason: plan?.blockedReason ?? '',
        });

        if (dryRun) continue;

        // 真扫：老帖进慢速队列，新帖直接建案
        if (isOldPost(thread, settings.oldPostDays)) {
            db.enqueueBackfill(guildId, forum.id, thread.id);
        } else {
            const { openCaseFor } = await import('./enforcer');
            openCaseFor(inspection);
        }
    }

    options.onProgress?.(progress);
    return { rows, progress };
}

// ============================================================
// 队列驱动（每个 tick 只处理一个帖子）
// ============================================================

export async function runBackfillTick(client: Client, guildId: string): Promise<void> {
    const item = db.nextBackfillItem();
    if (!item || item.guildId !== guildId) return;

    const thread = await fetchThread(client, item.threadId);
    if (!thread) {
        db.finishBackfillItem(item.guildId, item.threadId, 'skipped', '帖子已不存在');
        return;
    }

    try {
        // 这一步会调 LLM（如果需要）——队列本来就慢，不差这点时间
        const inspection = await inspectThread(thread);
        if (inspection.skipped) {
            db.finishBackfillItem(item.guildId, item.threadId, 'skipped', inspection.skipped);
            return;
        }

        const violations = effectiveViolations(inspection);
        if (violations.length === 0) {
            db.finishBackfillItem(item.guildId, item.threadId, 'skipped', '复查已合规');
            return;
        }

        const { openCaseFor } = await import('./enforcer');
        const guardCase = openCaseFor(inspection);
        if (!guardCase) {
            db.finishBackfillItem(item.guildId, item.threadId, 'skipped', '已有未结案件');
            return;
        }

        db.finishBackfillItem(item.guildId, item.threadId, 'done');
        console.log(`[TitleGuard] 老帖入案 #${guardCase.id}：${thread.name}`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        db.finishBackfillItem(item.guildId, item.threadId, 'failed', message);
        console.error(`[TitleGuard] 老帖整改失败 ${item.threadId}：`, err);
    }
}

// ============================================================
// TAG 映射自动生成
// ============================================================

/**
 * 用论坛现有的 TAG 名去词典里找同名词，猜出它属于哪个分类组。
 * 只补名字和「还没配过」的归属，**不覆盖管理组已经人工修正过的映射**。
 */
export function autoMapTags(guild: Guild, forum: ForumChannel): { total: number; guessed: number } {
    const dict = db.listDict(guild.id);
    const byWord = new Map(dict.filter(d => d.enabled && d.group).map(d => [d.word, d.group!]));

    const existing = new Map(db.listTagMap(guild.id, forum.id).map(m => [m.tagId, m.group]));

    let guessed = 0;
    for (const tag of forum.availableTags) {
        const normalized = tag.name.trim().toLowerCase();
        const guess = byWord.get(normalized) ?? null;

        // 已经有人工配置的就只更新名字
        if (existing.get(tag.id)) {
            db.touchTagMapping(guild.id, forum.id, tag.id, tag.name, null);
            continue;
        }

        db.setTagMapping(guild.id, forum.id, tag.id, tag.name, guess);
        if (guess) guessed++;
    }

    return { total: forum.availableTags.length, guessed };
}

export { isForumThread };
