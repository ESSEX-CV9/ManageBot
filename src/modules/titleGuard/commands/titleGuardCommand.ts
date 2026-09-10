// src/modules/titleGuard/commands/titleGuardCommand.ts
//
// /标题规范 —— 管理命令。
//
// 权限一律走 core/utils/permissionManager 的 checkAdminPermission，模块内不另做一套。
// 注意区分：**判定权限**用 permissionManager；**「呼叫管理组」@ 谁**是配置面板里单独设的
// 「接警身份组」——有权限改和想被 ping 是两回事。

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

import * as db from '../services/titleGuardDatabase';
import { getCompiledConfig, invalidateConfigCache, fetchThread, inspectThread, effectiveViolations, revertLast, applyPlan } from '../services/enforcer';
import { autoMapTags, scanForum, type ScanRow } from '../services/backfillQueue';
import { describeLlmConfig } from '../services/llmJudge';
import { cutForDebug } from '../services/wordBoundary';
import { normalize } from '../services/normalizer';
import type { DictKind, DictScope, ExclusiveDimension, SegmenterWord } from '../services/types';

// ============================================================
// 权限
// ============================================================

async function requireAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (!interaction.guildId) {
        await interaction.reply({ content: '❌ 这个指令只能在服务器里使用。', flags: MessageFlags.Ephemeral });
        return false;
    }

    let member = interaction.member as GuildMember | null;
    if (!member || !member.roles) {
        try {
            const guild = interaction.guild ?? await interaction.client.guilds.fetch(interaction.guildId);
            member = await guild.members.fetch(interaction.user.id);
        } catch {
            member = null;
        }
    }

    if (checkAdminPermission(member)) return true;
    await interaction.reply({ content: getPermissionDeniedMessage(), flags: MessageFlags.Ephemeral });
    return false;
}

// ============================================================
// 命令定义
// ============================================================

