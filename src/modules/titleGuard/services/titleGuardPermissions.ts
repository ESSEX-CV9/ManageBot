// src/modules/titleGuard/services/titleGuardPermissions.ts
//
// 谁能干什么。
//
// 「社区管理组」不是一个身份组，是一堆——风纪委员、执行管理、各版块的负责人，
// 各自管的事情不一样。所以这里不判「是不是管理员」，而是判「有没有这项能力」，
// 由管理组自己在线上把能力发给对应的身份组。
//
// 三条兜底规矩，缺一不可：
//   1. 服主和带 Discord 管理员权限的人**永远全通**——配错了也不至于把自己锁在门外。
//   2. 某项能力**一个身份组都没配** = 回退到原来的管理员判定。
//      不是「谁都不能用」（那等于上线即瘫痪），也不是「谁都能用」（那等于没有权限）。
//   3. 「接警」还要并上老的接警身份组设置，免得已经配好的服务器升级后突然 @ 不到人。

import type { Guild, GuildMember } from 'discord.js';

import { checkAdminPermission } from '../../../core/utils/permissionManager';
import * as db from './titleGuardDatabase';

export type GuardCapability = '复核' | '覆盖' | '词表' | '设置' | '接警';

export const CAPABILITIES: readonly GuardCapability[] = ['复核', '覆盖', '词表', '设置', '接警'];

/** 每项能力到底管什么，给配置面板和指令选项用 */
export const CAPABILITY_HINT: Record<GuardCapability, string> = {
    复核: '处理升上来的申诉：驳回或放行',
    覆盖: '通知上那个直接放行的按钮',
    词表: '改词典、互斥关系、优先级、分词词库',
    设置: '总开关、自动整改、宽限时长、论坛纳管',
    接警: '出事时 @ 谁（不含任何操作权限）',
};

export function isCapability(value: string): value is GuardCapability {
    return (CAPABILITIES as readonly string[]).includes(value);
}

/** 配了这项能力的身份组。空数组 = 没配过 */
export function rolesWithCapability(guildId: string, capability: GuardCapability): string[] {
    const configured = db.listRolesWithCapability(guildId, capability);
    if (capability !== '接警') return configured;

    // 老的「接警身份组」设置并进来，升级不掉人
    const legacy = db.getSettings(guildId).alertRoleIds;
    return [...new Set([...configured, ...legacy])];
}

/**
 * 这个人有没有这项能力。
 *
 * 注意 capability 没配任何身份组时会回退到管理员判定——
 * 也就是说「没配」等于「维持升级前的行为」，而不是把功能关掉。
 */
export function hasCapability(
    member: GuildMember | null | undefined,
    guildId: string,
    capability: GuardCapability,
): boolean {
    if (!member) return false;

    // 服主 / Discord 管理员永远全通，防止配错了锁死
    if (checkAdminPermission(member)) return true;

    const roles = rolesWithCapability(guildId, capability);
    if (roles.length === 0) return false; // 没配 → 上面的管理员判定已经是最终答案

    return member.roles.cache.some(r => roles.includes(r.id));
}

/** 这项能力配过身份组没有。没配的话面板要提示「当前仅管理员可用」 */
export function isCapabilityConfigured(guildId: string, capability: GuardCapability): boolean {
    return rolesWithCapability(guildId, capability).length > 0;
}

/** 拼 @ 提及串。只 @ 服务器里确实还存在的身份组，免得留一串死链接 */
export function capabilityMentions(guild: Guild, capability: GuardCapability): string {
    const roles = rolesWithCapability(guild.id, capability)
        .filter(id => guild.roles.cache.has(id));
    return roles.map(id => `<@&${id}>`).join(' ');
}

/**
 * 该 @ 谁来处理申诉。
 * 优先 @ 有「复核」能力的；没配就退回「接警」这一组，
 * 再没有就返回空串，调用方改发到接警频道。
 */
export function reviewerMentions(guild: Guild): string {
    return capabilityMentions(guild, '复核') || capabilityMentions(guild, '接警');
}
