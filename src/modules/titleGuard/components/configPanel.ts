// src/modules/titleGuard/components/configPanel.ts
//
// /标题规范 面板 —— 配置台。
//
// 为什么要有它：指令适合「加一条、删一条」，一到批量就难受——
// 给五个身份组发「复核」要敲五次，纳管八个论坛要敲八次，改四个时长要敲四段参数。
// 面板用 Discord 原生的**多选菜单**解决这个：身份组一次选完，论坛一次勾完，
// 时长一个弹窗四个格子填完。
//
// 两条设计上的硬规矩：
//   1. **多选 = 覆盖，不是追加。** 菜单里会把当前已配的预先勾上，
//      所以你看到的就是最终状态，取消勾选即为移除。追加语义在批量场景下
//      根本没法「减」，那才是真难受。
//   2. **权限那一页只有管理员能用**，和指令一致。不然拿到「复核」的人
//      能给自己发「设置」，权限体系就是个摆设。
//
// 面板消息是**仅本人可见**的，所以不用担心多个人同时开一个面板互相打架；
// 每个人操作的都是自己那一份，落库是即时的。

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    type AnySelectMenuInteraction,
    type ButtonInteraction,
    type ChatInputCommandInteraction,
    type GuildMember,
    type ModalSubmitInteraction,
} from 'discord.js';

import { checkAdminPermission } from '../../../core/utils/permissionManager';
import * as db from '../services/titleGuardDatabase';
import { invalidateConfigCache } from '../services/enforcer';
import {
    CAPABILITIES,
    CAPABILITY_HINT,
    hasCapability,
    isCapability,
    rolesWithCapability,
    type GuardCapability,
} from '../services/titleGuardPermissions';

/** 面板的 customId 都挂这个前缀，核心按 tt_ 分发进来后再细分 */
const P = 'tt_cfg';

const BTN_HOME = `${P}:home`;
const BTN_PERMS = `${P}:perms`;
const BTN_FORUMS = `${P}:forums`;
const BTN_TIMING = `${P}:timing`;
const BTN_TOGGLE = `${P}:tog`;      // tt_cfg:tog:<key>
const BTN_DICT = `${P}:dict`;
// 期限和队列拆成两个弹窗：Discord 一个弹窗最多五个输入框，六项塞不下；
// 而且这两组东西本来就是两回事，分开填也更好懂
const BTN_EDIT_GRACE = `${P}:grace`;
const BTN_EDIT_QUEUE = `${P}:queue`;
const BTN_EDIT_DICTSRC = `${P}:dictsrc`;
const SEL_CAP = `${P}:cap`;         // 选哪一项能力
const SEL_ROLES = `${P}:roles`;     // tt_cfg:roles:<capability>
const SEL_FORUMS = `${P}:forumsel`;
const MODAL_GRACE = `${P}:gracemodal`;
const MODAL_QUEUE = `${P}:queuemodal`;
const MODAL_DICTSRC = `${P}:dictsrcmodal`;

// ============================================================
// 权限判定
// ============================================================

function memberOf(i: { member: unknown }): GuildMember | null {
    return i.member as GuildMember | null;
}

/** 能不能打开面板：任意一种操作能力即可 */
function canOpen(member: GuildMember | null, guildId: string): boolean {
    const caps: GuardCapability[] = ['复核', '覆盖', '词表', '设置'];
    return caps.some(c => hasCapability(member, guildId, c));
}

async function denied(
    interaction: ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction,
    what: string,
): Promise<void> {
    await interaction.reply({ content: `❌ ${what}`, flags: MessageFlags.Ephemeral });
}

// ============================================================
// 首页
// ============================================================

/**
 * 按当前速率，队列里这些还要跑多久。管理组最常问的就是这个。
 * 两条队列是并行跑的，所以取较慢那条，不是相加。
 */
function queueEta(s: db.GuardSettings, fast: number, slow: number): string {
    const fastBatches = Math.ceil(fast / Math.max(1, s.fastBatchSize));
    const fastMin = Math.max(0, fastBatches - 1) * s.fastBatchPauseMinutes;
    const slowMin = slow * s.queueIntervalMinutes;
    const total = Math.max(fastMin, slowMin);
    if (total < 60) return `${total} 分钟`;
    if (total < 60 * 48) return `${Math.round(total / 60)} 小时`;
    return `${Math.round(total / 60 / 24)} 天`;
}

