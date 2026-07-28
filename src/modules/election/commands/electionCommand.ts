// src/modules/election/commands/electionCommand.ts
//
// 募选模块的管理斜杠命令 /募选管理。
// 子命令：配置 / 导入候选池 / 查看候选池 / 发起 / 取消 / 查看报名 / 列表 /
//         打回 / 恢复 / 开启公示 / 开启投票 / 补发投票面板 / 顺延投票截止 / 结算 / 公示 / 裁定平票。

import {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags,
    ChannelType,
    type GuildMember,
    type GuildTextBasedChannel,
} from 'discord.js';
import type { Command } from '../../../core/types';
import { canManageElection, isElectionTestMode } from '../services/electionPermission';
import { buildConfigHub } from '../components/electionConfig';
import { buildEntryMessage } from '../components/electionRound';
import {
    openPublicity, openVoting, resendVotePanels, settleRound, publishPending, resolveTie,
    disqualifyCandidate, restoreCandidate,
} from '../services/electionRunner';
import {
    getSettings,
    syncPool,
    listPool,
    createRound,
    getRound,
    listRounds,
    updateRound,
    listNominations,
    countNominations,
    type ParsedPoolEntry,
    type RoundStatus,
} from '../services/electionDatabase';
import { findPoolMessage, parsePoolMessage } from '../services/poolImport';
import { syncPoolViaApi } from '../services/poolSync';
import { resolveNames, nameTag } from '../services/nameResolver';

const STATUS_LABEL: Record<RoundStatus, string> = {
    nominating: '自荐中',
    publicity: '公示中',
    voting: '投票中',
    pending_confirm: '待确认公示',
    closed: '已结束',
    cancelled: '已取消',
};

