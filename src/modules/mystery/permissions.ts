import { GuildMember } from 'discord.js';
import { checkAdminPermission as checkManageBotAdmin, getPermissionDeniedMessage } from '../../core/utils/permissionManager';

// Source main's management roles, scoped only to mystery features.
const originalRoleIds = Object.freeze([
    '1511670629055725829',
    '1385066450829705226',
    '1490573263443853517',
    '1337450755791261766',
]);

export function getMysteryAdminRoleIds(): readonly string[] {
    const configured = process.env.MYSTERY_ADMIN_ROLE_IDS;
    if (configured === undefined) return originalRoleIds;
    const ids = [...new Set(configured.split(',').map(id => id.trim()).filter(Boolean))];
    if (ids.some(id => !/^\d{17,20}$/.test(id))) {
        throw new Error('MYSTERY_ADMIN_ROLE_IDS 必须为逗号分隔的身份组 ID；留空可禁用来源角色。');
    }
    return ids;
}

export function checkAdminPermission(member: unknown): boolean {
    // Raw API interaction members lack authoritative guild/user/role caches.
    // The adapter fetches them; never trust an array of caller-supplied role IDs.
    if (!(member instanceof GuildMember)) return false;
    if (checkManageBotAdmin(member)) return true;
    return getMysteryAdminRoleIds().some(id => member.roles.cache.has(id));
}

export { getPermissionDeniedMessage };
