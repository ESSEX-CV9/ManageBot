import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { getConfigById } from '../services/roleRotationDatabase';
import {
    confirmApplication,
    previewApplication,
    submitInquiryResponse,
} from '../services/roleRotationService';
import { buildApplicationConfirmation, ROTATION_IDS } from './rotationMessages';

function readRoundId(customId: string, prefix: string): number | null {
    if (!customId.startsWith(prefix)) return null;
    const raw = customId.slice(prefix.length);
    return /^\d+$/.test(raw) ? Number(raw) : null;
}

function readableDmContent(interaction: ButtonInteraction, content: string): string {
    return content
        .replace(/<@&(\d+)>/g, (_, id: string) => `@${interaction.guild?.roles.cache.get(id)?.name ?? `身份组 ${id}`}`)
        .replace(/<@(\d+)>/g, (_, id: string) => {
            const member = interaction.guild?.members.cache.get(id);
            return `@${member?.displayName ?? (id === interaction.user.id ? interaction.user.username : id)}`;
        })
        .replace(/<#(\d+)>/g, (_, id: string) => `#${interaction.guild?.channels.cache.get(id)?.name ?? id}`);
}

/**
 * 仅本人可见提示仍是主反馈；DM 是额外副本，解决繁忙频道里交互提示离原面板太远的问题。
 * 用户关闭私信时静默跳过，不把 DM 失败变成业务失败。
 */
async function trySendDmNotice(interaction: ButtonInteraction, content: string): Promise<void> {
    const location = interaction.guildId && interaction.channelId
        ? `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}`
        : null;
    const message = [
        `**${interaction.guild?.name ?? 'Discord 服务器'}｜分管轮替通知**`,
        readableDmContent(interaction, content),
        location ? `原频道：${location}` : null,
    ].filter(Boolean).join('\n');
    await interaction.user.send({ content: message, allowedMentions: { parse: [] } }).catch(() => undefined);
}

export async function handleRoleRotationButton(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.guildId) {
        await interaction.reply({ content: '该功能只能在服务器中使用。', flags: MessageFlags.Ephemeral });
        return;
    }

    for (const [prefix, response] of [
        [ROTATION_IDS.KEEP, 'keep'],
        [ROTATION_IDS.LEAVE, 'leave'],
    ] as const) {
        const roundId = readRoundId(interaction.customId, prefix);
        if (roundId !== null) {
            // 回答要先落库，失败提示又必须仅本人可见，因此先私密确认交互；
            // 成功后再单独向当前频道发布公开确认。
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const result = submitInquiryResponse(interaction.guildId, roundId, interaction.user.id, response);
            if (!result.ok || !result.round) {
                const failure = `⚠️ ${result.message}`;
                await interaction.editReply({
                    content: failure,
                    allowedMentions: { parse: [] },
                });
                await trySendDmNotice(interaction, failure);
                return;
            }
            const publicContent = response === 'keep'
                ? `✅ <@${interaction.user.id}> 已确认继续担任 <@&${result.round.roleId}>。`
                : `👋 <@${interaction.user.id}> 已确认不再担任 <@&${result.round.roleId}>，将在本轮结束时卸任。`;
            if (interaction.channel?.isSendable()) {
                try {
                    await interaction.channel.send({
                        content: publicContent,
                        allowedMentions: { users: [interaction.user.id], roles: [], repliedUser: false },
                    });
                    await interaction.editReply({
                        content: '✅ 你的选择已记录，并已在当前频道公开确认。',
                        allowedMentions: { parse: [] },
                    });
                } catch (error) {
                    console.warn(`[RoleRotation] 留任回答已记录但公开通知发送失败 round=${roundId}:`, error);
                    const warning = '✅ 你的选择已记录，但公开确认发送失败，请联系管理员检查频道权限。';
                    await interaction.editReply({ content: warning, allowedMentions: { parse: [] } });
                    await trySendDmNotice(interaction, warning);
                }
            } else {
                const warning = '✅ 你的选择已记录，但当前频道无法发送公开确认。';
                await interaction.editReply({ content: warning, allowedMentions: { parse: [] } });
                await trySendDmNotice(interaction, warning);
            }
            return;
        }
    }

    const applyRoundId = readRoundId(interaction.customId, ROTATION_IDS.APPLY);
    if (applyRoundId !== null) {
        // 资格检查可能触发服务器、成员或身份组 REST 请求，必须在检查前确认交互。
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await previewApplication(
            interaction.client,
            interaction.guildId,
            applyRoundId,
            interaction.user.id,
        );
        if (!result.ok || !result.round || !result.config) {
            const failure = `⚠️ ${result.message}`;
            await interaction.editReply({
                content: failure,
                allowedMentions: { parse: [] },
            });
            await trySendDmNotice(interaction, failure);
            return;
        }
        await interaction.editReply({
            ...buildApplicationConfirmation(result.config, result.round),
        });
        return;
    }

    const confirmRoundId = readRoundId(interaction.customId, ROTATION_IDS.CONFIRM);
    if (confirmRoundId !== null) {
        await interaction.deferUpdate();
        const result = await confirmApplication(
            interaction.client,
            interaction.guildId,
            confirmRoundId,
            interaction.user.id,
        );
        const config = result.round ? getConfigById(result.round.configId) : null;
        await interaction.editReply({
            content: result.ok ? '✅ 申请成功，结果已在当前频道公开。' : `⚠️ ${result.message}`,
            components: [],
            allowedMentions: { parse: [] },
        });
        if (!result.ok) {
            await trySendDmNotice(interaction, `⚠️ ${result.message}`);
        }
        if (result.ok && config && interaction.channel?.isSendable()) {
            try {
                await interaction.channel.send({
                    content: `🎉 <@${interaction.user.id}> 已确认申请并成功加入 <@&${config.managedRoleId}>！`,
                    allowedMentions: { users: [interaction.user.id], roles: [], repliedUser: false },
                });
            } catch (error) {
                console.warn(`[RoleRotation] 招募成功但公开通知发送失败 round=${confirmRoundId}:`, error);
                await interaction.editReply({
                    content: '✅ 申请成功并已授予身份组，但公开通知发送失败，请联系管理员检查频道权限。',
                    components: [],
                    allowedMentions: { parse: [] },
                }).catch(() => undefined);
                await trySendDmNotice(
                    interaction,
                    '✅ 申请成功并已授予身份组，但频道内的公开通知发送失败，请联系管理员检查频道权限。',
                );
            }
        } else if (result.ok) {
            await interaction.editReply({
                content: '✅ 申请成功并已授予身份组，但当前频道无法发送公开通知。',
                components: [],
                allowedMentions: { parse: [] },
            });
            await trySendDmNotice(
                interaction,
                '✅ 申请成功并已授予身份组，但当前频道无法发送公开通知。',
            );
        }
        return;
    }

    const cancelRoundId = readRoundId(interaction.customId, ROTATION_IDS.CANCEL);
    if (cancelRoundId !== null) {
        await interaction.update({ content: '已取消申请。', components: [], allowedMentions: { parse: [] } });
        return;
    }

    // customId 属于本模块但版本不匹配时，也明确结束交互，避免用户看到“应用无响应”。
    const expired = '⚠️ 该按钮已失效，请使用最新发布的面板。';
    await interaction.reply({
        content: expired,
        flags: MessageFlags.Ephemeral,
    });
    await trySendDmNotice(interaction, expired);
}
