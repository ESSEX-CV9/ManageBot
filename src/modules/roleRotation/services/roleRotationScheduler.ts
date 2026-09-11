import type { Client, GuildMember, PartialGuildMember } from 'discord.js';
import {
    addAudit,
    listConfigs,
    listRoundsByStatus,
    syncMember,
    updateConfig,
} from './roleRotationDatabase';
import {
    ensureRecruitmentMessages,
    settleInquiry,
    startInquiry,
    syncRoleMembers,
} from './roleRotationService';
import { computeNextMonthlyRun, cycleKeyFor } from './rotationTime';

const parsedTickMs = Number(process.env.ROLE_ROTATION_TICK_MS);
const TICK_MS = Number.isFinite(parsedTickMs) && parsedTickMs >= 5_000 ? parsedTickMs : 30_000;
const RETRY_MS = 5 * 60_000;
const RECRUIT_REFRESH_MS = 5 * 60_000;

let timer: NodeJS.Timeout | null = null;
let ticking = false;
const retryAfter = new Map<string, number>();
const recruitRefreshAfter = new Map<number, number>();

async function initialMemberSync(client: Client): Promise<void> {
    for (const guild of client.guilds.cache.values()) {
        const configs = listConfigs(guild.id);
        if (!configs.length) continue;
        await guild.members.fetch().catch(error => {
            console.warn(`[RoleRotation] 启动时拉取 ${guild.name} 成员失败，将使用当前缓存：`, error);
        });
        for (const config of configs) {
            const role = guild.roles.cache.get(config.managedRoleId)
                ?? await guild.roles.fetch(config.managedRoleId).catch(() => null);
            if (role) syncRoleMembers(config, role);
        }
    }
}

export async function tickRoleRotation(client: Client): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
        const now = Date.now();

        // 先结算已到期问询，再考虑开启新的月度场次。
        for (const round of listRoundsByStatus(['inquiry'])) {
            if (round.inquiryDeadline > now) continue;
            const key = `settle:${round.id}`;
            if ((retryAfter.get(key) ?? 0) > now) continue;
            try {
                const result = await settleInquiry(client, round);
                if (!result.ok) retryAfter.set(key, now + RETRY_MS);
                else retryAfter.delete(key);
                console.log(`[RoleRotation] 问询 #${round.id} 到期结算：${result.message}`);
            } catch (error) {
                retryAfter.set(key, now + RETRY_MS);
                console.error(`[RoleRotation] 问询 #${round.id} 结算异常：`, error);
            }
        }

        for (const config of listConfigs(undefined, true)) {
            if (config.nextRunAt > now) continue;
            const key = `start:${config.id}`;
            if ((retryAfter.get(key) ?? 0) > now) continue;
            const cycleKey = cycleKeyFor(config.nextRunAt, config.timezone);
            try {
                const result = await startInquiry(client, config, { scheduledCycleKey: cycleKey });
                const cycleAlreadyExists = result.round?.cycleKey === cycleKey && result.round.status !== 'failed';
                if (result.ok || cycleAlreadyExists) {
                    updateConfig(config.id, {
                        nextRunAt: computeNextMonthlyRun(
                            config.scheduleDay,
                            config.scheduleTime,
                            config.timezone,
                            now + 1_000,
                        ),
                    });
                    retryAfter.delete(key);
                } else {
                    retryAfter.set(key, now + RETRY_MS);
                }
                console.log(`[RoleRotation] 配置 #${config.id} 月度问询：${result.message}`);
            } catch (error) {
                retryAfter.set(key, now + RETRY_MS);
                console.error(`[RoleRotation] 配置 #${config.id} 发起月度问询异常：`, error);
            }
        }

        // 补发缺失的招募频道消息，也会在实时人数已满时自动关停。
        for (const round of listRoundsByStatus(['recruiting'])) {
            if ((recruitRefreshAfter.get(round.id) ?? 0) > now) continue;
            recruitRefreshAfter.set(round.id, now + RECRUIT_REFRESH_MS);
            try {
                const result = await ensureRecruitmentMessages(client, round);
                if (!result.ok) console.warn(`[RoleRotation] 招募 #${round.id} 检查：${result.message}`);
            } catch (error) {
                console.error(`[RoleRotation] 招募 #${round.id} 刷新异常：`, error);
            }
        }
    } finally {
        ticking = false;
    }
}

export async function startRoleRotationScheduler(client: Client): Promise<void> {
    if (timer) return;
    await initialMemberSync(client);
    await tickRoleRotation(client).catch(error => console.error('[RoleRotation] 首次调度失败：', error));
    timer = setInterval(() => {
        void tickRoleRotation(client).catch(error => console.error('[RoleRotation] 调度器异常：', error));
    }, TICK_MS);
    timer.unref?.();
    console.log(`[RoleRotation] ⏱️ 调度器已启动（间隔 ${Math.round(TICK_MS / 1000)} 秒）。`);
}

/** 实时记录身份组成员变动；真正的人数判断仍以 Discord 当前角色成员为准。 */
export function handleRoleRotationMemberUpdate(oldMember: GuildMember | PartialGuildMember, newMember: GuildMember): void {
    for (const config of listConfigs(newMember.guild.id)) {
        const hasRole = newMember.roles.cache.has(config.managedRoleId);
        if (oldMember.partial) {
            syncMember(config.id, newMember.id, newMember.user.bot, hasRole);
            continue;
        }
        const hadRole = oldMember.roles.cache.has(config.managedRoleId);
        if (hadRole === hasRole) continue;
        syncMember(config.id, newMember.id, newMember.user.bot, hasRole);
        addAudit({
            guildId: newMember.guild.id,
            configId: config.id,
            userId: newMember.id,
            event: hasRole ? 'membership_added_detected' : 'membership_removed_detected',
            detail: 'Discord GuildMemberUpdate',
        });
    }
}

export function handleRoleRotationMemberRemove(member: GuildMember | PartialGuildMember): void {
    for (const config of listConfigs(member.guild.id)) {
        syncMember(config.id, member.id, member.user.bot, false);
        if (member.partial || !member.roles.cache.has(config.managedRoleId)) continue;
        addAudit({
            guildId: member.guild.id,
            configId: config.id,
            userId: member.id,
            event: 'membership_removed_detected',
            detail: 'GuildMemberRemove',
        });
    }
}
