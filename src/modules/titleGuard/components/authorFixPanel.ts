// src/modules/titleGuard/components/authorFixPanel.ts
//
// 作者自助面板（仅本人可见）。设计文档 §7.3。
//
// 关键一条：**作者提交的方案要过同一套检测**。
// 不然作者能提交一个照样违规的标题，等于给了个绕过口。不通过就回显具体问题让他重提。
//
// 「多路线」由作者自己勾——bot 绝不自动加，那等于替作者声明作品有多条路线。

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    type AnySelectMenuInteraction,
    type ButtonInteraction,
    type GuildMember,
    type ModalSubmitInteraction,
} from 'discord.js';

import { hasCapability, type GuardCapability } from '../services/titleGuardPermissions';
import * as db from '../services/titleGuardDatabase';
import {
    applyPlan,
    effectiveViolations,
    fetchThread,
    getCompiledConfig,
    inspectThread,
} from '../services/enforcer';
import { buildPlan, validateNewTitle, type RewritePlan } from '../services/rewriter';
import type { GroupId } from '../services/types';
import { refreshNotice } from './noticePanel';

export const SELECT_KEEP = 'tt_keep';        // tt_keep:<caseId>
export const BTN_EDIT_TITLE = 'tt_title';    // tt_title:<caseId>
export const BTN_APPLY = 'tt_apply';         // tt_apply:<caseId>
export const MODAL_TITLE = 'tt_modal_title'; // tt_modal_title:<caseId>

/** 作者在面板里选的主分类，落库前先放内存（面板是临时的，没必要建表） */
const authorChoices = new Map<number, GroupId>();
/** 作者自己敲的标题 */
const authorTitles = new Map<number, string>();
/** 最近一次重算出的预览标题；打开标题弹窗时直接用，不能为了预填值先请求 Discord。 */
const authorPreviewTitles = new Map<number, string>();

function caseIdOf(customId: string): number | null {
    const id = Number(customId.split(':')[1]);
    return Number.isFinite(id) ? id : null;
}

/**
 * 谁能用这个面板：帖主本人，或者管理组里任意一种带操作能力的身份组。
 *
 * 必须和通知上「我要修改」那颗按钮用同一套判定。以前这里写的是
 * checkAdminPermission，而按钮那边已经认新的能力体系了——
 * 结果风纪委员能点开面板，面板里每一步都被拒。
 */
const PANEL_CAPS: GuardCapability[] = ['复核', '覆盖', '词表', '设置'];

function canUse(
    interaction: ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction,
    guardCase: db.GuardCase,
): boolean {
    if (guardCase.authorId && interaction.user.id === guardCase.authorId) return true;
    const member = interaction.member as GuildMember | null;
    return PANEL_CAPS.some(c => hasCapability(member, guardCase.guildId, c));
}

/** 冲突涉及的候选分类组，供作者二选一 */
function candidateGroups(guardCase: db.GuardCase): GroupId[] {
    const groups = new Set<GroupId>();
    for (const v of guardCase.violations) {
        if (v.rule === 'W' || v.rule === 'G' || v.rule === 'X') {
            for (const g of v.groups) groups.add(g);
        }
    }
    return [...groups];
}