const data = new SlashCommandBuilder()
    .setName('募选管理')
    .setDescription('募选模块管理指令')
    .addSubcommand(sub =>
        sub.setName('配置').setDescription('打开募选配置面板（频道/身份组/规则/旧bot）'))
    .addSubcommand(sub =>
        sub.setName('导入候选池')
            .setDescription('立即同步候选池（默认用 API，未配置则解析当前频道名单）')
            .addStringOption(o => o.setName('config_id').setDescription('临时覆盖默认 config_id（不填则用配置里的默认）').setRequired(false)))
    .addSubcommand(sub =>
        sub.setName('查看候选池').setDescription('查看当前在池的候选人名单'))
    .addSubcommand(sub =>
        sub.setName('发起')
            .setDescription('发起一场募选，在入口频道发出自荐面板')
            .addStringOption(o => o.setName('标题').setDescription('空位/职位名称').setRequired(true))
            .addIntegerOption(o => o.setName('空位数').setDescription('录取名额，同时是每票最多可选数').setRequired(true).setMinValue(1).setMaxValue(25))
            .addNumberOption(o => o.setName('自荐时长小时').setDescription('自荐阶段持续小时数').setRequired(true).setMinValue(0.1))
            .addNumberOption(o => o.setName('投票时长小时').setDescription('公示截止后投票持续小时数').setRequired(true).setMinValue(0.1))
            .addNumberOption(o => o.setName('公示时长天数').setDescription('自荐截止后的公示/审核期天数，默认 3').setRequired(false).setMinValue(0))
            .addBooleanOption(o => o.setName('启用大众投票').setDescription('默认取配置值'))
            .addBooleanOption(o => o.setName('启用管理投票').setDescription('默认取配置值')))
    .addSubcommand(sub =>
        sub.setName('取消')
            .setDescription('取消一场进行中的募选')
            .addIntegerOption(o => o.setName('场次id').setDescription('募选编号').setRequired(true)))
    .addSubcommand(sub =>
        sub.setName('查看报名')
            .setDescription('查看某场募选的自荐名单')
            .addIntegerOption(o => o.setName('场次id').setDescription('募选编号').setRequired(true)))
    .addSubcommand(sub =>
        sub.setName('列表').setDescription('列出进行中的募选'))
    .addSubcommand(sub =>
        sub.setName('打回')
            .setDescription('（投票开始前）打回某候选人，取消其本场参选资格并私信通知')
            .addIntegerOption(o => o.setName('场次id').setDescription('募选编号').setRequired(true))
            .addUserOption(o => o.setName('用户').setDescription('要打回的候选人').setRequired(true))
            .addStringOption(o => o.setName('理由').setDescription('打回理由（会私信告知本人，并展示在公示名单）').setRequired(false)))
    .addSubcommand(sub =>
        sub.setName('恢复')
            .setDescription('（投票开始前）恢复某被打回候选人的参选资格并私信通知')
            .addIntegerOption(o => o.setName('场次id').setDescription('募选编号').setRequired(true))
            .addUserOption(o => o.setName('用户').setDescription('要恢复的候选人').setRequired(true)))
    .addSubcommand(sub =>
        sub.setName('开启公示')
            .setDescription('（手动）立即结束自荐，进入公示期')
            .addIntegerOption(o => o.setName('场次id').setDescription('募选编号').setRequired(true)))
    .addSubcommand(sub =>
        sub.setName('开启投票')
            .setDescription('（手动）立即结束公示并开启投票')
            .addIntegerOption(o => o.setName('场次id').setDescription('募选编号').setRequired(true)))
    .addSubcommand(sub =>
        sub.setName('补发投票面板')
            .setDescription('（修复用）投票中但面板没发出来时，检查并补发投票面板')
            .addIntegerOption(o => o.setName('场次id').setDescription('募选编号').setRequired(true)))
    .addSubcommand(sub =>
        sub.setName('顺延投票截止')
            .setDescription('（修复用）延长投票截止时间，并刷新投票面板上的时间')
            .addIntegerOption(o => o.setName('场次id').setDescription('募选编号').setRequired(true))
            .addNumberOption(o => o.setName('小时').setDescription('顺延多少小时（已过期则从现在起算）').setRequired(true).setMinValue(0.1)))
    .addSubcommand(sub =>
        sub.setName('结算')
            .setDescription('（手动）立即结算投票并出结果')
            .addIntegerOption(o => o.setName('场次id').setDescription('募选编号').setRequired(true)))
    .addSubcommand(sub =>
        sub.setName('公示')
            .setDescription('（手动）公示一个待确认的结算结果')
            .addIntegerOption(o => o.setName('场次id').setDescription('募选编号').setRequired(true)))
    .addSubcommand(sub =>
        sub.setName('裁定平票')
            .setDescription('（平票时）从平票名单里人工指定当选者，指定后自动公示')
            .addIntegerOption(o => o.setName('场次id').setDescription('募选编号').setRequired(true))
            .addStringOption(o => o.setName('当选名单').setDescription('要当选的候选人：@ 他们或填用户ID，多人用空格分隔').setRequired(true)));