function homeView(guildId: string): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
    const s = db.getSettings(guildId);
    const forums = db.listForums(guildId);
    const dict = db.listDict(db.dictSourceOf(guildId));
    const open = db.listOpenCases(guildId, 100);
    const fast = db.pendingCount(guildId, 'fast');
    const slow = db.pendingCount(guildId, 'slow');

    const yn = (v: boolean) => (v ? '✅ 开' : '⭕ 关');

    const embed = new EmbedBuilder()
        .setTitle('⚙️ 标题规范 · 配置台')
        .setColor(0x5865f2)
        .setDescription('批量改配置用这儿，零敲碎打用 `/标题规范` 指令，两边改的是同一份数据。')
        .addFields(
            {
                name: '开关',
                value: [
                    `总开关 ${yn(s.enabled)}　自动整改 ${yn(s.autoFixEnabled)}`,
                    `语义判定 ${yn(s.llmEnabled)}　判定需确认 ${yn(s.llmNeedsConfirm)}`,
                    `整改队列 ${s.queuePaused ? '⏸ 暂停' : '▶ 运行中'}`,
                ].join('\n'),
                inline: true,
            },
            {
                name: '时限',
                value: [
                    `活帖宽限 ${s.graceNewHours} 小时`,
                    `老帖宽限 ${s.graceOldHours} 小时`,
                    `沉寂 ${s.oldPostInactiveHours} 小时算老帖`,
                ].join('\n'),
                inline: true,
            },
            {
                name: '队列速率',
                value: [
                    `活跃帖 ${s.fastBatchSize} 条/批，歇 ${s.fastBatchPauseMinutes} 分`,
                    `老　帖 ${s.queueIntervalMinutes} 分钟一个`,
                ].join('\n'),
                inline: true,
            },
            {
                name: '规模',
                value: [
                    `纳管论坛 ${forums.length} 个`,
                    `词条 ${dict.length} 条${s.dictSourceGuildId ? '（借用别服的）' : ''}`,
                    `已核查合格 ${db.cleanCount(guildId)} 个`,
                ].join('\n'),
                inline: true,
            },
            {
                name: '待办',
                value: [
                    `未结案件 ${open.length} 件`,
                    `排队中：活跃 ${fast} 个 / 老帖 ${slow} 个`,
                    fast + slow > 0 ? `预计跑完还要 ${queueEta(s, fast, slow)}` : '队列是空的',
                ].join('\n'),
                inline: true,
            },
        )
        .setFooter({ text: '这条消息只有你看得见，随便点。' });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(BTN_PERMS).setLabel('权限').setStyle(ButtonStyle.Primary).setEmoji('🔑'),
        new ButtonBuilder().setCustomId(BTN_FORUMS).setLabel('论坛').setStyle(ButtonStyle.Primary).setEmoji('📋'),
        new ButtonBuilder().setCustomId(BTN_TIMING).setLabel('时间与开关').setStyle(ButtonStyle.Primary).setEmoji('⏱️'),
        new ButtonBuilder().setCustomId(BTN_DICT).setLabel('词表').setStyle(ButtonStyle.Primary).setEmoji('📖'),
    );

    return { embeds: [embed], components: [row] };
}

// ============================================================
// 权限页
// ============================================================

function permsView(guildId: string, picked?: GuardCapability) {
    const embed = new EmbedBuilder()
        .setTitle('🔑 权限')
        .setColor(0x5865f2)
        .setDescription(
            '服主和带 Discord 管理员权限的人**始终拥有全部能力**。\n'
            + '某项能力一个身份组都没配时，它只有上面那些人能用。\n\n'
            + '下面选一项能力，再用身份组菜单一次选完——'
            + '**菜单里勾着的就是最终名单，取消勾选即为移除。**',
        );

    for (const cap of CAPABILITIES) {
        const roles = rolesWithCapability(guildId, cap);
        embed.addFields({
            name: `${cap} —— ${CAPABILITY_HINT[cap]}`,
            value: roles.length > 0 ? roles.map(id => `<@&${id}>`).join(' ') : '_未配置_',
        });
    }

    const capRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(SEL_CAP)
            .setPlaceholder(picked ? `正在编辑：${picked}` : '① 先选一项能力')
            .addOptions(CAPABILITIES.map(c => ({
                label: c,
                description: CAPABILITY_HINT[c].slice(0, 100),
                value: c,
                default: c === picked,
            }))),
    );

    const rows: ActionRowBuilder<StringSelectMenuBuilder | RoleSelectMenuBuilder | ButtonBuilder>[] = [capRow];

    if (picked) {
        const current = rolesWithCapability(guildId, picked);
        const roleSelect = new RoleSelectMenuBuilder()
            .setCustomId(`${SEL_ROLES}:${picked}`)
            .setPlaceholder(`② 选「${picked}」的身份组（可多选）`)
            .setMinValues(0)
            .setMaxValues(25);
        // 把已配的预先勾上：看到的就是最终状态，取消勾选就是移除
        if (current.length > 0) roleSelect.setDefaultRoles(current.slice(0, 25));

        rows.push(new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(roleSelect));
    }

    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(BTN_HOME).setLabel('返回').setStyle(ButtonStyle.Secondary).setEmoji('◀️'),
    ));

    return { embeds: [embed], components: rows };
}