async function renderPanel(
    interaction: ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction,
    guardCase: db.GuardCase,
    extraNote?: string,
): Promise<void> {
    const thread = await fetchThread(interaction.client, guardCase.threadId);
    if (!thread) {
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply({ content: '❌ 找不到这个帖子了。', embeds: [], components: [] });
        } else {
            await interaction.reply({ content: '❌ 找不到这个帖子了。', flags: MessageFlags.Ephemeral });
        }
        return;
    }

    const choice = authorChoices.get(guardCase.id) ?? null;
    const draftTitle = authorTitles.get(guardCase.id);

    const inspection = await inspectThread(thread, { dryRun: true, authorChoice: choice });
    const violations = effectiveViolations(inspection);
    const plan = inspection.plan;

    const previewTitle = draftTitle ?? plan?.newTitle ?? thread.name;
    authorPreviewTitles.set(guardCase.id, previewTitle);

    const embed = new EmbedBuilder()
        .setTitle('✏️ 调整你的帖子分类')
        .setColor(0x3ba55d)
        .addFields(
            { name: '当前标题', value: `\`${thread.name}\``.slice(0, 1024) },
            { name: '调整后', value: `\`${previewTitle}\``.slice(0, 1024) },
        );

    if (violations.length > 0) {
        embed.addFields({
            name: '要解决的问题',
            value: violations.map(v => `• ${v.message}`).join('\n').slice(0, 1024),
        });
    }

    embed.addFields({
        name: '保留的主分类',
        value: choice ? `**${choice}**（你选的）` : (plan?.keepGroup ? `**${plan.keepGroup}**（按 TAG 推断）` : '_尚未确定，请在下面选_'),
    });

    if (plan && plan.removeTagIds.length > 0) {
        const names = inspection.tags
            .filter(t => plan.removeTagIds.includes(t.tagId))
            .map(t => t.tagName);
        embed.addFields({ name: '会摘掉的 TAG', value: names.join('、') || '—' });
    }

    embed.setFooter({
        text: '如果作品确实有多条互斥路线，请在标题里自行加上「多路线」——机器人不会替你加。',
    });

    if (extraNote) embed.addFields({ name: '提示', value: extraNote.slice(0, 1024) });

    const groups = candidateGroups(guardCase);
    const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];

    if (groups.length > 1) {
        rows.push(
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`${SELECT_KEEP}:${guardCase.id}`)
                    .setPlaceholder('选择要保留的主分类')
                    .addOptions(groups.slice(0, 25).map(g => ({
                        label: g,
                        value: g,
                        default: g === choice,
                    }))),
            ),
        );
    }

    rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`${BTN_EDIT_TITLE}:${guardCase.id}`)
                .setLabel('自己改标题')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`${BTN_APPLY}:${guardCase.id}`)
                .setLabel('确认并提交')
                .setStyle(ButtonStyle.Success),
        ),
    );

    const payload = { embeds: [embed], components: rows, flags: MessageFlags.Ephemeral } as const;

    if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ embeds: payload.embeds, components: [...payload.components] });
    } else {
        await interaction.reply({ ...payload, components: [...payload.components] });
    }
}

export async function openAuthorFixPanel(
    interaction: ButtonInteraction,
    guardCase: db.GuardCase,
): Promise<void> {
    await renderPanel(interaction, guardCase);
}

// ============================================================
// 交互处理
// ============================================================

export async function handleTitleGuardSelect(interaction: AnySelectMenuInteraction): Promise<void> {
    if (!interaction.customId.startsWith(SELECT_KEEP)) return;

    const id = caseIdOf(interaction.customId);
    const guardCase = id === null ? null : db.getCase(id);
    if (!guardCase) {
        await interaction.reply({ content: '❌ 这条记录已经不存在了。', flags: MessageFlags.Ephemeral });
        return;
    }
    if (!canUse(interaction, guardCase)) {
        await interaction.reply({ content: '❌ 只有帖子作者本人和管理组可以操作。', flags: MessageFlags.Ephemeral });
        return;
    }

    const picked = 'values' in interaction ? interaction.values[0] : undefined;
    if (picked) {
        authorChoices.set(guardCase.id, picked);
        // 换了主分类，之前手敲的标题可能已经对不上，清掉重新生成建议
        authorTitles.delete(guardCase.id);
    }

    await interaction.deferUpdate();
    await renderPanel(interaction, guardCase);
}

export async function handleAuthorFixButton(interaction: ButtonInteraction): Promise<boolean> {
    if (interaction.customId.startsWith(BTN_EDIT_TITLE)) {
        await openTitleModal(interaction);
        return true;
    }
    if (interaction.customId.startsWith(BTN_APPLY)) {
        await applyAuthorPlan(interaction);
        return true;
    }
    return false;
}

async function openTitleModal(interaction: ButtonInteraction): Promise<void> {
    const id = caseIdOf(interaction.customId);
    const guardCase = id === null ? null : db.getCase(id);
    if (!guardCase) {
        await interaction.reply({ content: '❌ 这条记录已经不存在了。', flags: MessageFlags.Ephemeral });
        return;
    }
    if (!canUse(interaction, guardCase)) {
        await interaction.reply({ content: '❌ 只有帖子作者本人和管理组可以操作。', flags: MessageFlags.Ephemeral });
        return;
    }

    const savedPlan = guardCase.plan as RewritePlan | null;
    const prefill = authorTitles.get(guardCase.id)
        ?? authorPreviewTitles.get(guardCase.id)
        ?? savedPlan?.newTitle
        ?? guardCase.originalTitle;

    const modal = new ModalBuilder()
        .setCustomId(`${MODAL_TITLE}:${guardCase.id}`)
        .setTitle('修改帖子标题')
        .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId('title')
                    .setLabel('新标题')
                    .setStyle(TextInputStyle.Short)
                    .setMaxLength(100)
                    .setRequired(true)
                    .setValue(prefill.slice(0, 100)),
            ),
        );

    await interaction.showModal(modal);
}

