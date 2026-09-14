import type { Client, ThreadChannel } from 'discord.js';

import {
    appendWarning,
    getDeletionQueueState,
    getJob,
    isThreadMarkedOpened,
    listPendingMessages,
    listRestorableOpenedThreads,
    markThreadOpened,
    markScanCompleted,
    recordMessageCandidates,
    recordMessageResults,
    setJobStatus,
    setResolvedScope,
    setScanMode,
    unmarkThreadOpened,
    updateCursor,
} from './messageCleanupDatabase';
import type {
    CleanupMessageOutcome,
    CleanupMessageResult,
    PendingCleanupMessage,
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

interface DeleteResult {
    channelId: string;
    messageId: string;
    outcome: CleanupMessageOutcome;
    retryAt?: number;
    error?: string | null;
}

const SEARCH_CHANNEL_BATCH = 100;
const SEARCH_INDEX_MAX_ATTEMPTS = 3;
const SEARCH_INDEX_MAX_WAIT_MS = 5_000;
const RECENT_MESSAGE_AGE = 14 * 24 * 60 * 60_000;
const RECENT_SAFETY_MARGIN = 60_000;
const DEFAULT_HISTORY_PAGE_INTERVAL_MS = 1_100;
const MIN_HISTORY_PAGE_INTERVAL_MS = 250;
const MAX_HISTORY_PAGE_INTERVAL_MS = 10_000;
const DELETE_QUEUE_IDLE_MS = 500;
const MAX_DELETE_RETRY_DELAY_MS = 5 * 60_000;
const historyPageIntervalMs = (() => {
    const raw = process.env.MESSAGE_CLEANUP_HISTORY_PAGE_INTERVAL_MS?.trim();
    if (!raw) return DEFAULT_HISTORY_PAGE_INTERVAL_MS;
    const configured = Number(raw);
    if (!Number.isFinite(configured)) return DEFAULT_HISTORY_PAGE_INTERVAL_MS;
    return Math.min(Math.max(Math.trunc(configured), MIN_HISTORY_PAGE_INTERVAL_MS), MAX_HISTORY_PAGE_INTERVAL_MS);
})();
const lastHistoryPageStartedAt = new Map<string, number>();

interface ThreadLeaseState {
    count: number;
    restoreArchived: boolean;
}

const threadLeases = new Map<string, ThreadLeaseState>();
const threadTransitionTails = new Map<string, Promise<void>>();

function chunks<T>(values: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
    return result;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): number | null {
    for (const item of errorChain(error)) {
        if (!('code' in item)) continue;
        const code = Number((item as { code?: unknown }).code);
        if (Number.isFinite(code)) return code;
    }
    return null;
}

function errorChain(error: unknown): object[] {
    const result: object[] = [];
    const seen = new Set<object>();
    let current = error;
    while (current && typeof current === 'object' && !seen.has(current)) {
        seen.add(current);
        result.push(current);
        current = 'cause' in current ? (current as { cause?: unknown }).cause : null;
    }
    return result;
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

async function paceHistoryPage(channelId: string): Promise<void> {
    const earliestStart = (lastHistoryPageStartedAt.get(channelId) ?? 0) + historyPageIntervalMs;
    const remaining = earliestStart - Date.now();
    if (remaining > 0) await wait(remaining);
    lastHistoryPageStartedAt.set(channelId, Date.now());
}

async function fetchThread(client: Client, channelId: string): Promise<ThreadChannel | null> {
    const channel = await client.channels.fetch(channelId, { cache: true, force: true });
    return channel?.isThread() ? channel : null;
}

async function withThreadTransitionLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = threadTransitionTails.get(key) ?? Promise.resolve();
    let releaseLock!: () => void;
    const gate = new Promise<void>(resolve => { releaseLock = resolve; });
    const tail = previous.then(() => gate);
    threadTransitionTails.set(key, tail);
    await previous;
    try {
        return await action();
    } finally {
        releaseLock();
        if (threadTransitionTails.get(key) === tail) threadTransitionTails.delete(key);
    }
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
            await thread.setArchived(true, '恢复内容维护前的归档状态');
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
    const leaseKey = `${job.id}:${channelId}`;
    let released = false;
    const release = await withThreadTransitionLock(leaseKey, async (): Promise<(() => Promise<void>) | null> => {
        const existing = threadLeases.get(leaseKey);
        if (existing) {
            existing.count += 1;
        } else {
            const thread = await fetchThread(client, channelId).catch(() => null);
            if (!thread) return null;

            const alreadyMarked = isThreadMarkedOpened(job.id, channelId);
            const restoreArchived = thread.archived || alreadyMarked;
            if (thread.archived) {
                // 先落库再打开：即使进程恰好在 API 成功后退出，重启也知道要把它关回去。
                markThreadOpened(job.id, channelId);
                try {
                    await thread.setArchived(false, '临时执行内容维护');
                } catch (error) {
                    await restoreMarkedThread(client, job.id, channelId);
                    throw new Error(`<#${channelId}> 无法临时打开：${errorText(error)}`, { cause: error });
                }
            }
            threadLeases.set(leaseKey, { count: 1, restoreArchived });
        }

        return async (): Promise<void> => {
            if (released) return;
            released = true;
            await withThreadTransitionLock(leaseKey, async () => {
                const state = threadLeases.get(leaseKey);
                if (!state) return;
                state.count -= 1;
                if (state.count > 0) return;
                threadLeases.delete(leaseKey);
                if (state.restoreArchived) await restoreMarkedThread(client, job.id, channelId);
            });
        };
    });

    try {
        return await action();
    } finally {
        await release?.();
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

function errorStatus(error: unknown): number | null {
    for (const item of errorChain(error)) {
        if (!('status' in item)) continue;
        const status = Number((item as { status?: unknown }).status);
        if (Number.isFinite(status)) return status;
    }
    return null;
}

function isRetryableDeleteError(error: unknown): boolean {
    const status = errorStatus(error);
    if (status === 429 || (status !== null && status >= 500)) return true;
    for (const item of errorChain(error)) {
        if (item instanceof Error && item.name === 'AbortError') return true;
        if (!('code' in item)) continue;
        const code = String((item as { code?: unknown }).code ?? '').toUpperCase();
        if (code.startsWith('UND_ERR_')
            || ['ABORT_ERR', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT'].includes(code)) {
            return true;
        }
    }
    return false;
}

function isTerminalChannelDeleteError(error: unknown): boolean {
    return errorStatus(error) === 403 || [10003, 50001, 50013].includes(errorCode(error) ?? 0);
}

function retryDelayMs(error: unknown, attemptCount: number): number {
    for (const item of errorChain(error)) {
        const shaped = item as {
            retry_after?: unknown;
            rawError?: { retry_after?: unknown };
            data?: { retry_after?: unknown };
        };
        const raw = Number(shaped.retry_after ?? shaped.rawError?.retry_after ?? shaped.data?.retry_after);
        if (Number.isFinite(raw) && raw > 0) {
            const milliseconds = raw < 1_000 ? raw * 1_000 : raw;
            return Math.min(Math.ceil(milliseconds) + 250, MAX_DELETE_RETRY_DELAY_MS);
        }
    }
    return Math.min(2_000 * (2 ** Math.min(attemptCount, 7)), MAX_DELETE_RETRY_DELAY_MS);
}

function retryResult(message: PendingCleanupMessage, error: unknown): DeleteResult {
    return {
        channelId: message.channelId,
        messageId: message.messageId,
        outcome: 'pending',
        retryAt: Date.now() + retryDelayMs(error, message.attemptCount),
        error: errorText(error),
    };
}

function failedResult(message: PendingCleanupMessage, error: unknown): DeleteResult {
    return {
        channelId: message.channelId,
        messageId: message.messageId,
        outcome: 'failed',
        error: errorText(error),
    };
}

async function deleteOne(client: Client, message: PendingCleanupMessage, reason: string): Promise<DeleteResult> {
    try {
        await client.rest.delete(`/channels/${message.channelId}/messages/${message.messageId}`, { reason });
        return { channelId: message.channelId, messageId: message.messageId, outcome: 'deleted' };
    } catch (error) {
        // 重启续跑或管理员同时手动删除时，Unknown Message 不算真正失败。
        if (errorCode(error) === 10008) {
            return { channelId: message.channelId, messageId: message.messageId, outcome: 'skipped' };
        }
        if (isRetryableDeleteError(error)) return retryResult(message, error);
        console.warn(`[MessageCleanup] 删除消息 ${message.channelId}/${message.messageId} 失败：${errorText(error)}`);
        return failedResult(message, error);
    }
}

async function deleteRecentBatch(
    client: Client,
    jobId: number,
    messages: PendingCleanupMessage[],
    reason: string,
): Promise<DeleteResult[]> {
    if (messages.length === 1) return [await deleteOne(client, messages[0], reason)];
    const channelId = messages[0].channelId;
    try {
        await client.rest.post(`/channels/${channelId}/messages/bulk-delete`, {
            body: { messages: messages.map(message => message.messageId) },
            reason,
        });
        return messages.map(message => ({
            channelId,
            messageId: message.messageId,
            outcome: 'deleted',
        }));
    } catch (error) {
        if (isRetryableDeleteError(error)) return messages.map(message => retryResult(message, error));
        if (isTerminalChannelDeleteError(error)) {
            appendWarning(jobId, `<#${channelId}> 无法批量删除：${errorText(error)}`);
            return messages.map(message => failedResult(message, error));
        }
        // 某一条碰到年龄边界或属于不可删除的系统消息时，整批会失败；逐条回退可保住其他消息。
        console.warn(`[MessageCleanup] 批量删除频道 ${channelId} 失败，回退逐条删除：${errorText(error)}`);
        const results: DeleteResult[] = [];
        for (const message of messages) {
            if (!stillRunning(jobId)) break;
            results.push(await deleteOne(client, message, reason));
        }
        return results;
    }
}

function recordCandidates(
    job: CleanupJob,
    messages: ApiMessage[],
): void {
    const unique = new Map<string, ApiMessage>();
    const allowedChannels = new Set(job.scopeChannelIds);
    for (const message of messages) {
        if (!/^\d{17,20}$/.test(message.id)) continue;
        if (!allowedChannels.has(message.channel_id)) continue;
        if (message.author?.id !== job.targetUserId) continue;
        unique.set(`${message.channel_id}:${message.id}`, message);
    }
    recordMessageCandidates(job.id, [...unique.values()].map(message => ({
        channelId: message.channel_id,
        messageId: message.id,
    })));
}

async function deleteQueuedMessages(
    client: Client,
    job: CleanupJob,
    messages: PendingCleanupMessage[],
): Promise<void> {
    if (messages.length === 0) return;
    const channelId = messages[0].channelId;
    const reason = '社区内容维护';
    const recentBoundary = Date.now() - RECENT_MESSAGE_AGE + RECENT_SAFETY_MARGIN;
    const deleteInChannel = async (): Promise<void> => {
        const recent: PendingCleanupMessage[] = [];
        const old: PendingCleanupMessage[] = [];
        for (const message of messages) {
            (timestampFromSnowflake(message.messageId) >= recentBoundary ? recent : old).push(message);
        }

        if (recent.length > 0 && stillRunning(job.id)) {
            const results = await deleteRecentBatch(client, job.id, recent, reason);
            recordMessageResults(job.id, results);
        }
        for (const message of old) {
            if (!stillRunning(job.id)) break;
            recordMessageResults(job.id, [await deleteOne(client, message, reason)]);
        }
    };

    try {
        await withTemporarilyOpenedThread(client, job, channelId, deleteInChannel);
    } catch (error) {
        const results: CleanupMessageResult[] = messages.map(message => (
            isRetryableDeleteError(error) ? retryResult(message, error) : failedResult(message, error)
        ));
        recordMessageResults(job.id, results);
        if (!isRetryableDeleteError(error)) {
            appendWarning(job.id, `<#${channelId}> 无法执行待删除队列：${errorText(error)}`);
        }
    }
}

async function runDeletionWorker(client: Client, jobId: number): Promise<void> {
    while (stillRunning(jobId)) {
        const messages = listPendingMessages(jobId, 100);
        if (messages.length > 0) {
            const job = getJob(jobId);
            if (!job || job.status !== 'running') return;
            await deleteQueuedMessages(client, job, messages);
            continue;
        }

        const state = getDeletionQueueState(jobId);
        const job = getJob(jobId);
        if (!job || job.status !== 'running') return;
        if (job.scanCompletedAt !== null && state.pendingCount === 0) return;

        const untilRetry = state.nextAttemptAt === null
            ? DELETE_QUEUE_IDLE_MS
            : Math.max(state.nextAttemptAt - Date.now(), DELETE_QUEUE_IDLE_MS);
        // 最多睡一个轮询周期，以便扫描器新写入消息后删除器能快速接上。
        await wait(Math.min(untilRetry, DELETE_QUEUE_IDLE_MS));
    }
}

function flattenSearchMessages(response: SearchResponse, job: CleanupJob): ApiMessage[] {
    const result = new Map<string, ApiMessage>();
    for (const group of response.messages ?? []) {
        for (const message of group) {
            if (message.author?.id !== job.targetUserId) continue;
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
    for (let attempt = 0; attempt < SEARCH_INDEX_MAX_ATTEMPTS; attempt++) {
        const query = new URLSearchParams();
        query.set('limit', '25');
        query.set('sort_by', 'timestamp');
        query.set('sort_order', 'desc');
        query.set('max_id', maxId);
        query.append('author_id', job.targetUserId);
        for (const channelId of channelIds) query.append('channel_id', channelId);

        const response = await client.rest.get(`/guilds/${job.guildId}/messages/search`, { query }) as SearchResponse;
        if (response.code === 110000) {
            const seconds = Number(response.retry_after);
            await wait(Number.isFinite(seconds) && seconds > 0
                ? Math.min(seconds * 1000, SEARCH_INDEX_MAX_WAIT_MS)
                : 2_000);
            continue;
        }
        return flattenSearchMessages(response, job);
    }
    throw new Error('Discord 消息搜索索引长时间未就绪');
}

async function runSearchScan(client: Client, initialJob: CleanupJob): Promise<void> {
    // 全服任务直接使用 Discord 的服务器级作者搜索。候选写库时仍按已解析范围过滤，
    // 因此排除项不会被删除；同时避免给一次搜索附带数百个 channel_id。
    const channelBatches = initialJob.entireGuild
        ? [[]]
        : chunks(initialJob.scopeChannelIds, SEARCH_CHANNEL_BATCH);
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
            recordCandidates(fresh, found);
            updateCursor(initialJob.id, batchIndex, nextCursor);
            cursor = nextCursor;
        }

        if (!stillRunning(initialJob.id)) return;
        updateCursor(initialJob.id, batchIndex + 1, null);
    }
}

async function fetchHistoryPage(client: Client, channelId: string, before: string): Promise<ApiMessage[]> {
    // Discord 会按频道限制历史消息读取。主动摊平分页请求，避免先突发请求再被 SDK 强制等待数秒。
    await paceHistoryPage(channelId);
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
                    recordCandidates(fresh, candidates);

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
        } finally {
            lastHistoryPageStartedAt.delete(channelId);
        }

        if (!stillRunning(initialJob.id)) return;
        updateCursor(initialJob.id, channelIndex + 1, null);
    }
}

async function runScanWorker(client: Client, initialJob: CleanupJob): Promise<void> {
    if (initialJob.scanCompletedAt !== null) return;
    let job = initialJob;
    if (job.scanMode === 'search') {
        try {
            await runSearchScan(client, job);
        } catch (error) {
            if (!stillRunning(job.id)) return;
            const warning = `服务器消息快速搜索未完整结束，继续逐频道完整核验：${errorText(error)}`;
            console.warn(`[MessageCleanup] 任务 #${job.id} ${warning}`);
            appendWarning(job.id, warning);
        }

        if (!stillRunning(job.id)) return;
        // Discord 搜索只负责加速，绝不能作为“全部找完”的依据；随后逐频道翻到底兜底。
        setScanMode(job.id, 'history', true);
        job = getJob(job.id)!;
    }

    await runHistoryScan(client, job);
    if (stillRunning(job.id)) {
        markScanCompleted(job.id);
        const scanned = getJob(job.id)!;
        console.log(`[MessageCleanup] 🔎 任务 #${job.id} 扫描完成：找到 ${scanned.foundCount}，待删除 ${scanned.pendingCount}`);
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
        const supervise = async (worker: '扫描器' | '删除器', action: () => Promise<void>): Promise<void> => {
            try {
                await action();
            } catch (error) {
                const current = getJob(job.id);
                if (current?.status === 'running') {
                    setJobStatus(job.id, 'failed', `${worker}异常：${errorText(error)}`.slice(0, 2000));
                }
                console.error(`[MessageCleanup] 任务 #${job.id} ${worker}异常：`, error);
            }
        };

        // 两个 Promise 独立等待各自的 Discord 限流桶；删除器排队不会阻塞扫描器继续翻页。
        await Promise.all([
            supervise('扫描器', () => runScanWorker(client, job)),
            supervise('删除器', () => runDeletionWorker(client, job.id)),
        ]);

        const current = getJob(job.id);
        if (current?.status === 'running' && current.scanCompletedAt !== null && current.pendingCount === 0) {
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
