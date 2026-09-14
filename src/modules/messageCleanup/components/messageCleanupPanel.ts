import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    MessageFlags,
    ModalBuilder,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    UserSelectMenuBuilder,
    type AnySelectMenuInteraction,
    type ButtonInteraction,
    type ChatInputCommandInteraction,
    type GuildMember,
    type InteractionUpdateOptions,
    type ModalSubmitInteraction,
} from 'discord.js';

import {
    cancelJob,
    createJob,
    findActiveJob,
    getSettings,
    isJobListClearing,
    listJobs,
    pauseJob,
    requestJobListClear,
    resumeJob,
    setManageRoleIds,
} from '../services/messageCleanupDatabase';
import { canConfigureCleanup, canManageCleanup } from '../services/messageCleanupPermissions';
import { formatShanghaiTime, parseCleanupCutoff } from '../services/cleanupTime';
import type { CleanupJob, CleanupJobStatus } from '../services/types';

const ID = {
    PREFIX: 'mc_',
    USER: 'mc_user',
    SCOPE: 'mc_scope',
    EXCLUDE: 'mc_exclude',
    TIME: 'mc_time',
    TOGGLE_THREADS: 'mc_toggle_threads',
    TOGGLE_GUILD_SCOPE: 'mc_toggle_guild_scope',
    EDIT_IDS: 'mc_edit_ids',
    START: 'mc_start',
    TASKS: 'mc_tasks',
    PERMISSIONS: 'mc_permissions',
    HOME: 'mc_home',
    REFRESH: 'mc_refresh',
    PAUSE: 'mc_pause',
    RESUME: 'mc_resume',
    CANCEL: 'mc_cancel',
    CLEAR: 'mc_clear',
    ROLES: 'mc_roles',
    TIME_MODAL: 'mc_time_modal',
    TIME_INPUT: 'mc_time_input',
    IDS_MODAL: 'mc_ids_modal',
    TARGET_ID_INPUT: 'mc_target_id_input',
    EXCLUDE_IDS_INPUT: 'mc_exclude_ids_input',
} as const;

type CutoffMode = 'all' | '1d' | '7d' | '30d' | 'custom';

interface CleanupDraft {
    targetUserId: string | null;
    targetSelectedViaMenu: boolean;
    selectedChannelIds: string[];
    entireGuild: boolean;
    excludedSelectedIds: string[];
    excludedManualIds: string[];
    includeThreads: boolean;
    cutoffMode: CutoffMode;
    customCutoffAt: number | null;
    touchedAt: number;
}

const drafts = new Map<string, CleanupDraft>();
const DRAFT_TTL = 30 * 60_000;

function draftKey(guildId: string, userId: string): string {
    return `${guildId}:${userId}`;
}

function freshDraft(): CleanupDraft {
    return {
        targetUserId: null,
        targetSelectedViaMenu: false,
        selectedChannelIds: [],
        entireGuild: false,
        excludedSelectedIds: [],
        excludedManualIds: [],
        includeThreads: true,
        cutoffMode: 'all',
        customCutoffAt: null,
        touchedAt: Date.now(),
    };
}

function getDraft(guildId: string, userId: string): CleanupDraft {
    const now = Date.now();
    for (const [key, draft] of drafts) {
        if (now - draft.touchedAt > DRAFT_TTL) drafts.delete(key);
    }
    const key = draftKey(guildId, userId);
    const draft = drafts.get(key) ?? freshDraft();
    draft.touchedAt = now;
    drafts.set(key, draft);
    return draft;
}

function resetDraft(guildId: string, userId: string): CleanupDraft {
    const draft = freshDraft();
    drafts.set(draftKey(guildId, userId), draft);
    return draft;
}

function clearGuildDrafts(guildId: string): void {
    const prefix = `${guildId}:`;
    for (const key of drafts.keys()) {
        if (key.startsWith(prefix)) drafts.delete(key);
    }
}

function memberOf(interaction: ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction): GuildMember | null {
    const member = interaction.member as GuildMember | null;
    return member?.roles?.cache ? member : null;
}

function excludedIds(draft: CleanupDraft): string[] {
    return [...new Set([...draft.excludedSelectedIds, ...draft.excludedManualIds])];
}

function mentionList(ids: string[], empty: string): string {
    if (ids.length === 0) return empty;
    const shown = ids.slice(0, 25).map(id => `<#${id}>`).join(' ');
    return ids.length > 25 ? `${shown} 等 ${ids.length} 项` : shown;
}