const command: Command = {
    data,
    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: '❌ 此命令只能在服务器中使用。', flags: MessageFlags.Ephemeral });
        }
        const guildId = interaction.guild.id;
        if (!canManageElection(guildId, interaction.member as GuildMember | null)) {
            return interaction.reply({
                content: '❌ 你没有募选管理权限（需服主/管理员，或配置的「募选管理身份组」）。',
                flags: MessageFlags.Ephemeral,
            });
        }

        const sub = interaction.options.getSubcommand();

        // ---- 配置 ----
        if (sub === '配置') {
            return interaction.reply(buildConfigHub(guildId));
        }

        // ---- 导入候选池 ----
        if (sub === '导入候选池') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const settings = getSettings(guildId);

            // 解析后统一补显示名并同步
            const finalize = (entries: ParsedPoolEntry[], sourceLine: string, warn?: string) => {
                const withNames: ParsedPoolEntry[] = entries.map(e => ({
                    ...e,
                    displayName: e.displayName ?? interaction.guild!.members.cache.get(e.userId)?.displayName ?? null,
                }));
                const r = syncPool(guildId, withNames);
                const lines = [
                    '✅ **候选池已同步**',
                    `• 在池人数：**${r.total}**`,
                    `• 新进池：**${r.added}**　离池：**${r.removed}**　保留：**${r.kept}**`,
                    sourceLine,
                ];
                if (warn) lines.push('', warn);
                return interaction.editReply(lines.join('\n'));
            };

            // 首选：候选池 API（配置了 Token 或 env 提供）
            const token = settings.apiToken || process.env.ELECTION_APPROVED_API_TOKEN || null;
            if (token) {
                const override = interaction.options.getString('config_id'); // 未填为 null
                const res = await syncPoolViaApi(guildId, override ?? undefined);
                if (res.ok && res.result) {
                    const r = res.result;
                    return interaction.editReply(
                        `✅ **候选池已同步**\n` +
                        `• 在池人数：**${r.total}**\n` +
                        `• 新进池：**${r.added}**　离池：**${r.removed}**　保留：**${r.kept}**\n` +
                        `• 来源：候选池 API${override ? `（config_id=${override}）` : ''}`,
                    );
                }
                return interaction.editReply(
                    `❌ ${res.message}\n可到 \`/募选管理 配置 → 候选池对接\` 核对 API 设置；或清除 Token 改用频道名单解析。`,
                );
            }

            // 回退：解析当前频道旧 bot 发出的 embed 名单
            const channel = interaction.channel;
            if (!channel || channel.type !== ChannelType.GuildText) {
                return interaction.editReply('⚠️ 尚未配置候选池 API Token。若走回退方案，请在旧 bot 发出名单的**文字频道**里运行本命令。');
            }
            const msg = await findPoolMessage(channel as GuildTextBasedChannel, settings.oldBotId);
            if (!msg) {
                return interaction.editReply(
                    settings.oldBotId
                        ? `⚠️ 最近 50 条消息里没找到旧 bot（<@${settings.oldBotId}>）发出的候选池名单。\n请先在本频道运行旧 bot 的通过名单命令，再导入；或改用候选池 API。`
                        : '⚠️ 未配置候选池 API，也未在最近消息里找到名单。\n建议到 `/募选管理 配置 → 候选池对接` 设置 API Token。',
                );
            }
            const { entries, truncated } = parsePoolMessage(msg);
            if (!entries.length) {
                return interaction.editReply('⚠️ 找到了疑似名单消息，但没解析出任何 `<@用户>`。请确认名单里的 @ 是真实可点击的提及。');
            }
            return finalize(entries, `• 来源：频道名单 ${msg.url}`,
                truncated ? '⚠️ 名单接近 Discord 长度上限，**可能被截断/分页**，请核对人数是否完整。' : undefined);
        }

        // ---- 查看候选池 ----
        if (sub === '查看候选池') {
            const pool = listPool(guildId);
            if (!pool.length) {
                return interaction.reply({
                    content: '候选池当前为空。请先用 `/募选管理 导入候选池` 从旧 bot 同步。',
                    flags: MessageFlags.Ephemeral,
                });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const poolNames = await resolveNames(interaction.guild, pool.map(m => m.userId));
            const header = `🗂️ **候选池（在池 ${pool.length} 人）**\n`;
            const rows = pool.map((m, i) => {
                const when = m.passedAt ? `<t:${Math.floor(m.passedAt / 1000)}:f>` : '—';
                return `${i + 1}. ${nameTag(poolNames, m.userId)}｜通过：${when}`;
            });
            let body = rows.join('\n');
            let note = '';
            if (header.length + body.length > 1900) {
                const kept: string[] = [];
                let len = header.length;
                for (const row of rows) {
                    if (len + row.length + 1 > 1800) break;
                    kept.push(row);
                    len += row.length + 1;
                }
                body = kept.join('\n');
                note = `\n\n…（其余 ${pool.length - kept.length} 人未显示）`;
            }
            return interaction.editReply(header + body + note);
        }

        // ---- 发起 ----
        if (sub === '发起') {
            const settings = getSettings(guildId);
            if (!settings.entryChannelId) {
                return interaction.reply({
                    content: '❌ 尚未设置**入口频道**。请先 `/募选管理 配置 → 频道` 设置后再发起。',
                    flags: MessageFlags.Ephemeral,
                });
            }
            const enablePublic = interaction.options.getBoolean('启用大众投票') ?? settings.enablePublic;
            const enableAdmin = interaction.options.getBoolean('启用管理投票') ?? settings.enableAdmin;
            if (!enablePublic && !enableAdmin) {
                return interaction.reply({
                    content: '❌ 大众投票与管理投票至少启用一种。',
                    flags: MessageFlags.Ephemeral,
                });
            }

            const title = interaction.options.getString('标题', true).trim();
            const vacancy = interaction.options.getInteger('空位数', true);
            const nominateHours = interaction.options.getNumber('自荐时长小时', true);
            const voteHours = interaction.options.getNumber('投票时长小时', true);
            const publicityDays = interaction.options.getNumber('公示时长天数') ?? 3;
            const now = Date.now();
            const nominateDeadline = now + Math.round(nominateHours * 3600_000);
            const publicityDeadline = nominateDeadline + Math.round(publicityDays * 86400_000);
            const voteDeadline = publicityDeadline + Math.round(voteHours * 3600_000);

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            // 关键节点：发起前用默认 config_id 刷新一次候选池，确保自荐资格基于最新名单。
            // API 没配或拉取失败都不阻塞发起，只在结果里附一句提示。
            // 测试模式下跳过，以免覆盖 /募选测试 手动注入的候选池。
            let poolNote = '';
            if (isElectionTestMode()) {
                poolNote = '\n🧪 测试模式：已跳过候选池自动拉取（请用 /募选测试 注入候选池 手动管理）。';
            } else {
                const poolRes = await syncPoolViaApi(guildId);
                if (poolRes.ok) poolNote = `\n📥 已刷新候选池：${poolRes.message}`;
                else poolNote = `\n⚠️ 候选池未刷新（${poolRes.message}），将沿用上次同步的名单。`;
            }

            // 校验入口频道可发送
            const entryChannel = await interaction.guild.channels.fetch(settings.entryChannelId).catch(() => null);
            if (!entryChannel || !entryChannel.isTextBased() || !entryChannel.isSendable()) {
                return interaction.editReply('❌ 入口频道无法发送消息（可能已删除或缺少权限）。请检查配置与机器人权限。');
            }

            const roundId = createRound({
                guildId,
                title,
                createdBy: interaction.user.id,
                nominateDeadline,
                publicityDeadline,
                voteDeadline,
                enablePublic,
                enableAdmin,
                weightPublic: settings.weightPublic,
                weightAdmin: settings.weightAdmin,
                vacancyCount: vacancy,
                tieBreak: settings.tieBreak,
                requireConfirm: settings.requireConfirm,
                entryChannelId: settings.entryChannelId,
            });
            const round = getRound(roundId)!;
            const sent = await entryChannel.send(buildEntryMessage(round, 0));
            updateRound(roundId, { entryMessageId: sent.id });

            // 自荐开放通知：额外 @ 通知身份组，并记下消息 id 便于结束时改文案
            if (settings.nominateNotifyRoleIds.length) {
                const mentions = settings.nominateNotifyRoleIds.map(id => `<@&${id}>`).join(' ');
                const notifyMsg = await entryChannel.send({
                    content: `${mentions}\n📢 管理组开放新空位 **${title}**（${vacancy} 个名额），现已开放自荐！\n👉 前往报名：${sent.url}\n自荐截止 <t:${Math.floor(nominateDeadline / 1000)}:R>`,
                    allowedMentions: { roles: settings.nominateNotifyRoleIds },
                }).catch(() => null);
                if (notifyMsg) updateRound(roundId, { nominateNotifyMessageId: notifyMsg.id });
            }

            return interaction.editReply(
                `✅ 已发起募选 **#${roundId}｜${title}**（空位 ${vacancy}），自荐面板已发到 ${entryChannel.toString()}。\n`
                + `⏳ 自荐截止 <t:${Math.floor(nominateDeadline / 1000)}:R> → 公示 ${publicityDays} 天（可打回候选人）→ 投票截止 <t:${Math.floor(voteDeadline / 1000)}:R>\n`
                + `${sent.url}${poolNote}`,
            );
        }

        // ---- 取消 ----
        if (sub === '取消') {
            const id = interaction.options.getInteger('场次id', true);
            const round = getRound(id);
            if (!round || round.guildId !== guildId) {
                return interaction.reply({ content: `❌ 未找到募选 #${id}。`, flags: MessageFlags.Ephemeral });
            }
            if (round.status === 'closed' || round.status === 'cancelled') {
                return interaction.reply({ content: `ℹ️ 募选 #${id} 已是「${STATUS_LABEL[round.status]}」，无需取消。`, flags: MessageFlags.Ephemeral });
            }
            updateRound(id, { status: 'cancelled' });

            // 尽力把入口面板改成“已取消”并撤下按钮
            if (round.entryChannelId && round.entryMessageId) {
                try {
                    const ch = await interaction.client.channels.fetch(round.entryChannelId);
                    if (ch?.isTextBased()) {
                        const msg = await ch.messages.fetch(round.entryMessageId);
                        await msg.edit({
                            embeds: [new EmbedBuilder().setTitle(`🗳️ 募选 #${id}：${round.title}`).setColor(0x99aab5).setDescription('❌ 本场募选已取消。')],
                            components: [],
                        });
                    }
                } catch { /* 忽略 */ }
            }
            return interaction.reply({ content: `✅ 已取消募选 #${id}。`, flags: MessageFlags.Ephemeral });
        }

        // ---- 查看报名 ----
        if (sub === '查看报名') {
            const id = interaction.options.getInteger('场次id', true);
            const round = getRound(id);
            if (!round || round.guildId !== guildId) {
                return interaction.reply({ content: `❌ 未找到募选 #${id}。`, flags: MessageFlags.Ephemeral });
            }
            const noms = listNominations(id);
            if (!noms.length) {
                return interaction.reply({ content: `募选 #${id}（${round.title}）暂无人自荐。`, flags: MessageFlags.Ephemeral });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const nomNames = await resolveNames(interaction.guild, noms.map(n => n.userId));
            const lines = noms.map((n, i) => {
                const preview = (n.statement ?? '').replace(/\s+/g, ' ').slice(0, 60);
                const tag = n.rejected ? '🚫【已打回】' : '';
                const reason = n.rejected && n.rejectReason ? `（理由：${n.rejectReason}）` : '';
                return `${i + 1}. ${tag}${nameTag(nomNames, n.userId)}${preview ? `｜${preview}${(n.statement ?? '').length > 60 ? '…' : ''}` : ''}${reason}`;
            });
            const activeCount = noms.filter(n => !n.rejected).length;
            const rejectedCount = noms.length - activeCount;
            const header = `📋 **募选 #${id}｜${round.title} 自荐名单（有效 ${activeCount} 人${rejectedCount ? `，已打回 ${rejectedCount} 人` : ''}）**\n`;
            return interaction.editReply(header + lines.join('\n').slice(0, 1800));
        }

        // ---- 列表 ----
        if (sub === '列表') {
            const rounds = listRounds(guildId, ['nominating', 'publicity', 'voting', 'pending_confirm']);
            if (!rounds.length) {
                return interaction.reply({ content: '当前没有进行中的募选。', flags: MessageFlags.Ephemeral });
            }
            const lines = rounds.map(r => {
                const stage = r.status === 'nominating'
                    ? `自荐截止 <t:${Math.floor(r.nominateDeadline / 1000)}:R>`
                    : r.status === 'publicity'
                        ? `公示截止 <t:${Math.floor(r.publicityDeadline / 1000)}:R>`
                        : `投票截止 <t:${Math.floor(r.voteDeadline / 1000)}:R>`;
                return `**#${r.id}** ${r.title}｜${STATUS_LABEL[r.status]}｜空位 ${r.vacancyCount}｜自荐 ${countNominations(r.id)} 人｜${stage}`;
            });
            return interaction.reply({ content: `🗳️ **进行中的募选**\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral });
        }

        // ---- 打回 / 恢复（投票开始前，针对单个候选人） ----
        if (sub === '打回' || sub === '恢复') {
            const id = interaction.options.getInteger('场次id', true);
            const round = getRound(id);
            if (!round || round.guildId !== guildId) {
                return interaction.reply({ content: `❌ 未找到募选 #${id}。`, flags: MessageFlags.Ephemeral });
            }
            const target = interaction.options.getUser('用户', true);
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const res = sub === '打回'
                ? await disqualifyCandidate(interaction.client, round, target.id, interaction.user.id, interaction.options.getString('理由'))
                : await restoreCandidate(interaction.client, round, target.id);
            return interaction.editReply(res.ok ? `✅ ${target.toString()}：${res.message}` : `⚠️ ${res.message}`);
        }

        // ---- 裁定平票（规则分不出胜负时的人工决定） ----
        if (sub === '裁定平票') {
            const id = interaction.options.getInteger('场次id', true);
            const round = getRound(id);
            if (!round || round.guildId !== guildId) {
                return interaction.reply({ content: `❌ 未找到募选 #${id}。`, flags: MessageFlags.Ephemeral });
            }
            // 从 @提及 或裸 ID 里抓用户 id，允许空格/逗号/顿号随便分隔
            const ids = [...new Set(interaction.options.getString('当选名单', true).match(/\d{15,25}/g) ?? [])];
            if (!ids.length) {
                return interaction.reply({
                    content: '❌ 没解析出候选人。请 @ 他们，或直接填用户 ID（多人用空格分隔）。',
                    flags: MessageFlags.Ephemeral,
                });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const res = await resolveTie(interaction.client, round, ids);
            return interaction.editReply(res.ok ? `✅ 场次 #${id}：${res.message}` : `⚠️ 场次 #${id}：${res.message}`);
        }

        // ---- 顺延投票截止（面板发晚了/投票被耽误时补时间） ----
        if (sub === '顺延投票截止') {
            const id = interaction.options.getInteger('场次id', true);
            const round = getRound(id);
            if (!round || round.guildId !== guildId) {
                return interaction.reply({ content: `❌ 未找到募选 #${id}。`, flags: MessageFlags.Ephemeral });
            }
            if (round.status !== 'voting' && round.status !== 'publicity') {
                return interaction.reply({
                    content: `⚠️ 募选 #${id} 当前是「${STATUS_LABEL[round.status]}」，只有公示中/投票中的场次能顺延投票截止。`,
                    flags: MessageFlags.Ephemeral,
                });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const hours = interaction.options.getNumber('小时', true);
            // 已过期的场次从现在起算，避免顺延后仍是过去时间
            const base = Math.max(Date.now(), round.voteDeadline);
            const voteDeadline = base + Math.round(hours * 3600_000);
            updateRound(id, { voteDeadline });

            // 投票中的场次顺手刷新面板（同时会补发缺失的面板）
            let extra = '';
            if (round.status === 'voting') {
                const res = await resendVotePanels(interaction.client, getRound(id)!);
                extra = `\n${res.ok ? '🔄' : '⚠️'} ${res.message}`;
            }
            return interaction.editReply(
                `✅ 募选 #${id} 投票截止已顺延至 <t:${Math.floor(voteDeadline / 1000)}:f>（<t:${Math.floor(voteDeadline / 1000)}:R>）。${extra}`,
            );
        }

        // ---- 开启公示 / 开启投票 / 补发投票面板 / 结算 / 公示（手动触发 runner） ----
        if (sub === '开启公示' || sub === '开启投票' || sub === '补发投票面板' || sub === '结算' || sub === '公示') {
            const id = interaction.options.getInteger('场次id', true);
            const round = getRound(id);
            if (!round || round.guildId !== guildId) {
                return interaction.reply({ content: `❌ 未找到募选 #${id}。`, flags: MessageFlags.Ephemeral });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const runner = sub === '开启公示' ? openPublicity
                : sub === '开启投票' ? openVoting
                    : sub === '补发投票面板' ? resendVotePanels
                        : sub === '结算' ? settleRound
                            : publishPending;
            const res = await runner(interaction.client, round);
            return interaction.editReply(res.ok ? `✅ 场次 #${id}：${res.message}` : `⚠️ 场次 #${id}：${res.message}`);
        }
    },
};

export default command;
