import type { Client, ThreadChannel } from 'discord.js';

import {
    addCounts,
    appendWarning,
    getJob,
    isThreadMarkedOpened,
    listRestorableOpenedThreads,
    markThreadOpened,
    setJobStatus,
    setResolvedScope,
    setScanMode,
    unmarkThreadOpened,
    updateCursor,
} from './messageCleanupDatabase';
import { snowflakeAt, timestampFromSnowflake } from './cleanupTime';
import { resolveCleanupScope } from './scopeResolver';
import type { CleanupJob } from './types';

interface ApiMessage {
    id: string;
    channel_id: string;
    author?: { id?: string };
    timestamp?: string;
}

interface SearchResponse {
    code?: number;
    message?: string;
    retry_after?: number;
    total_results?: number;
    messages?: ApiMessage[][];
}

interface DeleteCounts {
    deleted: number;
    skipped: number;
    failed: number;
}

const SEARCH_CHANNEL_BATCH = 100;
const RECENT_MESSAGE_AGE = 14 * 24 * 60 * 60_000;
const RECENT_SAFETY_MARGIN = 60_000;

function chunks<T>(values: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
    return result;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): number | null {
    if (!error || typeof error !== 'object' || !('code' in error)) return null;
    const code = Number((error as { code?: unknown }).code);
    return Number.isFinite(code) ? code : null;
}

function oldestId(messages: ApiMessage[]): string {
    return messages.reduce((oldest, message) => BigInt(message.id) < BigInt(oldest) ? message.id : oldest, messages[0].id);
}

function stillRunning(jobId: number): boolean {
    return getJob(jobId)?.status === 'running';
}

async function wait(ms: number): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function fetchThread(client: Client, channelId: string): Promise<ThreadChannel | null> {
    const channel = await client.channels.fetch(channelId, { cache: true, force: true });
    return channel?.isThread() ? channel : null;
}

async function restoreMarkedThread(client: Client, jobId: number, channelId: string): Promise<boolean> {
    try {
        const thread = await fetchThread(client, channelId);
        if (!thread) {
            // 子区已经被删除或 ID 不再指向子区，不存在可恢复的归档状态。
            unmarkThreadOpened(jobId, channelId);
            return true;
        }
        if (!thread.archived) {
            await thread.setArchived(true, `恢复紧急隐私清理任务 #${jobId} 前的归档状态`);
        }
        unmarkThreadOpened(jobId, channelId);
        return true;
    } catch (error) {
        appendWarning(jobId, `<#${channelId}> 删除后重新归档失败，将由后台继续重试：${errorText(error)}`);
        return false;
    }
}

async function withTemporarilyOpenedThread<T>(
    client: Client,
    job: CleanupJob,
    channelId: string,
    action: () => Promise<T>,
): Promise<T> {
    const thread = await fetchThread(client, channelId).catch(() => null);
    if (!thread) return action();

    const alreadyMarked = isThreadMarkedOpened(job.id, channelId);
    if (!thread.archived && !alreadyMarked) return action();

    if (thread.archived) {
        // 先落库再打开：即使进程恰好在 API 成功后退出，重启也知道要把它关回去。
        markThreadOpened(job.id, channelId);
        try {
            await thread.setArchived(false, `紧急隐私清理任务 #${job.id} 临时打开归档区域`);
        } catch (error) {
            await restoreMarkedThread(client, job.id, channelId);
            throw new Error(`<#${channelId}> 无法临时打开：${errorText(error)}`);
        }
    }

    try {
        return await action();
    } finally {
        await restoreMarkedThread(client, job.id, channelId);
    }
}

/** 进程重启或上一次恢复失败时，持续补关已经完成/暂停任务留下的子区。 */
export async function restoreDanglingArchivedThreads(
    client: Client,
    skipGuildIds: ReadonlySet<string> = new Set(),
): Promise<void> {
    for (const record of listRestorableOpenedThreads()) {
        if (skipGuildIds.has(record.guildId)) continue;
        await restoreMarkedThread(client, record.jobId, record.channelId);
    }
}

async function deleteOne(client: Client, channelId: string, messageId: string, reason: string): Promise<DeleteCounts> {
    try {
        await client.rest.delete(`/channels/${channelId}/messages/${messageId}`, { reason });
        return { deleted: 1, skipped: 0, failed: 0 };
    } catch (error) {
        // 重启续跑或管理员同时手动删除时，Unknown Message 不算真正失败。
        if (errorCode(error) === 10008) return { deleted: 0, skipped: 1, failed: 0 };
        console.warn(`[MessageCleanup] 删除消息 ${channelId}/${messageId} 失败：${errorText(error)}`);
        return { deleted: 0, skipped: 0, failed: 1 };
    }
}