// ============================================================
// 论坛页
// ============================================================

function forumsView(guildId: string) {
    const forums = db.listForums(guildId);
    const enabled = forums.filter(f => f.enabled).map(f => f.forumId);

    const embed = new EmbedBuilder()
        .setTitle('📋 纳管的论坛')
        .setColor(0x5865f2)
        .setDescription(
            enabled.length > 0
                ? enabled.map(id => `<#${id}>`).join('\n')
                : '_还没纳管任何论坛。_',
        )
        .addFields({
            name: '怎么改',
            value: '下面的菜单**勾着的就是最终名单**，取消勾选即为移出管理。\n'
                + '移出不会删掉已有的案件记录，只是不再检查新帖。',
        });

    const select = new ChannelSelectMenuBuilder()
        .setCustomId(SEL_FORUMS)
        .setPlaceholder('选要纳管的论坛（可多选）')
        .addChannelTypes(ChannelType.GuildForum)
        .setMinValues(0)
        .setMaxValues(25);
    if (enabled.length > 0) select.setDefaultChannels(enabled.slice(0, 25));

    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select),
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(BTN_HOME).setLabel('返回').setStyle(ButtonStyle.Secondary).setEmoji('◀️'),
            ),
        ],
    };
}

// ============================================================
// 时间与开关页
// ============================================================

/** 开关名 → 设置字段。改一个加一行，不用动别处 */
const TOGGLES = [
    { key: 'enabled', label: '总开关', hint: '关掉就整个模块停摆' },
    { key: 'autoFixEnabled', label: '自动整改', hint: '关掉只检测、到期不动手' },
    { key: 'llmEnabled', label: '语义判定', hint: '关掉则需定性的一律转人工' },
    { key: 'llmNeedsConfirm', label: '判定需确认', hint: '开着则 AI 判出的违规要管理组点头' },
    { key: 'queuePaused', label: '暂停老帖队列', hint: '开着则不再翻老帖' },
] as const;

function timingView(guildId: string) {
    const s = db.getSettings(guildId);
    const val = (k: (typeof TOGGLES)[number]['key']) => Boolean(s[k]);

    const embed = new EmbedBuilder()
        .setTitle('⏱️ 时间与开关')
        .setColor(0x5865f2)
        .addFields(
            {
                name: '处理期限',
                value: [
                    `**活帖** ${s.graceNewHours} 小时　**老帖** ${s.graceOldHours} 小时`,
                    `**老帖门槛**：已归档且沉寂超过 ${s.oldPostInactiveHours} 小时`,
                ].join('\n'),
            },
            {
                name: '队列速率',
                value: [
                    `**活跃帖 + 近期归档**：一批 ${s.fastBatchSize} 条，然后歇 ${s.fastBatchPauseMinutes} 分钟`,
                    `**老帖**：${s.queueIntervalMinutes} 分钟一个`,
                ].join('\n'),
            },
            {
                name: '这些数是干什么的',
                value: '没归档的帖子、以及刚沉下去不久的帖子，都按**活帖**给宽限，走快队列。\n'
                    + '沉得够久的才算老帖——给它发通知要先解归档，而且一定会顶帖，'
                    + '所以给足时间、走慢队列。\n'
                    + '两条队列都要限速，因为**发消息就会顶帖**：一口气发几百条，'
                    + '论坛首页会被这几百个帖子全顶上来。',
            },
        );

    const toggleRows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < TOGGLES.length; i += 3) {
        toggleRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
            ...TOGGLES.slice(i, i + 3).map(t => new ButtonBuilder()
                .setCustomId(`${BTN_TOGGLE}:${t.key}`)
                .setLabel(`${t.label}：${val(t.key) ? '开' : '关'}`)
                .setStyle(val(t.key) ? ButtonStyle.Success : ButtonStyle.Secondary)),
        ));
    }

    return {
        embeds: [embed],
        components: [
            ...toggleRows,
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(BTN_EDIT_GRACE).setLabel('改期限').setStyle(ButtonStyle.Primary).setEmoji('⏳'),
                new ButtonBuilder().setCustomId(BTN_EDIT_QUEUE).setLabel('改队列速率').setStyle(ButtonStyle.Primary).setEmoji('🐢'),
                new ButtonBuilder().setCustomId(BTN_HOME).setLabel('返回').setStyle(ButtonStyle.Secondary).setEmoji('◀️'),
            ),
        ],
    };
}

