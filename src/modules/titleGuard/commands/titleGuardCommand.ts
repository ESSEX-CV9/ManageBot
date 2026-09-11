// src/modules/titleGuard/commands/titleGuardCommand.ts
//
// /标题规范 —— 管理命令。
//
// 权限按**能力**发，不按「是不是管理员」发（见 services/titleGuardPermissions.ts）：
// 社区管理组是一堆身份组，风纪委员和执行管理管的事情不一样。
//   词表 → 词典/分词/互斥/TAG 映射   设置 → 开关/论坛/队列
//   复核 → 案件/豁免/还原            覆盖 → 通知上的放行按钮
// 某项能力没配任何身份组时回退到管理员判定，也就是保持升级前的行为。
//
// 唯一的例外是 `权限` 这一组：发权限的权限**只有服主和 Discord 管理员**有，
// 否则一个只有「复核」的身份组能给自己发「设置」，权限体系就形同虚设。

import {
    AttachmentBuilder,
    ChannelType,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    type ForumChannel,
    type GuildMember,
} from 'discord.js';
import ExcelJS from 'exceljs';

import type { Command } from '../../../core/types';
import {
    checkAdminPermission,
    getAllowedRoles,
    getPermissionDeniedMessage,
} from '../../../core/utils/permissionManager';
import {
    CAPABILITIES,
    CAPABILITY_HINT,
    hasCapability,
    isCapability,
    rolesWithCapability,
    type GuardCapability,
} from '../services/titleGuardPermissions';

import * as db from '../services/titleGuardDatabase';
import { getCompiledConfig, invalidateConfigCache, fetchThread, inspectThread, effectiveViolations, revertLast, applyPlan } from '../services/enforcer';
import { autoMapTags, scanForums, type ScanRow } from '../services/backfillQueue';
import { describeLlmConfig, summarizeJudgement } from '../services/llmJudge';
import { cutForDebug } from '../services/wordBoundary';
import { openConfigPanel } from '../components/configPanel';
import { normalize } from '../services/normalizer';
import type {
    DictKind, DictScope, ExclusiveDimension, SegmenterWord, WordTier,
} from '../services/types';

// ============================================================
// 权限
// ============================================================

/** 交互里的 member 有时是残缺的（缺 roles），补一次真实成员 */
async function resolveMember(interaction: ChatInputCommandInteraction): Promise<GuildMember | null> {
    const member = interaction.member as GuildMember | null;
    if (member && member.roles) return member;
    try {
        const guild = interaction.guild ?? await interaction.client.guilds.fetch(interaction.guildId!);
        return await guild.members.fetch(interaction.user.id);
    } catch {
        return null;
    }
}

/** 这条子命令需要哪项能力。任意一项满足即可 */
async function requireCap(
    interaction: ChatInputCommandInteraction, caps: GuardCapability[],
): Promise<boolean> {
    if (!interaction.guildId) {
        await interaction.reply({ content: '❌ 这个指令只能在服务器里使用。', flags: MessageFlags.Ephemeral });
        return false;
    }

    const member = await resolveMember(interaction);
    if (caps.some(c => hasCapability(member, interaction.guildId!, c))) return true;

    const names = caps.map(c => `「${c}」`).join('或');
    await interaction.reply({
        content: `❌ 这个操作需要${names}权限。\n`
            + '（管理组可用 `/标题规范 权限 授予` 把它发给对应的身份组）',
        flags: MessageFlags.Ephemeral,
    });
    return false;
}

/** 发权限这件事本身不走能力体系，只认服主和 Discord 管理员 */
async function requireAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (!interaction.guildId) {
        await interaction.reply({ content: '❌ 这个指令只能在服务器里使用。', flags: MessageFlags.Ephemeral });
        return false;
    }
    if (checkAdminPermission(await resolveMember(interaction))) return true;
    await interaction.reply({ content: getPermissionDeniedMessage(), flags: MessageFlags.Ephemeral });
    return false;
}

// ============================================================
// 命令定义
// ============================================================