function cutoffForDraft(draft: CleanupDraft, now = Date.now()): { timestamp: number; label: string } {
    if (draft.cutoffMode === 'custom' && draft.customCutoffAt) {
        return { timestamp: draft.customCutoffAt, label: `北京时间 ${formatShanghaiTime(draft.customCutoffAt)}` };
    }
    const days = draft.cutoffMode === '1d' ? 1 : draft.cutoffMode === '7d' ? 7 : draft.cutoffMode === '30d' ? 30 : 0;
    if (days > 0) {
        const timestamp = now - days * 24 * 60 * 60_000;
        return { timestamp, label: `${days} 天前（北京时间 ${formatShanghaiTime(timestamp)}）` };
    }
    return { timestamp: now, label: '全部历史（任务启动前）' };
}

const CLEANUP_CHANNEL_TYPES = [
    ChannelType.GuildCategory,
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildForum,
    ChannelType.GuildMedia,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
] as const;

function mainView(guildId: string, actorId: string, configurable: boolean, notice?: string): InteractionUpdateOptions {
    const draft = getDraft(guildId, actorId);
    const cutoff = cutoffForDraft(draft);
    const target = draft.targetUserId ? `<@${draft.targetUserId}>（\`${draft.targetUserId}\`）` : '❌ 未选择';
    const content = [
        notice,
        '## 🧹 紧急消息冲水',
        `**目标用户：** ${target}`,
        `**清理范围：** ${draft.entireGuild ? '🌐 全服务器（所有可访问的文字频道、论坛及帖子）' : mentionList(draft.selectedChannelIds, '❌ 未选择')}`,
        `**截止时间：** ${cutoff.label}`,
        `**聊天频道子区：** ${draft.entireGuild ? '✅ 全服务器模式固定包含' : draft.includeThreads ? '✅ 包含活动及归档子区' : '⛔ 不包含（论坛帖子仍自动包含）'}`,
        `**本次排除：** ${mentionList(excludedIds(draft), '无')}`,
        '',
        '只会删除目标用户在上述范围内、早于截止时间且不在排除项中的消息。点击“立即开始”即确认执行。',
    ].filter(Boolean).join('\n');

    const userMenu = new UserSelectMenuBuilder()
        .setCustomId(ID.USER)
        .setPlaceholder('1️⃣ 选择要帮助冲水的用户')
        .setMinValues(0)
        .setMaxValues(1);
    if (draft.targetUserId && draft.targetSelectedViaMenu) userMenu.setDefaultUsers(draft.targetUserId);

    const scopeMenu = new ChannelSelectMenuBuilder()
        .setCustomId(ID.SCOPE)
        .setPlaceholder(draft.entireGuild ? '2️⃣ 已启用全服务器范围' : '2️⃣ 选择要清理的频道、论坛或分类（最多 25 个）')
        .setChannelTypes(...CLEANUP_CHANNEL_TYPES)
        .setMinValues(0)
        .setMaxValues(25)
        .setDisabled(draft.entireGuild);
    if (draft.selectedChannelIds.length) scopeMenu.setDefaultChannels(...draft.selectedChannelIds.slice(0, 25));

    const excludeMenu = new ChannelSelectMenuBuilder()
        .setCustomId(ID.EXCLUDE)
        .setPlaceholder('3️⃣ 可选：排除频道、子区、论坛帖子或分类')
        .setChannelTypes(...CLEANUP_CHANNEL_TYPES)
        .setMinValues(0)
        .setMaxValues(25);
    if (draft.excludedSelectedIds.length) excludeMenu.setDefaultChannels(...draft.excludedSelectedIds.slice(0, 25));

    const timeMenu = new StringSelectMenuBuilder()
        .setCustomId(ID.TIME)
        .setPlaceholder('4️⃣ 设置“删除此时间之前的消息”')
        .addOptions(
            { label: '全部历史', description: '删除任务启动前的全部目标消息', value: 'all', default: draft.cutoffMode === 'all' },
            { label: '一天前', description: '只删除早于一天前的消息', value: '1d', default: draft.cutoffMode === '1d' },
            { label: '七天前', description: '只删除早于七天前的消息', value: '7d', default: draft.cutoffMode === '7d' },
            { label: '三十天前', description: '只删除早于三十天前的消息', value: '30d', default: draft.cutoffMode === '30d' },
            { label: '自定义北京时间', description: '输入 YYYY-MM-DD HH:mm', value: 'custom', default: draft.cutoffMode === 'custom' },
        );

    const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(ID.TOGGLE_THREADS)
            .setLabel(draft.includeThreads ? '子区：包含' : '子区：不含')
            .setStyle(draft.includeThreads ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(draft.entireGuild),
        new ButtonBuilder()
            .setCustomId(ID.TOGGLE_GUILD_SCOPE)
            .setLabel(draft.entireGuild ? '范围：全服务器' : '范围：改为全服')
            .setStyle(draft.entireGuild ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(ID.EDIT_IDS).setLabel('输入用户 ID').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(ID.TASKS).setLabel('任务').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(ID.START).setLabel('立即开始').setStyle(ButtonStyle.Danger),
    );

    return {
        content: content.slice(0, 2000),
        components: [
            new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userMenu),
            new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(scopeMenu),
            new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(excludeMenu),
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(timeMenu),
            controls,
        ],
    };
}

