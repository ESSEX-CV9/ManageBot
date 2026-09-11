import {
    PermissionFlagsBits,
    type Client,
    type Guild,
    type GuildMember,
    type GuildTextBasedChannel,
    type Role,
} from 'discord.js';
import {
    addAudit,
    createRound,
    getActiveRound,
    getConfigById,
    getParticipant,
    getRound,
    getRoundByCycle,
    hasApplication,
    listMessages,
    listParticipants,
    markParticipantRemoval,
    recordApplication,
    recordResponse,
    saveMessage,
    syncMembers,
    syncMember,
    updateRound,
    type RoleRotationConfig,
    type RotationResponse,
    type RotationRound,
} from './roleRotationDatabase';
import {
    buildInquiryMessage,
    buildRecruitmentMessage,
} from '../components/rotationMessages';

export interface ServiceResult {
    ok: boolean;
    message: string;
    round?: RotationRound;
}

const locks = new Map<number, Promise<void>>();

/** 同一配置的结算、招募确认和换届发起必须串行，防止名额超发。 */
export async function withConfigLock<T>(configId: number, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(configId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => gate);
    locks.set(configId, queued);
    await previous.catch(() => undefined);
    try {
        return await task();
    } finally {
        release();
        if (locks.get(configId) === queued) locks.delete(configId);
    }
}

export function countNonBotMembers(role: Role): number {
    return role.members.filter(member => !member.user.bot).size;
}

export function syncRoleMembers(config: RoleRotationConfig, role: Role): void {
    syncMembers(config.id, role.members.map(member => ({ userId: member.id, isBot: member.user.bot })));
}

async function fetchGuildAndRole(
    client: Client,
    config: RoleRotationConfig,
): Promise<{ guild: Guild; role: Role } | { error: string }> {
    const guild = client.guilds.cache.get(config.guildId)
        ?? await client.guilds.fetch(config.guildId).catch(() => null);
    if (!guild) return { error: '机器人无法访问该服务器。' };
    const role = guild.roles.cache.get(config.managedRoleId)
        ?? await guild.roles.fetch(config.managedRoleId).catch(() => null);
    if (!role) return { error: '被管理的身份组已不存在。' };
    return { guild, role };
}

function canManageRole(guild: Guild, role: Role): boolean {
    const me = guild.members.me;
    return Boolean(me?.permissions.has(PermissionFlagsBits.ManageRoles) && role.editable);
}

