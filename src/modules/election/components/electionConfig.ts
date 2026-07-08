// src/modules/election/components/electionConfig.ts
//
// 募选模块的配置面板（ephemeral）。
// 配置项很多且含频道/身份组，采用「配置中心 + 分类子面板」：
//   主面板列出当前配置摘要 + 分类按钮 → 点分类进入子面板（≤5 行）编辑 → 即时存库。
//
// 所有 customId 以 `elect_cfg_` 开头（是模块前缀 `elect_` 的子集）。

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    RoleSelectMenuBuilder,
    UserSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
    MessageFlags,
    type ButtonInteraction,
    type AnySelectMenuInteraction,
    type ModalSubmitInteraction,
    type InteractionReplyOptions,
    type InteractionUpdateOptions,
} from 'discord.js';

import { getSettings, updateSettings, DEFAULT_SETTINGS, type ElectionSettings } from '../services/electionDatabase';

export const CFG = {
    PREFIX: 'elect_cfg_',
    HUB: 'elect_cfg_hub',
    CAT_CHANNELS: 'elect_cfg_cat_channels',
    CAT_ROLES: 'elect_cfg_cat_roles',
    CAT_RULES: 'elect_cfg_cat_rules',
    CAT_OLDBOT: 'elect_cfg_cat_oldbot',
    CAT_NOTIFY: 'elect_cfg_cat_notify',

    CH_ENTRY: 'elect_cfg_ch_entry',
    CH_PUBLIC: 'elect_cfg_ch_public',
    CH_RESULT: 'elect_cfg_ch_result',
    CH_ADMIN: 'elect_cfg_ch_admin',

    ROLE_ACTIVE: 'elect_cfg_role_active',
    ROLE_ADMINVOTE: 'elect_cfg_role_adminvote',
    ROLE_MANAGE: 'elect_cfg_role_manage',
    ROLE_NOTIFY_NOMINATE: 'elect_cfg_role_notify_nom',
    ROLE_NOTIFY_VOTE: 'elect_cfg_role_notify_vote',

    TOGGLE_PUBLIC: 'elect_cfg_toggle_public',
    TOGGLE_ADMIN: 'elect_cfg_toggle_admin',
    TOGGLE_CONFIRM: 'elect_cfg_toggle_confirm',
    TOGGLE_TIEBREAK: 'elect_cfg_toggle_tiebreak',
    WEIGHTS_OPEN: 'elect_cfg_weights_open',
    WEIGHTS_MODAL: 'elect_cfg_weights_modal',
    WEIGHTS_PUBLIC_IN: 'elect_cfg_w_public',
    WEIGHTS_ADMIN_IN: 'elect_cfg_w_admin',

    OLDBOT_SELECT: 'elect_cfg_oldbot',
    CONFIGID_OPEN: 'elect_cfg_configid_open',
    CONFIGID_MODAL: 'elect_cfg_configid_modal',
    CONFIGID_IN: 'elect_cfg_configid_in',

    API_OPEN: 'elect_cfg_api_open',
    API_MODAL: 'elect_cfg_api_modal',
    API_BASE_IN: 'elect_cfg_api_base',
    API_TOKEN_IN: 'elect_cfg_api_token',
    API_GUILD_IN: 'elect_cfg_api_guild',
    API_FIELD_IN: 'elect_cfg_api_field',
    API_INTERVAL_IN: 'elect_cfg_api_interval',
    POLL_TOGGLE: 'elect_cfg_poll_toggle',
} as const;

// --------------------------- 摘要文本 ---------------------------

const chMention = (id: string | null) => (id ? `<#${id}>` : '_未设置_');
const chList = (ids: string[]) => (ids.length ? ids.map(i => `<#${i}>`).join(' ') : '_未设置_');
const roleList = (ids: string[]) => (ids.length ? ids.map(i => `<@&${i}>`).join(' ') : '_未设置_');