// ============================================================
// 词表页
// ============================================================

/**
 * 词表这一页**不提供逐条编辑**，只管「这个服用谁的词表」。
 *
 * 逐条改词用指令；要动几十条就导出 xlsx 改完再导入——
 * 在 Discord 面板里一条一条点，比敲指令还慢。
 */
function dictView(guildId: string) {
    const source = db.dictSourceOf(guildId);
    const borrowed = source !== guildId;
    const dict = db.listDict(source);
    const core = dict.filter(d => d.tier === '本体');
    const sets = db.listExclusiveSets(source);
    const cross = db.listCrossExclusions(source);

    const embed = new EmbedBuilder()
        .setTitle('📖 词表')
        .setColor(borrowed ? 0xfaa61a : 0x5865f2)
        .addFields(
            {
                name: '来源',
                value: borrowed
                    ? `跟着服务器 \`${source}\` 走。`
                        + `**在本服改词表不生效**，要改去那个服务器改，改完两边一起变。`
                    : '本服自己的。',
            },
            {
                name: '规模',
                value: [
                    `词条 ${dict.length} 条，其中本体词 ${core.length} 个`,
                    `互斥集合 ${sets.length} 组，交叉互斥 ${cross.length} 条`,
                ].join('\n'),
            },
            {
                name: '本体词',
                value: core.length > 0
                    ? core.map(d => d.rawWord).join('、').slice(0, 1024)
                    : '_一个都没标。_ 本体词是大家真的会打进搜索框的那几个分类名，'
                        + '它们在正文里也从严处理；其余是关联词，落在正文里要结合上下文判。',
            },
            {
                name: '怎么改词条',
                value: [
                    '改一两条：`/标题规范 词典 添加` / `删除`',
                    '改一大批：`/标题规范 词典 导出` → 在 Excel 里改（含「词档」列）→ `导入`',
                ].join('\n'),
            },
        );

    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId(BTN_EDIT_DICTSRC)
                    .setLabel('改词表来源').setStyle(ButtonStyle.Primary).setEmoji('🔗'),
                new ButtonBuilder().setCustomId(BTN_HOME)
                    .setLabel('返回').setStyle(ButtonStyle.Secondary).setEmoji('◀️'),
            ),
        ],
    };
}

// ============================================================
// 入口
// ============================================================

