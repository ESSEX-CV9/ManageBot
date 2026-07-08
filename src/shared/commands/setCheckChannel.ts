// src/shared/commands/setCheckChannel.ts

import { SlashCommandBuilder, MessageFlags, ChannelType, type GuildMember, type TextChannel } from 'discord.js';
import { saveCheckChannelSettings } from '../../core/utils/database';
import { checkAdminPermission, getPermissionDeniedMessage } from '../../core/utils/permissionManager';
import type { Command } from '../../core/types';

const data = new SlashCommandBuilder()
    .setName('调试-设置检查报告频道')
    .setDescription('设置过期提案检查报告发送频道')
    .addChannelOption(option =>
        option.setName('频道')
            .setDescription('接收过期提案检查报告的频道')
            .setRequired(true))
    .addBooleanOption(option =>
        option.setName('启用')
            .setDescription('是否启用检查报告（默认启用）')
            .setRequired(false));

const command: Command = {
    data,
    async execute(interaction) {
        try {
            if (!interaction.guild) {
                return interaction.reply({
                    content: '❌ 此指令只能在服务器中使用，不能在私信中使用。',
                    flags: MessageFlags.Ephemeral,
                });
            }

            const hasPermission = checkAdminPermission(interaction.member as GuildMember | null);
            if (!hasPermission) {
                return interaction.reply({
                    content: getPermissionDeniedMessage(),
                    flags: MessageFlags.Ephemeral,
                });
            }

            // 立即 defer 以防止超时
            await interaction.deferReply({ ephemeral: true });

            const targetChannel = interaction.options.getChannel('频道', true);
            const enabled = interaction.options.getBoolean('启用') ?? true;

            // 验证频道类型
            if (targetChannel.type !== ChannelType.GuildText) {
                return interaction.editReply({ content: '❌ 目标频道必须是文字频道。' });
            }
            const textChannel = targetChannel as TextChannel;

            // 检查机器人在目标频道的权限
            const botMember = interaction.guild.members.me;
            if (!botMember) {
                return interaction.editReply({ content: '❌ 无法获取机器人成员信息。' });
            }
            const channelPermissions = textChannel.permissionsFor(botMember);

            if (!channelPermissions || !channelPermissions.has('SendMessages')) {
                return interaction.editReply({
                    content: `❌ 机器人在目标频道 ${textChannel} 没有发送消息的权限。`,
                });
            }
            if (!channelPermissions.has('EmbedLinks')) {
                return interaction.editReply({
                    content: `❌ 机器人在目标频道 ${textChannel} 没有嵌入链接的权限。`,
                });
            }

            console.log('设置检查报告频道...');
            console.log('Guild ID:', interaction.guild.id);
            console.log('Check Channel:', textChannel.name, textChannel.id);
            console.log('Enabled:', enabled);
            console.log('操作者:', interaction.user.tag, interaction.user.id);

            await saveCheckChannelSettings(interaction.guild.id, {
                guildId: interaction.guild.id,
                checkChannelId: textChannel.id,
                enabled,
                setupBy: interaction.user.id,
                timestamp: new Date().toISOString(),
            });

            // 发送测试消息验证设置
            try {
                const testMessage = await textChannel.send({
                    content: `📊 **过期提案检查报告频道设置完成**\n\n由 <@${interaction.user.id}> 设置\n设置时间: <t:${Math.floor(Date.now() / 1000)}:f>\n\n此频道将接收定期的过期提案检查报告。`,
                });

                await interaction.editReply({
                    content: `✅ **检查报告频道设置完成！**\n\n**配置信息：**\n• **报告频道：** ${textChannel}\n• **状态：** ${enabled ? '✅ 启用' : '❌ 禁用'}\n• **测试消息ID：** \`${testMessage.id}\`\n\n系统现在会将过期提案检查报告发送到指定频道。`,
                });
            } catch (sendError) {
                console.error('发送测试消息失败:', sendError);
                return interaction.editReply({
                    content: `❌ 设置保存成功，但发送测试消息失败。请检查机器人权限。错误信息：${sendError instanceof Error ? sendError.message : String(sendError)}`,
                });
            }

            console.log(`检查报告频道设置完成 - 频道: ${textChannel.name}, 操作者: ${interaction.user.tag}`);
        } catch (error) {
            console.error('设置检查报告频道时出错:', error);
            const msg = error instanceof Error ? error.message : String(error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: `❌ 设置检查报告频道时出错：${msg}\n请查看控制台获取详细信息。`,
                        flags: MessageFlags.Ephemeral,
                    });
                } else {
                    await interaction.editReply({
                        content: `❌ 设置检查报告频道时出错：${msg}\n请查看控制台获取详细信息。`,
                    });
                }
            } catch (replyError) {
                console.error('回复错误信息失败:', replyError);
            }
        }
    },
};

export default command;
