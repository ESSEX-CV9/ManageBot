import {
    ChannelType,
    MessageFlags,
    SlashCommandBuilder,
    type GuildMember,
    type Role,
} from 'discord.js';
import type { Command } from '../../../core/types';
import { checkAdminPermission, getPermissionDeniedMessage } from '../../../core/utils/permissionManager';
import {
    addAudit,
    addChannel,
    addConflictRole,
    addFrogCallerRole,
    createConfig,
    deleteConfig,
    getActiveRound,
    getConfigByRole,
    getFrogSettings,
    listAudit,
    listConfigs,
    listFrogCallerRoleIds,
    removeChannel,
    removeConflictRole,
    removeFrogCallerRole,
    setFrogRole,
    setFrogCooldown,
    updateConfig,
    type RotationChannelKind,
} from '../services/roleRotationDatabase';
import {
    closeRecruitment,
    countNonBotMembers,
    settleInquiry,
    startInquiry,
    startRecruitmentNow,
    syncRoleMembers,
} from '../services/roleRotationService';
import {
    computeNextMonthlyRun,
    isValidClockTime,
    isValidTimeZone,
} from '../services/rotationTime';

const DEFAULT_DAY = 15;
const DEFAULT_TIME = '09:00';
const DEFAULT_TIMEZONE = 'Asia/Shanghai';