function permissionsView(guildId: string): InteractionUpdateOptions {
    const settings = getSettings(guildId);
    const roles = settings.manageRoleIds.length
        ? settings.manageRoleIds.map(id => `<@&${id}>`).join(' ')
        : '_未配置：只有服主和 Discord Administrator 可以使用_';
    const menu = new RoleSelectMenuBuilder()
        .setCustomId(ID.ROLES)
        .setPlaceholder('选择允许执行冲水的管理身份组；清空即恢复默认')
        .setMinValues(0)
        .setMaxValues(25);
    if (settings.manageRoleIds.length) menu.setDefaultRoles(...settings.manageRoleIds.slice(0, 25));

    return {
        content: `## 🔐 冲水权限\n**当前管理身份组：** ${roles}\n\n只有服主和 Discord Administrator 能修改这里。`,
        components: [
            new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(menu),
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(ID.HOME).setLabel('返回冲水面板').setStyle(ButtonStyle.Secondary),
            ),
        ],
    };
}

const STATUS_LABEL: Record<CleanupJobStatus, string> = {
    queued: '🕐 等待开始',
    running: '🔄 正在清理',
    paused: '⏸️ 已暂停',
    cancelled: '🚫 已取消',
    completed: '✅ 已完成',
    failed: '❌ 失败',
};

function jobStage(job: CleanupJob, scanFinished: boolean): string {
    if (job.status === 'completed') return '完整核验与删除队列均已结束';
    if (job.status === 'cancelled') return '任务已取消，待删除队列已停止';
    if (job.status === 'failed') return '任务因异常停止';
    if (job.status === 'paused') return scanFinished ? '扫描已完成，删除队列已暂停' : '扫描器与删除器均已暂停';
    if (job.status === 'queued') return scanFinished ? '扫描已完成，等待删除器继续' : '等待扫描器与删除器开始或继续';
    if (scanFinished) return '扫描已完成，删除器正在清空待删除队列';
    if (job.scanMode === 'search') return '扫描器：快速搜索；删除器：并行工作中';
    return `扫描器：完整核验 ${Math.min(job.cursorBatch + 1, Math.max(job.scopeCount, 1))}/${Math.max(job.scopeCount, 1)}；删除器：并行工作中`;
}

function jobLine(job: CleanupJob): string {
    const active = job.status === 'queued' || job.status === 'running' || job.status === 'paused';
    const scanFinished = job.scanCompletedAt !== null || job.status === 'completed';
    const foundLabel = scanFinished
        ? '最终找到'
        : job.status === 'running'
            ? '已发现（仍会增长）'
            : '已发现（扫描未完成）';
    const counts = `${foundLabel} ${job.foundCount} / 待删除 ${job.pendingCount} / 已删除 ${job.deletedCount} / 跳过 ${job.skippedCount} / 失败 ${job.failedCount}`;
    const error = job.error ? `\n错误：${job.error.slice(0, 180)}` : '';
    const warning = job.warningText ? '　⚠️ 有提示' : '';
    const stage = jobStage(job, scanFinished);
    const heading = active
        ? `#${job.id} ${STATUS_LABEL[job.status]}　<@${job.targetUserId}>`
        : STATUS_LABEL[job.status];
    const scope = job.entireGuild
        ? `全服务器 · ${job.scopeCount || '待展开'} 个频道/子区`
        : `${job.scopeCount || '待展开'} 个频道/子区`;
    return `**${heading}**${warning}\n${counts}\n${stage}　范围 ${scope}${error}`;
}

