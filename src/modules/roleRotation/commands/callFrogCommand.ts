import {
    MessageFlags,
    PermissionFlagsBits,
    SlashCommandBuilder,
    type GuildMember,
} from 'discord.js';
import type { Command } from '../../../core/types';
import {
    addAudit,
    claimFrogCall,
    getFrogSettings,
    releaseFrogCall,
} from '../services/roleRotationDatabase';

const data = new SlashCommandBuilder()
    .setName('呼唤蛙人')
    .setDescription('由蛙人身份组成员呼叫整个蛙人身份组');

const command: Command = {
    data,
    async execute(interaction) {
        if (!interaction.guild || !interaction.guildId) {
            return interaction.reply({ content: '❌ 此命令只能在服务器中使用。', flags: MessageFlags.Ephemeral });
        }
        const frogSettings = getFrogSettings(interaction.guildId);
        const roleId = frogSettings.roleId;
        if (!roleId) {
            return interaction.reply({ content: '⚠️ 管理员尚未配置蛙人身份组。', flags: MessageFlags.Ephemeral });
        }
        const role = interaction.guild.roles.cache.get(roleId)
            ?? await interaction.guild.roles.fetch(roleId).catch(() => null);
        if (!role) {
            return interaction.reply({ content: '⚠️ 已配置的蛙人身份组不存在，请管理员重新设置。', flags: MessageFlags.Ephemeral });
        }
        const member = interaction.member as GuildMember | null;
        if (!member?.roles.cache.has(roleId)) {
            return interaction.reply({ content: '❌ 只有蛙人身份组成员才能使用此指令。', flags: MessageFlags.Ephemeral });
        }
        if (!role.mentionable && !interaction.appPermissions?.has(PermissionFlagsBits.MentionEveryone)) {
            return interaction.reply({
                content: '❌ 机器人缺少“提及 @everyone、@here 和所有身份组”权限，暂时无法呼叫蛙人。',
                flags: MessageFlags.Ephemeral,
            });
        }

        const claim = claimFrogCall(
            interaction.guildId,
            interaction.user.id,
            frogSettings.cooldownSeconds,
        );
        if (!claim.allowed) {
            const remaining = Math.max(1, Math.ceil((claim.retryAt - Date.now()) / 1000));
            return interaction.reply({
                content: `⏳ 呼唤冷却中，请等待 ${remaining} 秒后再试。`,
                flags: MessageFlags.Ephemeral,
            });
        }

        try {
            await interaction.reply({
                content: `🐸 <@&${roleId}> 集合！\n由 <@${interaction.user.id}> 发起呼叫。`,
                allowedMentions: { roles: [roleId], users: [], repliedUser: false },
            });
        } catch (error) {
            releaseFrogCall(interaction.guildId, interaction.user.id, claim.claimedAt);
            throw error;
        }
        addAudit({
            guildId: interaction.guildId,
            actorId: interaction.user.id,
            userId: interaction.user.id,
            event: 'frog_called',
            detail: `role=${roleId}; channel=${interaction.channelId}; cooldown=${frogSettings.cooldownSeconds}`,
        });
    },
};

export default command;