async function sendInquiryMessages(
    client: Client,
    config: RoleRotationConfig,
    round: RotationRound,
    participantCount: number,
    role: Role,
): Promise<{ available: number; errors: string[] }> {
    const existingChannels = new Set(listMessages(round.id, 'inquiry').map(item => item.channelId));
    let available = existingChannels.size;
    const errors: string[] = [];
    for (const channelId of config.notificationChannelIds) {
        if (existingChannels.has(channelId)) continue;
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel?.isSendable() || !('guildId' in channel) || channel.guildId !== config.guildId) {
            errors.push(`<#${channelId}> 不可发送`);
            continue;
        }
        const me = channel.guild.members.me;
        if (
            !role.mentionable
            && 'permissionsFor' in channel
            && (!me || !channel.permissionsFor(me).has(PermissionFlagsBits.MentionEveryone))
        ) {
            errors.push(`<#${channelId}> 缺少提及身份组权限`);
            continue;
        }
        try {
            const message = await channel.send(buildInquiryMessage(config, round, participantCount));
            saveMessage({ roundId: round.id, phase: 'inquiry', channelId, messageId: message.id });
            available++;
        } catch (error) {
            errors.push(`<#${channelId}>：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { available, errors };
}

async function editInquiryMessages(
    client: Client,
    config: RoleRotationConfig,
    round: RotationRound,
    result: { kept: number; removed: number; removalFailed: number },
): Promise<void> {
    const participants = listParticipants(round.id).length;
    for (const item of listMessages(round.id, 'inquiry')) {
        try {
            const channel = await client.channels.fetch(item.channelId);
            if (!channel?.isTextBased()) continue;
            const message = await (channel as GuildTextBasedChannel).messages.fetch(item.messageId);
            await message.edit(buildInquiryMessage(config, round, participants, result));
        } catch (error) {
            console.warn(`[RoleRotation] 无法更新问询消息 ${item.channelId}/${item.messageId}:`, error);
        }
    }
}

async function refreshRecruitmentMessages(
    client: Client,
    config: RoleRotationConfig,
    round: RotationRound,
    currentMembers: number,
    closedReason?: string,
): Promise<void> {
    for (const item of listMessages(round.id, 'recruitment')) {
        try {
            const channel = await client.channels.fetch(item.channelId);
            if (!channel?.isTextBased()) continue;
            const message = await (channel as GuildTextBasedChannel).messages.fetch(item.messageId);
            await message.edit(buildRecruitmentMessage(config, round, currentMembers, closedReason));
        } catch (error) {
            console.warn(`[RoleRotation] 无法更新招募消息 ${item.channelId}/${item.messageId}:`, error);
        }
    }
}

async function closeRecruitmentInternal(
    client: Client,
    round: RotationRound,
    config: RoleRotationConfig,
    reason: string,
): Promise<void> {
    const context = await fetchGuildAndRole(client, config);
    const current = 'error' in context ? config.capacity : countNonBotMembers(context.role);
    updateRound(round.id, { status: 'closed', closedAt: Date.now(), error: null });
    await refreshRecruitmentMessages(client, config, round, current, reason);
    addAudit({
        guildId: config.guildId,
        configId: config.id,
        roundId: round.id,
        event: 'recruitment_closed',
        detail: reason,
    });
}

/** 发起一轮问询。scheduledCycleKey 有值时用于保证每月最多创建一次。 */
export async function startInquiry(
    client: Client,
    configInput: RoleRotationConfig,
    options: { createdBy?: string | null; scheduledCycleKey?: string } = {},
): Promise<ServiceResult> {
    return withConfigLock(configInput.id, async () => {
        const config = getConfigById(configInput.id);
        if (!config) return { ok: false, message: '配置已不存在。' };
        if (!config.notificationChannelIds.length) {
            return { ok: false, message: '尚未配置通知频道，无法发起问询。' };
        }
        if (!config.recruitmentChannelIds.length) {
            return { ok: false, message: '尚未配置招募频道，无法发起问询。' };
        }

        const active = getActiveRound(config.id);
        if (active?.status === 'inquiry') {
            return { ok: false, message: `已有问询场次 #${active.id} 正在进行。`, round: active };
        }
        if (active?.status === 'recruiting') {
            await closeRecruitmentInternal(client, active, config, '新一轮月度问询开始');
        }

        const context = await fetchGuildAndRole(client, config);
        if ('error' in context) return { ok: false, message: context.error };
        if (!canManageRole(context.guild, context.role)) {
            return { ok: false, message: '机器人缺少“管理身份组”权限，或机器人身份组位置不高于目标身份组。' };
        }

        // 月度操作才完整拉取一次，保证成员快照和人数准确。
        await context.guild.members.fetch().catch(error => {
            console.warn(`[RoleRotation] 拉取服务器 ${context.guild.id} 成员失败，将使用缓存：`, error);
        });
        syncRoleMembers(config, context.role);
        const participantIds = context.role.members
            .filter(member => !member.user.bot)
            .map(member => member.id);
        const now = Date.now();
        const cycleKey = options.scheduledCycleKey ?? `manual-${now}`;
        const existing = getRoundByCycle(config.id, cycleKey);
        let round: RotationRound;
        if (existing) {
            if (existing.status !== 'failed') {
                return { ok: false, message: `本周期已经创建过场次 #${existing.id}。`, round: existing };
            }
            round = updateRound(existing.id, {
                status: 'inquiry',
                inquiryDeadline: now + config.inquiryHours * 3600_000,
                closedAt: null,
                error: null,
            })!;
        } else {
            round = createRound({
                config,
                cycleKey,
                openedAt: now,
                inquiryDeadline: now + config.inquiryHours * 3600_000,
                createdBy: options.createdBy,
                participantIds,
            });
        }

        const sent = await sendInquiryMessages(client, config, round, participantIds.length, context.role);
        if (sent.available === 0) {
            const detail = sent.errors.join('；') || '所有通知频道均不可用';
            updateRound(round.id, { status: 'failed', error: detail });
            addAudit({ guildId: config.guildId, configId: config.id, roundId: round.id, event: 'inquiry_failed', detail });
            return { ok: false, message: `问询消息全部发送失败：${detail}`, round };
        }

        addAudit({
            guildId: config.guildId,
            configId: config.id,
            roundId: round.id,
            actorId: options.createdBy,
            event: 'inquiry_started',
            detail: `participants=${participantIds.length}; deadline=${round.inquiryDeadline}`,
        });
        const warning = sent.errors.length ? `；${sent.errors.length} 个频道发送失败` : '';
        return { ok: true, message: `已发起问询 #${round.id}，共 ${participantIds.length} 名非 Bot 成员${warning}。`, round };
    });
}

