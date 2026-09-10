// src/modules/titleGuard/components/noticePanel.ts
//
// 发给作者的整改通知，以及三个按钮的处理。
//
// 按钮（设计文档 §7.2）：
//   我要修改              帖主 + 管理组   → 弹出仅本人可见的自助面板
//   我认为判错了，呼叫管理组  帖主 + 管理组   → @ 接警身份组，立刻暂停倒计时
//   人工覆盖              仅管理组        → 直接放行并写入豁免表
//
// customId 统一 tt_ 前缀，由 core/events/interactionCreate.ts 按前缀分发。

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    type ButtonInteraction,
    type GuildMember,
    type ThreadChannel,
} from 'discord.js';

import { checkAdminPermission } from '../../../core/utils/permissionManager';
import * as db from '../services/titleGuardDatabase';
import { alertMentions, fetchThread, inspectThread } from '../services/enforcer';
import type { RewritePlan } from '../services/rewriter';
import type { NormalizedTitle, Violation } from '../services/types';
import { buildNoticeContent, buildDoneMessage } from '../services/noticeContent';
import { openAuthorFixPanel } from './authorFixPanel';

export const BTN_FIX = 'tt_fix';           // tt_fix:<caseId>
export const BTN_APPEAL = 'tt_appeal';     // tt_appeal:<caseId>
export const BTN_OVERRIDE = 'tt_override'; // tt_override:<caseId>

/**
 * 通知内容由 services/noticeContent.ts 生成（纯逻辑，不依赖 discord.js），
 * 这样调试台能显示和这里一字不差的文案，方便上线前核对措辞。
 */
export function buildNoticeEmbed(
    guardCase: db.GuardCase,
    violations: Violation[],
    plan: RewritePlan | null,
    tagNames: Map<string, string> = new Map(),
    normalized?: NormalizedTitle,
): EmbedBuilder {
    const content = buildNoticeContent({
        authorId: guardCase.authorId,
        originalTitle: guardCase.originalTitle,
        newTitle: plan?.newTitle ?? guardCase.originalTitle,
        titleChanged: Boolean(plan && plan.newTitle !== plan.originalTitle),
        violations,
        removeTagNames: (plan?.removeTagIds ?? []).map(id => tagNames.get(id) ?? id),
        addTagNames: (plan?.addTagIds ?? []).map(id => tagNames.get(id) ?? '多路线'),
        keepGroup: plan?.keepGroup ?? null,
        keepSource: plan?.keepSource ?? 'none',
        autoFixable: Boolean(plan?.autoFixable),
        blockedReason: plan?.blockedReason ?? null,
        deadline: guardCase.deadline,
        isOldPost: guardCase.isOldPost,
        normalized,
    });

    const embed = new EmbedBuilder()
        .setTitle(content.title)
        .setColor(0xf0a30a)
        .setDescription(content.description)
        .setFooter({ text: content.footer });

    for (const f of content.fields) {
        embed.addFields({ name: f.name, value: f.value.slice(0, 1024) });
    }

    return embed;
}

