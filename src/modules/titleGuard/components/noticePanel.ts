// src/modules/titleGuard/components/noticePanel.ts
//
// 发给作者的整改通知，以及上面那几个按钮的处理。
//
// 按钮（会随案件状态变）：
//   我要修改      帖主 + 管理组            → 弹出仅本人可见的自助面板
//   申请复核      帖主 + 管理组            → 填一句理由，先走 AI 复核
//   申请人工复核  帖主 + 管理组            → AI 复核用掉之后变成这个
//   驳回申诉      有「复核」能力的身份组    → 申诉不成立，恢复倒计时
//   人工覆盖      有「覆盖」能力的身份组    → 直接放行并写入豁免表
//
// 复核是**两级**的：
//   1. AI 复核每个案子只有一次。它维持原判 → 恢复倒计时，作者可以再升人工；
//      它认为申诉成立 → 直接放行（不动帖子这个方向是无损的，出错也只是少改一个帖子）。
//   2. 建案时本来就经过 AI 定性的案子，跳过第一级——它已经说过话了，再问一次没有意义。
//
// 作者填的那句理由是**不可信输入**，会被塞进给模型的提示里，所以先过一道安检
//（llmAppeal.screenAppealText）。安检没过 → 这段话永远不进提示，案子直接转人工：
// 人是不会被提示词注入的。
//
// customId 统一 tt_ 前缀，由 core/events/interactionCreate.ts 按前缀分发。

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    type ButtonInteraction,
    type Client,
    type GuildMember,
    type ModalSubmitInteraction,
    type ThreadChannel,
} from 'discord.js';

import * as db from '../services/titleGuardDatabase';
import { alertMentions, fetchThread, inspectThread, readAppliedTags, getCompiledConfig } from '../services/enforcer';
import { hasCapability, reviewerMentions, type GuardCapability } from '../services/titleGuardPermissions';
import { APPEAL_MAX_LENGTH, reviewAppeal, screenAppealText } from '../services/llmAppeal';
import { buildJudgeRules } from '../services/llmJudge';
import type { RewritePlan } from '../services/rewriter';
import type { NormalizedTitle, Violation } from '../services/types';
import { buildNoticeContent, buildDoneMessage } from '../services/noticeContent';
import { openAuthorFixPanel } from './authorFixPanel';

export const BTN_FIX = 'tt_fix';           // tt_fix:<caseId>
export const BTN_APPEAL = 'tt_appeal';     // tt_appeal:<caseId>
export const BTN_REJECT = 'tt_reject';     // tt_reject:<caseId>
export const BTN_OVERRIDE = 'tt_override'; // tt_override:<caseId>
export const MODAL_APPEAL = 'tt_appealtext'; // tt_appealtext:<caseId>

/** 恢复倒计时时至少留这么久。AI 维持原判后作者总得有时间去点人工复核 */
const MIN_RESUME_MS = 60 * 60 * 1000;

// ============================================================
// 通知内容
// ============================================================

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
        llmReason: guardCase.llmReason,
        review: guardCase.aiReviewUpheld === null
            ? null
            : { upheld: guardCase.aiReviewUpheld, reason: guardCase.llmReviewReason ?? '' },
        awaitingHuman: guardCase.state === 'pending_admin',
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

/**
 * 通知上该有哪几个按钮。
 * 跟着案件状态走：AI 复核还没用掉就是「申请复核」，用掉了变「申请人工复核」，
 * 已经升到人工了就换成给管理组的「驳回申诉」。
 */