const data = new SlashCommandBuilder()
    .setName('分管轮替')
    .setDescription('配置分管身份组的月度留任问询与自动招募')
    .addSubcommand(sub => sub
        .setName('创建')
        .setDescription('为一个身份组创建轮替配置')
        .addRoleOption(option => option.setName('身份组').setDescription('需要轮替管理的身份组').setRequired(true))
        .addIntegerOption(option => option.setName('人数上限').setDescription('非 Bot 成员人数上限').setMinValue(1).setMaxValue(1000).setRequired(true)))
    .addSubcommand(sub => sub
        .setName('删除')
        .setDescription('删除一个轮替配置（存在进行中场次时不可删除）')
        .addRoleOption(option => option.setName('身份组').setDescription('被管理的身份组').setRequired(true)))
    .addSubcommand(sub => sub
        .setName('查看')
        .setDescription('查看轮替配置与当前状态')
        .addRoleOption(option => option.setName('身份组').setDescription('留空查看全部配置').setRequired(false)))
    .addSubcommand(sub => sub
        .setName('设置规则')
        .setDescription('修改人数、资格与月度执行规则')
        .addRoleOption(option => option.setName('身份组').setDescription('被管理的身份组').setRequired(true))
        .addIntegerOption(option => option.setName('人数上限').setDescription('非 Bot 成员人数上限').setMinValue(1).setMaxValue(1000))
        .addIntegerOption(option => option.setName('最低入服天数').setDescription('0 表示不限制').setMinValue(0).setMaxValue(3650))
        .addIntegerOption(option => option.setName('问询日').setDescription('每月几号，范围 1-28').setMinValue(1).setMaxValue(28))
        .addStringOption(option => option.setName('问询时间').setDescription('当地时间，格式 HH:mm，例如 09:00').setMaxLength(5))
        .addStringOption(option => option.setName('时区').setDescription('IANA 时区，例如 Asia/Shanghai').setMaxLength(64))
        .addIntegerOption(option => option.setName('问询时长小时').setDescription('默认 48 小时').setMinValue(1).setMaxValue(168))
        .addBooleanOption(option => option.setName('是否启用').setDescription('是否自动按月发起问询')))
    .addSubcommand(sub => sub
        .setName('添加频道')
        .setDescription('添加通知频道、招募频道或子区，可重复执行以配置多个')
        .addRoleOption(option => option.setName('身份组').setDescription('被管理的身份组').setRequired(true))
        .addStringOption(option => option.setName('类型').setDescription('频道用途').setRequired(true)
            .addChoices({ name: '通知频道', value: 'notification' }, { name: '招募频道', value: 'recruitment' }))
        .addChannelOption(option => option.setName('频道').setDescription('普通频道或论坛（子区看不到时留空）').setRequired(false)
            .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
                ChannelType.GuildForum,
                ChannelType.GuildMedia,
                ChannelType.PublicThread,
                ChannelType.PrivateThread,
                ChannelType.AnnouncementThread,
            ))
        .addStringOption(option => option.setName('频道或子区id').setDescription('选择器看不到时，粘贴频道/子区/论坛帖子 ID 或频道提及').setMaxLength(100)))
    .addSubcommand(sub => sub
        .setName('移除频道')
        .setDescription('从配置中移除通知频道、招募频道或子区')
        .addRoleOption(option => option.setName('身份组').setDescription('被管理的身份组').setRequired(true))
        .addStringOption(option => option.setName('类型').setDescription('频道用途').setRequired(true)
            .addChoices({ name: '通知频道', value: 'notification' }, { name: '招募频道', value: 'recruitment' }))
        .addChannelOption(option => option.setName('频道').setDescription('普通频道或论坛（子区看不到时留空）').setRequired(false)
            .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
                ChannelType.GuildForum,
                ChannelType.GuildMedia,
                ChannelType.PublicThread,
                ChannelType.PrivateThread,
                ChannelType.AnnouncementThread,
            ))
        .addStringOption(option => option.setName('频道或子区id').setDescription('选择器看不到时，粘贴频道/子区/论坛帖子 ID 或频道提及').setMaxLength(100)))
    .addSubcommand(sub => sub
        .setName('添加冲突')
        .setDescription('添加申请时互斥的身份组')
        .addRoleOption(option => option.setName('身份组').setDescription('被管理的身份组').setRequired(true))
        .addRoleOption(option => option.setName('冲突身份组').setDescription('持有它的人不能申请').setRequired(true)))
    .addSubcommand(sub => sub
        .setName('移除冲突')
        .setDescription('移除一个互斥身份组')
        .addRoleOption(option => option.setName('身份组').setDescription('被管理的身份组').setRequired(true))
        .addRoleOption(option => option.setName('冲突身份组').setDescription('要移除的身份组').setRequired(true)))
    .addSubcommand(sub => sub
        .setName('设置蛙人')
        .setDescription('设置哪个身份组可以通过 /呼唤蛙人 呼叫自身成员')
        .addRoleOption(option => option.setName('身份组').setDescription('蛙人身份组').setRequired(true)))
    .addSubcommand(sub => sub
        .setName('清除蛙人')
        .setDescription('关闭 /呼唤蛙人 功能'))
    .addSubcommand(sub => sub
        .setName('设置蛙人冷却')
        .setDescription('设置每位成员两次呼唤之间的最短时间')
        .addIntegerOption(option => option.setName('冷却秒数').setDescription('默认 60 秒').setMinValue(1).setMaxValue(86400).setRequired(true)))
    .addSubcommand(sub => sub
        .setName('添加蛙人呼叫组')
        .setDescription('允许一个额外身份组的成员使用 /呼唤蛙人')
        .addRoleOption(option => option.setName('身份组').setDescription('要授权的身份组').setRequired(true)))
    .addSubcommand(sub => sub
        .setName('移除蛙人呼叫组')
        .setDescription('取消一个额外身份组使用 /呼唤蛙人的权限')
        .addRoleOption(option => option.setName('身份组').setDescription('要取消授权的身份组').setRequired(true)))
    .addSubcommand(sub => sub
        .setName('查看蛙人设置')
        .setDescription('查看蛙人目标、额外呼叫身份组和冷却时间'))
    .addSubcommand(sub => sub
        .setName('立即问询')
        .setDescription('立即手动发起一轮问询，不改变下次月度时间')
        .addRoleOption(option => option.setName('身份组').setDescription('被管理的身份组').setRequired(true)))
    .addSubcommand(sub => sub
        .setName('立即招募')
        .setDescription('跳过问询，按实时空位立即发布招募')
        .addRoleOption(option => option.setName('身份组').setDescription('被管理的身份组').setRequired(true)))
    .addSubcommand(sub => sub
        .setName('立即结算')
        .setDescription('提前结算当前问询')
        .addRoleOption(option => option.setName('身份组').setDescription('被管理的身份组').setRequired(true)))
    .addSubcommand(sub => sub
        .setName('结束招募')
        .setDescription('手动结束当前招募并关闭所有频道按钮')
        .addRoleOption(option => option.setName('身份组').setDescription('被管理的身份组').setRequired(true)))
    .addSubcommand(sub => sub
        .setName('审计')
        .setDescription('查看最近的轮替操作记录')
        .addRoleOption(option => option.setName('身份组').setDescription('留空查看所有配置').setRequired(false)));