/** 结算问询：未回答和选择离任者统一移除，然后按实时人数开启招募。 */
export async function settleInquiry(client: Client, roundInput: RotationRound): Promise<ServiceResult> {
    const config = getConfigById(roundInput.configId);
    if (!config) return { ok: false, message: '该场次的配置已不存在。' };
    return withConfigLock(config.id, async () => {
        const round = getRound(roundInput.id);
        if (!round || round.status !== 'inquiry') {
            return { ok: false, message: '该场次不在问询阶段。' };
        }
        const currentConfig = getConfigById(round.configId);
        if (!currentConfig) return { ok: false, message: '该场次的配置已不存在。' };
        const context = await fetchGuildAndRole(client, currentConfig);
        if ('error' in context) return { ok: false, message: context.error };

        await context.guild.members.fetch().catch(error => {
            console.warn(`[RoleRotation] 结算前拉取服务器成员失败，将使用缓存：`, error);
        });

        let kept = 0;
        let removed = 0;
        let removalFailed = 0;
        for (const participant of listParticipants(round.id)) {
            if (participant.response === 'keep') {
                kept++;
                continue;
            }
            const member = context.guild.members.cache.get(participant.userId)
                ?? await context.guild.members.fetch(participant.userId).catch(() => null);
            if (!member || !member.roles.cache.has(currentConfig.managedRoleId)) {
                markParticipantRemoval(round.id, participant.userId);
                removed++;
                continue;
            }
            try {
                await member.roles.remove(
                    currentConfig.managedRoleId,
                    participant.response === 'leave' ? '月度问询选择不再担任' : '月度问询超时未回答',
                );
                markParticipantRemoval(round.id, participant.userId);
                syncMember(currentConfig.id, participant.userId, member.user.bot, false);
                addAudit({
                    guildId: currentConfig.guildId,
                    configId: currentConfig.id,
                    roundId: round.id,
                    userId: participant.userId,
                    event: participant.response === 'leave' ? 'role_removed_leave' : 'role_removed_timeout',
                });
                removed++;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                markParticipantRemoval(round.id, participant.userId, message);
                addAudit({
                    guildId: currentConfig.guildId,
                    configId: currentConfig.id,
                    roundId: round.id,
                    userId: participant.userId,
                    event: 'role_remove_failed',
                    detail: message,
                });
                removalFailed++;
            }
        }

        syncRoleMembers(currentConfig, context.role);
        const currentMembers = countNonBotMembers(context.role);
        const vacancies = Math.max(0, currentConfig.capacity - currentMembers);
        await editInquiryMessages(client, currentConfig, round, { kept, removed, removalFailed });

        if (vacancies === 0) {
            updateRound(round.id, { status: 'closed', closedAt: Date.now(), vacanciesAtOpen: 0, error: null });
            addAudit({
                guildId: currentConfig.guildId,
                configId: currentConfig.id,
                roundId: round.id,
                event: 'inquiry_settled',
                detail: `kept=${kept}; removed=${removed}; failed=${removalFailed}; vacancies=0`,
            });
            return { ok: true, message: `问询已结算：保留 ${kept}，卸任 ${removed}，失败 ${removalFailed}；当前没有空缺。`, round: getRound(round.id)! };
        }

        const recruitingRound = updateRound(round.id, {
            status: 'recruiting',
            recruitmentOpenedAt: Date.now(),
            vacanciesAtOpen: vacancies,
            error: null,
        })!;
        const publish = await ensureRecruitmentMessagesInternal(client, currentConfig, recruitingRound, context.role);
        addAudit({
            guildId: currentConfig.guildId,
            configId: currentConfig.id,
            roundId: round.id,
            event: 'inquiry_settled',
            detail: `kept=${kept}; removed=${removed}; failed=${removalFailed}; vacancies=${vacancies}`,
        });
        return {
            ok: true,
            message: `问询已结算：保留 ${kept}，卸任 ${removed}，失败 ${removalFailed}；开放 ${vacancies} 个名额。${publish}`,
            round: recruitingRound,
        };
    });
}