export function buildNoticeButtons(guardCase: db.GuardCase): ActionRowBuilder<ButtonBuilder> {
    const caseId = guardCase.id;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${BTN_FIX}:${caseId}`)
            .setLabel('我要修改')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('✏️'),
    );

    if (guardCase.state === 'pending_admin') {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`${BTN_REJECT}:${caseId}`)
                .setLabel('驳回申诉')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('📌'),
        );
    } else {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`${BTN_APPEAL}:${caseId}`)
                .setLabel(aiReviewAvailable(guardCase) ? '申请复核' : '申请人工复核')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('⚖️'),
        );
    }

    row.addComponents(
        new ButtonBuilder()
            .setCustomId(`${BTN_OVERRIDE}:${caseId}`)
            .setLabel('人工覆盖')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🛡️'),
    );

    return row;
}

/**
 * 这个案子还能不能走 AI 复核。
 * 两种情况都不能：已经用掉了，或者建案时本来就是 AI 定性的
 *（它已经就这个帖子表过态，再问一次是拿同样的输入要同样的答案）。
 */
function aiReviewAvailable(guardCase: db.GuardCase): boolean {
    return !guardCase.aiReviewUsed && !guardCase.llmReason;
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
        const message = await thread.send({
            content: mention || undefined,
            embeds: [buildNoticeEmbed(guardCase, violations, plan, tagNamesOf(thread), normalized)],
            components: [buildNoticeButtons(guardCase)],
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

function tagNamesOf(thread: ThreadChannel): Map<string, string> {
    return new Map(
        (thread.parent && 'availableTags' in thread.parent ? thread.parent.availableTags : [])
            .map(t => [t.id, t.name] as [string, string]),
    );
}

/**
 * 案件状态变了，把原来那条通知重画一遍——小字里的 AI 结论、footer、按钮都跟着变。
 * 消息被删了就静默跳过：通知没了不该阻断处置流程。
 */
export async function refreshNotice(client: Client, caseId: number): Promise<void> {
    const guardCase = db.getCase(caseId);
    if (!guardCase?.noticeMessageId) return;

    try {
        const thread = await fetchThread(client, guardCase.threadId);
        if (!thread) return;
        const message = await thread.messages.fetch(guardCase.noticeMessageId);
        await message.edit({
            embeds: [buildNoticeEmbed(
                guardCase,
                guardCase.violations,
                guardCase.plan as RewritePlan | null,
                tagNamesOf(thread),
            )],
            components: guardCase.closedAt ? [] : [buildNoticeButtons(guardCase)],
        });
    } catch { /* 消息可能已被删，忽略 */ }
}

// ============================================================
// 按钮处理
// ============================================================

function parseCaseId(customId: string): number | null {
    const id = Number(customId.split(':')[1]);
    return Number.isFinite(id) ? id : null;
}

function memberOf(interaction: ButtonInteraction | ModalSubmitInteraction): GuildMember | null {
    return interaction.member as GuildMember | null;
}

/** 管理组的任意一种身份都算「工作人员」，用于「谁能替作者操作」这类宽松判断 */
function isStaff(interaction: ButtonInteraction | ModalSubmitInteraction, guildId: string): boolean {
    const member = memberOf(interaction);
    const caps: GuardCapability[] = ['复核', '覆盖', '词表', '设置'];
    return caps.some(c => hasCapability(member, guildId, c));
}

function isAuthorOrStaff(
    interaction: ButtonInteraction | ModalSubmitInteraction, guardCase: db.GuardCase,
): boolean {
    if (guardCase.authorId && interaction.user.id === guardCase.authorId) return true;
    return isStaff(interaction, guardCase.guildId);
}

export async function handleTitleGuardButton(interaction: ButtonInteraction): Promise<void> {
    const id = parseCaseId(interaction.customId);
    const guardCase = id === null ? null : db.getCase(id);
    if (!guardCase) {
        await interaction.reply({ content: '❌ 这条记录已经不存在了。', flags: MessageFlags.Ephemeral });
        return;
    }

    if (interaction.customId.startsWith(BTN_OVERRIDE)) {
        await handleOverride(interaction, guardCase);
        return;
    }
    if (interaction.customId.startsWith(BTN_REJECT)) {
        await handleReject(interaction, guardCase);
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
    if (!isAuthorOrStaff(interaction, guardCase)) {
        await interaction.reply({
            content: '❌ 只有帖子作者本人和管理组可以使用这个功能。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    await openAuthorFixPanel(interaction, guardCase);
}

// ---------- 申请复核：先要一句理由 ----------

async function handleAppeal(interaction: ButtonInteraction, guardCase: db.GuardCase): Promise<void> {
    if (!isAuthorOrStaff(interaction, guardCase)) {
        await interaction.reply({
            content: '❌ 只有帖子作者本人和管理组可以使用这个功能。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    if (guardCase.closedAt) {
        await interaction.reply({ content: '这条记录已经结案了。', flags: MessageFlags.Ephemeral });
        return;
    }
    if (guardCase.state === 'pending_admin') {
        await interaction.reply({
            content: '本帖已提请人工复核，正在等待管理组处理，无需重复提交。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const toAi = aiReviewAvailable(guardCase);
    const modal = new ModalBuilder()
        .setCustomId(`${MODAL_APPEAL}:${guardCase.id}`)
        .setTitle(toAi ? '申请复核' : '申请人工复核');

    modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
                .setCustomId('reason')
                .setLabel('你认为哪里判错了？')
                .setPlaceholder(toAi
                    ? '例如：「纯爱」是作品名的一部分，不是分类标记'
                    : '说明为什么对上一次复核结论仍有异议')
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(APPEAL_MAX_LENGTH)
                .setMinLength(2)
                .setRequired(true),
        ),
    );

    await interaction.showModal(modal);
}

/** 显示用户原话时把 @ 提及打断，免得一条申诉理由把全服 ping 一遍 */
function defuse(text: string): string {
    return text
        .replace(/@(everyone|here)/g, '@​$1')
        .replace(/<@[!&]?(\d+)>/g, '@$1')
        .slice(0, APPEAL_MAX_LENGTH);
}

/** 暂停倒计时，把「还剩多久」记下来 */
function pauseCountdown(guardCase: db.GuardCase): void {
    const remaining = guardCase.deadline ? Math.max(0, guardCase.deadline - Date.now()) : null;
    db.updateCase(guardCase.id, {
        deadline: null,
        pausedRemainingMs: remaining ?? guardCase.pausedRemainingMs,
    });
}

/** 恢复倒计时。按暂停时剩下的时间算，但至少留一小时——不然刚恢复就到期了 */
function resumeCountdown(caseId: number): number | null {
    const guardCase = db.getCase(caseId);
    if (!guardCase) return null;
    const remaining = Math.max(guardCase.pausedRemainingMs ?? 0, MIN_RESUME_MS);
    const deadline = Date.now() + remaining;
    db.updateCase(caseId, { state: 'notified', deadline });
    return deadline;
}

export async function handleAppealModal(interaction: ModalSubmitInteraction): Promise<void> {
    const id = parseCaseId(interaction.customId);
    const guardCase = id === null ? null : db.getCase(id);
    if (!guardCase) {
        await interaction.reply({ content: '❌ 这条记录已经不存在了。', flags: MessageFlags.Ephemeral });
        return;
    }
    if (!isAuthorOrStaff(interaction, guardCase)) {
        await interaction.reply({
            content: '❌ 只有帖子作者本人和管理组可以使用这个功能。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const raw = interaction.fields.getTextInputValue('reason').trim();
    if (raw.length < 2) {
        await interaction.reply({ content: '❌ 请写清楚你认为哪里判错了。', flags: MessageFlags.Ephemeral });
        return;
    }
    // Discord 那边已经限长，这里再挡一次，防的是绕过客户端直接发交互的情况
    const text = raw.slice(0, APPEAL_MAX_LENGTH);

    // 安检和复核都要真调模型，肯定超过 3 秒，先把交互挂起来
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // 不管后面怎么走，倒计时先停下——作者已经明确表示有异议了
    pauseCountdown(guardCase);
    db.updateCase(guardCase.id, {
        appealText: guardCase.appealText ? `${guardCase.appealText}\n---\n${text}` : text,
        appealBy: interaction.user.id,
        appealAt: Date.now(),
    });

    const settings = db.getSettings(guardCase.guildId);
    const wantAi = aiReviewAvailable(guardCase);

    // ---------- 安检 ----------
    const screening = await screenAppealText(text, { enabled: settings.llmEnabled && wantAi });

    if (wantAi && !screening.safe) {
        // 没过安检 → 这段话不进任何提示词，直接转人工。
        // 注意这不等于驳回申诉：想搞提示词注入的人，他的帖子该不该改是另一回事。
        await escalateToHuman(interaction, guardCase.id, text, {
            note: screening.by === 'none'
                ? `AI 复核未能进行（${screening.reason}），已直接转人工。`
                : `⚠️ 申诉理由未通过输入安检（${screening.reason}），未提交 AI 复核，请人工判断。`,
            flagged: screening.by !== 'none',
        });
        return;
    }

    // ---------- AI 复核 ----------
    if (wantAi) {
        const outcome = await runAiReview(interaction, guardCase, text, settings.llmEnabled);
        if (outcome === 'done') return;
        // 复核没跑成（模型不可用等）→ 落到人工
        await escalateToHuman(interaction, guardCase.id, text, {
            note: 'AI 复核未能完成，已转人工。',
            flagged: false,
        });
        return;
    }

    // ---------- 直接人工 ----------
    await escalateToHuman(interaction, guardCase.id, text, {
        note: guardCase.aiReviewUsed
            ? '作者对 AI 复核结论仍有异议。'
            : '本案由 AI 定性，按规则直接转人工复核。',
        flagged: false,
    });
}

type ReviewOutcome = 'done' | 'failed';

async function runAiReview(
    interaction: ModalSubmitInteraction,
    guardCase: db.GuardCase,
    appealText: string,
    llmEnabled: boolean,
): Promise<ReviewOutcome> {
    const thread = await fetchThread(interaction.client, guardCase.threadId);
    if (!thread) return 'failed';

    const compiled = getCompiledConfig(guardCase.guildId);
    const tags = readAppliedTags(thread);
    const plan = guardCase.plan as RewritePlan | null;
    const names = tagNamesOf(thread);

    const outcome = await reviewAppeal({
        title: guardCase.originalTitle,
        forumName: thread.parent?.name ?? '',
        tags: tags.map(t => ({ name: t.tagName, group: t.group })),
        hits: guardCase.violations.flatMap(v => v.hits)
            .filter(h => h.entry.group)
            .map(h => ({ word: h.entry.word, group: h.entry.group!, where: h.segmentKind })),
        violationMessages: guardCase.violations.map(v => v.message),
        plan: plan
            ? {
                titleChanged: plan.newTitle !== plan.originalTitle,
                newTitle: plan.newTitle,
                removeTagNames: plan.removeTagIds.map(t => names.get(t) ?? t),
                addTagNames: plan.addTagIds.map(t => names.get(t) ?? t),
            }
            : null,
        priorReason: guardCase.llmReason,
        rules: buildJudgeRules(compiled.raw),
        appealText,
    }, { enabled: llmEnabled });

    if (!outcome.ok) {
        console.warn(`[TitleGuard] 申诉复核失败（${outcome.kind}）：${outcome.error.slice(0, 200)}`);
        return 'failed';
    }

    const review = outcome.review;
    db.updateCase(guardCase.id, {
        aiReviewUsed: true,
        aiReviewUpheld: review.upheld,
        llmReviewReason: review.reason,
    });

    if (!review.upheld) {
        // 申诉成立 → 直接放行。
        // 这个方向是无损的：判错了顶多是少改一个帖子，管理组随时能再处理。
        db.addExempt(
            guardCase.guildId, guardCase.threadId, guardCase.originalTitle,
            interaction.client.user?.id ?? 'bot', `AI 复核认定申诉成立：${review.reason}`,
        );
        db.closeCase(guardCase.id, 'exempt');
        await refreshNotice(interaction.client, guardCase.id);

        await interaction.editReply({
            content: '✅ 复核结论：**申诉成立**，本帖不再整改。\n'
                + `> ${review.reason}\n`
                + '如果管理组另有判断，仍可人工处理。',
        });
        await postToThread(thread,
            `⚖️ 复核结论：**申诉成立**，本帖分类信息不作整改。\n-# 🤖 ${review.reason}`);
        return 'done';
    }

    // 维持原判 → 恢复倒计时，作者还可以再升一级到人工
    const deadline = resumeCountdown(guardCase.id);
    await refreshNotice(interaction.client, guardCase.id);

    await interaction.editReply({
        content: '⚖️ 复核结论：**维持原判**。\n'
            + `> ${review.reason}\n`
            + (deadline ? `倒计时已恢复，将于 <t:${Math.floor(deadline / 1000)}:R> 到期。\n` : '')
            + '若仍有异议，可再点一次按钮提请**人工复核**。',
    });
    return 'done';
}