async function deleteRecentBatch(
    client: Client,
    channelId: string,
    messageIds: string[],
    reason: string,
): Promise<DeleteCounts> {
    if (messageIds.length === 1) return deleteOne(client, channelId, messageIds[0], reason);
    try {
        await client.rest.post(`/channels/${channelId}/messages/bulk-delete`, {
            body: { messages: messageIds },
            reason,
        });
        return { deleted: messageIds.length, skipped: 0, failed: 0 };
    } catch (error) {
        // 某一条碰到年龄边界或属于不可删除的系统消息时，整批会失败；逐条回退可保住其他消息。
        console.warn(`[MessageCleanup] 批量删除频道 ${channelId} 失败，回退逐条删除：${errorText(error)}`);
        const total: DeleteCounts = { deleted: 0, skipped: 0, failed: 0 };
        for (const id of messageIds) {
            const one = await deleteOne(client, channelId, id, reason);
            total.deleted += one.deleted;
            total.skipped += one.skipped;
            total.failed += one.failed;
        }
        return total;
    }
}

async function deleteCandidates(
    client: Client,
    job: CleanupJob,
    messages: ApiMessage[],
    manageThreadState = true,
): Promise<void> {
    const unique = new Map<string, ApiMessage>();
    const allowedChannels = new Set(job.scopeChannelIds);
    for (const message of messages) {
        if (!/^\d{17,20}$/.test(message.id)) continue;
        if (!allowedChannels.has(message.channel_id)) continue;
        if (message.author?.id !== job.targetUserId) continue;
        unique.set(`${message.channel_id}:${message.id}`, message);
    }
    const candidates = [...unique.values()];
    if (candidates.length === 0) return;

    const reason = `紧急隐私清理任务 #${job.id}，目标用户 ${job.targetUserId}`;
    const recentBoundary = Date.now() - RECENT_MESSAGE_AGE + RECENT_SAFETY_MARGIN;
    const byChannel = new Map<string, ApiMessage[]>();
    for (const message of candidates) {
        const list = byChannel.get(message.channel_id) ?? [];
        list.push(message);
        byChannel.set(message.channel_id, list);
    }

    const total: DeleteCounts = { deleted: 0, skipped: 0, failed: 0 };
    for (const [channelId, channelMessages] of byChannel) {
        const deleteInChannel = async (): Promise<void> => {
            const recent: string[] = [];
            const old: string[] = [];
            for (const message of channelMessages) {
                const timestamp = message.timestamp ? Date.parse(message.timestamp) : timestampFromSnowflake(message.id);
                (timestamp >= recentBoundary ? recent : old).push(message.id);
            }

            for (const batch of chunks(recent, 100)) {
                const result = await deleteRecentBatch(client, channelId, batch, reason);
                total.deleted += result.deleted;
                total.skipped += result.skipped;
                total.failed += result.failed;
            }
            for (const id of old) {
                const result = await deleteOne(client, channelId, id, reason);
                total.deleted += result.deleted;
                total.skipped += result.skipped;
                total.failed += result.failed;
            }
        };

        try {
            if (manageThreadState) {
                await withTemporarilyOpenedThread(client, job, channelId, deleteInChannel);
            } else {
                await deleteInChannel();
            }
        } catch (error) {
            total.failed += channelMessages.length;
            appendWarning(job.id, errorText(error));
        }
    }

    addCounts(job.id, {
        found: candidates.length,
        deleted: total.deleted,
        skipped: total.skipped,
        failed: total.failed,
    });
}

function flattenSearchMessages(response: SearchResponse, job: CleanupJob, scope: Set<string>): ApiMessage[] {
    const result = new Map<string, ApiMessage>();
    for (const group of response.messages ?? []) {
        for (const message of group) {
            if (message.author?.id !== job.targetUserId || !scope.has(message.channel_id)) continue;
            result.set(`${message.channel_id}:${message.id}`, message);
        }
    }
    return [...result.values()];
}

async function searchPage(
    client: Client,
    job: CleanupJob,
    channelIds: string[],
    maxId: string,
): Promise<ApiMessage[]> {
    for (let attempt = 0; attempt < 15; attempt++) {
        const query = new URLSearchParams();
        query.set('limit', '25');
        query.set('sort_by', 'timestamp');
        query.set('sort_order', 'desc');
        query.set('include_nsfw', 'true');
        query.set('max_id', maxId);
        query.append('author_id', job.targetUserId);
        for (const channelId of channelIds) query.append('channel_id', channelId);

        const response = await client.rest.get(`/guilds/${job.guildId}/messages/search`, { query }) as SearchResponse;
        if (response.code === 110000) {
            const seconds = Number(response.retry_after);
            await wait(Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 10_000) : 2_000);
            continue;
        }
        return flattenSearchMessages(response, job, new Set(channelIds));
    }
    throw new Error('Discord 消息搜索索引长时间未就绪');
}

