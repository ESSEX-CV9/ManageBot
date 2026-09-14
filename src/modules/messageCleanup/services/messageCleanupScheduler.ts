import type { Client } from 'discord.js';

import {
    claimGuildMessageIndex,
    claimJob,
    completeJobListClear,
    hasOpenedThreadsForGuild,
    listJobListClearRequests,
    listRunnableGuildIndexes,
    listRunnableJobs,
    recoverInterruptedGuildIndexes,
    recoverInterruptedJobs,
    yieldGuildMessageIndex,
} from './messageCleanupDatabase';
import {
    executeCleanupJob,
    executeGuildMessageIndex,
    restoreDanglingArchivedThreads,
    restoreDanglingIndexThreads,
} from './messageCleanupService';

const TICK_MS = 2_000;
const LIST_CLEAR_RESTORE_GRACE_MS = 30_000;
let timer: NodeJS.Timeout | null = null;
let ticking = false;
const runningGuildIds = new Set<string>();
const runningIndexGuildIds = new Set<string>();

export async function tickMessageCleanup(client: Client): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
        const clearRequests = listJobListClearRequests();
        // 旧请求先强制收尾，避免重启后又被不可访问的归档子区拖住。
        for (const request of clearRequests) {
            if (Date.now() - request.requestedAt >= LIST_CLEAR_RESTORE_GRACE_MS) {
                completeJobListClear(request, true);
            }
        }

        await restoreDanglingArchivedThreads(client, runningGuildIds);
        await restoreDanglingIndexThreads(client, runningGuildIds);
        for (const request of listJobListClearRequests()) {
            if (runningGuildIds.has(request.guildId)) continue;
            if (hasOpenedThreadsForGuild(request.guildId)) continue;
            completeJobListClear(request);
        }
        const cleanupQueue = listRunnableJobs();
        // 冲水是紧急操作：若同服索引正在跑，让它在当前分页后退回队列，清理结束后自动续上。
        for (const pending of cleanupQueue) {
            if (runningIndexGuildIds.has(pending.guildId)) yieldGuildMessageIndex(pending.guildId);
        }
        for (const pending of cleanupQueue) {
            if (runningGuildIds.has(pending.guildId)) continue;
            const claimed = claimJob(pending.id);
            if (!claimed) continue;

            runningGuildIds.add(claimed.guildId);
            void executeCleanupJob(client, claimed).finally(() => {
                runningGuildIds.delete(claimed.guildId);
            });
        }
        // 紧急清理优先；同一服务器没有清理任务在运行时，才启动较慢的全服建库。
        for (const pending of listRunnableGuildIndexes()) {
            if (runningGuildIds.has(pending.guildId)) continue;
            const claimed = claimGuildMessageIndex(pending.guildId);
            if (!claimed) continue;

            runningGuildIds.add(claimed.guildId);
            runningIndexGuildIds.add(claimed.guildId);
            void executeGuildMessageIndex(client, claimed).finally(() => {
                runningGuildIds.delete(claimed.guildId);
                runningIndexGuildIds.delete(claimed.guildId);
            });
        }
    } finally {
        ticking = false;
    }
}

export async function startMessageCleanupScheduler(client: Client): Promise<void> {
    if (timer) return;
    const recovered = recoverInterruptedJobs();
    if (recovered > 0) console.log(`[MessageCleanup] 恢复 ${recovered} 个被重启打断的任务。`);
    const recoveredIndexes = recoverInterruptedGuildIndexes();
    if (recoveredIndexes > 0) console.log(`[MessageCleanup] 恢复 ${recoveredIndexes} 个被重启打断的全服索引。`);

    await tickMessageCleanup(client);
    timer = setInterval(() => {
        void tickMessageCleanup(client).catch(error => console.error('[MessageCleanup] 调度器异常：', error));
    }, TICK_MS);
    timer.unref?.();
    console.log('[MessageCleanup] ⏱️ 紧急消息清理调度器已启动。');
}
