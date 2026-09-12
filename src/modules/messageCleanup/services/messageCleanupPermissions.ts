import type { GuildMember } from 'discord.js';

import { checkAdminPermission } from '../../../core/utils/permissionManager';
import { getSettings } from './messageCleanupDatabase';

export function canManageCleanup(guildId: string, member: GuildMember | null | undefined): boolean {
    if (!member) return false;
    if (checkAdminPermission(member)) return true;
    const roleIds = getSettings(guildId).manageRoleIds;
    return roleIds.length > 0 && member.roles.cache.hasAny(...roleIds);
}

export function canConfigureCleanup(member: GuildMember | null | undefined): boolean {
    return checkAdminPermission(member);
}