async function runSearchScan(client: Client, initialJob: CleanupJob): Promise<void> {
    const channelBatches = chunks(initialJob.scopeChannelIds, SEARCH_CHANNEL_BATCH);
    const cutoffId = snowflakeAt(initialJob.cutoffAt);

    for (let batchIndex = initialJob.cursorBatch; batchIndex < channelBatches.length; batchIndex++) {
        let cursor = batchIndex === initialJob.cursorBatch && initialJob.cursorId
            ? initialJob.cursorId
            : cutoffId;
        while (stillRunning(initialJob.id)) {
            const fresh = getJob(initialJob.id)!;
            const found = await searchPage(client, fresh, channelBatches[batchIndex], cursor);
            if (found.length === 0) break;

            const nextCursor = oldestId(found);
            if (nextCursor === cursor) {
                throw new Error('Discord 消息搜索游标没有继续前进');
            }
            if (!stillRunning(initialJob.id)) return;
            await deleteCandidates(client, fresh, found);
            updateCursor(initialJob.id, batchIndex, nextCursor);
            cursor = nextCursor;
        }

        if (!stillRunning(initialJob.id)) return;
        updateCursor(initialJob.id, batchIndex + 1, null);
    }
}

async function fetchHistoryPage(client: Client, channelId: string, before: string): Promise<ApiMessage[]> {
    const query = new URLSearchParams({ limit: '100', before });
    const raw = await client.rest.get(`/channels/${channelId}/messages`, { query });
    return Array.isArray(raw) ? raw as ApiMessage[] : [];
}

async function runHistoryScan(client: Client, initialJob: CleanupJob): Promise<void> {
    const cutoffId = snowflakeAt(initialJob.cutoffAt);
    for (let channelIndex = initialJob.cursorBatch; channelIndex < initialJob.scopeChannelIds.length; channelIndex++) {
        const channelId = initialJob.scopeChannelIds[channelIndex];
        let cursor = channelIndex === initialJob.cursorBatch && initialJob.cursorId
            ? initialJob.cursorId
            : cutoffId;

        try {
            await withTemporarilyOpenedThread(client, getJob(initialJob.id)!, channelId, async () => {
                while (stillRunning(initialJob.id)) {
                    let page: ApiMessage[];
                    try {
                        page = await fetchHistoryPage(client, channelId, cursor);
                    } catch (error) {
                        appendWarning(initialJob.id, `<#${channelId}> 扫描中断：${errorText(error)}`);
                        break;
                    }
                    if (page.length === 0) break;

                    const fresh = getJob(initialJob.id)!;
                    const candidates = page.filter(message => message.author?.id === fresh.targetUserId);
                    if (!stillRunning(initialJob.id)) return;
                    // 外层已经把归档子区保持为打开状态，避免每翻一页都反复开关。
                    await deleteCandidates(client, fresh, candidates, false);

                    const nextCursor = oldestId(page);
                    if (nextCursor === cursor) {
                        appendWarning(initialJob.id, `<#${channelId}> 扫描游标没有继续前进，已跳过剩余历史`);
                        break;
                    }
                    updateCursor(initialJob.id, channelIndex, nextCursor);
                    cursor = nextCursor;
                    if (page.length < 100) break;
                }
            });
        } catch (error) {
            appendWarning(initialJob.id, `<#${channelId}> 无法完成归档区域扫描：${errorText(error)}`);
        }

        if (!stillRunning(initialJob.id)) return;
        updateCursor(initialJob.id, channelIndex + 1, null);
    }
}

export async function executeCleanupJob(client: Client, claimedJob: CleanupJob): Promise<void> {
    try {
        const guild = client.guilds.cache.get(claimedJob.guildId)
            ?? await client.guilds.fetch(claimedJob.guildId).catch(() => null);
        if (!guild) throw new Error('机器人已不在目标服务器中');

        let job = getJob(claimedJob.id)!;
        if (job.scopeChannelIds.length === 0) {
            const scope = await resolveCleanupScope(guild, job);
            setResolvedScope(job.id, scope.channelIds, scope.warnings);
            if (scope.channelIds.length === 0) {
                throw new Error('没有可清理的频道；请检查所选范围、排除项和机器人权限');
            }
            job = getJob(job.id)!;
        }

        if (!stillRunning(job.id)) return;
        if (job.scanMode === 'search') {
            try {
                await runSearchScan(client, job);
            } catch (error) {
                if (!stillRunning(job.id)) return;
                const warning = `服务器消息搜索不可用，已切换为逐频道完整扫描：${errorText(error)}`;
                console.warn(`[MessageCleanup] 任务 #${job.id} ${warning}`);
                appendWarning(job.id, warning);
                setScanMode(job.id, 'history', true);
                job = getJob(job.id)!;
                await runHistoryScan(client, job);
            }
        } else {
            await runHistoryScan(client, job);
        }

        if (stillRunning(job.id)) {
            setJobStatus(job.id, 'completed');
            const done = getJob(job.id)!;
            console.log(`[MessageCleanup] ✅ 任务 #${job.id} 完成：找到 ${done.foundCount}，删除 ${done.deletedCount}，失败 ${done.failedCount}`);
        }
    } catch (error) {
        const current = getJob(claimedJob.id);
        if (current && current.status === 'running') {
            setJobStatus(claimedJob.id, 'failed', errorText(error).slice(0, 2000));
        }
        console.error(`[MessageCleanup] 任务 #${claimedJob.id} 失败：`, error);
    }
}
