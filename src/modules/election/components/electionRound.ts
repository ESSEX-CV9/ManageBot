// src/modules/election/components/electionRound.ts
//
// 募选场次的入口面板 + 自荐（自荐按钮 / 自荐宣言 Modal）。
// customId：
//   自荐按钮   elect_nominate_<roundId>
//   自荐 Modal elect_nominate_modal_<roundId>

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
    type ButtonInteraction,
    type ModalSubmitInteraction,
} from 'discord.js';

import {
    getRound,
    isInPool,
    upsertNomination,
    getNomination,
    countNominations,
    type ElectionRound,
} from '../services/electionDatabase';

const NOMINATE_BTN = 'elect_nominate_';
const NOMINATE_MODAL = 'elect_nominate_modal_';
const NOMINATE_INPUT = 'elect_nominate_input';

export const nominateButtonId = (roundId: number) => `${NOMINATE_BTN}${roundId}`;
const nominateModalId = (roundId: number) => `${NOMINATE_MODAL}${roundId}`;

const sec = (ms: number) => Math.floor(ms / 1000);

/**
 * 构建入口面板（空位需求 + 自荐按钮）。
 * @param nomineeCount 已自荐人数
 * @param closedLabel 传入则表示自荐已结束：按钮变灰禁用并显示该文字，其余消息内容不变。
 */
export function buildEntryMessage(round: ElectionRound, nomineeCount: number, closedLabel?: string) {
    const votes: string[] = [];
    if (round.enablePublic) votes.push('大众投票');
    if (round.enableAdmin) votes.push('管理内部投票');

    const embed = new EmbedBuilder()
        .setTitle(`🗳️ 管理组募选：${round.title}`)
        .setColor(0x5865f2)
        .setDescription(
            [
                `**空位数**：${round.vacancyCount}（可选/录取名额）`,
                `**投票方式**：${votes.join(' + ') || '（待定）'}`,
                `**自荐截止**：<t:${sec(round.nominateDeadline)}:f>（<t:${sec(round.nominateDeadline)}:R>）`,
                `**投票时间**：<t:${sec(round.nominateDeadline)}:f> 至 <t:${sec(round.voteDeadline)}:f>`,
                '',
                '候选池成员点击下方按钮自荐并填写自荐宣言；截止后系统据此建立投票。',
            ].join('\n'),
        )
        .addFields({ name: '当前自荐人数', value: String(nomineeCount), inline: true })
        .setFooter({ text: `募选 #${round.id}` });

    const active = !closedLabel;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(nominateButtonId(round.id))
            .setLabel(closedLabel ?? '🙋 我要自荐')
            .setStyle(active ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(!active),
    );

    return { embeds: [embed], components: [row] };
}

/** 尽力刷新入口面板上的自荐人数（失败静默）。 */
async function refreshEntry(interaction: ButtonInteraction | ModalSubmitInteraction, round: ElectionRound): Promise<void> {
    if (!round.entryChannelId || !round.entryMessageId) return;
    try {
        const channel = await interaction.client.channels.fetch(round.entryChannelId);
        if (!channel || !channel.isTextBased()) return;
        const msg = await channel.messages.fetch(round.entryMessageId);
        await msg.edit(buildEntryMessage(round, countNominations(round.id)));
    } catch {
        /* 面板可能被删/无权限，忽略 */
    }
}

/** customId 是否为自荐按钮（elect_nominate_<数字>）。 */
export function isNominateButton(customId: string): boolean {
    return customId.startsWith(NOMINATE_BTN) && !customId.startsWith(NOMINATE_MODAL)
        && /^\d+$/.test(customId.slice(NOMINATE_BTN.length));
}

/** customId 是否为自荐 Modal。 */
export function isNominateModal(customId: string): boolean {
    return customId.startsWith(NOMINATE_MODAL);
}

/** 校验一场募选当前是否可自荐；不可则返回拒绝文案，可则返回 round。 */
function checkNominatable(guildId: string, roundId: number): { round: ElectionRound } | { error: string } {
    const round = getRound(roundId);
    if (!round || round.guildId !== guildId) return { error: '❌ 该募选不存在或已被移除。' };
    if (round.status !== 'nominating') return { error: '⏳ 该募选的自荐阶段已结束。' };
    if (Date.now() > round.nominateDeadline) return { error: '⏳ 自荐已截止。' };
    return { round };
}

/** 处理自荐按钮：校验在池 → 弹出自荐宣言 Modal。 */
export async function handleNominateButton(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.guildId) return;
    const roundId = Number(interaction.customId.slice(NOMINATE_BTN.length));
    const check = checkNominatable(interaction.guildId, roundId);
    if ('error' in check) {
        await interaction.reply({ content: check.error, flags: MessageFlags.Ephemeral });
        return;
    }
    if (!isInPool(interaction.guildId, interaction.user.id)) {
        await interaction.reply({
            content: '❌ 你当前不在候选池，暂时无法自荐。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const existing = getNomination(roundId, interaction.user.id);
    const modal = new ModalBuilder()
        .setCustomId(nominateModalId(roundId))
        .setTitle(existing ? '修改自荐宣言' : '自荐');
    modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
                .setCustomId(NOMINATE_INPUT)
                .setLabel('自荐宣言（将展示给投票者）')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('说明你的意愿、经验、能负责的方向……')
                .setValue(existing?.statement ?? '')
                .setRequired(true)
                .setMaxLength(1000),
        ),
    );
    await interaction.showModal(modal);
}

/** 处理自荐 Modal 提交：保存自荐并刷新入口面板。 */
export async function handleNominateModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.guildId) return;
    const roundId = Number(interaction.customId.slice(NOMINATE_MODAL.length));
    const check = checkNominatable(interaction.guildId, roundId);
    if ('error' in check) {
        await interaction.reply({ content: check.error, flags: MessageFlags.Ephemeral });
        return;
    }
    // 二次校验在池（打开 Modal 到提交之间可能被移出池）
    if (!isInPool(interaction.guildId, interaction.user.id)) {
        await interaction.reply({ content: '❌ 你已不在候选池，无法自荐。', flags: MessageFlags.Ephemeral });
        return;
    }

    const first = !getNomination(roundId, interaction.user.id);
    const statement = interaction.fields.getTextInputValue(NOMINATE_INPUT).trim();
    upsertNomination(roundId, interaction.user.id, statement);

    await interaction.reply({
        content: first ? '✅ 自荐成功！截止后将进入投票。' : '✅ 自荐宣言已更新。',
        flags: MessageFlags.Ephemeral,
    });
    await refreshEntry(interaction, check.round);
}