function tasksView(guildId: string, configurable: boolean, notice?: string): InteractionUpdateOptions {
    const clearing = isJobListClearing(guildId);
    const jobs = clearing ? [] : listJobs(guildId, 10);
    const active = clearing ? null : findActiveJob(guildId);
    const lines = jobs.length ? jobs.map(jobLine).join('\n\n') : '_还没有冲水任务。_';
    const detail = active?.warningText
        ? `\n\n**当前任务提示：**\n${active.warningText.slice(0, 700)}`
        : active?.error
            ? `\n\n**当前任务错误：** ${active.error.slice(0, 700)}`
            : '';

    const buttons = [
        new ButtonBuilder().setCustomId(ID.REFRESH).setLabel('刷新').setStyle(ButtonStyle.Primary),
    ];
    if (active) {
        buttons.push(
            active.status === 'paused'
                ? new ButtonBuilder().setCustomId(ID.RESUME).setLabel('继续').setStyle(ButtonStyle.Success)
                : new ButtonBuilder().setCustomId(ID.PAUSE).setLabel('暂停').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(ID.CANCEL).setLabel('取消任务').setStyle(ButtonStyle.Danger),
        );
    }
    if (jobs.length > 0) {
        buttons.push(new ButtonBuilder().setCustomId(ID.CLEAR).setLabel('清空列表').setStyle(ButtonStyle.Secondary));
    }
    const navigation = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(ID.HOME).setLabel('返回').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(ID.PERMISSIONS).setLabel('权限').setStyle(ButtonStyle.Secondary).setDisabled(!configurable),
    );

    return {
        content: (`${notice ? `${notice}\n\n` : ''}## 📋 冲水任务\n_扫描和删除相互独立；“待删除”会持续被后台删除器消费。扫描完成后“最终找到”才是完整数量。_\n\n${lines}${detail}`).slice(0, 2000),
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons), navigation],
    };
}

function timeModal(): ModalBuilder {
    return new ModalBuilder()
        .setCustomId(ID.TIME_MODAL)
        .setTitle('设置清理截止时间')
        .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId(ID.TIME_INPUT)
                    .setLabel('北京时间（删除早于此时间的消息）')
                    .setPlaceholder('2026-09-12 18:30 或 2026-09-12')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(32),
            ),
        );
}

function idsModal(draft: CleanupDraft): ModalBuilder {
    const target = new TextInputBuilder()
        .setCustomId(ID.TARGET_ID_INPUT)
        .setLabel('目标用户 ID（可用于已退服用户）')
        .setPlaceholder('粘贴用户 ID 或用户提及；已有目标时留空则保持')
        .setStyle(TextInputStyle.Short)
        .setRequired(!draft.targetUserId)
        .setMaxLength(64);
    if (draft.targetUserId) target.setValue(draft.targetUserId);

    const exclusions = new TextInputBuilder()
        .setCustomId(ID.EXCLUDE_IDS_INPUT)
        .setLabel('额外排除的频道/子区/论坛帖链接或 ID')
        .setPlaceholder('每行一个；再次打开可编辑或清空')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(2000);
    if (draft.excludedManualIds.length) exclusions.setValue(draft.excludedManualIds.join('\n'));

    return new ModalBuilder()
        .setCustomId(ID.IDS_MODAL)
        .setTitle('输入目标用户 ID')
        .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(target),
            new ActionRowBuilder<TextInputBuilder>().addComponents(exclusions),
        );
}

function firstSnowflake(raw: string): string | null {
    return raw.match(/\d{17,20}/)?.[0] ?? null;
}