const data = new SlashCommandBuilder()
    .setName('标题规范')
    .setDescription('管理论坛帖子的标题与 TAG 分类规范')

    .addSubcommand(s => s.setName('面板').setDescription('打开配置台：批量改权限、论坛、时间与开关'))

    .addSubcommand(s => s.setName('配置').setDescription('查看/修改本服务器的规范设置')
        .addChannelOption(o => o.setName('接警频道').setDescription('无法 @ 到接警身份组时，通知发到这里').addChannelTypes(ChannelType.GuildText))
        .addRoleOption(o => o.setName('接警身份组').setDescription('出事 @ 谁（只增不减；要移除用 /标题规范 权限 收回）'))
        .addBooleanOption(o => o.setName('启用').setDescription('总开关'))
        .addBooleanOption(o => o.setName('自动整改').setDescription('到期后是否允许机器人动手改'))
        .addBooleanOption(o => o.setName('启用llm').setDescription('是否调用 LLM 判定标题正文'))
        .addBooleanOption(o => o.setName('llm需确认').setDescription('LLM 判出的违规是否要管理组先确认'))
        .addIntegerOption(o => o.setName('新帖宽限小时').setDescription('默认 24').setMinValue(1).setMaxValue(720))
        .addIntegerOption(o => o.setName('老帖宽限小时').setDescription('默认 168（7 天）').setMinValue(1).setMaxValue(2160))
        .addIntegerOption(o => o.setName('老帖沉寂小时')
            .setDescription('已归档且沉寂超过多少小时算老帖（看最近回复，不看发帖时间），默认 72')
            .setMinValue(1))
        .addIntegerOption(o => o.setName('队列间隔分钟')
            .setDescription('老帖队列多久发一个，默认 5').setMinValue(1))
        .addIntegerOption(o => o.setName('快队列每批')
            .setDescription('活跃帖一批最多发几条，默认 50').setMinValue(1))
        .addIntegerOption(o => o.setName('快队列间歇分钟')
            .setDescription('活跃帖每批之间歇多久，默认 30').setMinValue(0))
        .addStringOption(o => o.setName('词表来源')
            .setDescription('词表跟着哪个服务器走。填服务器ID；填 self 改回用自己的')))

    .addSubcommandGroup(g => g.setName('权限').setDescription('哪些身份组能干哪些事')
        .addSubcommand(s => s.setName('授予').setDescription('把一项能力发给一个身份组')
            .addRoleOption(o => o.setName('身份组').setDescription('比如风纪委员').setRequired(true))
            .addStringOption(o => o.setName('能力').setDescription('要发哪一项').setRequired(true)
                .addChoices(...CAPABILITIES.map(c => ({ name: `${c} —— ${CAPABILITY_HINT[c]}`, value: c })))))
        .addSubcommand(s => s.setName('收回').setDescription('收回一项能力（不填能力则全部收回）')
            .addRoleOption(o => o.setName('身份组').setDescription('要收回的身份组').setRequired(true))
            .addStringOption(o => o.setName('能力').setDescription('留空 = 收回这个身份组的全部能力')
                .addChoices(...CAPABILITIES.map(c => ({ name: c, value: c })))))
        .addSubcommand(s => s.setName('列表').setDescription('查看当前的权限分配')))

    .addSubcommandGroup(g => g.setName('论坛').setDescription('管哪些论坛')
        .addSubcommand(s => s.setName('添加').setDescription('把一个论坛纳入管理')
            .addChannelOption(o => o.setName('论坛').setDescription('论坛频道（和「频道id」二选一）').addChannelTypes(ChannelType.GuildForum))
            .addStringOption(o => o.setName('频道id').setDescription('直接填论坛频道 ID，频道太多不好翻时用'))
            .addBooleanOption(o => o.setName('正文给llm').setDescription('是否允许把首楼摘录发给 LLM（露骨内容多的论坛建议关）')))
        .addSubcommand(s => s.setName('移除').setDescription('移出管理')
            .addChannelOption(o => o.setName('论坛').setDescription('论坛频道（和「频道id」二选一）').addChannelTypes(ChannelType.GuildForum))
            .addStringOption(o => o.setName('频道id').setDescription('直接填论坛频道 ID')))
        .addSubcommand(s => s.setName('列表').setDescription('列出已纳入管理的论坛')))

    .addSubcommandGroup(g => g.setName('词典').setDescription('维护关键词表')
        .addSubcommand(s => s.setName('添加').setDescription('新增/修改一个词条')
            .addStringOption(o => o.setName('词').setDescription('关键词').setRequired(true))
            .addStringOption(o => o.setName('类型').setDescription('词条类型').setRequired(true)
                .addChoices(
                    { name: '分类词', value: '分类词' },
                    { name: '黑名单（命中即改）', value: '黑名单' },
                    { name: '白名单（吃掉误判）', value: '白名单' },
                    { name: '中性标记（如多路线）', value: '中性标记' },
                ))
            .addStringOption(o => o.setName('分类组').setDescription('归属的分类组，如 NTR'))
            .addStringOption(o => o.setName('词档').setDescription('本体词管得严，关联词看上下文；不填保持原样')
                .addChoices(
                    { name: '本体词（就是大家搜的那几个字，严格处理）', value: '本体' },
                    { name: '关联词（只是相关，写在正文里多半是描述）', value: '关联' },
                ))
            .addStringOption(o => o.setName('替换为').setDescription('黑名单词替换成什么，如 NTR'))
            .addStringOption(o => o.setName('范围').setDescription('在哪里生效，默认全标题')
                .addChoices(
                    { name: '全标题', value: '全标题' },
                    { name: '仅标记段', value: '仅标记段' },
                    { name: '仅主体段', value: '仅主体段' },
                ))
            .addStringOption(o => o.setName('备注').setDescription('给管理组看的说明')))
        .addSubcommand(s => s.setName('删除').setDescription('删掉一个词条')
            .addStringOption(o => o.setName('词').setDescription('关键词').setRequired(true)))
        .addSubcommand(s => s.setName('列表').setDescription('查看词典'))
        .addSubcommand(s => s.setName('导出').setDescription('把词典导成 Excel'))
        .addSubcommand(s => s.setName('导入').setDescription('从 Excel 批量导入词典')
            .addAttachmentOption(o => o.setName('文件').setDescription('导出格式的 xlsx').setRequired(true))))

    .addSubcommandGroup(g => g.setName('互斥组').setDescription('配置三种互斥关系')
        .addSubcommand(s => s.setName('添加').setDescription('把一个分类组加进某个互斥集合')
            .addStringOption(o => o.setName('维度').setDescription('这条互斥管的是 TAG 还是标题关键字')
                .addChoices(
                    { name: 'TAG 之间互斥', value: 'tag' },
                    { name: '标题关键字之间互斥', value: 'word' },
                ).setRequired(true))
            .addStringOption(o => o.setName('集合名').setDescription('如「男女向路线」').setRequired(true))
            .addStringOption(o => o.setName('分类组').setDescription('如 NTR').setRequired(true)))
        .addSubcommand(s => s.setName('移除').setDescription('把一个分类组移出互斥集合')
            .addStringOption(o => o.setName('维度').setDescription('TAG 还是标题关键字')
                .addChoices(
                    { name: 'TAG 之间互斥', value: 'tag' },
                    { name: '标题关键字之间互斥', value: 'word' },
                ).setRequired(true))
            .addStringOption(o => o.setName('集合名').setDescription('集合名').setRequired(true))
            .addStringOption(o => o.setName('分类组').setDescription('分类组').setRequired(true)))
        .addSubcommand(s => s.setName('交叉').setDescription('挂了 X 的 TAG → 标题里不许出现 Y 的关键字')
            .addStringOption(o => o.setName('tag分类').setDescription('如 百合').setRequired(true))
            .addStringOption(o => o.setName('关键字分类').setDescription('如 百破').setRequired(true))
            .addBooleanOption(o => o.setName('双向').setDescription('true=反方向也一并禁'))
            .addBooleanOption(o => o.setName('删除').setDescription('传 true 表示删掉这条')))
        .addSubcommand(s => s.setName('列表').setDescription('查看三种互斥关系')))

    .addSubcommandGroup(g => g.setName('分词').setDescription('纠正中文分词器的切分')
        .addSubcommand(s => s.setName('补词').setDescription('分词器不认识这个词，加给它')
            .addStringOption(o => o.setName('词').setDescription('如 牛逼').setRequired(true))
            .addStringOption(o => o.setName('备注').setDescription('为什么要加')))
        .addSubcommand(s => s.setName('拆词').setDescription('分词器把这个词粘得太狠，拆开')
            .addStringOption(o => o.setName('词').setDescription('如 戴绿帽').setRequired(true))
            .addStringOption(o => o.setName('备注').setDescription('为什么要拆')))
        .addSubcommand(s => s.setName('删除').setDescription('把一条分词配置删掉')
            .addStringOption(o => o.setName('词').setDescription('要删的词').setRequired(true)))
        .addSubcommand(s => s.setName('试切').setDescription('看一段文字会被切成什么')
            .addStringOption(o => o.setName('文字').setDescription('标题或片段').setRequired(true)))
        .addSubcommand(s => s.setName('列表').setDescription('查看分词词库')))

    .addSubcommandGroup(g => g.setName('tag映射').setDescription('论坛 TAG 对应哪个分类组')
        .addSubcommand(s => s.setName('自动生成').setDescription('用 TAG 名去词典里猜，不覆盖已人工配置的')
            .addChannelOption(o => o.setName('论坛')
                .setDescription('留空 = 已纳管的全部论坛一起跑')
                .addChannelTypes(ChannelType.GuildForum)))
        .addSubcommand(s => s.setName('查看').setDescription('查看某论坛的映射')
            .addChannelOption(o => o.setName('论坛').setDescription('论坛频道').addChannelTypes(ChannelType.GuildForum).setRequired(true)))
        .addSubcommand(s => s.setName('修改').setDescription('手工指定某个 TAG 的分类组')
            .addChannelOption(o => o.setName('论坛').setDescription('论坛频道').addChannelTypes(ChannelType.GuildForum).setRequired(true))
            .addStringOption(o => o.setName('tag名').setDescription('TAG 名称').setRequired(true))
            .addStringOption(o => o.setName('分类组').setDescription('留空表示清除映射'))))

    .addSubcommand(s => s.setName('检查').setDescription('手动检查单个帖子，显示完整判定过程')
        .addStringOption(o => o.setName('帖子').setDescription('帖子链接或 ID').setRequired(true)))

    .addSubcommand(s => s.setName('扫描').setDescription('快速全量扫描：拉全部帖子标题判一遍，出 Excel')
        .addChannelOption(o => o.setName('论坛')
            .setDescription('留空 = 已纳管的全部论坛一起扫')
            .addChannelTypes(ChannelType.GuildForum))
        .addBooleanOption(o => o.setName('静默')
            .setDescription('true=只出报表不动手（默认 true）；false=合格的记账、违规的入队')))

    .addSubcommandGroup(g => g.setName('案件').setDescription('查看待处理的案件')
        .addSubcommand(s => s.setName('列表').setDescription('列出未结案件'))
        .addSubcommand(s => s.setName('执行').setDescription('对某个挂起的案件立即执行整改方案')
            .addIntegerOption(o => o.setName('编号').setDescription('案件编号').setRequired(true)))
        .addSubcommand(s => s.setName('关闭').setDescription('关掉一个案件（不做任何修改）')
            .addIntegerOption(o => o.setName('编号').setDescription('案件编号').setRequired(true))))

    .addSubcommand(s => s.setName('还原').setDescription('还原机器人对某个帖子最近一次的改动')
        .addStringOption(o => o.setName('帖子').setDescription('帖子链接或 ID').setRequired(true)))

    .addSubcommandGroup(g => g.setName('豁免').setDescription('豁免管理')
        .addSubcommand(s => s.setName('添加').setDescription('放行一个帖子的当前标题')
            .addStringOption(o => o.setName('帖子').setDescription('帖子链接或 ID').setRequired(true))
            .addStringOption(o => o.setName('备注').setDescription('原因')))
        .addSubcommand(s => s.setName('移除').setDescription('取消豁免')
            .addStringOption(o => o.setName('帖子').setDescription('帖子链接或 ID').setRequired(true)))
        .addSubcommand(s => s.setName('列表').setDescription('查看豁免名单')))

    .addSubcommandGroup(g => g.setName('队列').setDescription('整改队列（活跃帖 / 老帖两条）')
        .addSubcommand(s => s.setName('状态').setDescription('查看进度'))
        .addSubcommand(s => s.setName('暂停').setDescription('暂停队列'))
        .addSubcommand(s => s.setName('继续').setDescription('继续队列'))
        .addSubcommand(s => s.setName('清空').setDescription('清空队列'))
        .addSubcommand(s => s.setName('重置核查')
            .setDescription('清掉「已核查合格」记录，让下次全量扫描重新判一遍所有帖子')));

// ============================================================
// 小工具
// ============================================================

