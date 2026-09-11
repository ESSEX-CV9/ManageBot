// src/modules/titleGuard/services/backfillQueue.ts
//
// 老帖慢速整改队列。
//
// 为什么要慢：整改老帖会在帖子里发通知，**发消息一定会顶帖**（单纯解归档/重新归档不会）。
// 存量几百上千个帖子，一口气跑完等于把论坛首页全刷成翻出来的老帖。
// 所以全局串行 + 可配速率（默认 20 分钟一个，约 72 个/天），队列持久化，重启接着跑。
//
// 扫描本身（把帖子塞进队列）不受限速影响，只有「实际发通知」这一步走队列。

import {
    ChannelType,
    type Client,
    type ForumChannel,
    type Guild,
    type ThreadChannel,
} from 'discord.js';

import * as db from './titleGuardDatabase';
import { normalize } from './normalizer';
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
 *
 * **返回的是帖子对象本身，不是 ID。** 这一点很要紧：
 * Discord 翻页时已经把完整的帖子给你了——标题、TAG、归档状态、最后消息时间全在里面，
 * 判定需要的东西一样不缺。以前这里只留了 ID 把对象扔掉，外面再对每个帖子单独 fetch 一次，
 * 两万个帖子就是两万次 REST 请求，限速下要跑几个小时。
 * 直接用翻页的结果，同样两万个帖子只要两百来次请求。
 *
 * 归档帖的分页要靠 before 游标，这里一次抓 100、抓到空为止。
 */