function scopeIdsFromText(raw: string): string[] {
    const result = new Set<string>();
    const linkPattern = /(?:https?:\/\/)?(?:\w+\.)?discord(?:app)?\.com\/channels\/(?:@me|\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?/gi;
    let remaining = raw;
    for (const match of raw.matchAll(linkPattern)) {
        result.add(match[1]);
        remaining = remaining.replace(match[0], ' ');
    }
    for (const id of remaining.match(/\d{17,20}/g) ?? []) result.add(id);
    return [...result];
}

async function deny(interaction: ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction, text: string): Promise<void> {
    await interaction.reply({ content: `❌ ${text}`, flags: MessageFlags.Ephemeral }).catch(() => {});
}

export async function openCleanupPanel(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const member = interaction.member as GuildMember | null;
    resetDraft(guildId, interaction.user.id);
    const view = mainView(guildId, interaction.user.id, canConfigureCleanup(member));
    await interaction.reply({
        content: typeof view.content === 'string' ? view.content : undefined,
        components: view.components,
        flags: MessageFlags.Ephemeral,
    });
}

export async function handleCleanupSelect(interaction: AnySelectMenuInteraction): Promise<void> {
    if (!interaction.customId.startsWith(ID.PREFIX) || !interaction.guildId) return;
    const guildId = interaction.guildId;
    const member = memberOf(interaction);
    if (!canManageCleanup(guildId, member)) {
        await deny(interaction, '你没有使用冲水面板的权限。');
        return;
    }

    const draft = getDraft(guildId, interaction.user.id);
    if (interaction.customId === ID.USER && interaction.isUserSelectMenu()) {
        const user = interaction.users.first();
        if (user?.bot) {
            await deny(interaction, '目标必须是真实用户，不能选择 Bot。');
            return;
        }
        draft.targetUserId = interaction.values[0] ?? null;
        draft.targetSelectedViaMenu = Boolean(draft.targetUserId);
        await interaction.update(mainView(guildId, interaction.user.id, canConfigureCleanup(member)));
        return;
    }
    if (interaction.customId === ID.SCOPE && interaction.isChannelSelectMenu()) {
        draft.selectedChannelIds = [...interaction.values];
        await interaction.update(mainView(guildId, interaction.user.id, canConfigureCleanup(member)));
        return;
    }
    if (interaction.customId === ID.EXCLUDE && interaction.isChannelSelectMenu()) {
        draft.excludedSelectedIds = [...interaction.values];
        await interaction.update(mainView(guildId, interaction.user.id, canConfigureCleanup(member)));
        return;
    }
    if (interaction.customId === ID.TIME && interaction.isStringSelectMenu()) {
        const mode = interaction.values[0] as CutoffMode;
        if (mode === 'custom') {
            await interaction.showModal(timeModal());
            return;
        }
        if (mode === 'all' || mode === '1d' || mode === '7d' || mode === '30d') draft.cutoffMode = mode;
        await interaction.update(mainView(guildId, interaction.user.id, canConfigureCleanup(member)));
        return;
    }
    if (interaction.customId === ID.ROLES && interaction.isRoleSelectMenu()) {
        if (!canConfigureCleanup(member)) {
            await deny(interaction, '只有服主和 Discord Administrator 能修改冲水权限。');
            return;
        }
        const roleIds = interaction.values.filter(id => {
            if (id === guildId) return false; // 禁止 @everyone，避免误把清理权发给全服。
            const role = interaction.roles.get(id);
            return !role?.managed;
        });
        setManageRoleIds(guildId, roleIds, interaction.user.id);
        await interaction.update(permissionsView(guildId));
    }
}

export async function handleCleanupButton(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.customId.startsWith(ID.PREFIX) || !interaction.guildId) return;
    const guildId = interaction.guildId;
    const member = memberOf(interaction);
    if (!canManageCleanup(guildId, member)) {
        await deny(interaction, '你没有使用冲水面板的权限。');
        return;
    }
    const configurable = canConfigureCleanup(member);
    const draft = getDraft(guildId, interaction.user.id);

    if (interaction.customId === ID.HOME) {
        await interaction.update(mainView(guildId, interaction.user.id, configurable));
        return;
    }
    if (interaction.customId === ID.TOGGLE_THREADS) {
        draft.includeThreads = !draft.includeThreads;
        await interaction.update(mainView(guildId, interaction.user.id, configurable));
        return;
    }
    if (interaction.customId === ID.TOGGLE_GUILD_SCOPE) {
        draft.entireGuild = !draft.entireGuild;
        if (draft.entireGuild) draft.includeThreads = true;
        await interaction.update(mainView(guildId, interaction.user.id, configurable));
        return;
    }
    if (interaction.customId === ID.EDIT_IDS) {
        await interaction.showModal(idsModal(draft));
        return;
    }
    if (interaction.customId === ID.PERMISSIONS) {
        if (!configurable) {
            await deny(interaction, '只有服主和 Discord Administrator 能修改冲水权限。');
            return;
        }
        await interaction.update(permissionsView(guildId));
        return;
    }
    if (interaction.customId === ID.TASKS || interaction.customId === ID.REFRESH) {
        await interaction.update(tasksView(guildId, configurable));
        return;
    }

    if (interaction.customId === ID.CLEAR) {
        const result = requestJobListClear(guildId, interaction.user.id);
        if (!result.accepted) {
            await interaction.update(tasksView(guildId, configurable, '列表暂时无法更新，请稍后再试。'));
            return;
        }
        clearGuildDrafts(guildId);
        await interaction.update(tasksView(guildId, configurable));
        return;
    }

    const active = findActiveJob(guildId);
    if (interaction.customId === ID.PAUSE) {
        if (active) pauseJob(active.id, interaction.user.id);
        await interaction.update(tasksView(guildId, configurable));
        return;
    }
    if (interaction.customId === ID.RESUME) {
        if (active) resumeJob(active.id, interaction.user.id);
        await interaction.update(tasksView(guildId, configurable));
        return;
    }
    if (interaction.customId === ID.CANCEL) {
        if (active) cancelJob(active.id, interaction.user.id);
        await interaction.update(tasksView(guildId, configurable));
        return;
    }
    if (interaction.customId === ID.START) {
        if (!draft.targetUserId) {
            await interaction.update(mainView(guildId, interaction.user.id, configurable, '❌ 请先选择目标用户。'));
            return;
        }
        if (!draft.entireGuild && draft.selectedChannelIds.length === 0) {
            await interaction.update(mainView(guildId, interaction.user.id, configurable, '❌ 请至少选择一个清理频道、论坛或分类。'));
            return;
        }

        await interaction.deferUpdate();
        const knownUser = await interaction.client.users.fetch(draft.targetUserId).catch(() => null);
        if (knownUser?.bot) {
            await interaction.editReply(mainView(guildId, interaction.user.id, configurable, '❌ 目标必须是真实用户，不能是 Bot。'));
            return;
        }

        const cutoff = cutoffForDraft(draft);
        const result = createJob({
            guildId,
            actorId: interaction.user.id,
            targetUserId: draft.targetUserId,
            selectedChannelIds: draft.selectedChannelIds,
            entireGuild: draft.entireGuild,
            excludedChannelIds: excludedIds(draft),
            includeThreads: draft.includeThreads,
            cutoffAt: cutoff.timestamp,
            cutoffLabel: cutoff.label,
        });
        if (!result.job) {
            await interaction.editReply(mainView(guildId, interaction.user.id, configurable, '列表正在更新，请稍后再试。'));
            return;
        }
        const prefix = result.created
            ? `✅ 已启动紧急冲水任务 #${result.job.id}。\n\n`
            : `⚠️ 本服务器已有未结束的任务 #${result.job.id}，未重复创建。\n\n`;
        const view = tasksView(guildId, configurable);
        await interaction.editReply({ ...view, content: `${prefix}${view.content ?? ''}`.slice(0, 2000) });
    }
}

