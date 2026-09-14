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
    listFrogCallerRoleIds,
    releaseFrogCall,
} from '../services/roleRotationDatabase';

const data = new SlashCommandBuilder()
    .setName('呼唤蛙人')
    .setDescription('由蛙人身份组成员呼叫整个蛙人身份组');

const command: Command = {
    data,
    async execute(interaction) {
        // 身份组不在缓存时会访问 Discord REST；先确认交互，避免查询排队导致过期。
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (!interaction.guild || !interaction.guildId) {
            return interaction.editReply({ content: '❌ 此命令只能在服务器中使用。' });
        }
        const frogSettings = getFrogSettings(interaction.guildId);
        const roleId = frogSettings.roleId;
        if (!roleId) {
            return interaction.editReply({ content: '⚠️ 管理员尚未配置蛙人身份组。' });
        }
        const role = interaction.guild.roles.cache.get(roleId)
            ?? await interaction.guild.roles.fetch(roleId).catch(() => null);
        if (!role) {
            return interaction.editReply({ content: '⚠️ 已配置的蛙人身份组不存在，请管理员重新设置。' });
        }
        const member = interaction.member as GuildMember | null;
        const callerRoleIds = listFrogCallerRoleIds(interaction.guildId);
        const mayCall = member?.roles.cache.has(roleId)
            || callerRoleIds.some(allowedRoleId => member?.roles.cache.has(allowedRoleId));
        if (!mayCall) {
            return interaction.editReply({
                content: '❌ 你没有使用此指令的身份组。',
            });
        }
        if (!role.mentionable && !interaction.appPermissions?.has(PermissionFlagsBits.MentionEveryone)) {
            return interaction.editReply({
                content: '❌ 机器人缺少“提及 @everyone、@here 和所有身份组”权限，暂时无法呼叫蛙人。',
            });
        }

        const channel = interaction.channel;
        if (!channel?.isSendable()) {
            return interaction.editReply({ content: '❌ 当前频道无法发送蛙人呼叫。' });
        }

        const claim = claimFrogCall(
            interaction.guildId,
            interaction.user.id,
            frogSettings.cooldownSeconds,
        );
        if (!claim.allowed) {
            const remaining = Math.max(1, Math.ceil((claim.retryAt - Date.now()) / 1000));
            return interaction.editReply({
                content: `⏳ 呼唤冷却中，请等待 ${remaining} 秒后再试。`,
            });
        }

        try {
            await channel.send({
                content: `🐸 <@&${roleId}> 集合！\n由 <@${interaction.user.id}> 发起呼叫。`,
                allowedMentions: { roles: [roleId], users: [], repliedUser: false },
            });
        } catch (error) {
            releaseFrogCall(interaction.guildId, interaction.user.id, claim.claimedAt);
            console.warn(`[RoleRotation] 呼唤蛙人发送失败 guild=${interaction.guildId} channel=${interaction.channelId}:`, error);
            return interaction.editReply({ content: '❌ 呼唤发送失败，请检查机器人在当前频道的发言和身份组提及权限。' });
        }
        addAudit({
            guildId: interaction.guildId,
            actorId: interaction.user.id,
            userId: interaction.user.id,
            event: 'frog_called',
            detail: `role=${roleId}; channel=${interaction.channelId}; cooldown=${frogSettings.cooldownSeconds}`,
        });
        return interaction.editReply({ content: '✅ 已在当前频道呼唤蛙人。' });
    },
};

export default command;
