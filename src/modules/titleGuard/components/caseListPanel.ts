// src/modules/titleGuard/components/caseListPanel.ts
//
// 未结案件列表。每个案件占一个完整的 embed 字段，再用按钮翻页，避免旧版把整条
// Discord 回复直接 slice 到 1900 字、导致最后一个案件从任意字符处断掉。

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    type ButtonInteraction,
    type GuildMember,
} from 'discord.js';

import * as db from '../services/titleGuardDatabase';
import { hasCapability } from '../services/titleGuardPermissions';

const BUTTON_PREFIX = 'tt_cases:';
const CASES_PER_PAGE = 4;

function oneLine(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

/** 列表是摘要；需要缩短时明确留下省略号，不能像旧列表一样无提示地硬切。 */
function clipped(value: string, limit: number): string {
    const clean = oneLine(value);
    if (clean.length <= limit) return clean;
    return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function caseField(guardCase: db.GuardCase): { name: string; value: string } {
    const rows = [
        `**帖子：**<#${guardCase.threadId}>`,
        `**标题：**${clipped(guardCase.originalTitle, 140) || '（空）'}`,
        `**规则：**${clipped(guardCase.violations.map(v => v.rule).join('；'), 260) || '—'}`,
    ];

    if (guardCase.llmReason) {
        rows.push(`🤖 **定性：**${clipped(guardCase.llmReason, 160)}`);
    }
    if (guardCase.appealText) {
        rows.push(`🙋 **申诉：**${clipped(guardCase.appealText.split('\n').pop() ?? '', 160)}`);
    }
    if (guardCase.aiReviewUpheld !== null) {
        const result = guardCase.aiReviewUpheld ? '维持原判' : '申诉成立';
        rows.push(`⚖️ **复核：**${result}——${clipped(guardCase.llmReviewReason ?? '', 140)}`);
    }

    return {
        name: `案件 #${guardCase.id} · ${guardCase.state}`,
        value: rows.join('\n'),
    };
}

export function buildCaseListView(guildId: string, requestedPage = 0) {
    const total = db.countOpenCases(guildId);
    if (total === 0) {
        return {
            content: '✅ 当前没有未结案件。',
            embeds: [],
            components: [],
        };
    }

    const pageCount = Math.ceil(total / CASES_PER_PAGE);
    const page = Math.min(Math.max(0, Math.trunc(requestedPage)), pageCount - 1);
    const cases = db.listOpenCasesPage(guildId, CASES_PER_PAGE, page * CASES_PER_PAGE);

    const embed = new EmbedBuilder()
        .setTitle('📋 未结案件')
        .setColor(0x5865f2)
        .setDescription(`共 **${total}** 件，按建案时间从新到旧排列。`)
        .addFields(cases.map(caseField))
        .setFooter({ text: `第 ${page + 1} / ${pageCount} 页 · 本页 ${cases.length} 件 · 每页最多 ${CASES_PER_PAGE} 件` });

    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${BUTTON_PREFIX}${page - 1}`)
            .setLabel('上一页')
            .setEmoji('◀️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
        new ButtonBuilder()
            .setCustomId(`${BUTTON_PREFIX}${page}`)
            .setLabel('刷新本页')
            .setEmoji('🔄')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${BUTTON_PREFIX}${page + 1}`)
            .setLabel('下一页')
            .setEmoji('▶️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= pageCount - 1),
    );

    return { content: undefined, embeds: [embed], components: [controls] };
}

/** 返回 false 表示不是案件列表按钮，交给 TitleGuard 的下一层按钮处理器。 */
export async function handleCaseListButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith(BUTTON_PREFIX)) return false;

    const guildId = interaction.guildId;
    const page = Number(interaction.customId.slice(BUTTON_PREFIX.length));
    if (!guildId || !Number.isSafeInteger(page)) {
        await interaction.reply({
            content: '❌ 这个案件列表按钮已经失效，请重新运行 `/标题规范 案件 列表`。',
            flags: MessageFlags.Ephemeral,
        });
        return true;
    }

    const member = interaction.member as GuildMember | null;
    if (!hasCapability(member, guildId, '复核')) {
        await interaction.reply({
            content: '❌ 查看案件列表需要「复核」权限。',
            flags: MessageFlags.Ephemeral,
        });
        return true;
    }

    await interaction.update(buildCaseListView(guildId, page));
    return true;
}