function getConfiguredRole(interaction: Parameters<Command['execute']>[0]): { role: Role; config: NonNullable<ReturnType<typeof getConfigByRole>> } | null {
    const role = interaction.options.getRole('身份组', true) as Role;
    const config = getConfigByRole(interaction.guildId!, role.id);
    return config ? { role, config } : null;
}

function channelKindLabel(kind: RotationChannelKind): string {
    return kind === 'notification' ? '通知频道' : '招募频道';
}

function parseChannelId(raw: string | null): string | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    const mention = trimmed.match(/^<#(\d{15,25})>$/);
    if (mention) return mention[1];
    return /^\d{15,25}$/.test(trimmed) ? trimmed : null;
}

const SUPPORTED_DESTINATION_TYPES = new Set<ChannelType>([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildForum,
    ChannelType.GuildMedia,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
]);

function statusLabel(status: string): string {
    return ({ inquiry: '问询中', recruiting: '招募中', closed: '已结束', cancelled: '已取消', failed: '失败' } as Record<string, string>)[status] ?? status;
}

function auditLabel(event: string): string {
    return ({
        config_created: '创建配置',
        config_updated: '修改规则',
        config_deleted: '删除配置',
        channel_added: '添加频道',
        channel_removed: '移除频道',
        conflict_added: '添加冲突身份组',
        conflict_removed: '移除冲突身份组',
        frog_role_set: '设置蛙人身份组',
        frog_role_cleared: '清除蛙人身份组',
        frog_cooldown_set: '设置蛙人冷却',
        frog_caller_role_added: '添加蛙人呼叫身份组',
        frog_caller_role_removed: '移除蛙人呼叫身份组',
        inquiry_started: '发起问询',
        inquiry_settled: '结算问询',
        recruitment_started_manual: '立即发起招募',
        response_keep: '选择继续担任',
        response_leave: '选择不再担任',
        role_removed_leave: '按选择卸任',
        role_removed_timeout: '超时卸任',
        role_remove_failed: '卸任失败',
        application_accepted: '申请成功',
        role_grant_failed: '授予失败',
        recruitment_closed: '结束招募',
        membership_added_detected: '检测到成员加入',
        membership_removed_detected: '检测到成员离开',
    } as Record<string, string>)[event] ?? event;
}