async function ensureRecruitmentMessagesInternal(
    client: Client,
    config: RoleRotationConfig,
    round: RotationRound,
    knownRole?: Role,
): Promise<string> {
    const context = knownRole ? null : await fetchGuildAndRole(client, config);
    if (context && 'error' in context) return `招募消息未发布：${context.error}`;
    const role = knownRole ?? (context as { guild: Guild; role: Role }).role;
    const currentMembers = countNonBotMembers(role);
    if (currentMembers >= config.capacity) {
        await closeRecruitmentInternal(client, round, config, '名额已满');
        return '名额已满，招募已关闭。';
    }

    const existingChannels = new Set(listMessages(round.id, 'recruitment').map(item => item.channelId));
    let sent = 0;
    const failures: string[] = [];
    for (const channelId of config.recruitmentChannelIds) {
        if (existingChannels.has(channelId)) continue;
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel?.isSendable() || !('guildId' in channel) || channel.guildId !== config.guildId) {
            failures.push(channelId);
            continue;
        }
        try {
            const message = await channel.send(buildRecruitmentMessage(config, round, currentMembers));
            saveMessage({ roundId: round.id, phase: 'recruitment', channelId, messageId: message.id });
            sent++;
        } catch {
            failures.push(channelId);
        }
    }
    await refreshRecruitmentMessages(client, config, round, currentMembers);
    if (failures.length) return `已发布 ${sent} 个招募面板，${failures.length} 个频道失败。`;
    return `已发布/刷新 ${sent || existingChannels.size} 个招募面板。`;
}

export async function ensureRecruitmentMessages(client: Client, roundInput: RotationRound): Promise<ServiceResult> {
    const config = getConfigById(roundInput.configId);
    if (!config) return { ok: false, message: '配置已不存在。' };
    return withConfigLock(config.id, async () => {
        const round = getRound(roundInput.id);
        if (!round || round.status !== 'recruiting') return { ok: false, message: '该场次不在招募阶段。' };
        const message = await ensureRecruitmentMessagesInternal(client, config, round);
        return { ok: true, message, round: getRound(round.id)! };
    });
}

export async function closeRecruitment(
    client: Client,
    roundInput: RotationRound,
    reason = '管理员手动结束',
): Promise<ServiceResult> {
    const config = getConfigById(roundInput.configId);
    if (!config) return { ok: false, message: '配置已不存在。' };
    return withConfigLock(config.id, async () => {
        const round = getRound(roundInput.id);
        if (!round || round.status !== 'recruiting') return { ok: false, message: '当前没有进行中的招募。' };
        await closeRecruitmentInternal(client, round, config, reason);
        return { ok: true, message: '招募已结束。', round: getRound(round.id)! };
    });
}

export function submitInquiryResponse(
    guildId: string,
    roundId: number,
    userId: string,
    response: RotationResponse,
): ServiceResult {
    const round = getRound(roundId);
    if (!round || round.guildId !== guildId) return { ok: false, message: '该问询不存在。' };
    if (round.status !== 'inquiry' || Date.now() >= round.inquiryDeadline) {
        return { ok: false, message: '本轮问询已经截止。' };
    }
    const participant = getParticipant(round.id, userId);
    if (!participant) return { ok: false, message: '你不在本轮问询的成员快照中，无需作答。' };
    if (participant.response) {
        return {
            ok: false,
            message: `你已经选择“${participant.response === 'keep' ? '继续担任' : '不再担任'}”，不能重复修改。`,
        };
    }
    if (!recordResponse(round.id, userId, response)) return { ok: false, message: '回答未保存，请稍后重试。' };
    addAudit({
        guildId,
        configId: round.configId,
        roundId: round.id,
        actorId: userId,
        userId,
        event: response === 'keep' ? 'response_keep' : 'response_leave',
    });
    return { ok: true, message: response === 'keep' ? '已记录：继续担任。' : '已记录：本轮结束时卸任。', round };
}

