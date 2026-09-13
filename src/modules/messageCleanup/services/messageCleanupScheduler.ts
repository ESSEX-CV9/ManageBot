import type { Client } from 'discord.js';

import {
    claimJob,
    completeJobListClear,
    hasOpenedThreadsForGuild,
    listJobListClearRequests,
    listRunnableJobs,
    recoverInterruptedJobs,
} from './messageCleanupDatabase';
import { executeCleanupJob, restoreDanglingArchivedThreads } from './messageCleanupService';

const TICK_MS = 2_000;
let timer: NodeJS.Timeout | null = null;
let ticking = false;
const runningGuildIds = new Set<string>();

export async function tickMessageCleanup(client: Client): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
        await restoreDanglingArchivedThreads(client, runningGuildIds);
        for (const request of listJobListClearRequests()) {
            if (runningGuildIds.has(request.guildId)) continue;
            if (hasOpenedThreadsForGuild(request.guildId)) continue;
            completeJobListClear(request);
        }
        for (const pending of listRunnableJobs()) {
            if (runningGuildIds.has(pending.guildId)) continue;
            const claimed = claimJob(pending.id);
            if (!claimed) continue;

            runningGuildIds.add(claimed.guildId);
            void executeCleanupJob(client, claimed).finally(() => {
                runningGuildIds.delete(claimed.guildId);
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

    await tickMessageCleanup(client);
    timer = setInterval(() => {
        void tickMessageCleanup(client).catch(error => console.error('[MessageCleanup] 调度器异常：', error));
    }, TICK_MS);
    timer.unref?.();
    console.log('[MessageCleanup] ⏱️ 紧急消息清理调度器已启动。');
}