const data = new SlashCommandBuilder()
    .setName('标题规范')
    .setDescription('管理论坛帖子的标题与 TAG 分类规范')

    .addSubcommand(s => s.setName('配置').setDescription('查看/修改本服务器的规范设置')
        .addChannelOption(o => o.setName('接警频道').setDescription('无法 @ 到接警身份组时，通知发到这里').addChannelTypes(ChannelType.GuildText))
        .addRoleOption(o => o.setName('接警身份组').setDescription('「呼叫管理组」按钮 @ 的身份组'))
        .addBooleanOption(o => o.setName('启用').setDescription('总开关'))
        .addBooleanOption(o => o.setName('自动整改').setDescription('到期后是否允许机器人动手改'))
        .addBooleanOption(o => o.setName('启用llm').setDescription('是否调用 LLM 判定标题正文'))
        .addBooleanOption(o => o.setName('llm需确认').setDescription('LLM 判出的违规是否要管理组先确认'))
        .addIntegerOption(o => o.setName('新帖宽限小时').setDescription('默认 24').setMinValue(1).setMaxValue(720))
        .addIntegerOption(o => o.setName('老帖宽限小时').setDescription('默认 168（7 天）').setMinValue(1).setMaxValue(2160))
        .addIntegerOption(o => o.setName('老帖天数').setDescription('发帖超过多少天算老帖，默认 60').setMinValue(1))
        .addIntegerOption(o => o.setName('队列间隔分钟').setDescription('老帖队列多久处理一个，默认 20').setMinValue(1)))

    .addSubcommandGroup(g => g.setName('论坛').setDescription('管哪些论坛')
        .addSubcommand(s => s.setName('添加').setDescription('把一个论坛纳入管理')
            .addChannelOption(o => o.setName('论坛').setDescription('论坛频道').addChannelTypes(ChannelType.GuildForum).setRequired(true))
            .addBooleanOption(o => o.setName('正文给llm').setDescription('是否允许把首楼摘录发给 LLM（露骨内容多的论坛建议关）')))
        .addSubcommand(s => s.setName('移除').setDescription('移出管理')
            .addChannelOption(o => o.setName('论坛').setDescription('论坛频道').addChannelTypes(ChannelType.GuildForum).setRequired(true)))
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
            .addChannelOption(o => o.setName('论坛').setDescription('论坛频道').addChannelTypes(ChannelType.GuildForum).setRequired(true)))
        .addSubcommand(s => s.setName('查看').setDescription('查看某论坛的映射')
            .addChannelOption(o => o.setName('论坛').setDescription('论坛频道').addChannelTypes(ChannelType.GuildForum).setRequired(true)))
        .addSubcommand(s => s.setName('修改').setDescription('手工指定某个 TAG 的分类组')
            .addChannelOption(o => o.setName('论坛').setDescription('论坛频道').addChannelTypes(ChannelType.GuildForum).setRequired(true))
            .addStringOption(o => o.setName('tag名').setDescription('TAG 名称').setRequired(true))
            .addStringOption(o => o.setName('分类组').setDescription('留空表示清除映射'))))

    .addSubcommand(s => s.setName('检查').setDescription('手动检查单个帖子，显示完整判定过程')
        .addStringOption(o => o.setName('帖子').setDescription('帖子链接或 ID').setRequired(true)))

    .addSubcommand(s => s.setName('扫描').setDescription('批量扫描一个论坛')
        .addChannelOption(o => o.setName('论坛').setDescription('论坛频道').addChannelTypes(ChannelType.GuildForum).setRequired(true))
        .addBooleanOption(o => o.setName('静默').setDescription('true=只出报表不动手（默认 true）')))

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

    .addSubcommandGroup(g => g.setName('队列').setDescription('老帖慢速整改队列')
        .addSubcommand(s => s.setName('状态').setDescription('查看进度'))
        .addSubcommand(s => s.setName('暂停').setDescription('暂停队列'))
        .addSubcommand(s => s.setName('继续').setDescription('继续队列'))
        .addSubcommand(s => s.setName('清空').setDescription('清空队列')));

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
        ['老帖天数', 'oldPostDays'],
        ['队列间隔分钟', 'queueIntervalMinutes'],
    ] as const) {
        const value = o.getInteger(option);
        if (value !== null) { (patch as Record<string, unknown>)[key] = value; changed = true; }
    }

    const settings = changed ? db.saveSettings(patch) : db.getSettings(guildId);

    const alertRoles = settings.alertRoleIds.length > 0
        ? settings.alertRoleIds.map(id => `<@&${id}>`).join(' ')
        : (getAllowedRoles().length > 0
            ? `_未设置，将回退到权限管理器里的身份组：${getAllowedRoles().map(id => `<@&${id}>`).join(' ')}_`
            : '⚠️ _未设置，且权限管理器里的 ALLOWED_ROLE_IDS 也是空的——「呼叫管理组」按钮 @ 不到任何人_');

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
            { name: '老帖门槛', value: `发帖超过 ${settings.oldPostDays} 天`, inline: true },
            { name: '队列速率', value: `${settings.queueIntervalMinutes} 分钟 / 帖`, inline: true },
            { name: '队列状态', value: settings.queuePaused ? '⏸️ 已暂停' : '▶️ 运行中', inline: true },
            { name: '接警身份组', value: alertRoles },
            { name: '接警频道', value: settings.alertChannelId ? `<#${settings.alertChannelId}>` : '_未设置_' },
        )
        .setFooter({ text: '管理命令的权限判定走 permissionManager；接警身份组只决定「呼叫管理组」@ 谁。' });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
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

    const forum = interaction.options.getChannel('论坛', true) as ForumChannel;

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
        const replaceTo = interaction.options.getString('替换为');
        const scope = (interaction.options.getString('范围') ?? '全标题') as DictScope;
        const note = interaction.options.getString('备注');

        if (kind !== '白名单' && !group) {
            await interaction.reply(ephemeral('❌ 除白名单外，都必须指定「分类组」。'));
            return;
        }

        const record = db.upsertDict(guildId, { rawWord: word, kind, group, replaceTo, scope, note });
        invalidateConfigCache();

        await interaction.reply(ephemeral(
            `✅ 已保存词条 **${record.rawWord}**\n`
            + `类型：${record.kind}　分类组：${record.group ?? '—'}　范围：${record.scope}\n`
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
            const line = `${d.rawWord}${d.group ? `→${d.group}` : ''}${d.replaceTo ? ` ⇒${d.replaceTo}` : ''}${d.enabled ? '' : '（停用）'}`;
            const list = byKind.get(d.kind);
            if (list) list.push(line);
            else byKind.set(d.kind, [line]);
        }
        const embed = new EmbedBuilder().setTitle(`📖 词典（共 ${dict.length} 条）`).setColor(0x5865f2);
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
                        scope: (cell(4) || '全标题') as DictScope,
                        replaceTo: cell(5) || null,
                        asciiBoundary: cell(6) ? cell(6) === '是' : undefined,
                        enabled: cell(7) ? cell(7) === '是' : true,
                        note: cell(8) || null,
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
    const forum = interaction.options.getChannel('论坛', true) as ForumChannel;

    if (sub === '自动生成') {
        const result = autoMapTags(interaction.guild!, forum);
        invalidateConfigCache();
        await interaction.reply(ephemeral(
            `✅ <#${forum.id}> 共 ${result.total} 个 TAG，按词典猜出 ${result.guessed} 个分类组。\n`
            + '已人工配置过的映射不会被覆盖。',
        ));
        return;
    }

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
            value: violations.map(v => `**${v.rule}** ${v.message}${v.needsLlm ? '（需 LLM 定性）' : ''}`)
                .join('\n').slice(0, 1024),
        });
    } else {
        embed.addFields({ name: '结论', value: '✅ 没有发现问题' });
    }

    if (inspection.judgement) {
        embed.addFields({
            name: 'LLM 判定',
            value: `是否分类标记：${inspection.judgement.isClassification ? '是' : '否'}　`
                + `把握：${inspection.judgement.confidence}\n理由：${inspection.judgement.reason}`.slice(0, 1024),
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

    const forum = interaction.options.getChannel('论坛', true) as ForumChannel;
    const dryRun = interaction.options.getBoolean('静默') ?? true;

    await interaction.editReply(`🔎 开始扫描 <#${forum.id}>${dryRun ? '（静默模式：只出报表，不发通知不改动）' : ''}…`);

    try {
        const { rows, progress } = await scanForum(interaction.client, interaction.guildId!, forum.id, {
            dryRun,
            onProgress: p => {
                void interaction.editReply(`🔎 扫描中… 已看 ${p.scanned} 个帖子，命中 ${p.flagged} 个`).catch(() => { /* 忽略 */ });
            },
        });

        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('检出结果');
        ws.columns = [
            { header: '论坛', key: 'forumName', width: 18 },
            { header: '标题', key: 'title', width: 50 },
            { header: 'TAG', key: 'tags', width: 24 },
            { header: '老帖', key: 'isOldPost', width: 8 },
            { header: '命中规则', key: 'rules', width: 14 },
            { header: '说明', key: 'detail', width: 50 },
            { header: '需LLM', key: 'needsLlm', width: 8 },
            { header: '建议新标题', key: 'suggestedTitle', width: 50 },
            { header: '建议摘除TAG', key: 'removeTags', width: 20 },
            { header: '可自动改', key: 'autoFixable', width: 10 },
            { header: '不能自动改的原因', key: 'blockedReason', width: 40 },
            { header: '作者ID', key: 'authorId', width: 22 },
            { header: '链接', key: 'threadUrl', width: 60 },
        ];
        for (const r of rows) {
            ws.addRow({
                ...r,
                isOldPost: r.isOldPost ? '是' : '否',
                needsLlm: r.needsLlm ? '是' : '否',
                autoFixable: r.autoFixable ? '是' : '否',
            } satisfies Record<keyof ScanRow, unknown> & Record<string, unknown>);
        }
        ws.getRow(1).font = { bold: true };

        const buffer = await wb.xlsx.writeBuffer();
        const needsLlmCount = rows.filter(r => r.needsLlm).length;

        await interaction.editReply({
            content: `✅ 扫描完成。\n`
                + `• 看了 **${progress.scanned}** 个帖子，跳过 ${progress.skipped} 个\n`
                + `• 命中 **${progress.flagged}** 个，其中 ${needsLlmCount} 个需要 LLM 定性\n`
                + `• 老帖 ${rows.filter(r => r.isOldPost).length} 个${dryRun ? '' : '（已进入慢速队列）'}\n`
                + (dryRun ? '\n静默模式没有发任何通知、没有改任何东西。' : ''),
            files: [new AttachmentBuilder(Buffer.from(buffer), { name: `扫描结果_${forum.name}.xlsx` })],
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
            + (c.llmReason ? `\n　LLM：${c.llmReason.slice(0, 80)}` : ''),
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
        await interaction.reply(ephemeral(sub === '暂停' ? '⏸️ 老帖队列已暂停。' : '▶️ 老帖队列已继续。'));
        return;
    }

    if (sub === '清空') {
        db.clearBackfill(guildId);
        await interaction.reply(ephemeral('✅ 老帖队列已清空。'));
        return;
    }

    const stats = db.backfillStats(guildId);
    const settings = db.getSettings(guildId);
    const pending = stats.pending ?? 0;
    const etaHours = pending * settings.queueIntervalMinutes / 60;

    await interaction.reply(ephemeral(
        `**老帖队列**\n`
        + `• 待处理：**${pending}**　已完成：${stats.done ?? 0}　跳过：${stats.skipped ?? 0}　失败：${stats.failed ?? 0}\n`
        + `• 速率：${settings.queueIntervalMinutes} 分钟 / 帖　状态：${settings.queuePaused ? '⏸️ 暂停' : '▶️ 运行中'}\n`
        + `• 按当前速率跑完还需约 **${etaHours.toFixed(1)} 小时**（${(etaHours / 24).toFixed(1)} 天）\n\n`
        + '_队列慢是故意的：老帖发通知会顶帖，慢速摊平才不会把论坛首页刷成老帖。_',
    ));
}

// ============================================================
// 入口
// ============================================================

const command: Command = {
    data,
    async execute(interaction: ChatInputCommandInteraction) {
        if (!await requireAdmin(interaction)) return;

        const group = interaction.options.getSubcommandGroup(false);
        const sub = interaction.options.getSubcommand();

        try {
            switch (group) {
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