const command: Command = {
    data,
    async execute(interaction) {
        if (!interaction.guild || !interaction.guildId) {
            return interaction.reply({ content: '❌ 此命令只能在服务器中使用。', flags: MessageFlags.Ephemeral });
        }
        if (!checkAdminPermission(interaction.member as GuildMember | null)) {
            return interaction.reply({ content: getPermissionDeniedMessage(), flags: MessageFlags.Ephemeral });
        }

        const guild = interaction.guild;
        const sub = interaction.options.getSubcommand();

        if (sub === '创建') {
            const role = interaction.options.getRole('身份组', true) as Role;
            const capacity = interaction.options.getInteger('人数上限', true);
            if (role.id === guild.id || role.managed) {
                return interaction.reply({ content: '❌ 不能管理 @everyone 或由外部集成托管的身份组。', flags: MessageFlags.Ephemeral });
            }
            if (getConfigByRole(guild.id, role.id)) {
                return interaction.reply({ content: '⚠️ 这个身份组已经有轮替配置。', flags: MessageFlags.Ephemeral });
            }
            if (!guild.members.me || !role.editable) {
                return interaction.reply({
                    content: '❌ 机器人当前无法增删这个身份组。请授予“管理身份组”权限，并把机器人身份组移动到目标身份组上方。',
                    flags: MessageFlags.Ephemeral,
                });
            }
            const nextRunAt = computeNextMonthlyRun(DEFAULT_DAY, DEFAULT_TIME, DEFAULT_TIMEZONE);
            const config = createConfig({ guildId: guild.id, managedRoleId: role.id, capacity, nextRunAt, createdBy: interaction.user.id });
            syncRoleMembers(config, role);
            addAudit({ guildId: guild.id, configId: config.id, actorId: interaction.user.id, event: 'config_created', detail: `capacity=${capacity}` });
            return interaction.reply({
                content: `✅ 已为 ${role} 创建轮替配置。默认每月 15 日 09:00（Asia/Shanghai）问询 48 小时。\n下一步请分别添加至少一个通知频道和招募频道，并按需设置最低入服天数与冲突身份组。`,
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
        }

        if (sub === '删除') {
            const found = getConfiguredRole(interaction);
            if (!found) return interaction.reply({ content: '❌ 该身份组没有轮替配置。', flags: MessageFlags.Ephemeral });
            const active = getActiveRound(found.config.id);
            if (active) {
                return interaction.reply({
                    content: `❌ 场次 #${active.id} 正处于“${statusLabel(active.status)}”，请先结算问询或结束招募。`,
                    flags: MessageFlags.Ephemeral,
                });
            }
            addAudit({ guildId: guild.id, configId: found.config.id, actorId: interaction.user.id, event: 'config_deleted', detail: `role=${found.role.id}` });
            deleteConfig(found.config.id);
            return interaction.reply({ content: `✅ 已删除 ${found.role} 的轮替配置。`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        }

        if (sub === '设置规则') {
            const found = getConfiguredRole(interaction);
            if (!found) return interaction.reply({ content: '❌ 该身份组没有轮替配置。', flags: MessageFlags.Ephemeral });
            const capacity = interaction.options.getInteger('人数上限') ?? found.config.capacity;
            const minTenureDays = interaction.options.getInteger('最低入服天数') ?? found.config.minTenureDays;
            const scheduleDay = interaction.options.getInteger('问询日') ?? found.config.scheduleDay;
            const scheduleTime = interaction.options.getString('问询时间')?.trim() ?? found.config.scheduleTime;
            const timezone = interaction.options.getString('时区')?.trim() ?? found.config.timezone;
            const inquiryHours = interaction.options.getInteger('问询时长小时') ?? found.config.inquiryHours;
            const enabled = interaction.options.getBoolean('是否启用') ?? found.config.enabled;
            if (!isValidClockTime(scheduleTime)) {
                return interaction.reply({ content: '❌ 问询时间格式应为 HH:mm，例如 09:00。', flags: MessageFlags.Ephemeral });
            }
            if (!isValidTimeZone(timezone)) {
                return interaction.reply({ content: '❌ 时区无效，请填写 IANA 时区，例如 Asia/Shanghai。', flags: MessageFlags.Ephemeral });
            }
            const scheduleChanged = scheduleDay !== found.config.scheduleDay
                || scheduleTime !== found.config.scheduleTime
                || timezone !== found.config.timezone
                || (enabled && !found.config.enabled);
            const nextRunAt = scheduleChanged
                ? computeNextMonthlyRun(scheduleDay, scheduleTime, timezone)
                : found.config.nextRunAt;
            const updated = updateConfig(found.config.id, {
                capacity,
                minTenureDays,
                scheduleDay,
                scheduleTime,
                timezone,
                inquiryHours,
                enabled,
                nextRunAt,
            })!;
            addAudit({ guildId: guild.id, configId: updated.id, actorId: interaction.user.id, event: 'config_updated', detail: JSON.stringify({ capacity, minTenureDays, scheduleDay, scheduleTime, timezone, inquiryHours, enabled }) });
            return interaction.reply({
                content: `✅ 已更新 ${found.role}：上限 ${capacity} 人，最低入服 ${minTenureDays} 天，每月 ${scheduleDay} 日 ${scheduleTime}（${timezone}）问询 ${inquiryHours} 小时，自动执行${enabled ? '已启用' : '已停用'}。`,
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
        }

        if (sub === '添加频道' || sub === '移除频道') {
            const found = getConfiguredRole(interaction);
            if (!found) return interaction.reply({ content: '❌ 该身份组没有轮替配置。', flags: MessageFlags.Ephemeral });
            const kind = interaction.options.getString('类型', true) as RotationChannelKind;
            const selectedChannel = interaction.options.getChannel('频道');
            const rawValue = interaction.options.getString('频道或子区id');
            if (selectedChannel && rawValue) {
                return interaction.reply({ content: '❌ “频道”和“频道或子区id”只需填写其中一个。', flags: MessageFlags.Ephemeral });
            }
            const parsedId = parseChannelId(rawValue);
            if (!selectedChannel && !parsedId) {
                return interaction.reply({
                    content: rawValue
                        ? '❌ 无法识别该 ID。请粘贴纯频道/子区 ID，或 `<#频道ID>` 格式的频道提及。'
                        : '❌ 请选择频道，或填写“频道或子区id”。',
                    flags: MessageFlags.Ephemeral,
                });
            }
            const channelId = selectedChannel?.id ?? parsedId!;
            const adding = sub === '添加频道';
            const fetchedChannel = selectedChannel
                ?? await interaction.client.channels.fetch(channelId).catch(() => null);
            if (adding) {
                if (!fetchedChannel || !('guildId' in fetchedChannel) || fetchedChannel.guildId !== guild.id) {
                    return interaction.reply({ content: '❌ 机器人无法访问这个频道/子区，或它不属于当前服务器。', flags: MessageFlags.Ephemeral });
                }
                if (!SUPPORTED_DESTINATION_TYPES.has(fetchedChannel.type)) {
                    return interaction.reply({ content: '❌ 仅支持文字/公告频道、论坛/媒体频道，以及公开、私密或公告子区。', flags: MessageFlags.Ephemeral });
                }
            }
            const changed = adding
                ? addChannel(found.config.id, kind, channelId)
                : removeChannel(found.config.id, kind, channelId);
            if (changed) addAudit({
                guildId: guild.id,
                configId: found.config.id,
                actorId: interaction.user.id,
                event: adding ? 'channel_added' : 'channel_removed',
                detail: `${kind}:${channelId}`,
            });
            return interaction.reply({
                content: `${changed ? '✅' : 'ℹ️'} <#${channelId}> ${changed ? `已${adding ? '添加到' : '移出'}` : '配置未变化：'}${channelKindLabel(kind)}。`,
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
        }

        if (sub === '添加冲突' || sub === '移除冲突') {
            const found = getConfiguredRole(interaction);
            if (!found) return interaction.reply({ content: '❌ 该身份组没有轮替配置。', flags: MessageFlags.Ephemeral });
            const conflict = interaction.options.getRole('冲突身份组', true) as Role;
            if (conflict.id === found.role.id) {
                return interaction.reply({ content: '❌ 目标身份组不能与自身冲突。', flags: MessageFlags.Ephemeral });
            }
            const adding = sub === '添加冲突';
            const changed = adding
                ? addConflictRole(found.config.id, conflict.id)
                : removeConflictRole(found.config.id, conflict.id);
            if (changed) addAudit({
                guildId: guild.id,
                configId: found.config.id,
                actorId: interaction.user.id,
                event: adding ? 'conflict_added' : 'conflict_removed',
                detail: conflict.id,
            });
            return interaction.reply({
                content: `${changed ? '✅' : 'ℹ️'} ${conflict} ${changed ? `已${adding ? '加入' : '移出'}冲突列表` : '配置未变化'}。`,
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
        }

        if (sub === '设置蛙人' || sub === '清除蛙人') {
            const role = sub === '设置蛙人' ? interaction.options.getRole('身份组', true) as Role : null;
            if (role && role.id === guild.id) {
                return interaction.reply({ content: '❌ 不能把 @everyone 设置为蛙人身份组。', flags: MessageFlags.Ephemeral });
            }
            setFrogRole(guild.id, role?.id ?? null, interaction.user.id);
            addAudit({ guildId: guild.id, actorId: interaction.user.id, event: role ? 'frog_role_set' : 'frog_role_cleared', detail: role?.id });
            const cooldown = getFrogSettings(guild.id).cooldownSeconds;
            return interaction.reply({
                content: role
                    ? `✅ 已将 ${role} 设置为蛙人身份组；其成员现在可以使用 \`/呼唤蛙人\`，每人冷却 ${cooldown} 秒。`
                    : '✅ 已关闭呼唤蛙人功能。',
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
        }

        if (sub === '设置蛙人冷却') {
            const cooldownSeconds = interaction.options.getInteger('冷却秒数', true);
            setFrogCooldown(guild.id, cooldownSeconds, interaction.user.id);
            addAudit({
                guildId: guild.id,
                actorId: interaction.user.id,
                event: 'frog_cooldown_set',
                detail: `seconds=${cooldownSeconds}`,
            });
            return interaction.reply({
                content: `✅ 每位成员的蛙人呼唤冷却已设置为 ${cooldownSeconds} 秒。`,
                flags: MessageFlags.Ephemeral,
            });
        }

        if (sub === '添加蛙人呼叫组' || sub === '移除蛙人呼叫组') {
            const role = interaction.options.getRole('身份组', true) as Role;
            if (role.id === guild.id) {
                return interaction.reply({ content: '❌ 不能授权 @everyone 使用呼唤指令。', flags: MessageFlags.Ephemeral });
            }
            const adding = sub === '添加蛙人呼叫组';
            const changed = adding
                ? addFrogCallerRole(guild.id, role.id)
                : removeFrogCallerRole(guild.id, role.id);
            if (changed) addAudit({
                guildId: guild.id,
                actorId: interaction.user.id,
                event: adding ? 'frog_caller_role_added' : 'frog_caller_role_removed',
                detail: `role=${role.id}`,
            });
            return interaction.reply({
                content: `${changed ? '✅' : 'ℹ️'} ${role} ${changed ? `已${adding ? '获得' : '失去'}呼唤蛙人的权限` : '配置没有变化'}。`,
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
        }

        if (sub === '查看蛙人设置') {
            const settings = getFrogSettings(guild.id);
            const callerRoleIds = listFrogCallerRoleIds(guild.id);
            return interaction.reply({
                content: [
                    '**蛙人呼叫设置**',
                    `被呼叫身份组：${settings.roleId ? `<@&${settings.roleId}>` : '未配置'}`,
                    `额外可呼叫身份组：${callerRoleIds.map(id => `<@&${id}>`).join('、') || '无'}`,
                    `每人冷却：${settings.cooldownSeconds} 秒`,
                    '',
                    '蛙人身份组自身成员始终拥有呼叫权限。',
                ].join('\n'),
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
        }

        if (sub === '立即问询') {
            const found = getConfiguredRole(interaction);
            if (!found) return interaction.reply({ content: '❌ 该身份组没有轮替配置。', flags: MessageFlags.Ephemeral });
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const result = await startInquiry(interaction.client, found.config, { createdBy: interaction.user.id });
            return interaction.editReply(`${result.ok ? '✅' : '⚠️'} ${result.message}`);
        }

        if (sub === '立即招募') {
            const found = getConfiguredRole(interaction);
            if (!found) return interaction.reply({ content: '❌ 该身份组没有轮替配置。', flags: MessageFlags.Ephemeral });
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const result = await startRecruitmentNow(interaction.client, found.config, interaction.user.id);
            return interaction.editReply(`${result.ok ? '✅' : '⚠️'} ${result.message}`);
        }

        if (sub === '立即结算') {
            const found = getConfiguredRole(interaction);
            if (!found) return interaction.reply({ content: '❌ 该身份组没有轮替配置。', flags: MessageFlags.Ephemeral });
            const round = getActiveRound(found.config.id);
            if (!round || round.status !== 'inquiry') {
                return interaction.reply({ content: '⚠️ 当前没有进行中的问询。', flags: MessageFlags.Ephemeral });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const result = await settleInquiry(interaction.client, round);
            return interaction.editReply(`${result.ok ? '✅' : '⚠️'} ${result.message}`);
        }

        if (sub === '结束招募') {
            const found = getConfiguredRole(interaction);
            if (!found) return interaction.reply({ content: '❌ 该身份组没有轮替配置。', flags: MessageFlags.Ephemeral });
            const round = getActiveRound(found.config.id);
            if (!round || round.status !== 'recruiting') {
                return interaction.reply({ content: '⚠️ 当前没有进行中的招募。', flags: MessageFlags.Ephemeral });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const result = await closeRecruitment(interaction.client, round);
            return interaction.editReply(`${result.ok ? '✅' : '⚠️'} ${result.message}`);
        }

        if (sub === '查看') {
            const selected = interaction.options.getRole('身份组') as Role | null;
            const configs = selected
                ? [getConfigByRole(guild.id, selected.id)].filter(Boolean)
                : listConfigs(guild.id);
            if (!configs.length) {
                return interaction.reply({ content: '当前服务器还没有分管轮替配置。', flags: MessageFlags.Ephemeral });
            }
            const sections: string[] = [];
            for (const config of configs) {
                if (!config) continue;
                const role = guild.roles.cache.get(config.managedRoleId);
                const nonBots = role ? countNonBotMembers(role) : 0;
                const bots = role ? role.members.filter(member => member.user.bot).size : 0;
                const active = getActiveRound(config.id);
                sections.push([
                    `**${role?.toString() ?? `<@&${config.managedRoleId}>`}**（配置 #${config.id}）`,
                    `人数：${nonBots}/${config.capacity}（Bot ${bots}，不计入）｜最低入服：${config.minTenureDays} 天`,
                    `问询：每月 ${config.scheduleDay} 日 ${config.scheduleTime}（${config.timezone}），持续 ${config.inquiryHours} 小时`,
                    `自动执行：${config.enabled ? '开启' : '关闭'}｜下次：<t:${Math.floor(config.nextRunAt / 1000)}:f>`,
                    `通知频道：${config.notificationChannelIds.map(id => `<#${id}>`).join('、') || '未配置'}`,
                    `招募频道：${config.recruitmentChannelIds.map(id => `<#${id}>`).join('、') || '未配置'}`,
                    `冲突身份组：${config.conflictRoleIds.map(id => `<@&${id}>`).join('、') || '无'}`,
                    `当前场次：${active ? `#${active.id} ${statusLabel(active.status)}` : '无'}`,
                ].join('\n'));
            }
            return interaction.reply({
                content: sections.join('\n\n').slice(0, 1950),
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
        }

        if (sub === '审计') {
            const selected = interaction.options.getRole('身份组') as Role | null;
            const config = selected ? getConfigByRole(guild.id, selected.id) : null;
            if (selected && !config) return interaction.reply({ content: '❌ 该身份组没有轮替配置。', flags: MessageFlags.Ephemeral });
            const rows = listAudit(guild.id, config?.id, 20);
            if (!rows.length) return interaction.reply({ content: '暂无审计记录。', flags: MessageFlags.Ephemeral });
            const lines = rows.map(row => {
                const target = row.userId ? `｜用户 <@${row.userId}>` : '';
                const round = row.roundId ? `｜场次 #${row.roundId}` : '';
                const detail = row.detail ? `｜${row.detail.slice(0, 120)}` : '';
                return `<t:${Math.floor(row.createdAt / 1000)}:f>｜${auditLabel(row.event)}${round}${target}${detail}`;
            });
            return interaction.reply({
                content: `**最近的分管轮替记录**\n${lines.join('\n')}`.slice(0, 1950),
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
        }
    },
};

export default command;