export async function openConfigPanel(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    if (!canOpen(memberOf(interaction), guildId)) {
        await interaction.reply({
            content: '❌ 打开配置台需要「复核」「覆盖」「词表」「设置」里的任意一项权限。',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }
    await interaction.reply({ ...homeView(guildId), flags: MessageFlags.Ephemeral });
}

// ============================================================
// 按钮
// ============================================================

export async function handleConfigButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith(P)) return false;
    const guildId = interaction.guildId!;

    if (!canOpen(memberOf(interaction), guildId)) {
        await denied(interaction, '你没有操作这个面板的权限。');
        return true;
    }

    // 权限这一页只有管理员能碰：否则拿到「复核」的人能给自己发「设置」
    const needsAdmin = interaction.customId.startsWith(BTN_PERMS);
    if (needsAdmin && !checkAdminPermission(memberOf(interaction))) {
        await denied(interaction, '「权限」只有服主和 Discord 管理员能改。');
        return true;
    }

    if (interaction.customId === BTN_HOME) {
        await interaction.update(homeView(guildId));
        return true;
    }
    if (interaction.customId === BTN_PERMS) {
        await interaction.update(permsView(guildId));
        return true;
    }
    if (interaction.customId === BTN_FORUMS) {
        await interaction.update(forumsView(guildId));
        return true;
    }
    if (interaction.customId === BTN_TIMING) {
        await interaction.update(timingView(guildId));
        return true;
    }
    if (interaction.customId === BTN_DICT) {
        await interaction.update(dictView(guildId));
        return true;
    }

    if (interaction.customId.startsWith(BTN_TOGGLE)) {
        if (!hasCapability(memberOf(interaction), guildId, '设置')) {
            await denied(interaction, '改开关需要「设置」权限。');
            return true;
        }
        const key = interaction.customId.split(':')[2] as (typeof TOGGLES)[number]['key'];
        if (!TOGGLES.some(t => t.key === key)) return true;

        const current = db.getSettings(guildId);
        db.saveSettings({ guildId, [key]: !current[key] } as Parameters<typeof db.saveSettings>[0]);
        invalidateConfigCache();
        await interaction.update(timingView(guildId));
        return true;
    }

    if (interaction.customId === BTN_EDIT_GRACE || interaction.customId === BTN_EDIT_QUEUE) {
        if (!hasCapability(memberOf(interaction), guildId, '设置')) {
            await denied(interaction, '改这些需要「设置」权限。');
            return true;
        }
        const s = db.getSettings(guildId);
        const field = (id: string, label: string, value: number, hint: string) =>
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId(id).setLabel(label).setValue(String(value))
                    .setPlaceholder(hint)
                    .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6),
            );

        await interaction.showModal(
            interaction.customId === BTN_EDIT_GRACE
                ? new ModalBuilder().setCustomId(MODAL_GRACE).setTitle('改期限').addComponents(
                    field('graceNew', '活帖宽限（小时）', s.graceNewHours, '默认 24'),
                    field('graceOld', '老帖宽限（小时）', s.graceOldHours, '默认 168'),
                    field('inactive', '沉寂多少小时算老帖', s.oldPostInactiveHours, '默认 48'),
                )
                : new ModalBuilder().setCustomId(MODAL_QUEUE).setTitle('改队列速率').addComponents(
                    field('fastSize', '活跃帖：一批发几条', s.fastBatchSize, '默认 50'),
                    field('fastPause', '活跃帖：每批歇几分钟', s.fastBatchPauseMinutes, '默认 30'),
                    field('slowGap', '老帖：几分钟发一个', s.queueIntervalMinutes, '默认 5'),
                ),
        );
        return true;
    }

    if (interaction.customId === BTN_EDIT_DICTSRC) {
        if (!hasCapability(memberOf(interaction), guildId, '设置')) {
            await denied(interaction, '改词表来源需要「设置」权限。');
            return true;
        }
        await interaction.showModal(
            new ModalBuilder().setCustomId(MODAL_DICTSRC).setTitle('词表来源').addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('source')
                        .setLabel('跟着哪个服务器的词表走')
                        .setValue(db.getSettings(guildId).dictSourceGuildId)
                        .setPlaceholder('填服务器 ID；留空 = 用本服自己的')
                        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20),
                ),
            ),
        );
        return true;
    }

    return true;
}

// ============================================================
// 选择菜单
// ============================================================

export async function handleConfigSelect(interaction: AnySelectMenuInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith(P)) return false;
    const guildId = interaction.guildId!;

    // ① 选了一项能力 → 把身份组菜单画出来
    if (interaction.customId === SEL_CAP) {
        if (!checkAdminPermission(memberOf(interaction))) {
            await denied(interaction, '「权限」只有服主和 Discord 管理员能改。');
            return true;
        }
        const cap = interaction.isStringSelectMenu() ? interaction.values[0] : '';
        await interaction.update(permsView(guildId, isCapability(cap) ? cap : undefined));
        return true;
    }

    // ② 选完身份组 → 覆盖这一项能力的名单
    if (interaction.customId.startsWith(SEL_ROLES)) {
        if (!checkAdminPermission(memberOf(interaction))) {
            await denied(interaction, '「权限」只有服主和 Discord 管理员能改。');
            return true;
        }
        const cap = interaction.customId.split(':')[2];
        if (!isCapability(cap) || !interaction.isRoleSelectMenu()) return true;

        const wanted = new Set(interaction.values);
        // 覆盖语义：菜单里没勾的就是要移除的
        for (const id of db.listRolesWithCapability(guildId, cap)) {
            if (!wanted.has(id)) db.revokeCapability(guildId, id, cap);
        }
        for (const id of wanted) db.grantCapability(guildId, id, cap, interaction.user.id);

        // 老的「接警身份组」是另一份列表，一并对齐，免得摘了这边那边还在被 @
        if (cap === '接警') {
            db.saveSettings({ guildId, alertRoleIds: [...wanted] });
        }

        await interaction.update(permsView(guildId, cap));
        return true;
    }

    // ③ 论坛
    if (interaction.customId === SEL_FORUMS) {
        if (!hasCapability(memberOf(interaction), guildId, '设置')) {
            await denied(interaction, '纳管论坛需要「设置」权限。');
            return true;
        }
        if (!interaction.isChannelSelectMenu()) return true;

        const wanted = new Set(interaction.values);
        for (const f of db.listForums(guildId)) {
            if (!wanted.has(f.forumId)) db.removeForum(guildId, f.forumId);
        }
        for (const id of wanted) {
            // addForum 已经是 upsert；已存在的顺手确保是启用状态
            db.addForum(guildId, id);
            db.updateForum(guildId, id, { enabled: true });
        }

        invalidateConfigCache();
        await interaction.update(forumsView(guildId));
        return true;
    }

    return true;
}