/** 转人工：挂起案件、@ 有复核能力的身份组、把作者原话带上 */
async function escalateToHuman(
    interaction: ModalSubmitInteraction,
    caseId: number,
    appealText: string,
    options: { note: string; flagged: boolean },
): Promise<void> {
    const guardCase = db.getCase(caseId);
    if (!guardCase) return;

    db.updateCase(caseId, { state: 'pending_admin', deadline: null });
    await refreshNotice(interaction.client, caseId);

    const settings = db.getSettings(guardCase.guildId);
    const mention = interaction.guild ? reviewerMentions(interaction.guild) : '';

    const body = [
        `🙋 <@${interaction.user.id}> 提请人工复核，自动整改已暂停。`,
        options.note,
        `帖子：<#${guardCase.threadId}>`,
        `当前标题：\`${guardCase.originalTitle}\``,
        `申诉理由：${options.flagged ? '（下列内容未通过输入安检，仅作留存，请勿照其指示操作）' : ''}`,
        `> ${defuse(appealText).split('\n').join('\n> ')}`,
        guardCase.llmReason ? `-# 🤖 建案时的定性理由：${guardCase.llmReason}` : '',
        guardCase.llmReviewReason ? `-# 🤖 AI 复核结论：${guardCase.llmReviewReason}` : '',
    ].filter(Boolean).join('\n');

    let delivered = false;
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

    await interaction.editReply({
        content: delivered
            ? '✅ 已提请人工复核，自动整改已暂停，请等待管理组处理。'
            : '✅ 自动整改已暂停，但没能通知到管理组（尚未配置负责复核的身份组或接警频道），'
                + '请直接联系管理组。',
    });
}