async function checkApplicant(
    guild: Guild,
    config: RoleRotationConfig,
    round: RotationRound,
    userId: string,
): Promise<{ member: GuildMember; role: Role; currentMembers: number } | { error: string }> {
    const role = guild.roles.cache.get(config.managedRoleId)
        ?? await guild.roles.fetch(config.managedRoleId).catch(() => null);
    if (!role) return { error: '招募身份组已不存在。' };
    const member = guild.members.cache.get(userId)
        ?? await guild.members.fetch(userId).catch(() => null);
    if (!member) return { error: '无法读取你的服务器成员信息。' };
    if (member.user.bot) return { error: 'Bot 账号不能参与申请。' };
    if (member.roles.cache.has(config.managedRoleId)) return { error: '你已经拥有该身份组。' };
    if (hasApplication(round.id, userId)) return { error: '你已经在本轮申请成功。' };
    const joinedAt = member.joinedTimestamp;
    if (!joinedAt) return { error: '无法确认你的入服时间，请联系管理员。' };
    const requiredMs = config.minTenureDays * 86400_000;
    if (Date.now() - joinedAt < requiredMs) {
        const eligibleAt = joinedAt + requiredMs;
        return { error: `入服时间尚未达到 ${config.minTenureDays} 天；可在 <t:${Math.ceil(eligibleAt / 1000)}:f> 后申请。` };
    }
    const conflicts = config.conflictRoleIds.filter(id => member.roles.cache.has(id));
    if (conflicts.length) return { error: `你持有冲突身份组：${conflicts.map(id => `<@&${id}>`).join('、')}。` };
    const currentMembers = countNonBotMembers(role);
    if (currentMembers >= config.capacity) return { error: '名额已经满了。' };
    if (!canManageRole(guild, role)) return { error: '机器人目前无法授予该身份组，请联系管理员检查权限和身份组顺序。' };
    return { member, role, currentMembers };
}

export async function previewApplication(
    client: Client,
    guildId: string,
    roundId: number,
    userId: string,
): Promise<ServiceResult & { config?: RoleRotationConfig }> {
    const round = getRound(roundId);
    if (!round || round.guildId !== guildId) return { ok: false, message: '该招募不存在。' };
    if (round.status !== 'recruiting') return { ok: false, message: '本轮招募已经结束。' };
    const config = getConfigById(round.configId);
    if (!config) return { ok: false, message: '招募配置已不存在。' };
    const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return { ok: false, message: '机器人无法访问服务器。' };
    const checked = await checkApplicant(guild, config, round, userId);
    if ('error' in checked) return { ok: false, message: checked.error };
    return { ok: true, message: '资格初检通过。', round, config };
}

export async function confirmApplication(
    client: Client,
    guildId: string,
    roundId: number,
    userId: string,
): Promise<ServiceResult> {
    const firstRound = getRound(roundId);
    if (!firstRound || firstRound.guildId !== guildId) return { ok: false, message: '该招募不存在。' };
    return withConfigLock(firstRound.configId, async () => {
        const round = getRound(roundId);
        if (!round || round.status !== 'recruiting') return { ok: false, message: '本轮招募已经结束。' };
        const config = getConfigById(round.configId);
        if (!config) return { ok: false, message: '招募配置已不存在。' };
        const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return { ok: false, message: '机器人无法访问服务器。' };
        const checked = await checkApplicant(guild, config, round, userId);
        if ('error' in checked) {
            if (checked.error === '名额已经满了。') {
                await closeRecruitmentInternal(client, round, config, '名额已满');
            }
            return { ok: false, message: checked.error };
        }

        try {
            await checked.member.roles.add(config.managedRoleId, `分管身份组公开招募 #${round.id}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            addAudit({
                guildId,
                configId: config.id,
                roundId: round.id,
                actorId: userId,
                userId,
                event: 'role_grant_failed',
                detail: message,
            });
            return { ok: false, message: `授予身份组失败，请联系管理员：${message}` };
        }

        recordApplication(round.id, userId);
        syncMember(config.id, userId, checked.member.user.bot, true);
        addAudit({
            guildId,
            configId: config.id,
            roundId: round.id,
            actorId: userId,
            userId,
            event: 'application_accepted',
        });

        const currentMembers = countNonBotMembers(checked.role);
        if (currentMembers >= config.capacity) {
            await closeRecruitmentInternal(client, round, config, '名额已满');
        } else {
            await refreshRecruitmentMessages(client, config, round, currentMembers);
        }
        return {
            ok: true,
            message: `申请成功，已授予 <@&${config.managedRoleId}>。当前人数 ${currentMembers}/${config.capacity}。`,
            round: getRound(round.id)!,
        };
    });
}