export async function handleCleanupModal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.customId.startsWith(ID.PREFIX) || !interaction.guildId) return;
    const guildId = interaction.guildId;
    const member = memberOf(interaction);
    if (!canManageCleanup(guildId, member)) {
        await deny(interaction, '你没有使用冲水面板的权限。');
        return;
    }
    const draft = getDraft(guildId, interaction.user.id);

    if (interaction.customId === ID.TIME_MODAL) {
        const raw = interaction.fields.getTextInputValue(ID.TIME_INPUT);
        const parsed = parseCleanupCutoff(raw);
        if (!parsed) {
            await deny(interaction, '时间格式无效或时间在未来。请使用北京时间 YYYY-MM-DD HH:mm。');
            return;
        }
        draft.cutoffMode = 'custom';
        draft.customCutoffAt = parsed;
        if (interaction.isFromMessage()) {
            await interaction.update(mainView(guildId, interaction.user.id, canConfigureCleanup(member)));
        } else {
            await interaction.reply({ content: '✅ 截止时间已保存，请返回冲水面板继续。', flags: MessageFlags.Ephemeral });
        }
        return;
    }

    if (interaction.customId === ID.IDS_MODAL) {
        const targetRaw = interaction.fields.getTextInputValue(ID.TARGET_ID_INPUT).trim();
        const excludeRaw = interaction.fields.getTextInputValue(ID.EXCLUDE_IDS_INPUT);
        if (targetRaw) {
            const targetId = firstSnowflake(targetRaw);
            if (!targetId) {
                await deny(interaction, '目标用户 ID 无效。');
                return;
            }
            draft.targetUserId = targetId;
            draft.targetSelectedViaMenu = false;
        }
        draft.excludedManualIds = scopeIdsFromText(excludeRaw);
        if (interaction.isFromMessage()) {
            await interaction.update(mainView(guildId, interaction.user.id, canConfigureCleanup(member)));
        } else {
            await interaction.reply({ content: '✅ ID 设置已保存，请返回冲水面板继续。', flags: MessageFlags.Ephemeral });
        }
    }
}