export function buildNoticeButtons(caseId: number): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${BTN_FIX}:${caseId}`)
            .setLabel('我要修改')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('✏️'),
        new ButtonBuilder()
            .setCustomId(`${BTN_APPEAL}:${caseId}`)
            .setLabel('申请复核')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('⚖️'),
        new ButtonBuilder()
            .setCustomId(`${BTN_OVERRIDE}:${caseId}`)
            .setLabel('人工覆盖')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🛡️'),
    );
}

/**
 * 在帖子里发通知并 @ 作者。
 * 老帖若处于归档状态，会先解归档、发完再归档回去。
 */
export async function sendNotice(
    thread: ThreadChannel,
    guardCase: db.GuardCase,
    violations: Violation[],
    plan: RewritePlan | null,
    normalized?: NormalizedTitle,
): Promise<boolean> {
    const wasArchived = Boolean(thread.archived);
    try {
        if (wasArchived) await thread.setArchived(false, '标题规范：发送整改通知');

        const mention = guardCase.authorId ? `<@${guardCase.authorId}>` : '';
        const tagNames = new Map(
            (thread.parent && 'availableTags' in thread.parent
                ? thread.parent.availableTags
                : []).map(t => [t.id, t.name] as [string, string]),
        );
        const message = await thread.send({
            content: mention || undefined,
            embeds: [buildNoticeEmbed(guardCase, violations, plan, tagNames, normalized)],
            components: [buildNoticeButtons(guardCase.id)],
        });

        db.updateCase(guardCase.id, {
            state: 'notified',
            noticeChannelId: thread.id,
            noticeMessageId: message.id,
        });
        return true;
    } catch (err) {
        console.error(`[TitleGuard] 发送通知失败 thread=${thread.id}：`, err);
        return false;
    } finally {
        if (wasArchived) {
            await thread.setArchived(true, '标题规范：通知发送后恢复归档').catch(() => { /* 忽略 */ });
        }
    }
}

// ============================================================
// 按钮处理
// ============================================================

function parseCaseId(customId: string): number | null {
    const id = Number(customId.split(':')[1]);
    return Number.isFinite(id) ? id : null;
}

async function loadCase(interaction: ButtonInteraction): Promise<db.GuardCase | null> {
    const id = parseCaseId(interaction.customId);
    if (id === null) return null;
    return db.getCase(id);
}

function isAuthorOrAdmin(interaction: ButtonInteraction, guardCase: db.GuardCase): boolean {
    if (guardCase.authorId && interaction.user.id === guardCase.authorId) return true;
    return checkAdminPermission(interaction.member as GuildMember | null);
}

export async function handleTitleGuardButton(interaction: ButtonInteraction): Promise<void> {
    const guardCase = await loadCase(interaction);
    if (!guardCase) {
        await interaction.reply({ content: '❌ 这条记录已经不存在了。', flags: MessageFlags.Ephemeral });
        return;
    }

    if (interaction.customId.startsWith(BTN_OVERRIDE)) {
        await handleOverride(interaction, guardCase);
        return;
    }
    if (interaction.customId.startsWith(BTN_APPEAL)) {
        await handleAppeal(interaction, guardCase);
        return;
    }
    if (interaction.customId.startsWith(BTN_FIX)) {
        await handleFix(interaction, guardCase);
    }
}

async function handleFix(interaction: ButtonInteraction, guardCase: db.GuardCase): Promise<void> {
    if (!isAuthorOrAdmin(interaction, guardCase)) {
        await interaction.reply({
            content: '❌ 只有帖子作者本人和管理组可以使用这个功能。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    await openAuthorFixPanel(interaction, guardCase);
}

async function handleAppeal(interaction: ButtonInteraction, guardCase: db.GuardCase): Promise<void> {
    if (!isAuthorOrAdmin(interaction, guardCase)) {
        await interaction.reply({
            content: '❌ 只有帖子作者本人和管理组可以使用这个功能。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // 立刻暂停倒计时
    db.updateCase(guardCase.id, { state: 'pending_admin', deadline: null });

    const settings = db.getSettings(guardCase.guildId);
    const mention = interaction.guild ? alertMentions(interaction.guild, settings) : '';

    const body = `🙋 <@${interaction.user.id}> 认为这条判定有误，已暂停自动整改，请管理组处理。`
        + `\n帖子：<#${guardCase.threadId}>\n当前标题：\`${guardCase.originalTitle}\``;

    let delivered = false;

    // interaction.channel 的类型里含 PartialGroupDMChannel（没有 send），先窄化到服务器文字频道
    const here = interaction.channel && !interaction.channel.isDMBased() ? interaction.channel : null;

    if (mention && here) {
        try {
            await here.send({ content: `${mention}\n${body}` });
            delivered = true;
        } catch { /* 下面走兜底 */ }
    }
    if (!delivered && settings.alertChannelId) {
        try {
            const channel = await interaction.client.channels.fetch(settings.alertChannelId);
            if (channel?.isTextBased() && !channel.isDMBased()) {
                await channel.send({ content: body });
                delivered = true;
            }
        } catch { /* 忽略 */ }
    }

    await interaction.reply({
        content: delivered
            ? '✅ 已通知管理组，自动整改已暂停。请等待人工处理。'
            : '✅ 自动整改已暂停，但没能通知到管理组（尚未配置接警身份组或频道），请直接联系管理组。',
        flags: MessageFlags.Ephemeral,
    });
}

async function handleOverride(interaction: ButtonInteraction, guardCase: db.GuardCase): Promise<void> {
    if (!checkAdminPermission(interaction.member as GuildMember | null)) {
        await interaction.reply({ content: '❌ 这个按钮只有管理组能用。', flags: MessageFlags.Ephemeral });
        return;
    }

    const thread = await fetchThread(interaction.client, guardCase.threadId);
    const currentTitle = thread?.name ?? guardCase.originalTitle;

    // 豁免绑定「帖子 + 当前标题」，作者之后再改标题会重新判定
    db.addExempt(guardCase.guildId, guardCase.threadId, currentTitle, interaction.user.id, '管理组人工覆盖');
    db.closeCase(guardCase.id, 'exempt');

    await interaction.reply({
        content: `✅ 已放行。这个标题以后不会再被判定。\n（作者若再改标题，会重新走一次检查）`,
        flags: MessageFlags.Ephemeral,
    });

    await interaction.message.edit({ components: [] }).catch(() => { /* 忽略 */ });
    if (interaction.channel && !interaction.channel.isDMBased()) {
        await interaction.channel.send({
            content: `🛡️ 管理组 <@${interaction.user.id}> 已人工放行本帖，无需再做调整。`,
        }).catch(() => { /* 忽略 */ });
    }
}

/** 复查用：帖子已经合规了就把通知消息的按钮撤掉 */
export async function disableNoticeButtons(
    guardCase: db.GuardCase,
    thread: ThreadChannel | null,
): Promise<void> {
    if (!thread || !guardCase.noticeMessageId) return;
    try {
        const message = await thread.messages.fetch(guardCase.noticeMessageId);
        await message.edit({ components: [] });
    } catch { /* 消息可能已被删，忽略 */ }
}

export { inspectThread, buildDoneMessage };