function parseThreadId(input: string): string {
    const trimmed = input.trim();
    const link = trimmed.match(/channels\/\d+\/(\d+)/);
    if (link) return link[1];
    const mention = trimmed.match(/^<#(\d+)>$/);
    if (mention) return mention[1];
    return trimmed;
}

function ephemeral(content: string) {
    return { content, flags: MessageFlags.Ephemeral } as const;
}

// ============================================================
// 各子命令
// ============================================================

async function handleConfig(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const o = interaction.options;

    const patch: Partial<db.GuardSettings> & { guildId: string } = { guildId };
    let changed = false;

    const channel = o.getChannel('接警频道');
    if (channel) { patch.alertChannelId = channel.id; changed = true; }

    const role = o.getRole('接警身份组');
    if (role) {
        const current = db.getSettings(guildId).alertRoleIds;
        patch.alertRoleIds = current.includes(role.id) ? current : [...current, role.id];
        changed = true;
    }

    for (const [option, key] of [
        ['启用', 'enabled'],
        ['自动整改', 'autoFixEnabled'],
        ['启用llm', 'llmEnabled'],
        ['llm需确认', 'llmNeedsConfirm'],
    ] as const) {
        const value = o.getBoolean(option);
        if (value !== null) { (patch as Record<string, unknown>)[key] = value; changed = true; }
    }

    for (const [option, key] of [
        ['新帖宽限小时', 'graceNewHours'],
        ['老帖宽限小时', 'graceOldHours'],
        ['老帖沉寂小时', 'oldPostInactiveHours'],
        ['队列间隔分钟', 'queueIntervalMinutes'],
        ['快队列每批', 'fastBatchSize'],
        ['快队列间歇分钟', 'fastBatchPauseMinutes'],
    ] as const) {
        const value = o.getInteger(option);
        if (value !== null) { (patch as Record<string, unknown>)[key] = value; changed = true; }
    }

    const dictSource = o.getString('词表来源');
    if (dictSource !== null) {
        const trimmed = dictSource.trim();
        const target = trimmed === '' || trimmed.toLowerCase() === 'self' || trimmed === guildId
            ? '' : trimmed;
        if (target && !/^\d{17,20}$/.test(target)) {
            await interaction.reply(ephemeral('❌ 词表来源要填服务器 ID（一串数字），'
                + '或者填 `self` 改回用本服自己的词表。'));
            return;
        }
        if (target && db.listDict(target).length === 0) {
            await interaction.reply(ephemeral(`❌ 服务器 \`${target}\` 的词表是空的。`
                + '先去那个服务器把词表配好，再回来指过去——'
                + '指向一个空词表等于把本服的判定全关掉。'));
            return;
        }
        patch.dictSourceGuildId = target;
        changed = true;
    }

    const settings = changed ? db.saveSettings(patch) : db.getSettings(guildId);

    const alertList = rolesWithCapability(guildId, '接警');
    const reviewList = rolesWithCapability(guildId, '复核');
    const alertRoles = alertList.length > 0
        ? alertList.map(id => `<@&${id}>`).join(' ')
        : (getAllowedRoles().length > 0
            ? `_未设置，将回退到权限管理器里的身份组：${getAllowedRoles().map(id => `<@&${id}>`).join(' ')}_`
            : '⚠️ _未设置——申诉转人工时 @ 不到任何人_');

    const embed = new EmbedBuilder()
        .setTitle('⚙️ 标题规范设置')
        .setColor(settings.enabled ? 0x3ba55d : 0x99aab5)
        .addFields(
            { name: '总开关', value: settings.enabled ? '✅ 已启用' : '⛔ 未启用', inline: true },
            { name: '自动整改', value: settings.autoFixEnabled ? '✅ 到期会动手' : '⛔ 只通知不动手', inline: true },
            { name: 'LLM', value: settings.llmEnabled ? describeLlmConfig() : '⛔ 已关闭' },
            { name: 'LLM 判定需管理组确认', value: settings.llmNeedsConfirm ? '是' : '否', inline: true },
            { name: '新帖宽限', value: `${settings.graceNewHours} 小时`, inline: true },
            { name: '老帖宽限', value: `${settings.graceOldHours} 小时`, inline: true },
            {
                name: '老帖门槛',
                value: `已归档且沉寂超过 ${settings.oldPostInactiveHours} 小时`,
                inline: true,
            },
            {
                name: '队列速率',
                value: `活跃帖 ${settings.fastBatchSize} 条/批，间歇 ${settings.fastBatchPauseMinutes} 分钟`
                    + `
老帖 ${settings.queueIntervalMinutes} 分钟 / 帖`,
                inline: true,
            },
            {
                name: '词表来源',
                value: settings.dictSourceGuildId
                    ? `跟着服务器 \`${settings.dictSourceGuildId}\` 走`
                        + `（本服的词典指令会被拦下，去那边改）`
                    : '本服自己的',
                inline: true,
            },
            { name: '队列状态', value: settings.queuePaused ? '⏸️ 已暂停' : '▶️ 运行中', inline: true },
            {
                name: '接警身份组',
                value: alertRoles,
            },
            {
                name: '负责人工复核',
                value: reviewList.length > 0
                    ? reviewList.map(id => `<@&${id}>`).join(' ')
                    : '_未配置，申诉转人工时改 @ 接警身份组_',
            },
            { name: '接警频道', value: settings.alertChannelId ? `<#${settings.alertChannelId}>` : '_未设置_' },
        )
        .setFooter({ text: '各项操作分别需要哪种权限，用 /标题规范 权限 列表 查看。' });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/**
 * 身份组能力。
 *
 * 「管理组」在这个社区是一堆身份组，各管一摊，所以权限按能力发。
 * 三条兜底规矩在 services/titleGuardPermissions.ts 里，这里只负责增删查和把状态说清楚——
 * 尤其是「没配任何身份组 = 当前仅管理员可用」这一条，不写在面板上没人猜得到。
 */
async function handlePerms(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
    const guildId = interaction.guildId!;

    if (sub === '授予' || sub === '收回') {
        const role = interaction.options.getRole('身份组', true);
        const capRaw = interaction.options.getString('能力');

        /**
         * 老的「接警身份组」是存在 settings 里的另一份列表，
         * 而且那条命令只增不删。不在这儿一并清掉的话，
         * 从老路径加进去的身份组就永远摘不掉了。
         */
        const dropLegacyAlert = (): boolean => {
            const current = db.getSettings(guildId).alertRoleIds;
            if (!current.includes(role.id)) return false;
            db.saveSettings({ guildId, alertRoleIds: current.filter(id => id !== role.id) });
            return true;
        };

        if (sub === '收回' && !capRaw) {
            const n = db.revokeAllCapabilities(guildId, role.id);
            const legacy = dropLegacyAlert();
            await interaction.reply(ephemeral(n > 0 || legacy
                ? `✅ 已收回 <@&${role.id}> 的全部能力${n > 0 ? `（${n} 项）` : ''}`
                    + `${legacy ? '，并从接警身份组名单里移除' : ''}。`
                : `⚠️ <@&${role.id}> 本来就没有任何能力。`));
            return;
        }

        if (!capRaw || !isCapability(capRaw)) {
            await interaction.reply(ephemeral('❌ 能力名认不出来。'));
            return;
        }

        if (sub === '授予') {
            const ok = db.grantCapability(guildId, role.id, capRaw, interaction.user.id);
            await interaction.reply(ephemeral(ok
                ? `✅ <@&${role.id}> 现在可以：**${capRaw}** —— ${CAPABILITY_HINT[capRaw]}`
                : `⚠️ <@&${role.id}> 已经有「${capRaw}」了。`));
        } else {
            const ok = db.revokeCapability(guildId, role.id, capRaw);
            // 收回「接警」要连老名单一起清，否则它还会继续被 @ 到
            const legacy = capRaw === '接警' && dropLegacyAlert();
            await interaction.reply(ephemeral(ok || legacy
                ? `✅ 已收回 <@&${role.id}> 的「${capRaw}」。`
                : `⚠️ <@&${role.id}> 本来就没有「${capRaw}」。`));
        }
        return;
    }

    // 列表
    const embed = new EmbedBuilder()
        .setTitle('🔑 标题规范 · 权限分配')
        .setColor(0x5865f2)
        .setDescription(
            '服主和带 Discord 管理员权限的人始终拥有全部能力。\n'
            + '某项能力**一个身份组都没配**时，它回退到管理员判定——也就是只有上面那些人能用。',
        );

    for (const cap of CAPABILITIES) {
        const roles = rolesWithCapability(guildId, cap);
        embed.addFields({
            name: `${cap} —— ${CAPABILITY_HINT[cap]}`,
            value: roles.length > 0
                ? roles.map(id => `<@&${id}>`).join(' ')
                : '_未配置，当前仅管理员可用_',
        });
    }

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/**
 * 从「论坛」选择器或「频道id」里拿到论坛频道。
 *
 * 有两件事必须拦住，否则指令会回一句 ✅ 然后什么都不发生，你根本查不出来：
 *
 *   1. **填的是别的服务器的频道 ID。** 论坛名单是按服务器存的，而机器人检查帖子时
 *      是拿「帖子所在的服」去查名单的。在 A 服把 B 服的论坛加进来，记录会落在 A 服名下，
 *      B 服的帖子永远查不到它 —— 加了等于没加。要管 B 服的论坛，就去 B 服敲这条指令。
 *   2. 填的 ID 根本不是论坛频道。
 */
async function resolveForum(
    interaction: ChatInputCommandInteraction,
): Promise<ForumChannel | null> {
    const picked = interaction.options.getChannel('论坛');
    if (picked) return picked as ForumChannel;

    const raw = (interaction.options.getString('频道id') ?? '').trim();
    if (!raw) {
        await interaction.reply(ephemeral('❌ 「论坛」和「频道id」至少要给一个。'));
        return null;
    }

    const id = raw.replace(/[<#>]/g, '');
    if (!/^\d{17,20}$/.test(id)) {
        await interaction.reply(ephemeral(`❌ \`${raw}\` 不像一个频道 ID。`));
        return null;
    }

    const channel = await interaction.client.channels.fetch(id).catch(() => null);
    if (!channel) {
        await interaction.reply(ephemeral(`❌ 找不到频道 \`${id}\`，`
            + '可能是机器人不在那个服务器，或者没有查看权限。'));
        return null;
    }
    if (channel.type !== ChannelType.GuildForum) {
        await interaction.reply(ephemeral(`❌ \`${id}\` 不是论坛频道。`));
        return null;
    }

    const forum = channel as ForumChannel;
    if (forum.guildId !== interaction.guildId) {
        await interaction.reply(ephemeral([
            `❌ \`${forum.name}\` 在另一个服务器，不能从这儿加。`,
            '',
            '论坛名单是按服务器分开存的，机器人检查帖子时会去**帖子所在那个服**的名单里找。',
            '从这边加进来，记录会落在本服名下，那边永远查不到 —— 加了等于没加。',
            '',
            '**去那个服务器敲同一条指令就行。**',
            '词表不用重配：在那边跑一次 `/标题规范 配置 词表来源:'
                + `${interaction.guildId}\`，两边就共用一份词表了；`,
            '身份组和通知仍然各用各服自己的。',
        ].join('\n')));
        return null;
    }

    return forum;
}

async function handleForum(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
    const guildId = interaction.guildId!;

    if (sub === '列表') {
        const forums = db.listForums(guildId);
        if (forums.length === 0) {
            await interaction.reply(ephemeral('还没有纳入任何论坛。用 `/标题规范 论坛 添加` 开始。'));
            return;
        }
        const lines = forums.map(f =>
            `• <#${f.forumId}> — ${f.enabled ? '启用' : '停用'}，正文给 LLM：${f.sendBodyToLlm ? '是' : '否'}`,
        );
        await interaction.reply(ephemeral(`**已纳入管理的论坛（${forums.length}）**\n${lines.join('\n')}`));
        return;
    }

    const forum = await resolveForum(interaction);
    if (!forum) return;

    if (sub === '移除') {
        db.removeForum(guildId, forum.id);
        await interaction.reply(ephemeral(`✅ 已把 <#${forum.id}> 移出管理。`));
        return;
    }

    // 添加
    db.addForum(guildId, forum.id);
    const sendBody = interaction.options.getBoolean('正文给llm');
    if (sendBody !== null) db.updateForum(guildId, forum.id, { sendBodyToLlm: sendBody });

    const mapped = autoMapTags(interaction.guild!, forum);
    await interaction.reply(ephemeral(
        `✅ 已纳入 <#${forum.id}>。\n`
        + `顺便扫了一遍它的 ${mapped.total} 个 TAG，其中 ${mapped.guessed} 个按词典自动猜出了分类组。\n`
        + `用 \`/标题规范 tag映射 查看\` 核对，猜错的用 \`tag映射 修改\` 改。`,
    ));
}

async function handleDict(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
    const guildId = interaction.guildId!;

    if (sub === '添加') {
        const word = interaction.options.getString('词', true);
        const kind = interaction.options.getString('类型', true) as DictKind;
        const group = interaction.options.getString('分类组');
        // 不填就保持原样：别把管理组辛苦标好的本体词，因为改了个备注就悄悄降回关联
        const tier = (interaction.options.getString('词档') ?? undefined) as WordTier | undefined;
        const replaceTo = interaction.options.getString('替换为');
        const scope = (interaction.options.getString('范围') ?? '全标题') as DictScope;
        const note = interaction.options.getString('备注');

        if (kind !== '白名单' && !group) {
            await interaction.reply(ephemeral('❌ 除白名单外，都必须指定「分类组」。'));
            return;
        }

        const record = db.upsertDict(guildId, {
            rawWord: word, kind, group, tier, replaceTo, scope, note,
        });
        invalidateConfigCache();

        await interaction.reply(ephemeral(
            `✅ 已保存词条 **${record.rawWord}**\n`
            + `类型：${record.kind}　分类组：${record.group ?? '—'}　`
            + `词档：${record.tier}　范围：${record.scope}\n`
            + `替换为：${record.replaceTo ?? '—'}　词边界：${record.asciiBoundary ? '是' : '否'}`,
        ));
        return;
    }

    if (sub === '删除') {
        const word = interaction.options.getString('词', true);
        const ok = db.deleteDict(guildId, word);
        invalidateConfigCache();
        await interaction.reply(ephemeral(ok ? `✅ 已删除词条 **${word}**。` : `⚠️ 词典里没有 **${word}**。`));
        return;
    }

    if (sub === '列表') {
        const dict = db.listDict(guildId);
        if (dict.length === 0) {
            await interaction.reply(ephemeral('词典是空的。代码里不内置任何默认词——全部由管理组用 `/标题规范 词典 添加` 维护。'));
            return;
        }
        const byKind = new Map<string, string[]>();
        for (const d of dict) {
            // 本体词单独打个星，管理组一眼看得出哪些词是从严处理的
            const line = `${d.tier === '本体' ? '★' : ''}${d.rawWord}`
                + `${d.group ? `→${d.group}` : ''}${d.replaceTo ? ` ⇒${d.replaceTo}` : ''}`
                + `${d.enabled ? '' : '（停用）'}`;
            const list = byKind.get(d.kind);
            if (list) list.push(line);
            else byKind.set(d.kind, [line]);
        }
        const embed = new EmbedBuilder().setTitle(`📖 词典（共 ${dict.length} 条）`).setColor(0x5865f2)
            .setFooter({ text: '★ = 本体词，写进标题就一定被搜到，所以从严处理；'
                + '其余是关联词，落在正文里要结合上下文判' });
        for (const [kind, lines] of byKind) {
            embed.addFields({ name: `${kind}（${lines.length}）`, value: lines.join('、').slice(0, 1024) });
        }
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        return;
    }

    if (sub === '导出') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const dict = db.listDict(guildId);

        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('词典');
        ws.columns = [
            { header: '词', key: 'word', width: 20 },
            { header: '类型', key: 'kind', width: 12 },
            { header: '分类组', key: 'group', width: 12 },
            { header: '词档', key: 'tier', width: 8 },
            { header: '范围', key: 'scope', width: 12 },
            { header: '替换为', key: 'replaceTo', width: 12 },
            { header: '词边界', key: 'boundary', width: 8 },
            { header: '启用', key: 'enabled', width: 8 },
            { header: '备注', key: 'note', width: 40 },
        ];
        for (const d of dict) {
            ws.addRow({
                word: d.rawWord,
                kind: d.kind,
                group: d.group ?? '',
                tier: d.tier,
                scope: d.scope,
                replaceTo: d.replaceTo ?? '',
                boundary: d.asciiBoundary ? '是' : '否',
                enabled: d.enabled ? '是' : '否',
                note: d.note ?? '',
            });
        }
        ws.getRow(1).font = { bold: true };

        // 光有词条不够用：互斥关系、交叉规则、优先级都得跟着走，
        // 不然换个服务器复用时，词还在，规矩全丢了。
        const sets = db.listExclusiveSets(guildId);
        const cross = db.listCrossExclusions(guildId);
        const groups = db.listGroups(guildId);

        const wsSets = wb.addWorksheet('互斥关系');
        wsSets.columns = [
            { header: '维度', key: 'dim', width: 14 },
            { header: '集合名', key: 'name', width: 20 },
            { header: '分类组（逗号分隔）', key: 'groups', width: 46 },
        ];
        for (const x of sets) {
            wsSets.addRow({
                dim: x.dimension === 'tag' ? 'TAG' : '关键字',
                name: x.name,
                groups: x.groups.join(', '),
            });
        }

        const wsCross = wb.addWorksheet('交叉互斥');
        wsCross.columns = [
            { header: 'TAG 分类', key: 'tag', width: 16 },
            { header: '标题里禁止出现的分类', key: 'word', width: 24 },
            { header: '备注', key: 'note', width: 40 },
        ];
        for (const c of cross) {
            wsCross.addRow({ tag: c.tagGroup, word: c.wordGroup, note: c.note ?? '' });
        }

        const wsGroups = wb.addWorksheet('分类优先级');
        wsGroups.columns = [
            { header: '分类组', key: 'group', width: 16 },
            { header: '优先级', key: 'priority', width: 10 },
            { header: '规范写法', key: 'canonical', width: 16 },
            { header: '备注', key: 'note', width: 40 },
        ];
        for (const g of groups) {
            wsGroups.addRow({
                group: g.groupId,
                priority: g.priority,
                canonical: g.canonical,
                note: g.note ?? '',
            });
        }

        const segWords = db.listSegmenterWords(guildId);
        const wsSeg = wb.addWorksheet('分词词库');
        wsSeg.columns = [
            { header: '词', key: 'word', width: 20 },
            { header: '动作', key: 'action', width: 10 },
            { header: '备注', key: 'note', width: 40 },
        ];
        for (const w of segWords) {
            wsSeg.addRow({ word: w.word, action: w.action, note: w.note ?? '' });
        }

        for (const w of [wsSets, wsCross, wsGroups, wsSeg]) w.getRow(1).font = { bold: true };

        const buffer = await wb.xlsx.writeBuffer();
        await interaction.editReply({
            content: `📤 已导出：词条 ${dict.length} 条、互斥集合 ${sets.length} 组、`
                + `交叉互斥 ${cross.length} 条、分类 ${groups.length} 个、分词词 ${segWords.length} 条。\n`
                + `五张表都能改完用 \`/标题规范 词典 导入\` 传回来。\n`
                + `（TAG 映射没导出——它是按论坛记的，换个服务器 ID 对不上，得重新生成。）`,
            files: [new AttachmentBuilder(Buffer.from(buffer), { name: '标题规范词表.xlsx' })],
        });
        return;
    }

    if (sub === '导入') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const file = interaction.options.getAttachment('文件', true);

        try {
            const res = await fetch(file.url);
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.load(await res.arrayBuffer());
            // 词条表：认表名，认不到就退回第一张（兼容旧版只有一张表的导出文件）
            const ws = wb.getWorksheet('词典') ?? wb.worksheets[0];
            if (!ws) throw new Error('文件里没有工作表');

            let imported = 0;
            const errors: string[] = [];

            ws.eachRow((row, index) => {
                if (index === 1) return; // 表头
                const cell = (i: number) => String(row.getCell(i).value ?? '').trim();
                const word = cell(1);
                if (!word) return;

                try {
                    db.upsertDict(guildId, {
                        rawWord: word,
                        kind: (cell(2) || '分类词') as DictKind,
                        group: cell(3) || null,
                        // 老版本导出的文件没有「词档」这一列，留空就保持原样
                        tier: cell(4) === '本体' ? '本体'
                            : cell(4) === '关联' ? '关联' : undefined,
                        scope: (cell(5) || '全标题') as DictScope,
                        replaceTo: cell(6) || null,
                        asciiBoundary: cell(7) ? cell(7) === '是' : undefined,
                        enabled: cell(8) ? cell(8) === '是' : true,
                        note: cell(9) || null,
                    });
                    imported++;
                } catch (err) {
                    errors.push(`第 ${index} 行「${word}」：${err instanceof Error ? err.message : err}`);
                }
            });

            // 配置表是可选的：老版本导出的文件只有词条，跳过就是了
            const extra = importConfigSheets(guildId, wb, errors);

            invalidateConfigCache();
            await interaction.editReply(
                `✅ 导入完成，词条 ${imported} 条`
                + (extra ? `，${extra}` : '')
                + '。'
                + (errors.length > 0 ? `\n⚠️ 失败 ${errors.length} 条：\n${errors.slice(0, 5).join('\n')}` : ''),
            );
        } catch (err) {
            await interaction.editReply(`❌ 导入失败：${err instanceof Error ? err.message : err}`);
        }
    }
}

/**
 * 导入 xlsx 里的配置表（互斥关系 / 交叉互斥 / 分类优先级）。
 * 三张表都是可选的——老版本导出的文件只有词条，缺哪张跳哪张。
 *
 * 语义是**增量覆盖**，跟词条导入一致：文件里有的就写进去，
 * 文件里没提到的原有配置保持不动。要清空得用对应的删除指令。
 */
function importConfigSheets(
    guildId: string,
    wb: ExcelJS.Workbook,
    errors: string[],
): string {
    const done: string[] = [];
    const text = (row: ExcelJS.Row, i: number) => String(row.getCell(i).value ?? '').trim();

    const wsSets = wb.getWorksheet('互斥关系');
    if (wsSets) {
        let n = 0;
        wsSets.eachRow((row, index) => {
            if (index === 1) return;
            const dimRaw = text(row, 1);
            const setName = text(row, 2);
            const groups = text(row, 3).split(/[,，]/).map(x => x.trim()).filter(Boolean);
            if (!dimRaw && !setName && groups.length === 0) return;

            const dimension: ExclusiveDimension | null =
                /tag/i.test(dimRaw) ? 'tag' : dimRaw.includes('关键字') ? 'word' : null;
            if (!dimension) {
                errors.push(`互斥关系第 ${index} 行：维度「${dimRaw}」认不出来，只认「TAG」或「关键字」`);
                return;
            }
            if (!setName) {
                errors.push(`互斥关系第 ${index} 行：集合名是空的`);
                return;
            }
            for (const g of groups) {
                db.ensureGroup(guildId, g);
                db.addToExclusiveSet(guildId, dimension, setName, g);
            }
            n++;
        });
        if (n > 0) done.push(`互斥集合 ${n} 组`);
    }

    const wsCross = wb.getWorksheet('交叉互斥');
    if (wsCross) {
        let n = 0;
        wsCross.eachRow((row, index) => {
            if (index === 1) return;
            const tagGroup = text(row, 1);
            const wordGroup = text(row, 2);
            if (!tagGroup && !wordGroup) return;
            if (!tagGroup || !wordGroup) {
                errors.push(`交叉互斥第 ${index} 行：两边都得填`);
                return;
            }
            db.ensureGroup(guildId, tagGroup);
            db.ensureGroup(guildId, wordGroup);
            db.addCrossExclusion(guildId, tagGroup, wordGroup, text(row, 3) || undefined);
            n++;
        });
        if (n > 0) done.push(`交叉互斥 ${n} 条`);
    }

    const wsSeg = wb.getWorksheet('分词词库');
    if (wsSeg) {
        let n = 0;
        wsSeg.eachRow((row, index) => {
            if (index === 1) return;
            const word = text(row, 1);
            if (!word) return;
            const raw = text(row, 2);
            const action: SegmenterWord['action'] = raw.includes('拆') ? '拆词' : '补词';
            if (raw && !raw.includes('拆') && !raw.includes('补')) {
                errors.push(`分词词库第 ${index} 行「${word}」：动作「${raw}」认不出来，只认「补词」或「拆词」`);
                return;
            }
            db.upsertSegmenterWord(guildId, word, action, text(row, 3) || undefined);
            n++;
        });
        if (n > 0) done.push(`分词词 ${n} 条`);
    }

    const wsGroups = wb.getWorksheet('分类优先级');
    if (wsGroups) {
        let n = 0;
        wsGroups.eachRow((row, index) => {
            if (index === 1) return;
            const group = text(row, 1);
            if (!group) return;
            const priority = Number(text(row, 2));
            if (Number.isNaN(priority)) {
                errors.push(`分类优先级第 ${index} 行「${group}」：优先级不是数字`);
                return;
            }
            db.upsertGroup(guildId, group, text(row, 3) || group, priority, text(row, 4) || undefined);
            n++;
        });
        if (n > 0) done.push(`分类 ${n} 个`);
    }

    return done.join('、');
}

async function handleExclusive(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
    const guildId = interaction.guildId!;

    if (sub === '添加' || sub === '移除') {
        const dimension = interaction.options.getString('维度', true) as ExclusiveDimension;
        const setName = interaction.options.getString('集合名', true);
        const group = interaction.options.getString('分类组', true);
        const what = dimension === 'tag' ? 'TAG 互斥' : '关键字互斥';

        if (sub === '添加') {
            db.ensureGroup(guildId, group);
            db.addToExclusiveSet(guildId, dimension, setName, group);
            invalidateConfigCache();
            await interaction.reply(ephemeral(
                `✅ 已把 **${group}** 加入${what}集合「${setName}」。`,
            ));
            return;
        }

        db.removeFromExclusiveSet(guildId, dimension, setName, group);
        invalidateConfigCache();
        await interaction.reply(ephemeral(`✅ 已把 **${group}** 移出${what}集合「${setName}」。`));
        return;
    }

    if (sub === '交叉') {
        const tagGroup = interaction.options.getString('tag分类', true);
        const wordGroup = interaction.options.getString('关键字分类', true);
        const both = interaction.options.getBoolean('双向') ?? false;
        const remove = interaction.options.getBoolean('删除') ?? false;

        const pairs: [string, string][] = both
            ? [[tagGroup, wordGroup], [wordGroup, tagGroup]]
            : [[tagGroup, wordGroup]];

        if (remove) {
            for (const [t, w] of pairs) db.removeCrossExclusion(guildId, t, w);
            invalidateConfigCache();
            await interaction.reply(ephemeral(
                `✅ 已删除交叉互斥：${pairs.map(([t, w]) => `${t} TAG × ${w} 关键字`).join('、')}。`,
            ));
            return;
        }

        for (const [t, w] of pairs) {
            db.ensureGroup(guildId, t);
            db.ensureGroup(guildId, w);
            db.addCrossExclusion(guildId, t, w);
        }
        invalidateConfigCache();
        await interaction.reply(ephemeral(
            `✅ 已添加交叉互斥：`
            + pairs.map(([t, w]) => `挂 **${t}** TAG 时标题里不得出现 **${w}**`).join('；')
            + '。\n撞上时按分类优先级裁决：优先级低的那边被摘掉，'
            + '在 TAG 侧就摘 TAG，在关键字侧就删标题里的词。',
        ));
        return;
    }

    // 列表
    const sets = db.listExclusiveSets(guildId);
    const cross = db.listCrossExclusions(guildId);
    const groups = db.listGroups(guildId);
    const priority = new Map(groups.map(g => [g.groupId, g.priority]));
    const withPriority = (list: string[]) => [...list]
        .sort((x, y) => (priority.get(y) ?? 0) - (priority.get(x) ?? 0))
        .map(g => `${g}(${priority.get(g) ?? 0})`)
        .join(' > ');

    const embed = new EmbedBuilder().setTitle('⚔️ 互斥关系').setColor(0xed4245)
        .setDescription(
            'TAG 和标题关键字是两套独立的东西，互不互斥分开配。\n'
            + '括号里是保留优先级，撞上时留数值大的。',
        );

    for (const [dimension, label] of [['tag', 'TAG 之间互斥'], ['word', '标题关键字之间互斥']] as const) {
        const mine = sets.filter(x => x.dimension === dimension);
        embed.addFields({
            name: label,
            value: mine.length > 0
                ? mine.map(x => `• **${x.name}**：${withPriority(x.groups)}`).join('\n')
                : '_还没配置。代码里不内置默认值。_',
        });
    }

    embed.addFields({
        name: '交叉互斥（TAG × 关键字，有方向）',
        value: cross.length > 0
            ? cross.map(c => `• 挂 **${c.tagGroup}** TAG → 标题里不得出现 **${c.wordGroup}**`).join('\n')
            : '_还没配置。_',
    });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/**
 * 分词词库。
 *
 * 词典匹配是按字面找子串的，中文没空格，所以「班上的乖乖女同学」里会找到「女同」。
 * 引擎拿分词器切一遍，只放行落在词边界上的命中——于是分词器切得准不准，
 * 直接决定判得对不对。这组指令就是用来纠正它的：
 *   补词：它不认识「牛逼」，把「我说纯爱牛逼」切成「纯爱/牛/逼」，「纯爱牛」就混过去了
 *   拆词：它把「戴绿帽」当成一个词，「绿帽」抠不出来，真正的 NTR 反而漏判
 */
async function handleSegmenter(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
    const guildId = interaction.guildId!;

    if (sub === '补词' || sub === '拆词') {
        const word = interaction.options.getString('词', true).trim();
        const note = interaction.options.getString('备注') ?? undefined;
        if (!word) {
            await interaction.reply(ephemeral('❌ 词不能是空的。'));
            return;
        }
        db.upsertSegmenterWord(guildId, word, sub, note);
        invalidateConfigCache();

        const before = cutForDebug(word, [], []);
        const after = cutForDebug(word, [], db.listSegmenterWords(guildId));
        await interaction.reply(ephemeral(
            `✅ 已${sub}：**${word}**\n`
            + (before && after
                ? `「${word}」现在切成：${after.join(' / ')}（原来：${before.join(' / ')}）`
                : '（分词器没加载起来，这条配置暂时不会生效）'),
        ));
        return;
    }

    if (sub === '删除') {
        const word = interaction.options.getString('词', true).trim();
        const ok = db.removeSegmenterWord(guildId, word);
        invalidateConfigCache();
        await interaction.reply(ephemeral(ok ? `✅ 已删除分词配置 **${word}**。` : `⚠️ 词库里没有 **${word}**。`));
        return;
    }

    if (sub === '试切') {
        const text = interaction.options.getString('文字', true);
        const raw = getCompiledConfig(guildId).raw;
        const jargon = raw.dict.filter(d => d.kind !== '黑名单').map(d => d.word);
        const cut = cutForDebug(normalize(text).text, jargon, raw.segmenterWords ?? []);
        await interaction.reply(ephemeral(
            cut
                ? `\`${text}\`\n切成：\n\`${cut.join(' / ')}\`\n\n`
                    + '命中只有起止都落在这些边界上才作数（仅限标题正文，标签区不受此限）。'
                : '❌ 分词器没加载起来。',
        ));
        return;
    }

    // 列表
    const words = db.listSegmenterWords(guildId);
    const embed = new EmbedBuilder().setTitle('✂️ 分词词库').setColor(0x5865f2)
        .setDescription(
            '用来纠正中文分词器的切分。标题正文里的命中必须落在词边界上才作数，\n'
            + '所以分词器切错了，判定就跟着错。\n'
            + '代码里不内置任何词，全部在这里配。',
        );

    for (const [action, hint] of [
        ['补词', '分词器不认识，加给它'],
        ['拆词', '分词器粘得太狠，拆开'],
    ] as const) {
        const mine = words.filter(w => w.action === action);
        embed.addFields({
            name: `${action}（${hint}）`,
            value: mine.length > 0
                ? mine.map(w => `• **${w.word}**${w.note ? ` —— ${w.note}` : ''}`).join('\n')
                : '_还没配置。_',
        });
    }

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleTagMap(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
    const guildId = interaction.guildId!;

    // 自动生成允许不指定论坛 —— 那就把已纳管的全部跑一遍。
    // 纳管了八个论坛还要敲八次，是上线时最烦的一步。
    if (sub === '自动生成') {
        const picked = interaction.options.getChannel('论坛') as ForumChannel | null;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const targets: ForumChannel[] = [];
        const missing: string[] = [];

        if (picked) {
            targets.push(picked);
        } else {
            for (const f of db.listForums(guildId)) {
                const ch = await interaction.client.channels.fetch(f.forumId).catch(() => null);
                if (ch && ch.type === ChannelType.GuildForum) targets.push(ch as ForumChannel);
                else missing.push(f.forumId);
            }
        }

        if (targets.length === 0) {
            await interaction.editReply(picked
                ? '❌ 读不到这个论坛。'
                : '还没有纳管任何论坛。先用 `/标题规范 论坛 添加`。');
            return;
        }

        const lines: string[] = [];
        let total = 0;
        let guessed = 0;
        let mapped = 0;

        for (const forum of targets) {
            const r = autoMapTags(interaction.guild!, forum);
            total += r.total;
            guessed += r.guessed;
            mapped += r.mapped;
            const left = r.total - r.mapped;
            lines.push(`• <#${forum.id}> ${r.total} 个 TAG，新猜出 ${r.guessed} 个`
                + (left > 0 ? `，还有 **${left}** 个没对上` : '，全部有归属'));
        }
        invalidateConfigCache();

        const left = total - mapped;
        await interaction.editReply([
            `✅ 跑完 ${targets.length} 个论坛，共 ${total} 个 TAG，新猜出 ${guessed} 个分类组。`,
            ...lines,
            '',
            '已人工配置过的映射不会被覆盖。',
            left > 0
                ? `还有 **${left}** 个 TAG 没对上分类组 —— 多半是画风、平台这类非分类 TAG，`
                    + '那就不用管；真是分类 TAG 的用 `/标题规范 tag映射 修改` 手工指一下。'
                : '所有 TAG 都有归属了。',
            ...(missing.length > 0
                ? ['', `⚠️ 有 ${missing.length} 个纳管的论坛读不到（频道删了或没权限）：`
                    + missing.map(id => `\`${id}\``).join('、')]
                : []),
        ].join('\n'));
        return;
    }

    const forum = interaction.options.getChannel('论坛', true) as ForumChannel;

    if (sub === '修改') {
        const tagName = interaction.options.getString('tag名', true);
        const group = interaction.options.getString('分类组');
        const tag = forum.availableTags.find(t => t.name === tagName);
        if (!tag) {
            await interaction.reply(ephemeral(`❌ 这个论坛里没有叫「${tagName}」的 TAG。`));
            return;
        }
        db.setTagMapping(guildId, forum.id, tag.id, tag.name, group || null);
        invalidateConfigCache();
        await interaction.reply(ephemeral(
            group ? `✅ TAG「${tagName}」→ 分类组 **${group}**。` : `✅ 已清除 TAG「${tagName}」的分类映射。`,
        ));
        return;
    }

    // 查看
    const mappings = db.listTagMap(guildId, forum.id);
    if (mappings.length === 0) {
        await interaction.reply(ephemeral('这个论坛还没有映射记录，先跑 `/标题规范 tag映射 自动生成`。'));
        return;
    }
    const mapped = mappings.filter(m => m.group);
    const unmapped = mappings.filter(m => !m.group);

    const embed = new EmbedBuilder()
        .setTitle(`🏷️ ${forum.name} 的 TAG 映射`)
        .setColor(0x5865f2)
        .addFields(
            {
                name: `已映射（${mapped.length}）`,
                value: mapped.map(m => `${m.tagName} → **${m.group}**`).join('\n').slice(0, 1024) || '—',
            },
            {
                name: `未映射（${unmapped.length}）`,
                value: unmapped.map(m => m.tagName).join('、').slice(0, 1024) || '—',
            },
        );

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleInspect(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const threadId = parseThreadId(interaction.options.getString('帖子', true));
    const thread = await fetchThread(interaction.client, threadId);
    if (!thread) {
        await interaction.editReply('❌ 找不到这个帖子，或者它不是论坛帖。');
        return;
    }

    const inspection = await inspectThread(thread);
    if (inspection.skipped) {
        await interaction.editReply(`ℹ️ 跳过：${inspection.skipped}`);
        return;
    }

    const violations = effectiveViolations(inspection);
    const embed = new EmbedBuilder()
        .setTitle('🔍 检查结果')
        .setColor(violations.length > 0 ? 0xf0a30a : 0x3ba55d)
        .addFields(
            { name: '标题', value: `\`${thread.name}\``.slice(0, 1024) },
            { name: 'TAG', value: inspection.tags.map(t => `${t.tagName}${t.group ? `(${t.group})` : ''}`).join('、') || '—' },
            {
                name: '切分结果',
                value: inspection.detectResult.segments
                    .map(s => `${s.kind === 'marker' ? '【标记】' : '【正文】'}${s.text}`)
                    .join('\n').slice(0, 1024) || '—',
            },
            {
                name: '命中的词',
                value: inspection.detectResult.matches
                    .map(m => `${m.entry.word}[${m.entry.kind}${m.entry.group ? `/${m.entry.group}` : ''}] @${m.segmentKind === 'marker' ? '标记' : '正文'}`)
                    .join('\n').slice(0, 1024) || '—',
            },
        );

    if (violations.length > 0) {
        embed.addFields({
            name: '违规',
            value: violations.map(v => `**${v.rule}** ${v.message}（${v.arbiter}裁决）`)
                .join('\n').slice(0, 1024),
        });
    } else {
        embed.addFields({ name: '结论', value: '✅ 没有发现问题' });
    }

    if (inspection.judgement) {
        embed.addFields({
            name: 'LLM 判定',
            value: (summarizeJudgement(inspection.judgement) ?? '—').slice(0, 1024),
        });
    }

    if (inspection.plan) {
        embed.addFields({
            name: '整改方案',
            value: [
                `新标题：\`${inspection.plan.newTitle}\``,
                `保留分类：${inspection.plan.keepGroup ?? '—'}（依据：${inspection.plan.keepSource}）`,
                `摘除 TAG：${inspection.plan.removeTagIds.length} 个`,
                `可自动执行：${inspection.plan.autoFixable ? '是' : `否 — ${inspection.plan.blockedReason}`}`,
            ].join('\n').slice(0, 1024),
        });
    }

    await interaction.editReply({ embeds: [embed] });
}

async function handleScan(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guildId!;
    const picked = interaction.options.getChannel('论坛') as ForumChannel | null;
    const dryRun = interaction.options.getBoolean('静默') ?? true;

    // 留空 = 已纳管的全部论坛。两万个帖子分散在好几个论坛里，
    // 一个一个敲既慢又容易漏掉一个
    const forumIds = picked ? [picked.id] : db.listForums(guildId).map(f => f.forumId);
    if (forumIds.length === 0) {
        await interaction.editReply('还没纳管任何论坛。先用 `/标题规范 论坛 添加`。');
        return;
    }

    // 词表空着照样跑的话，什么都匹配不到、全判合格，
    // 而 静默:false 会把这一大批帖子记成「已核查合格」—— 一次静悄悄的误判
    const dictSource = db.dictSourceOf(guildId);
    const classifiers = db.listDict(dictSource)
        .filter(d => d.enabled && d.kind === '分类词' && d.group);
    if (classifiers.length === 0) {
        await interaction.editReply([
            '🚨 **词表里一条分类词都没有，扫了也是白扫。**',
            '',
            dictSource === guildId
                ? '本服的词表是空的。先导入：`/标题规范 词典 导入 文件:标题规范词表.xlsx`'
                : `本服词表跟着服务器 \`${dictSource}\` 走，而那边的词表是空的。`,
            '',
            '（不拦住的话，所有帖子都会被判成合格；'
                + '要是再用了 `静默:false`，它们还会被记成「已核查」。）',
        ].join('\n'));
        return;
    }

    await interaction.editReply(
        `🔎 开始扫描${picked ? ` <#${picked.id}>` : `已纳管的 ${forumIds.length} 个论坛`}`
        + `（词表 ${classifiers.length} 条分类词）`
        + `${dryRun ? '　静默模式：只出报表，不发通知不改动' : ''}…`);

    try {
        const { rows, progress, failed, incomplete, active, archived } = await scanForums(
            interaction.client, guildId, forumIds, {
            dryRun,
            onProgress: p => {
                void interaction.editReply(
                    `🔎 扫描中… 已看 ${p.scanned} 个帖子，命中 ${p.flagged} 个`,
                ).catch(() => { /* 忽略 */ });
            },
        });

        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('检出结果');
        ws.columns = [
            { header: '论坛', key: 'forumName', width: 18 },
            { header: '标题', key: 'title', width: 50 },
            { header: 'TAG', key: 'tags', width: 24 },
            { header: '活跃状态', key: 'activity', width: 12 },
            { header: '处置', key: 'disposition', width: 12 },
            { header: '命中规则', key: 'rules', width: 14 },
            { header: '说明', key: 'detail', width: 50 },
            { header: '建议新标题', key: 'suggestedTitle', width: 50 },
            { header: '建议摘除TAG', key: 'removeTags', width: 20 },
            { header: '不能自动改的原因', key: 'blockedReason', width: 40 },
            { header: '作者ID', key: 'authorId', width: 22 },
            { header: '链接', key: 'threadUrl', width: 60 },
        ];
        for (const r of rows) {
            ws.addRow({ ...r } satisfies Record<keyof ScanRow, unknown> & Record<string, unknown>);
        }
        ws.getRow(1).font = { bold: true };

        const buffer = await wb.xlsx.writeBuffer();
        const count = (pick: (r: ScanRow) => boolean) => rows.filter(pick).length;
        const fastLane = count(r => r.activity !== '老帖');
        const slowLane = count(r => r.activity === '老帖');
        const settings = db.getSettings(interaction.guildId!);

        await interaction.editReply({
            content: `✅ 扫描完成。\n`
                + `• 看了 **${progress.scanned}** 个帖子`
                + `（活跃 ${active} + 已归档 ${archived}），跳过 ${progress.skipped} 个\n`
                + `• 合格 **${progress.scanned - progress.skipped - progress.flagged}** 个`
                + `${dryRun ? '' : '（已记为已核查）'}\n`
                + `• 违规 **${progress.flagged}** 个：`
                + `可自动整改 ${count(r => r.disposition === '可自动整改')}、`
                + `需模型定性 ${count(r => r.disposition === '需模型定性')}、`
                + `转人工 ${count(r => r.disposition === '转人工')}\n`
                + `• 分队：活跃/近期归档 **${fastLane}** 个、老帖 **${slowLane}** 个\n`
                + (dryRun
                    ? '\n静默模式：没发任何通知、没改任何东西、也没记账。'
                        + '\n确认这份表没问题之后，去掉 `静默:true` 再跑一次才会真动。'
                    : `\n已入队。按当前速率：活跃那批约 `
                        + `${Math.ceil(fastLane / Math.max(1, settings.fastBatchSize))} 批 × `
                        + `${settings.fastBatchPauseMinutes} 分钟，`
                        + `老帖那批约 ${Math.ceil(slowLane * settings.queueIntervalMinutes / 60)} 小时。`)
                + (failed.length > 0
                    ? `\n\n⚠️ 有 ${failed.length} 个论坛没扫成（频道删了或没权限），`
                        + '上面的数字不含它们。'
                    : '')
                // 取不全比扫不到更危险：数字看着正常，实际有一大批帖子压根没进来
                + (incomplete.length > 0
                    ? `\n\n🚨 **有 ${incomplete.length} 个论坛的帖子没取全**，`
                        + '上面的数字是不完整的，别拿它当摸底结论：\n'
                        + incomplete.map(x => `• <#${x.forumId}> — ${x.reason}`).join('\n')
                    : ''),
            files: [new AttachmentBuilder(Buffer.from(buffer), {
                name: `扫描结果_${picked ? picked.name : '全部论坛'}.xlsx`,
            })],
        });
    } catch (err) {
        await interaction.editReply(`❌ 扫描失败：${err instanceof Error ? err.message : err}`);
    }
}

async function handleCases(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
    const guildId = interaction.guildId!;

    if (sub === '列表') {
        const cases = db.listOpenCases(guildId, 25);
        if (cases.length === 0) {
            await interaction.reply(ephemeral('✅ 当前没有未结案件。'));
            return;
        }
        const lines = cases.map(c =>
            `**#${c.id}** \`${c.state}\` <#${c.threadId}>\n　${c.originalTitle.slice(0, 60)}\n　${c.violations.map(v => v.rule).join(' ')}`
            + (c.llmReason ? `\n　🤖 定性：${c.llmReason.slice(0, 70)}` : '')
            + (c.appealText
                ? `\n　🙋 申诉：${c.appealText.split('\n').pop()!.slice(0, 70)}`
                : '')
            + (c.aiReviewUpheld === null
                ? ''
                : `\n　⚖️ 复核：${c.aiReviewUpheld ? '维持原判' : '申诉成立'}——${(c.llmReviewReason ?? '').slice(0, 60)}`),
        );
        await interaction.reply(ephemeral(`**未结案件（${cases.length}）**\n\n${lines.join('\n\n').slice(0, 1900)}`));
        return;
    }

    const id = interaction.options.getInteger('编号', true);
    const guardCase = db.getCase(id);
    if (!guardCase || guardCase.guildId !== guildId) {
        await interaction.reply(ephemeral('❌ 找不到这个案件。'));
        return;
    }

    if (sub === '关闭') {
        db.closeCase(id, 'resolved');
        await interaction.reply(ephemeral(`✅ 已关闭案件 #${id}（没有做任何修改）。`));
        return;
    }

    // 执行
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const thread = await fetchThread(interaction.client, guardCase.threadId);
    if (!thread) {
        await interaction.editReply('❌ 找不到这个帖子了。');
        return;
    }

    const inspection = await inspectThread(thread);
    if (!inspection.plan) {
        await interaction.editReply('❌ 生成不了整改方案。');
        return;
    }
    if (!inspection.plan.autoFixable) {
        await interaction.editReply(`❌ 这个方案不能自动执行：${inspection.plan.blockedReason}`);
        return;
    }

    const result = await applyPlan(thread, inspection.plan, `admin:${interaction.user.id}`, guardCase.id);
    if (!result.ok) {
        await interaction.editReply(`❌ 执行失败：${result.error}`);
        return;
    }
    db.closeCase(id, 'resolved');
    await interaction.editReply(`✅ 已执行案件 #${id}。新标题：\`${inspection.plan.newTitle}\``);
}

async function handleRevert(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const threadId = parseThreadId(interaction.options.getString('帖子', true));
    const thread = await fetchThread(interaction.client, threadId);
    if (!thread) {
        await interaction.editReply('❌ 找不到这个帖子。');
        return;
    }

    const result = await revertLast(thread);
    await interaction.editReply(result.ok ? `✅ ${result.message}` : `❌ ${result.message}`);
}

async function handleExempt(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
    const guildId = interaction.guildId!;

    if (sub === '列表') {
        const list = db.listExempt(guildId, 25);
        if (list.length === 0) {
            await interaction.reply(ephemeral('豁免名单是空的。'));
            return;
        }
        await interaction.reply(ephemeral(
            `**豁免名单（${list.length}）**\n`
            + list.map(e => `• <#${e.threadId}> — 由 <@${e.byUserId}>${e.note ? `（${e.note}）` : ''}`).join('\n'),
        ));
        return;
    }

    const threadId = parseThreadId(interaction.options.getString('帖子', true));

    if (sub === '移除') {
        db.removeExempt(guildId, threadId);
        await interaction.reply(ephemeral(`✅ 已取消 <#${threadId}> 的豁免。`));
        return;
    }

    const thread = await fetchThread(interaction.client, threadId);
    if (!thread) {
        await interaction.reply(ephemeral('❌ 找不到这个帖子。'));
        return;
    }
    db.addExempt(guildId, threadId, thread.name, interaction.user.id, interaction.options.getString('备注') ?? undefined);
    const open = db.getOpenCase(threadId);
    if (open) db.closeCase(open.id, 'exempt');

    await interaction.reply(ephemeral(
        `✅ 已豁免 <#${threadId}> 的当前标题。\n作者之后如果再改标题，会重新走一次检查。`,
    ));
}

async function handleQueue(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
    const guildId = interaction.guildId!;

    if (sub === '暂停' || sub === '继续') {
        db.saveSettings({ guildId, queuePaused: sub === '暂停' });
        await interaction.reply(ephemeral(sub === '暂停'
            ? '⏸️ 整改队列已暂停（两条都停）。'
            : '▶️ 整改队列已继续。'));
        return;
    }

    if (sub === '清空') {
        db.clearBackfill(guildId);
        await interaction.reply(ephemeral('✅ 整改队列已清空（两条都清）。'));
        return;
    }

    // 用得着这条的场景：拿一份不对的词表（比如空词表）跑过 静默:false，
    // 一批帖子被错记成合格。清掉之后重跑全量，它们会按新词表重新判。
    if (sub === '重置核查') {
        const n = db.cleanCount(guildId);
        db.clearClean(guildId);
        await interaction.reply(ephemeral(n > 0
            ? `✅ 已清掉 ${n} 条「已核查合格」记录。`
                + `\n下次 \`/标题规范 扫描\` 会把这些帖子重新判一遍。`
            : '「已核查合格」本来就是空的，不用清。'));
        return;
    }

    const stats = db.backfillStats(guildId);
    const settings = db.getSettings(guildId);
    const fast = db.pendingCount(guildId, 'fast');
    const slow = db.pendingCount(guildId, 'slow');

    // 快队列是「一批 N 个然后歇 M 分钟」，所以耗时取决于**批数**，不是条数。
    // 最后一批发完就结束了，不用再歇，所以减一
    const fastBatches = Math.ceil(fast / Math.max(1, settings.fastBatchSize));
    const fastMin = Math.max(0, fastBatches - 1) * settings.fastBatchPauseMinutes;
    const slowMin = slow * settings.queueIntervalMinutes;

    const dur = (min: number) => min < 60
        ? `${min} 分钟`
        : min < 60 * 48 ? `${(min / 60).toFixed(1)} 小时` : `${(min / 60 / 24).toFixed(1)} 天`;

    // 队列不动的时候，绝大多数原因是这两个开关，而不是队列本身有问题。
    // 不在这儿说清楚，看的人只会看到「待处理 28」一直不变，完全无从下手
    const blockers: string[] = [];
    if (!settings.enabled) {
        blockers.push('🚨 **总开关是关的** —— 调度器根本不会碰队列。'
            + '开：`/标题规范 配置 启用:true`');
    }
    if (settings.queuePaused) {
        blockers.push('⏸️ **队列被暂停了**。继续：`/标题规范 队列 继续`');
    }
    if (blockers.length === 0 && fast + slow > 0) {
        blockers.push('▶️ 正在跑。调度器每分钟醒一次，'
            + '快队列会在一次唤醒里连着发完这一批，慢队列按间隔一个一个来。');
    }

    await interaction.reply(ephemeral([
        `**整改队列**`,
        ...blockers,
        '',
        `🏃 **快队列**（活跃帖 + 近期归档）　待处理 **${fast}**`,
        `　　${settings.fastBatchSize} 条一批，每批歇 ${settings.fastBatchPauseMinutes} 分钟`
            + `　→ 共 ${fastBatches} 批，约 ${dur(fastMin)}`,
        '',
        `🐢 **慢队列**（沉寂老帖）　待处理 **${slow}**`,
        `　　${settings.queueIntervalMinutes} 分钟一个　→ 约 ${dur(slowMin)}`,
        '',
        `累计：已完成 ${stats.done ?? 0}　跳过 ${stats.skipped ?? 0}　失败 ${stats.failed ?? 0}`,
        ...(stats.skipped
            ? ['_跳过 = 帖子没了 / 复查发现已经合规 / 已有未结案件。这些不占限速配额。_']
            : []),
        ...(stats.failed
            ? [`_失败 ${stats.failed} 个，去看机器人日志里的「队列整改失败」。_`]
            : []),
        '',
        '_两条队列并行跑，所以实际跑完的时间取慢的那条。_',
        '_限速是故意的：发通知一定会顶帖，一口气发几百条会把论坛首页整个刷掉。_',
    ].join('\n')));
}

// ============================================================
// 入口
// ============================================================

/**
 * 每组子命令需要哪项能力。列表里任意一项满足即可。
 * 键是子命令组名；没有组的（配置/检查/扫描/还原）用子命令名。
 */
/** 这几组指令改的都是词表本身，跟着别的服走时不能在本服改 */
const DICT_GROUPS = new Set(['词典', '分词', '互斥组']);
/** 这些只是看看，不改东西，跟随方也放行 */
const READ_ONLY_DICT_SUBS = new Set(['列表', '导出']);

const CAPS_FOR: Record<string, GuardCapability[]> = {
    词典: ['词表'],
    分词: ['词表'],
    互斥组: ['词表'],
    tag映射: ['词表'],
    论坛: ['设置'],
    队列: ['设置'],
    配置: ['设置'],
    案件: ['复核'],
    豁免: ['复核', '覆盖'],
    还原: ['复核', '覆盖'],
    // 只读的诊断，管词表和管设置的都该能看
    检查: ['词表', '设置', '复核'],
    扫描: ['词表', '设置', '复核'],
};

const command: Command = {
    data,
    async execute(interaction: ChatInputCommandInteraction) {
        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();

        // 发权限的权限不下放，其余按能力判。
        // 面板例外：它自己会按页判权限，外层一刀切会把只有「词表」的人挡在门外
        if (group === '权限') {
            if (!await requireAdmin(interaction)) return;
        } else if (group === null && sub === '面板') {
            if (!interaction.guildId) {
                await interaction.reply(ephemeral('❌ 这个指令只能在服务器里使用。'));
                return;
            }
        } else if (!await requireCap(interaction, CAPS_FOR[group ?? sub] ?? ['设置'])) {
            return;
        }

        // 词表跟着别的服走的时候，在本服改词表是无效的——改完了也不会被用上。
        // 不拦住的话管理组会在这儿改半天，然后发现判定一点没变，很难想到是这个原因。
        // 只拦「写」，查看和导出照常放行（想对照一下很正常）。
        if (DICT_GROUPS.has(group ?? '') && !READ_ONLY_DICT_SUBS.has(sub)) {
            const source = db.getSettings(interaction.guildId!).dictSourceGuildId;
            if (source) {
                await interaction.reply(ephemeral([
                    `⚠️ 本服的词表跟着服务器 \`${source}\` 走，在这儿改不生效。`,
                    '去那个服务器改，改完两边一起生效。',
                    '',
                    '想让本服用自己的词表：`/标题规范 配置 词表来源:self`',
                ].join('\n')));
                return;
            }
        }

        try {
            switch (group) {
                case '权限': return await handlePerms(interaction, sub);
                case '论坛': return await handleForum(interaction, sub);
                case '词典': return await handleDict(interaction, sub);
                case '分词': return await handleSegmenter(interaction, sub);
                case '互斥组': return await handleExclusive(interaction, sub);
                case 'tag映射': return await handleTagMap(interaction, sub);
                case '案件': return await handleCases(interaction, sub);
                case '豁免': return await handleExempt(interaction, sub);
                case '队列': return await handleQueue(interaction, sub);
                default: break;
            }

            switch (sub) {
                case '面板': return await openConfigPanel(interaction);
                case '配置': return await handleConfig(interaction);
                case '检查': return await handleInspect(interaction);
                case '扫描': return await handleScan(interaction);
                case '还原': return await handleRevert(interaction);
                default:
                    await interaction.reply(ephemeral('❌ 未知子命令。'));
            }
        } catch (err) {
            console.error('[TitleGuard] 命令执行出错：', err);
            const message = `❌ 执行出错：${err instanceof Error ? err.message : err}`;
            if (interaction.deferred) await interaction.editReply(message).catch(() => { /* 忽略 */ });
            else if (!interaction.replied) await interaction.reply(ephemeral(message)).catch(() => { /* 忽略 */ });
        }
    },
};

export default command;
export { getCompiledConfig };
