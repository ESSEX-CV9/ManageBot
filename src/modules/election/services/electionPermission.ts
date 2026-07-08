// src/modules/election/services/electionPermission.ts
//
// 募选模块的权限判定。
// 本服管理靠身份组而非原生 admin，所以「谁能管理募选」由配置的 manageRoleIds 决定；
// 同时仍兼容核心的管理员判定（服主 / 原生管理员权限）。

import type { GuildMember } from 'discord.js';
import { checkAdminPermission } from '../../../core/utils/permissionManager';
import { getSettings } from './electionDatabase';

/** 是否有权管理募选（发起/配置/导入等）。 */
export function canManageElection(guildId: string, member: GuildMember | null | undefined): boolean {
    if (!member) return false;
    if (checkAdminPermission(member)) return true; // 服主 / 原生管理员
    const { manageRoleIds } = getSettings(guildId);
    if (!manageRoleIds.length) return false;
    return member.roles.cache.hasAny(...manageRoleIds);
}

/** 成员是否拥有给定身份组之一（用于投票资格校验）。 */
export function hasAnyRole(member: GuildMember | null | undefined, roleIds: string[]): boolean {
    if (!member || !roleIds.length) return false;
    return member.roles.cache.hasAny(...roleIds);
}

/** 募选测试模式是否开启（.env 的 ELECTION_TEST_MODE=true）。仅测试服使用。 */
export function isElectionTestMode(): boolean {
    return String(process.env.ELECTION_TEST_MODE || '').toLowerCase() === 'true';
}
