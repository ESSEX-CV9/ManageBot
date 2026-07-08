// src/modules/template/commands/templateCommand.ts
//
// 模版模块的斜杠命令示例。
// 每个命令文件默认导出一个满足 Command 接口的对象：{ data, execute }。
// 在 src/core/index.ts 中 import 本文件并 client.commands.set(data.name, command) 即完成接入。

import { SlashCommandBuilder, MessageFlags, type GuildMember } from 'discord.js';
import { checkAdminPermission, getPermissionDeniedMessage } from '../../../core/utils/permissionManager';
import { buildTemplatePanel } from '../components/templateComponents';
import { getCounter } from '../services/templateDatabase';
import type { Command } from '../../../core/types';

const data = new SlashCommandBuilder()
    .setName('模版')
    .setDescription('模版模块示例命令')
    .addSubcommand(sub =>
        sub.setName('面板')
            .setDescription('（管理员）在当前频道发送一个示例交互面板'))
    .addSubcommand(sub =>
        sub.setName('我的计数')
            .setDescription('查看你自己的计数与备注'));

const command: Command = {
    data,
    async execute(interaction) {
        // 只能在服务器内使用
        if (!interaction.guild) {
            return interaction.reply({
                content: '❌ 此命令只能在服务器中使用。',
                flags: MessageFlags.Ephemeral,
            });
        }

        const sub = interaction.options.getSubcommand();

        if (sub === '面板') {
            // 发送面板属于管理操作，做一次权限校验（演示核心权限工具的用法）
            if (!checkAdminPermission(interaction.member as GuildMember | null)) {
                return interaction.reply({
                    content: getPermissionDeniedMessage(),
                    flags: MessageFlags.Ephemeral,
                });
            }

            // 面板需要是公开消息，这样其他人才能点击按钮
            if (!interaction.channel || !interaction.channel.isSendable()) {
                return interaction.reply({
                    content: '❌ 当前频道无法发送消息。',
                    flags: MessageFlags.Ephemeral,
                });
            }

            await interaction.channel.send(buildTemplatePanel());
            return interaction.reply({
                content: '✅ 已在当前频道发送示例面板。',
                flags: MessageFlags.Ephemeral,
            });
        }

        if (sub === '我的计数') {
            const record = getCounter(interaction.guild.id, interaction.user.id);
            if (!record) {
                return interaction.reply({
                    content: '你还没有任何计数记录，去面板点一下 `➕ 计数 +1` 吧。',
                    flags: MessageFlags.Ephemeral,
                });
            }
            return interaction.reply({
                content:
                    `📊 **你的记录**\n` +
                    `• 计数：**${record.count}**\n` +
                    `• 备注：${record.note ? record.note : '（无）'}`,
                flags: MessageFlags.Ephemeral,
            });
        }
    },
};

export default command;