export async function collectThreads(forum: ForumChannel): Promise<ThreadChannel[]> {
    const found = new Map<string, ThreadChannel>();

    try {
        const active = await forum.threads.fetchActive();
        for (const [id, thread] of active.threads) found.set(id, thread);
    } catch (err) {
        console.warn(`[TitleGuard] 读取论坛 ${forum.id} 活跃帖失败：`, err);
    }

    let before: string | undefined;
    for (let page = 0; page < 400; page++) {
        try {
            const archived = await forum.threads.fetchArchived({ limit: 100, before });
            if (archived.threads.size === 0) break;

            let oldest: number | undefined;
            for (const [id, thread] of archived.threads) {
                if (!found.has(id)) found.set(id, thread);
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

    return [...found.values()];
}

// ============================================================
// 快速全量扫描（只看不动）
// ============================================================

/**
 * 帖子的活跃状态。决定它走哪条队列。
 *
 *   活跃     —— 还没归档。发通知不用解归档
 *   近期归档 —— 已归档但最近还有人在回（默认 48 小时内）。按活帖待遇，走快队列
 *   老帖     —— 已归档且沉寂超过门槛。发通知得先解归档，而且一定会顶帖，走慢队列
 */
export type Activity = '活跃' | '近期归档' | '老帖';

export function activityOf(thread: ThreadChannel, inactiveHours: number): Activity {
    if (!thread.archived) return '活跃';
    return isOldPost(thread, inactiveHours) ? '老帖' : '近期归档';
}

/** 这个帖子接下来能怎么处理 */
export type Disposition = '可自动整改' | '需模型定性' | '转人工';

export interface ScanRow {
    forumName: string;
    threadId: string;
    threadUrl: string;
    title: string;
    tags: string;
    authorId: string;
    /** 活跃 / 近期归档 / 老帖 */
    activity: Activity;
    /** 可自动整改 / 需模型定性 / 转人工 */
    disposition: Disposition;
    rules: string;
    detail: string;
    suggestedTitle: string;
    removeTags: string;
    blockedReason: string;
}

/**
 * 快速全量扫描一个论坛。
 *
 * **全程不调 LLM**，判定是纯 CPU 的，两万条几秒就跑完。
 * 需要模型定性的那些在表里单独标成「需模型定性」——它们既不能算合格，
 * 也不能直接发通知（方案还没定），得等进了队列再逐个问模型。
 *
 * dryRun=true（默认）：只出表，一个字都不改、一条通知都不发。
 * dryRun=false：合格的记进「已核查」，违规的按活跃状态分别入快/慢队列。
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

    const threads = await collectThreads(forum);
    const rows: ScanRow[] = [];
    const progress: ScanProgress = { scanned: 0, flagged: 0, skipped: 0 };
    const cleanIds: string[] = [];

    for (const thread of threads) {
        progress.scanned++;
        if (progress.scanned % 500 === 0) options.onProgress?.(progress);

        // dryRun 一律为真：快扫不调模型
        const inspection = await inspectThread(thread, { dryRun: true });
        if (inspection.skipped) { progress.skipped++; continue; }

        const violations = effectiveViolations(inspection);
        if (violations.length === 0) {
            cleanIds.push(thread.id);
            continue;
        }

        progress.flagged++;

        const plan = inspection.plan;
        const activity = activityOf(thread, settings.oldPostInactiveHours);
        const disposition: Disposition =
            violations.some(v => v.arbiter === 'LLM') ? '需模型定性'
                : plan?.autoFixable ? '可自动整改'
                    : '转人工';

        rows.push({
            forumName: forum.name,
            threadId: thread.id,
            threadUrl: thread.url,
            title: thread.name,
            tags: inspection.tags.map(t => t.tagName).join(' | '),
            authorId: thread.ownerId ?? '',
            activity,
            disposition,
            rules: [...new Set(violations.map(v => v.rule))].join(' '),
            detail: violations.map(v => v.message).join('；'),
            suggestedTitle: plan && plan.newTitle !== plan.originalTitle ? plan.newTitle : '',
            removeTags: plan
                ? inspection.tags.filter(t => plan.removeTagIds.includes(t.tagId))
                    .map(t => t.tagName).join(' | ')
                : '',
            blockedReason: plan?.blockedReason ?? '',
        });

        if (dryRun) continue;

        // 真扫：按活跃状态分队。
        //   活跃 / 近期归档 → 快队列（50 个一批，批间隔 30 分钟）
        //   老帖            → 慢队列（默认 5 分钟一个）
        // 「转人工」的也入队——队列里会再判一次，那时才决定是发通知还是叫管理组。
        db.enqueueBackfill(guildId, forum.id, thread.id, activity === '老帖' ? 'slow' : 'fast');
    }

    // 合格的批量记账。只是个「还剩多少活要干」的标记：
    // 帖子改了名有事件兜着，重跑全量时也会无视这个标记一律重判，
    // 所以它永远不会让你漏掉东西。
    if (!dryRun && cleanIds.length > 0) {
        db.markClean(guildId, forum.id, cleanIds);
    }

    options.onProgress?.(progress);
    return { rows, progress };
}

// ============================================================
// 队列驱动（一次只处理一个帖子）
// ============================================================

/**
 * 从指定队列取一个帖子处理。
 *
 * 返回**这次有没有真的处理掉一个**。调用方靠它决定要不要记一次配额——
 * 队列空跑也算数的话，歇 30 分钟的闸会被一堆空转悄悄耗光，
 * 等真有帖子进来时配额已经没了。
 */
export async function runBackfillTick(
    client: Client, guildId: string, lane: db.QueueLane = 'slow',
): Promise<boolean> {
    const item = db.nextBackfillItem(lane);
    if (!item || item.guildId !== guildId) return false;

    const thread = await fetchThread(client, item.threadId);
    if (!thread) {
        db.finishBackfillItem(item.guildId, item.threadId, 'skipped', '帖子已不存在');
        return false;
    }

    try {
        // 这一步会调 LLM（如果需要）。快队列一批 50 个，真碰上一批全要模型定性会慢一些，
        // 但慢的是这一批内部，批与批之间的闸不受影响
        const inspection = await inspectThread(thread);
        if (inspection.skipped) {
            db.finishBackfillItem(item.guildId, item.threadId, 'skipped', inspection.skipped);
            return false;
        }

        const violations = effectiveViolations(inspection);
        if (violations.length === 0) {
            db.finishBackfillItem(item.guildId, item.threadId, 'skipped', '复查已合规');
            // 复查发现没事了，记进「已核查」，省得下次全量又把它捞出来
            db.markClean(item.guildId, item.forumId, [item.threadId]);
            return false;
        }

        const { openCaseFor } = await import('./enforcer');
        const guardCase = openCaseFor(inspection);
        if (!guardCase) {
            db.finishBackfillItem(item.guildId, item.threadId, 'skipped', '已有未结案件');
            return false;
        }

        db.finishBackfillItem(item.guildId, item.threadId, 'done');
        console.log(`[TitleGuard] ${lane === 'fast' ? '活跃帖' : '老帖'}入案 #${guardCase.id}：${thread.name}`);
        // 真发了一条通知才算用掉一次配额
        return true;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        db.finishBackfillItem(item.guildId, item.threadId, 'failed', message);
        console.error(`[TitleGuard] 队列整改失败 ${item.threadId}：`, err);
        return false;
    }
}

// ============================================================
// TAG 映射自动生成
// ============================================================

export interface AutoMapResult {
    total: number;
    /** 这次新猜出来的 */
    guessed: number;
    /** 跑完之后一共有多少个 TAG 是有分类组的（含以前人工配的） */
    mapped: number;
}

/**
 * 用论坛现有的 TAG 名去词典里找同名词，猜出它属于哪个分类组。
 * 只补名字和「还没配过」的归属，**不覆盖管理组已经人工修正过的映射**。
 *
 * 两个容易踩的点：
 *   1. 词表可能是**借别的服的**，所以要走 dictSourceOf，不能直接用 guild.id，
 *      否则借用方这边永远是一张空词表，什么都猜不出来。
 *   2. TAG 名要走和词典同一套**归一化**再比。词典里存的是归一化形式，
 *      而 TAG 名常有全角和装饰符——「ＮＴＲ」「纯★爱」只做 toLowerCase 是匹配不上的。
 */
export function autoMapTags(guild: Guild, forum: ForumChannel): AutoMapResult {
    const dict = db.listDict(db.dictSourceOf(guild.id));
    const byWord = new Map(dict.filter(d => d.enabled && d.group).map(d => [d.word, d.group!]));

    const existing = new Map(db.listTagMap(guild.id, forum.id).map(m => [m.tagId, m.group]));

    let guessed = 0;
    let mapped = 0;
    for (const tag of forum.availableTags) {
        const already = existing.get(tag.id);

        // 已经有人工配置的就只更新名字
        if (already) {
            db.touchTagMapping(guild.id, forum.id, tag.id, tag.name, null);
            mapped++;
            continue;
        }

        const guess = byWord.get(normalize(tag.name).text.trim()) ?? null;
        db.setTagMapping(guild.id, forum.id, tag.id, tag.name, guess);
        if (guess) { guessed++; mapped++; }
    }

    return { total: forum.availableTags.length, guessed, mapped };
}

export { isForumThread };