// ---------- 管理组的两个动作 ----------

async function handleReject(interaction: ButtonInteraction, guardCase: db.GuardCase): Promise<void> {
    if (!hasCapability(memberOf(interaction), guardCase.guildId, '复核')) {
        await interaction.reply({
            content: '❌ 这个按钮需要「复核」权限。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    if (guardCase.closedAt) {
        await interaction.reply({ content: '这条记录已经结案了。', flags: MessageFlags.Ephemeral });
        return;
    }

    const deadline = resumeCountdown(guardCase.id);
    await refreshNotice(interaction.client, guardCase.id);

    await interaction.reply({
        content: `✅ 已驳回申诉，倒计时恢复${deadline ? `，将于 <t:${Math.floor(deadline / 1000)}:R> 到期` : ''}。`,
        flags: MessageFlags.Ephemeral,
    });

    if (interaction.channel && !interaction.channel.isDMBased()) {
        await interaction.channel.send({
            content: `📌 管理组 <@${interaction.user.id}> 已复核本帖，**维持原判定**，请按通知处理。`,
        }).catch(() => { /* 忽略 */ });
    }
}

async function handleOverride(interaction: ButtonInteraction, guardCase: db.GuardCase): Promise<void> {
    if (!hasCapability(memberOf(interaction), guardCase.guildId, '覆盖')) {
        await interaction.reply({
            content: '❌ 这个按钮需要「覆盖」权限。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const thread = await fetchThread(interaction.client, guardCase.threadId);
    const currentTitle = thread?.name ?? guardCase.originalTitle;

    // 豁免绑定「帖子 + 当前标题」，作者之后再改标题会重新判定
    db.addExempt(guardCase.guildId, guardCase.threadId, currentTitle, interaction.user.id, '管理组人工覆盖');
    db.closeCase(guardCase.id, 'exempt');

    await interaction.reply({
        content: '✅ 已放行。这个标题以后不会再被判定。\n（作者若再改标题，会重新走一次检查）',
        flags: MessageFlags.Ephemeral,
    });

    await interaction.message.edit({ components: [] }).catch(() => { /* 忽略 */ });
    if (interaction.channel && !interaction.channel.isDMBased()) {
        await interaction.channel.send({
            content: `🛡️ 管理组 <@${interaction.user.id}> 已人工放行本帖，无需再做调整。`,
        }).catch(() => { /* 忽略 */ });
    }
}

async function postToThread(thread: ThreadChannel, content: string): Promise<void> {
    const wasArchived = Boolean(thread.archived);
    try {
        if (wasArchived) await thread.setArchived(false, '标题规范：发送复核结论');
        await thread.send({ content });
    } catch { /* 忽略 */ } finally {
        if (wasArchived) {
            await thread.setArchived(true, '标题规范：发送后恢复归档').catch(() => { /* 忽略 */ });
        }
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

export { inspectThread, buildDoneMessage, alertMentions };
