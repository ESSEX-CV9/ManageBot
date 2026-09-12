import {
    MessageFlags,
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    type GuildMember,
} from 'discord.js';

import type { Command } from '../../../core/types';
import { openCleanupPanel } from '../components/messageCleanupPanel';
import { canManageCleanup } from '../services/messageCleanupPermissions';

const data = new SlashCommandBuilder()
    .setName('冲水')
    .setDescription('帮助用户紧急清理指定范围内的本人消息')
    .addSubcommand(subcommand => subcommand
        .setName('面板')
        .setDescription('打开紧急消息清理面板'));

const command: Command = {
    data,
    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
        if (!interaction.guildId || !interaction.guild) {
            await interaction.reply({ content: '❌ 这个命令只能在服务器中使用。', flags: MessageFlags.Ephemeral });
            return;
        }

        let member = interaction.member as GuildMember | null;
        if (!member?.roles?.cache) member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!canManageCleanup(interaction.guildId, member)) {
            await interaction.reply({
                content: '❌ 你没有使用冲水面板的权限。请让服主或管理员在面板中配置管理身份组。',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await openCleanupPanel(interaction);
    },
};

export default command;