export async function handleTitleGuardModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.customId.startsWith(MODAL_TITLE)) return;

    const id = caseIdOf(interaction.customId);
    const guardCase = id === null ? null : db.getCase(id);
    if (!guardCase) {
        await interaction.reply({ content: '❌ 这条记录已经不存在了。', flags: MessageFlags.Ephemeral });
        return;
    }
    if (!canUse(interaction, guardCase)) {
        await interaction.reply({ content: '❌ 只有帖子作者本人和管理组可以操作。', flags: MessageFlags.Ephemeral });
        return;
    }

    const candidate = interaction.fields.getTextInputValue('title').trim();

    // 后面要读取帖子并重新校验，先确认这次 Modal 交互，避免超过 Discord 的 3 秒窗口。
    // deferUpdate 保留原来的自助面板；校验成功后 renderPanel 会原地更新它。
    await interaction.deferUpdate();

    const thread = await fetchThread(interaction.client, guardCase.threadId);
    if (!thread) {
        await interaction.followUp({
            content: '❌ 找不到这个帖子了。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // 关键：作者提交的方案也要过同一套检测，不能留绕过口
    const compiled = getCompiledConfig(guardCase.guildId);
    const inspection = await inspectThread(thread, { dryRun: true });
    const check = validateNewTitle(candidate, candidate, inspection.tags, compiled, { allowAddition: true });

    if (!check.ok) {
        await interaction.followUp({
            content: `❌ 这个标题还是不符合规范：${check.reason}\n请再改一下。`,
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    authorTitles.set(guardCase.id, candidate);
    await renderPanel(interaction, guardCase, '标题已通过检查，点「确认并提交」生效。');
}

async function applyAuthorPlan(interaction: ButtonInteraction): Promise<void> {
    const id = caseIdOf(interaction.customId);
    const guardCase = id === null ? null : db.getCase(id);
    if (!guardCase) {
        await interaction.reply({ content: '❌ 这条记录已经不存在了。', flags: MessageFlags.Ephemeral });
        return;
    }
    if (!canUse(interaction, guardCase)) {
        await interaction.reply({ content: '❌ 只有帖子作者本人和管理组可以操作。', flags: MessageFlags.Ephemeral });
        return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const thread = await fetchThread(interaction.client, guardCase.threadId);
    if (!thread) {
        await interaction.editReply('❌ 找不到这个帖子了。');
        return;
    }

    const choice = authorChoices.get(guardCase.id) ?? null;
    const inspection = await inspectThread(thread, { dryRun: true, authorChoice: choice });
    const compiled = getCompiledConfig(guardCase.guildId);

    let plan = inspection.plan;
    const manualTitle = authorTitles.get(guardCase.id);

    if (manualTitle) {
        // 作者手敲的标题：仍要过一遍检测才允许提交
        const check = validateNewTitle(manualTitle, manualTitle, inspection.tags, compiled, { allowAddition: true });
        if (!check.ok) {
            await interaction.editReply(`❌ 这个标题还是不符合规范：${check.reason}`);
            return;
        }
        plan = plan
            ? { ...plan, newTitle: manualTitle, autoFixable: true, blockedReason: null }
            : buildPlan({
                detectResult: inspection.detectResult,
                tags: inspection.tags,
                forumTags: inspection.availableTags,
                compiled,
                authorChoice: choice,
            });
        plan.newTitle = manualTitle;
    }

    if (!plan) {
        await interaction.editReply('❌ 生成不了整改方案，请呼叫管理组处理。');
        return;
    }
    if (!plan.autoFixable && !manualTitle) {
        await interaction.editReply(
            `❌ 这个情况需要人工处理：${plan.blockedReason ?? '无法自动判断'}\n`
            + '你可以点「自己改标题」手动给一个，或者呼叫管理组。',
        );
        return;
    }

    const result = await applyPlan(thread, plan, `author:${interaction.user.id}`, guardCase.id);
    if (!result.ok) {
        await interaction.editReply(`❌ 修改失败：${result.error}`);
        return;
    }

    authorChoices.delete(guardCase.id);
    authorTitles.delete(guardCase.id);
    authorPreviewTitles.delete(guardCase.id);
    db.closeCase(guardCase.id, 'resolved');

    // 作者自助提交不会再有未结案件供 ThreadUpdate 的延迟检查拾取，必须在结案后
    // 直接重画原通知；否则只会多出绿色完成消息，旧的黄色整改面板会永久留着。
    await refreshNotice(interaction.client, guardCase.id);

    await interaction.editReply('✅ 已按你的方案调整完成，感谢配合！');

    await thread.send({
        content: `✅ <@${interaction.user.id}> 已自行完成调整，本次检查结束。`,
    }).catch(() => { /* 忽略 */ });
}