// ============================================================
// 模态框
// ============================================================

const MODALS = new Set([MODAL_GRACE, MODAL_QUEUE, MODAL_DICTSRC]);

export async function handleConfigModal(interaction: ModalSubmitInteraction): Promise<boolean> {
    if (!MODALS.has(interaction.customId)) return false;
    const guildId = interaction.guildId!;

    if (!hasCapability(memberOf(interaction), guildId, '设置')) {
        await denied(interaction, '改这些需要「设置」权限。');
        return true;
    }

    const ok = (text: string) =>
        interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    const bad = (text: string) =>
        interaction.reply({ content: `❌ ${text}`, flags: MessageFlags.Ephemeral });

    // ---------- 词表来源 ----------
    if (interaction.customId === MODAL_DICTSRC) {
        const raw = interaction.fields.getTextInputValue('source').trim();
        const target = raw === '' || raw === guildId ? '' : raw;

        if (target && !/^\d{17,20}$/.test(target)) {
            await bad('要填服务器 ID（一串 17~20 位数字），或者留空改回用本服自己的词表。');
            return true;
        }
        // 指过去的词表要是空的，等于把本服的判定整个关掉，而且不会有任何报错。必须当场拦住
        if (target && db.listDict(target).length === 0) {
            await bad(`服务器 \`${target}\` 的词表是空的，指过去等于把本服的判定全关了。`
                + '先去那个服务器把词表配好再回来。');
            return true;
        }

        db.saveSettings({ guildId, dictSourceGuildId: target });
        invalidateConfigCache();
        await ok(target
            ? `✅ 本服词表改为跟着服务器 \`${target}\` 走。`
                + '之后在本服敲词典指令会被拦下，提示你去那个服务器改。'
            : '✅ 本服改回使用自己的词表。');
        return true;
    }

    // ---------- 数值类 ----------
    const num = (id: string, min: number): number | null => {
        const n = Number(interaction.fields.getTextInputValue(id).trim());
        return Number.isFinite(n) && n >= min ? Math.trunc(n) : null;
    };

    if (interaction.customId === MODAL_GRACE) {
        const graceNew = num('graceNew', 1);
        const graceOld = num('graceOld', 1);
        const inactive = num('inactive', 1);

        // 全有全无：只存一半会留下一份自相矛盾的配置，比报错难查得多
        if (graceNew === null || graceOld === null || inactive === null) {
            await bad('三个都得填**不小于 1 的整数**，一项都没保存。');
            return true;
        }

        db.saveSettings({
            guildId,
            graceNewHours: graceNew,
            graceOldHours: graceOld,
            oldPostInactiveHours: inactive,
        });
        invalidateConfigCache();
        await ok(`✅ 已保存：活帖 ${graceNew} 小时 · 老帖 ${graceOld} 小时 · `
            + `沉寂 ${inactive} 小时算老帖。（面板点「返回」刷新）`);
        return true;
    }

    // MODAL_QUEUE
    const fastSize = num('fastSize', 1);
    const fastPause = num('fastPause', 0);
    const slowGap = num('slowGap', 1);

    if (fastSize === null || fastPause === null || slowGap === null) {
        await bad('每批条数和老帖间隔要**不小于 1**，间歇分钟可以填 0，一项都没保存。');
        return true;
    }

    db.saveSettings({
        guildId,
        fastBatchSize: fastSize,
        fastBatchPauseMinutes: fastPause,
        queueIntervalMinutes: slowGap,
    });
    invalidateConfigCache();
    await ok(`✅ 已保存：活跃帖 ${fastSize} 条/批歇 ${fastPause} 分钟 · `
        + `老帖 ${slowGap} 分钟一个。（面板点「返回」刷新）`);
    return true;
}
