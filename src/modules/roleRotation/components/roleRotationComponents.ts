import { MessageFlags, type ButtonInteraction } from 'discord.js';
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
            const result = submitInquiryResponse(interaction.guildId, roundId, interaction.user.id, response);
            await interaction.reply({
                content: `${result.ok ? '✅' : '⚠️'} ${result.message}`,
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
            return;
        }
    }

    const applyRoundId = readRoundId(interaction.customId, ROTATION_IDS.APPLY);
    if (applyRoundId !== null) {
        const result = await previewApplication(
            interaction.client,
            interaction.guildId,
            applyRoundId,
            interaction.user.id,
        );
        if (!result.ok || !result.round || !result.config) {
            await interaction.reply({
                content: `⚠️ ${result.message}`,
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
            return;
        }
        await interaction.reply({
            ...buildApplicationConfirmation(result.config, result.round),
            flags: MessageFlags.Ephemeral,
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
        await interaction.editReply({
            content: `${result.ok ? '✅' : '⚠️'} ${result.message}`,
            components: [],
            allowedMentions: { parse: [] },
        });
        return;
    }

    const cancelRoundId = readRoundId(interaction.customId, ROTATION_IDS.CANCEL);
    if (cancelRoundId !== null) {
        await interaction.update({ content: '已取消申请。', components: [], allowedMentions: { parse: [] } });
        return;
    }

    // customId 属于本模块但版本不匹配时，也明确结束交互，避免用户看到“应用无响应”。
    await interaction.reply({
        content: '该按钮已失效，请使用最新发布的面板。',
        flags: MessageFlags.Ephemeral,
    });
}