function summary(s: ElectionSettings): string {
    const tie = s.tieBreak === 'public' ? '大众得票率优先' : '管理得票率优先';
    return [
        '## 🗳️ 募选配置',
        '',
        '**频道**',
        `• 入口（空位需求/自荐）：${chMention(s.entryChannelId)}`,
        `• 大众投票：${chMention(s.publicVoteChannelId)}`,
        `• 结果公示：${chMention(s.resultChannelId)}`,
        `• 管理内投频道：${chList(s.adminVoteChannelIds)}`,
        '',
        '**身份组**',
        `• 大众投票资格：${roleList(s.activeRoleIds)}`,
        `• 管理投票资格：${roleList(s.adminVoteRoleIds)}`,
        `• 募选管理权限：${roleList(s.manageRoleIds)}`,
        '',
        '**通知**',
        `• 自荐开放通知：${roleList(s.nominateNotifyRoleIds)}`,
        `• 投票开始通知：${roleList(s.voteNotifyRoleIds)}`,
        '',
        '**规则**',
        `• 大众投票：${s.enablePublic ? '✅ 启用' : '⛔ 关闭'}　管理投票：${s.enableAdmin ? '✅ 启用' : '⛔ 关闭'}`,
        `• 权重（大众:管理）：${s.weightPublic} : ${s.weightAdmin}`,
        `• 结算二次确认：${s.requireConfirm ? '✅ 需要' : '否（自动公示）'}`,
        `• 并列规则：${tie}`,
        '',
        '**候选池对接**',
        `• 候选池 API：${s.apiToken ? '✅ Token 已设置' : '⛔ 未设置（将回退到解析频道名单）'}`,
        `• API 地址：${s.apiBaseUrl ? `\`${s.apiBaseUrl}\`` : '_由 .env 提供或未设置_'}`,
        `• config_id / 岗位：${s.poolConfigId ? `\`${s.poolConfigId}\`` : '全部'} / ${s.apiFieldName ? `\`${s.apiFieldName}\`` : '全部'}`,
        `• API guild：${s.apiGuildId ? `\`${s.apiGuildId}\`` : '.env 或当前服务器'}`,
        `• 定时自动拉取：${s.pollEnabled ? `✅ 每 ${s.pollIntervalMinutes} 分钟` : '关闭'}`,
        `• 旧 bot（回退方案）：${s.oldBotId ? `<@${s.oldBotId}>` : '_未设置_'}`,
        '',
        '_点下方分类按钮进入编辑；改动即时生效。_',
    ].join('\n');
}

// --------------------------- 面板构建 ---------------------------

function hubComponents(): ActionRowBuilder<ButtonBuilder>[] {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(CFG.CAT_CHANNELS).setLabel('📺 频道').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(CFG.CAT_ROLES).setLabel('👥 身份组').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(CFG.CAT_RULES).setLabel('⚙️ 规则').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(CFG.CAT_NOTIFY).setLabel('🔔 通知').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(CFG.CAT_OLDBOT).setLabel('🔗 候选池').setStyle(ButtonStyle.Primary),
    );
    return [row];
}

/** 主面板（供命令首次回复 / 返回时使用）。 */
export function buildConfigHub(guildId: string): InteractionReplyOptions {
    const s = getSettings(guildId);
    return { content: summary(s), components: hubComponents(), flags: MessageFlags.Ephemeral };
}

function backRow(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(CFG.HUB).setLabel('⬅️ 返回配置总览').setStyle(ButtonStyle.Secondary),
    );
}

function singleChannelRow(customId: string, placeholder: string, current: string | null) {
    const menu = new ChannelSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(0)
        .setMaxValues(1);
    if (current) menu.setDefaultChannels(current);
    return new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(menu);
}

function channelsPanel(s: ElectionSettings): InteractionUpdateOptions {
    const adminMenu = new ChannelSelectMenuBuilder()
        .setCustomId(CFG.CH_ADMIN)
        .setPlaceholder('4️⃣ 管理内投频道（可多选）')
        .setChannelTypes(ChannelType.GuildText)
        .setMinValues(0)
        .setMaxValues(25);
    if (s.adminVoteChannelIds.length) adminMenu.setDefaultChannels(...s.adminVoteChannelIds);

    return {
        content: [
            '**📺 频道设置**（下面四个框从上到下依次是；留空=清除）',
            '1️⃣ 入口频道 —— 发布空位需求、放自荐入口',
            '2️⃣ 大众投票频道 —— 放大众投票器',
            '3️⃣ 结果公示频道 —— 公布当选结果',
            '4️⃣ 管理内投频道 —— 每场在这些频道各开一个子区投票（可多选）',
        ].join('\n'),
        components: [
            singleChannelRow(CFG.CH_ENTRY, '1️⃣ 入口频道', s.entryChannelId),
            singleChannelRow(CFG.CH_PUBLIC, '2️⃣ 大众投票频道', s.publicVoteChannelId),
            singleChannelRow(CFG.CH_RESULT, '3️⃣ 结果公示频道', s.resultChannelId),
            new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(adminMenu),
            backRow(),
        ],
    };
}

function roleRow(customId: string, placeholder: string, current: string[]) {
    const menu = new RoleSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(placeholder)
        .setMinValues(0)
        .setMaxValues(25);
    if (current.length) menu.setDefaultRoles(...current);
    return new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(menu);
}

function rolesPanel(s: ElectionSettings): InteractionUpdateOptions {
    return {
        content: [
            '**👥 身份组设置**（下面三个框从上到下，按编号对应）',
            '1️⃣ 大众投票资格 —— 谁能投「大众票」。设成有资格投票的身份组',
            '2️⃣ 管理投票资格 —— 谁能投「管理内部票」。设成管理身份组。',
            '3️⃣ 募选管理权限 —— 谁能操作募选（发起 / 配置 / 导入 / 结算等命令）。',
        ].join('\n'),
        components: [
            roleRow(CFG.ROLE_ACTIVE, '1️⃣ 大众投票资格', s.activeRoleIds),
            roleRow(CFG.ROLE_ADMINVOTE, '2️⃣ 管理投票资格', s.adminVoteRoleIds),
            roleRow(CFG.ROLE_MANAGE, '3️⃣ 募选管理权限', s.manageRoleIds),
            backRow(),
        ],
    };
}

function notifyPanel(s: ElectionSettings): InteractionUpdateOptions {
    return {
        content: [
            '**🔔 通知设置**（留空=不通知；会真的 @ 到这些身份组）',
            '1️⃣ 自荐开放通知 —— 发起募选时，在入口频道额外发一条 @ 这些身份组，告知有空位可自荐。',
            '2️⃣ 投票开始通知 —— 大众投票开始时，在投票频道额外 @ 这些身份组。',
        ].join('\n'),
        components: [
            roleRow(CFG.ROLE_NOTIFY_NOMINATE, '1️⃣ 自荐开放通知', s.nominateNotifyRoleIds),
            roleRow(CFG.ROLE_NOTIFY_VOTE, '2️⃣ 投票开始通知', s.voteNotifyRoleIds),
            backRow(),
        ],
    };
}

function rulesPanel(s: ElectionSettings): InteractionUpdateOptions {
    const toggles = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(CFG.TOGGLE_PUBLIC)
            .setLabel(`大众投票：${s.enablePublic ? '开' : '关'}`)
            .setStyle(s.enablePublic ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(CFG.TOGGLE_ADMIN)
            .setLabel(`管理投票：${s.enableAdmin ? '开' : '关'}`)
            .setStyle(s.enableAdmin ? ButtonStyle.Success : ButtonStyle.Secondary),
    );
    const toggles2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(CFG.TOGGLE_CONFIRM)
            .setLabel(`结算二次确认：${s.requireConfirm ? '需要' : '否'}`)
            .setStyle(s.requireConfirm ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(CFG.TOGGLE_TIEBREAK)
            .setLabel(`并列优先：${s.tieBreak === 'public' ? '大众' : '管理'}`)
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(CFG.WEIGHTS_OPEN)
            .setLabel(`权重 ${s.weightPublic}:${s.weightAdmin}`)
            .setStyle(ButtonStyle.Primary),
    );
    return {
        content: '**⚙️ 规则设置**\n两票都启用时按各自得票率加权；只启用一种则该种占 100%。',
        components: [toggles, toggles2, backRow()],
    };
}

function oldbotPanel(s: ElectionSettings): InteractionUpdateOptions {
    const userMenu = new UserSelectMenuBuilder()
        .setCustomId(CFG.OLDBOT_SELECT)
        .setPlaceholder('选择旧募选 bot（用于校验名单来源）')
        .setMinValues(0)
        .setMaxValues(1);
    if (s.oldBotId) userMenu.setDefaultUsers(s.oldBotId);

    const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(CFG.API_OPEN).setLabel('🔌 候选池 API / 间隔').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(CFG.CONFIGID_OPEN).setLabel('✏️ 默认 config_id').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(CFG.POLL_TOGGLE)
            .setLabel(`⏱️ 定时拉取：${s.pollEnabled ? '开' : '关'}`)
            .setStyle(s.pollEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    );
    return {
        content:
            '**🔗 候选池对接**\n' +
            '推荐用 **候选池 API**：设好 Token 后，`/募选管理 导入候选池` 直接联网拉名单；发起募选时也会自动拉一次。\n' +
            '「定时拉取」开启后，会按设定间隔用默认 config_id 定期同步（默认关）。\n' +
            '下方「旧 bot」是**回退方案**：未配置 API 时改为解析该 bot 在频道发的名单。',
        components: [
            new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userMenu),
            btnRow,
            backRow(),
        ],
    };
}

// --------------------------- 交互分发 ---------------------------

/** 处理配置相关按钮（分类切换 / 开关 / 打开 Modal / 返回）。返回 true 表示已处理。 */
export async function handleConfigButton(interaction: ButtonInteraction): Promise<boolean> {
    const id = interaction.customId;
    if (!id.startsWith(CFG.PREFIX)) return false;
    const guildId = interaction.guildId!;

    switch (id) {
        case CFG.HUB:
            await interaction.update({ content: summary(getSettings(guildId)), components: hubComponents() });
            return true;
        case CFG.CAT_CHANNELS:
            await interaction.update(channelsPanel(getSettings(guildId)));
            return true;
        case CFG.CAT_ROLES:
            await interaction.update(rolesPanel(getSettings(guildId)));
            return true;
        case CFG.CAT_RULES:
            await interaction.update(rulesPanel(getSettings(guildId)));
            return true;
        case CFG.CAT_NOTIFY:
            await interaction.update(notifyPanel(getSettings(guildId)));
            return true;
        case CFG.CAT_OLDBOT:
            await interaction.update(oldbotPanel(getSettings(guildId)));
            return true;

        case CFG.TOGGLE_PUBLIC: {
            const s = updateSettings(guildId, { enablePublic: !getSettings(guildId).enablePublic });
            await interaction.update(rulesPanel(s));
            return true;
        }
        case CFG.TOGGLE_ADMIN: {
            const s = updateSettings(guildId, { enableAdmin: !getSettings(guildId).enableAdmin });
            await interaction.update(rulesPanel(s));
            return true;
        }
        case CFG.TOGGLE_CONFIRM: {
            const s = updateSettings(guildId, { requireConfirm: !getSettings(guildId).requireConfirm });
            await interaction.update(rulesPanel(s));
            return true;
        }
        case CFG.TOGGLE_TIEBREAK: {
            const cur = getSettings(guildId).tieBreak;
            const s = updateSettings(guildId, { tieBreak: cur === 'public' ? 'admin' : 'public' });
            await interaction.update(rulesPanel(s));
            return true;
        }

        case CFG.WEIGHTS_OPEN: {
            const s = getSettings(guildId);
            const modal = new ModalBuilder().setCustomId(CFG.WEIGHTS_MODAL).setTitle('设置加权比例');
            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId(CFG.WEIGHTS_PUBLIC_IN)
                        .setLabel('大众权重（如 0.6）')
                        .setStyle(TextInputStyle.Short)
                        .setValue(String(s.weightPublic))
                        .setRequired(true),
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId(CFG.WEIGHTS_ADMIN_IN)
                        .setLabel('管理权重（如 0.4）')
                        .setStyle(TextInputStyle.Short)
                        .setValue(String(s.weightAdmin))
                        .setRequired(true),
                ),
            );
            await interaction.showModal(modal);
            return true;
        }
        case CFG.API_OPEN: {
            const s = getSettings(guildId);
            const modal = new ModalBuilder().setCustomId(CFG.API_MODAL).setTitle('候选池 API 设置');
            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder().setCustomId(CFG.API_BASE_IN).setLabel('API 基址（.env 未填时必填）')
                        .setStyle(TextInputStyle.Short).setValue(s.apiBaseUrl ?? '').setRequired(false),
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder().setCustomId(CFG.API_TOKEN_IN).setLabel('Bearer Token（留空则清除）')
                        .setStyle(TextInputStyle.Short).setValue(s.apiToken ?? '').setRequired(false),
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder().setCustomId(CFG.API_GUILD_IN).setLabel('guild_id（留空用当前服务器）')
                        .setStyle(TextInputStyle.Short).setValue(s.apiGuildId ?? '').setRequired(false),
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder().setCustomId(CFG.API_FIELD_IN).setLabel('岗位名 field_name（可选，精确匹配）')
                        .setStyle(TextInputStyle.Short).setValue(s.apiFieldName ?? '').setRequired(false),
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder().setCustomId(CFG.API_INTERVAL_IN).setLabel('定时拉取间隔（分钟，最低 10）')
                        .setStyle(TextInputStyle.Short).setValue(String(s.pollIntervalMinutes)).setRequired(false),
                ),
            );
            await interaction.showModal(modal);
            return true;
        }
        case CFG.POLL_TOGGLE: {
            const s = updateSettings(guildId, { pollEnabled: !getSettings(guildId).pollEnabled });
            await interaction.update(oldbotPanel(s));
            return true;
        }
        case CFG.CONFIGID_OPEN: {
            const s = getSettings(guildId);
            const modal = new ModalBuilder().setCustomId(CFG.CONFIGID_MODAL).setTitle('设置 config_id');
            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId(CFG.CONFIGID_IN)
                        .setLabel('配置id（旧 bot 命令要填的值）')
                        .setStyle(TextInputStyle.Short)
                        .setValue(s.poolConfigId ?? '')
                        .setRequired(false),
                ),
            );
            await interaction.showModal(modal);
            return true;
        }
    }
    return false;
}

/** 处理配置相关的频道/身份组/用户选择菜单。返回 true 表示已处理。 */
export async function handleConfigSelect(interaction: AnySelectMenuInteraction): Promise<boolean> {
    const id = interaction.customId;
    if (!id.startsWith(CFG.PREFIX)) return false;
    const guildId = interaction.guildId!;
    const values = interaction.values;
    const first = values[0] ?? null;

    switch (id) {
        case CFG.CH_ENTRY:
            await interaction.update(channelsPanel(updateSettings(guildId, { entryChannelId: first })));
            return true;
        case CFG.CH_PUBLIC:
            await interaction.update(channelsPanel(updateSettings(guildId, { publicVoteChannelId: first })));
            return true;
        case CFG.CH_RESULT:
            await interaction.update(channelsPanel(updateSettings(guildId, { resultChannelId: first })));
            return true;
        case CFG.CH_ADMIN:
            await interaction.update(channelsPanel(updateSettings(guildId, { adminVoteChannelIds: values })));
            return true;

        case CFG.ROLE_ACTIVE:
            await interaction.update(rolesPanel(updateSettings(guildId, { activeRoleIds: values })));
            return true;
        case CFG.ROLE_ADMINVOTE:
            await interaction.update(rolesPanel(updateSettings(guildId, { adminVoteRoleIds: values })));
            return true;
        case CFG.ROLE_MANAGE:
            await interaction.update(rolesPanel(updateSettings(guildId, { manageRoleIds: values })));
            return true;
        case CFG.ROLE_NOTIFY_NOMINATE:
            await interaction.update(notifyPanel(updateSettings(guildId, { nominateNotifyRoleIds: values })));
            return true;
        case CFG.ROLE_NOTIFY_VOTE:
            await interaction.update(notifyPanel(updateSettings(guildId, { voteNotifyRoleIds: values })));
            return true;

        case CFG.OLDBOT_SELECT:
            await interaction.update(oldbotPanel(updateSettings(guildId, { oldBotId: first })));
            return true;
    }
    return false;
}

/** 处理配置相关的 Modal 提交（权重 / 配置id）。返回 true 表示已处理。 */
export async function handleConfigModal(interaction: ModalSubmitInteraction): Promise<boolean> {
    const id = interaction.customId;
    if (!id.startsWith(CFG.PREFIX)) return false;
    const guildId = interaction.guildId!;

    if (id === CFG.WEIGHTS_MODAL) {
        const wp = Number(interaction.fields.getTextInputValue(CFG.WEIGHTS_PUBLIC_IN).trim());
        const wa = Number(interaction.fields.getTextInputValue(CFG.WEIGHTS_ADMIN_IN).trim());
        if (!Number.isFinite(wp) || !Number.isFinite(wa) || wp < 0 || wa < 0 || wp + wa <= 0) {
            await interaction.reply({
                content: '❌ 权重需为非负数字且不能同时为 0（如 0.6 / 0.4）。',
                flags: MessageFlags.Ephemeral,
            });
            return true;
        }
        updateSettings(guildId, { weightPublic: wp, weightAdmin: wa });
        await interaction.reply({ ...buildConfigHub(guildId), content: `✅ 已保存权重 ${wp}:${wa}\n\n${summary(getSettings(guildId))}` });
        return true;
    }

    if (id === CFG.CONFIGID_MODAL) {
        const raw = interaction.fields.getTextInputValue(CFG.CONFIGID_IN).trim();
        updateSettings(guildId, { poolConfigId: raw || null });
        await interaction.reply({ ...buildConfigHub(guildId), content: `✅ config_id 已${raw ? '保存' : '清除'}\n\n${summary(getSettings(guildId))}` });
        return true;
    }

    if (id === CFG.API_MODAL) {
        const base = interaction.fields.getTextInputValue(CFG.API_BASE_IN).trim();
        const token = interaction.fields.getTextInputValue(CFG.API_TOKEN_IN).trim();
        const gid = interaction.fields.getTextInputValue(CFG.API_GUILD_IN).trim();
        const field = interaction.fields.getTextInputValue(CFG.API_FIELD_IN).trim();
        const intervalRaw = interaction.fields.getTextInputValue(CFG.API_INTERVAL_IN).trim();
        const parsed = Number(intervalRaw);
        const interval = Number.isFinite(parsed) && parsed >= 10
            ? Math.round(parsed)
            : getSettings(guildId).pollIntervalMinutes; // 非法或空则保持原值
        updateSettings(guildId, {
            apiBaseUrl: base || DEFAULT_SETTINGS.apiBaseUrl,
            apiToken: token || null,
            apiGuildId: gid || null,
            apiFieldName: field || null,
            pollIntervalMinutes: interval,
        });
        await interaction.reply({ ...buildConfigHub(guildId), content: `✅ 候选池 API 已更新（Token ${token ? '已设置' : '已清除'}，间隔 ${interval} 分钟）\n\n${summary(getSettings(guildId))}` });
        return true;
    }

    return false;
}
