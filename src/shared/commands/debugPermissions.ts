// src/shared/commands/debugPermissions.ts

import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getUserPermissionDetails } from '../../core/utils/permissionManager';
import type { Command } from '../../core/types';

const data = new SlashCommandBuilder()
    .setName('调试-调试权限')
    .setDescription('调试权限信息（仅用于测试）')
    .addUserOption(option =>
        option.setName('用户')
            .setDescription('要检查权限的用户（不填则检查自己）')
            .setRequired(false));

const command: Command = {
    data,
    async execute(interaction) {
        try {
            if (!interaction.guild) {
                return interaction.reply({
                    content: '❌ 此指令只能在服务器中使用。',
                    flags: MessageFlags.Ephemeral,
                });
            }

            const targetUser = interaction.options.getUser('用户') || interaction.user;
            console.log(`开始调试用户权限: ${targetUser.tag} (${targetUser.id})`);

            let targetMember;
            try {
                targetMember = await interaction.guild.members.fetch(targetUser.id);
            } catch (fetchError) {
                console.error('获取成员信息失败:', fetchError);
                return interaction.reply({
                    content: `❌ 无法获取用户 ${targetUser.tag} 的成员信息。`,
                    flags: MessageFlags.Ephemeral,
                });
            }

            const permissionDetails = getUserPermissionDetails(targetMember);
            console.log('权限详情:', permissionDetails);

            const safeUserRoles = permissionDetails.userRoles || [];
            const safeAllowedUserRoles = permissionDetails.allowedUserRoles || [];
            const safeAllowedRolesList = permissionDetails.allowedRolesList || [];

            const debugInfo = `**🔍 权限调试信息**\n\n` +
                `**用户：** ${permissionDetails.userTag || '未知'} (${permissionDetails.userId || '未知'})\n` +
                `**是否为服务器所有者：** ${permissionDetails.isOwner ? '✅ 是' : '❌ 否'}\n` +
                `**是否有原生权限：** ${permissionDetails.hasNativePermissions ? '✅ 是' : '❌ 否'}\n` +
                `**最终权限结果：** ${permissionDetails.hasPermission ? '✅ 有权限' : '❌ 无权限'}\n\n` +
                `**用户所有身份组（${safeUserRoles.length}个）：**\n${safeUserRoles.length > 0 ? safeUserRoles.map(r => `• \`${r.name}\` (${r.id})`).join('\n') : '• 无身份组'}\n\n` +
                `**匹配的允许身份组ID（${safeAllowedUserRoles.length}个）：**\n${safeAllowedUserRoles.length > 0 ? safeAllowedUserRoles.map(id => `• \`${id}\``).join('\n') : '• 无匹配'}\n\n` +
                `**系统允许的身份组ID（${safeAllowedRolesList.length}个）：**\n${safeAllowedRolesList.length > 0 ? safeAllowedRolesList.map(id => `• \`${id}\``).join('\n') : '• （未配置）'}`;

            await interaction.reply({
                content: debugInfo,
                flags: MessageFlags.Ephemeral,
            });
        } catch (error) {
            console.error('调试权限时出错:', error);
            await interaction.reply({
                content: `❌ 调试权限时出错: ${error instanceof Error ? error.message : String(error)}\n请查看控制台获取详细信息。`,
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};

export default command;
