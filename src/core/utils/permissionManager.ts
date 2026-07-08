// src/core/utils/permissionManager.ts
//
// 通用权限工具：判定“是否为管理员/是否拥有指定管理身份组”。
// 模块专用的权限判定请放到对应模块内，避免核心膨胀。

import { PermissionFlagsBits, type GuildMember } from 'discord.js';

// 配置允许使用管理指令的身份组ID
// TODO: 替换为你自己服务器的身份组ID
const ALLOWED_ROLE_IDS: string[] = [
    // '1234567890123456789', // 示例：总管理
];

// 配置允许使用管理指令的 Discord 原生权限
const ALLOWED_PERMISSIONS = [
    PermissionFlagsBits.Administrator,
];

export interface PermissionDetails {
    userId: string;
    userTag: string;
    isOwner: boolean;
    hasNativePermissions: boolean;
    userRoles: { name: string; id: string }[];
    userRoleIds: string[];
    allowedUserRoles: string[];
    allowedRolesList: string[];
    hasPermission: boolean;
    error?: string;
}

/**
 * 检查用户是否有权限使用管理指令。
 * 判定顺序：服务器所有者 → Discord 原生权限 → 配置的管理身份组。
 */
export function checkAdminPermission(member: GuildMember | null | undefined): boolean {
    try {
        if (!member || !member.user || !member.guild || !member.roles) {
            return false;
        }

        // 服务器所有者
        if (member.guild.ownerId === member.user.id) {
            return true;
        }

        // Discord 原生权限
        if (member.permissions) {
            for (const permission of ALLOWED_PERMISSIONS) {
                if (member.permissions.has(permission)) {
                    return true;
                }
            }
        }

        // 配置的管理身份组
        if (member.roles.cache) {
            for (const userRole of member.roles.cache.values()) {
                if (ALLOWED_ROLE_IDS.includes(userRole.id)) {
                    return true;
                }
            }
        }

        return false;
    } catch (error) {
        console.error('权限检查过程中出错:', error);
        return false;
    }
}

/**
 * 检查一组角色ID是否包含管理员角色。
 */
export function checkAdminByRoleIds(roleIds: string[] | null | undefined): boolean {
    if (!roleIds || !Array.isArray(roleIds)) return false;
    return roleIds.some(id => ALLOWED_ROLE_IDS.includes(id));
}

/**
 * 获取权限不足时的错误消息。
 */
export function getPermissionDeniedMessage(): string {
    return `❌ **权限不足**\n\n您没有权限使用此指令。\n\n**需要以下权限之一：**\n• 服务器所有者\n• 管理员权限\n• 指定管理身份组之一\n\n请联系服务器管理员获取相应权限。`;
}

/**
 * 获取允许的身份组ID列表（副本）。
 */
export function getAllowedRoles(): string[] {
    return [...ALLOWED_ROLE_IDS];
}

/**
 * 获取允许的权限列表（副本）。
 */
export function getAllowedPermissions(): bigint[] {
    return [...ALLOWED_PERMISSIONS];
}

/**
 * 获取用户权限详情（用于调试指令 /调试-调试权限）。
 */
export function getUserPermissionDetails(member: GuildMember): PermissionDetails {
    try {
        const userRoles: { name: string; id: string }[] = [];
        const userRoleIds: string[] = [];

        if (member.roles && member.roles.cache) {
            member.roles.cache.forEach(role => {
                userRoles.push({ name: role.name, id: role.id });
                userRoleIds.push(role.id);
            });
        }

        let hasNativePermissions = false;
        if (member.permissions) {
            hasNativePermissions = ALLOWED_PERMISSIONS.some(permission =>
                member.permissions.has(permission)
            );
        }

        const allowedUserRoles = userRoleIds.filter(roleId =>
            ALLOWED_ROLE_IDS.includes(roleId)
        );

        return {
            userId: member.user ? member.user.id : 'unknown',
            userTag: member.user ? member.user.tag : 'unknown',
            isOwner: member.guild ? (member.guild.ownerId === member.user.id) : false,
            hasNativePermissions,
            userRoles,
            userRoleIds,
            allowedUserRoles,
            allowedRolesList: [...ALLOWED_ROLE_IDS],
            hasPermission: checkAdminPermission(member),
        };
    } catch (error) {
        console.error('获取用户权限详情时出错:', error);
        return {
            userId: 'error',
            userTag: 'error',
            isOwner: false,
            hasNativePermissions: false,
            userRoles: [],
            userRoleIds: [],
            allowedUserRoles: [],
            allowedRolesList: [...ALLOWED_ROLE_IDS],
            hasPermission: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export { ALLOWED_ROLE_IDS, ALLOWED_PERMISSIONS };
