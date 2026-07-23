// src/modules/election/services/electionScheduler.ts
//
// 募选后台调度器：周期扫描到点的场次，自动推进状态。
//   nominating 且过自荐截止 → openPublicity（进入公示期）
//   publicity  且过公示截止 → openVoting
//   voting     且过投票截止 → settleRound
// pending_confirm 不自动处理（等待管理员确认）。
//
// 用内存锁避免同一场次在异步处理期间被下一次 tick 重复推进。

import type { Client } from 'discord.js';
import { getCheckIntervals } from '../../../core/config/timeconfig';
import { listRoundsAll, getSettings } from './electionDatabase';
import { openPublicity, openVoting, settleRound } from './electionRunner';
import { syncPoolViaApi } from './poolSync';
import { isElectionTestMode } from './electionPermission';

let timer: NodeJS.Timeout | null = null;
const processing = new Set<number>();
const lastPoll = new Map<string, number>();
const MIN_POLL_MINUTES = 10;

/** 候选池定时自动拉取：仅对开启了轮询的服务器，按各自间隔同步。 */
async function pollPools(client: Client): Promise<void> {
    if (isElectionTestMode()) return; // 测试模式下不自动拉取，避免覆盖注入的候选池
    const now = Date.now();
    for (const guild of client.guilds.cache.values()) {
        const s = getSettings(guild.id);
        if (!s.pollEnabled) continue;
        const intervalMs = Math.max(MIN_POLL_MINUTES, s.pollIntervalMinutes) * 60_000;
        if (now - (lastPoll.get(guild.id) ?? 0) < intervalMs) continue;
        lastPoll.set(guild.id, now); // 先占位，失败也等下个周期再试，避免频繁重试
        try {
            const r = await syncPoolViaApi(guild.id);
            if (r.ok) console.log(`[Election] 定时同步候选池 ${guild.name}：${r.message}`);
            else console.warn(`[Election] 定时同步候选池 ${guild.name} 跳过：${r.message}`);
        } catch (err) {
            console.error(`[Election] 定时同步候选池 ${guild.name} 出错：`, err);
        }
    }
}

async function tick(client: Client): Promise<void> {
    const now = Date.now();

    for (const round of listRoundsAll(['nominating'])) {
        if (now < round.nominateDeadline || processing.has(round.id)) continue;
        processing.add(round.id);
        try {
            const r = await openPublicity(client, round);
            console.log(`[Election] 场次 #${round.id} 自荐截止 → 公示期：${r.message}`);
        } catch (err) {
            console.error(`[Election] 场次 #${round.id} 进公示期出错：`, err);
        } finally {
            processing.delete(round.id);
        }
    }

    for (const round of listRoundsAll(['publicity'])) {
        if (now < round.publicityDeadline || processing.has(round.id)) continue;
        processing.add(round.id);
        try {
            const r = await openVoting(client, round);
            console.log(`[Election] 场次 #${round.id} 公示截止 → 开投票：${r.message}`);
        } catch (err) {
            console.error(`[Election] 场次 #${round.id} 开投票出错：`, err);
        } finally {
            processing.delete(round.id);
        }
    }

    for (const round of listRoundsAll(['voting'])) {
        if (now < round.voteDeadline || processing.has(round.id)) continue;
        processing.add(round.id);
        try {
            const r = await settleRound(client, round);
            console.log(`[Election] 场次 #${round.id} 投票截止 → 结算：${r.message}`);
        } catch (err) {
            console.error(`[Election] 场次 #${round.id} 结算出错：`, err);
        } finally {
            processing.delete(round.id);
        }
    }
}

/** 启动募选调度器（clientReady 后调用）。 */
export function startElectionScheduler(client: Client): void {
    if (timer) return;
    const intervalMs = getCheckIntervals().electionCheck;
    timer = setInterval(() => {
        tick(client).catch(err => console.error('[Election] 调度器 tick 出错：', err));
        pollPools(client).catch(err => console.error('[Election] 候选池轮询出错：', err));
    }, intervalMs);
    timer.unref?.();
    console.log(`[Election] ⏱️ 调度器已启动（间隔 ${Math.round(intervalMs / 1000)} 秒）。`);
}
