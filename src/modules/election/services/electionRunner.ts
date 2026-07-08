// src/modules/election/services/electionRunner.ts
//
// 募选流程编排：开启投票 / 建管理 thread / 结算 / 公示 / 二次确认。
// 被调度器（到点自动）与管理命令（手动）共同调用，因此每个入口都会重新读取
// 最新状态并做幂等保护，避免重复推进。

import {
    ChannelType,
    ThreadAutoArchiveDuration,
    EmbedBuilder,
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    type Client,
    type ButtonInteraction,
    type GuildMember,
    type Message,
} from 'discord.js';

import {
    getRound,
    updateRound,
    setRoundWinners,
    getSettings,
    listNominations,
    countNominations,
    tallyVotes,
    getVotersByCandidate,
    listAdminThreads,
    saveAdminThread,
    type ElectionRound,
} from './electionDatabase';
import { computeResults, type CandidateResult } from './electionTally';
import { buildVotePanel } from '../components/electionVote';
import { buildEntryMessage } from '../components/electionRound';
import { canManageElection } from './electionPermission';
import { resolveNames, nameTag } from './nameResolver';

const CONFIRM_BTN = 'elect_confirm_';
const REJECT_BTN = 'elect_reject_';
export const isConfirmButton = (id: string) => id.startsWith(CONFIRM_BTN);
export const isRejectButton = (id: string) => id.startsWith(REJECT_BTN);

export interface RunResult {
    ok: boolean;
    message: string;
}

const sec = (ms: number) => Math.floor(ms / 1000);

async function fetchGuild(client: Client, guildId: string) {
    return client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
}

// --------------------------- 计票 ---------------------------

/** 重新读取票数并计算某场的完整排名（投票已冻结，随时可复算）。 */
export function computeRoundResults(round: ElectionRound): CandidateResult[] {
    const candidateIds = listNominations(round.id).map(n => n.userId);
    const pub = tallyVotes(round.id, 'public');
    const adm = tallyVotes(round.id, 'admin');
    return computeResults(round, candidateIds, pub, adm);
}

// --------------------------- 小工具 ---------------------------

/** 自荐结束时：保持入口消息不变，只把自荐按钮变灰并改文字（失败静默）。 */
async function closeEntryPanel(client: Client, round: ElectionRound, buttonLabel: string): Promise<void> {
    if (!round.entryChannelId || !round.entryMessageId) return;
    try {
        const ch = await client.channels.fetch(round.entryChannelId);
        if (ch?.isTextBased()) {
            const msg = await ch.messages.fetch(round.entryMessageId);
            await msg.edit(buildEntryMessage(round, countNominations(round.id), buttonLabel));
        }
    } catch { /* 忽略 */ }
}

/** 编辑一条通知消息的文案（阶段结束时告知已结束），不 ping、失败静默。 */
async function editNotify(client: Client, channelId: string | null, messageId: string | null, content: string): Promise<void> {
    if (!channelId || !messageId) return;
    try {
        const ch = await client.channels.fetch(channelId);
        if (ch?.isTextBased()) {
            const msg = await ch.messages.fetch(messageId);
            await msg.edit({ content, allowedMentions: { parse: [] } });
        }
    } catch { /* 忽略 */ }
}

/** 撤下投票面板按钮（大众面板 + 各管理 thread 面板），防止结算后继续投。 */
async function disableVotePanels(client: Client, round: ElectionRound): Promise<void> {
    if (round.publicChannelId && round.publicMessageId) {
        try {
            const ch = await client.channels.fetch(round.publicChannelId);
            if (ch?.isTextBased()) {
                const msg = await ch.messages.fetch(round.publicMessageId);
                await msg.edit({ components: [] });
            }
        } catch { /* 忽略 */ }
    }
    for (const t of listAdminThreads(round.id)) {
        if (!t.messageId) continue;
        try {
            const ch = await client.channels.fetch(t.threadId);
            if (ch?.isTextBased()) {
                const msg = await ch.messages.fetch(t.messageId);
                await msg.edit({ components: [] });
            }
        } catch { /* 忽略 */ }
    }
}

// --------------------------- 开启投票 ---------------------------

/**
 * 到点/手动：结束自荐、锁定候选、建立投票器。
 * @param force 测试用：强制进入投票，忽略「无人自荐流选」「人数≤空位自动当选」这两个捷径。
 */
export async function openVoting(client: Client, round: ElectionRound, force = false): Promise<RunResult> {
    const fresh = getRound(round.id);
    if (!fresh) return { ok: false, message: '募选不存在。' };
    if (fresh.status !== 'nominating') return { ok: false, message: `当前状态为「${fresh.status}」，无法开启投票。` };

    const candidates = listNominations(fresh.id);

    // 无候选人：无法投票
    if (candidates.length === 0) {
        if (force) return { ok: false, message: '没有候选人，无法开启投票（先注入自荐）。' };
        // 流选：无人自荐
        updateRound(fresh.id, { status: 'closed' });
        setRoundWinners(fresh.id, []);
        await closeEntryPanel(client, fresh, '🔒 已结束（无人自荐）');
        await editNotify(client, fresh.entryChannelId, fresh.nominateNotifyMessageId, `📢 **${fresh.title}** 自荐已结束（无人报名）。`);
        await announce(client, fresh, `📢 募选 **#${fresh.id}｜${fresh.title}** 流选：自荐阶段无人报名。`);
        return { ok: true, message: '无人自荐，已流选关闭。' };
    }

    // 自荐即将结束：更新自荐开放通知消息
    await editNotify(client, fresh.entryChannelId, fresh.nominateNotifyMessageId, `📢 **${fresh.title}** 自荐已结束，进入投票阶段。`);

    // 解析候选人昵称，供面板/公告以「昵称 <@id>」展示
    const guild = await fetchGuild(client, fresh.guildId);
    const names = guild ? await resolveNames(guild, candidates.map(c => c.userId)) : new Map<string, string>();

    // 候选人不多于空位：无需投票，自动全部当选（不受二次确认约束，因无争议）。force 时跳过此捷径。
    if (!force && candidates.length <= fresh.vacancyCount) {
        const winners = candidates.map(c => c.userId);
        updateRound(fresh.id, { status: 'closed' });
        setRoundWinners(fresh.id, winners);
        await closeEntryPanel(client, fresh, '🔒 自荐已结束');
        await announce(client, fresh,
            `📢 募选 **#${fresh.id}｜${fresh.title}** 结果：自荐人数（${winners.length}）不多于空位（${fresh.vacancyCount}），以下候选人自动当选：\n` +
            winners.map(id => `🏆 ${nameTag(names, id)}`).join('\n'));
        return { ok: true, message: `候选人不多于空位，自动当选 ${winners.length} 人。` };
    }

    // 正常进入投票
    updateRound(fresh.id, { status: 'voting' });
    const settings = getSettings(fresh.guildId);
    const notes: string[] = [];

    // 大众投票面板
    if (fresh.enablePublic) {
        if (settings.publicVoteChannelId) {
            try {
                const ch = await client.channels.fetch(settings.publicVoteChannelId);
                if (ch?.isTextBased() && ch.isSendable()) {
                    const msg = await ch.send(buildVotePanel(fresh, 'public', candidates, names));
                    updateRound(fresh.id, { publicChannelId: ch.id, publicMessageId: msg.id });
                    // 投票开始通知：额外 @ 通知身份组，并记下消息 id 便于结束时改文案
                    if (settings.voteNotifyRoleIds.length) {
                        const mentions = settings.voteNotifyRoleIds.map(id => `<@&${id}>`).join(' ');
                        const notifyMsg = await ch.send({
                            content: `${mentions}\n🗳️ **${fresh.title}** 大众投票开始！\n👉 前往投票：${msg.url}\n投票截止 <t:${sec(fresh.voteDeadline)}:R>`,
                            allowedMentions: { roles: settings.voteNotifyRoleIds },
                        }).catch(() => null);
                        if (notifyMsg) updateRound(fresh.id, { voteNotifyMessageId: notifyMsg.id });
                    }
                } else notes.push('大众投票频道不可发送。');
            } catch { notes.push('大众投票面板发送失败。'); }
        } else notes.push('未配置大众投票频道，跳过大众投票面板。');
    }

    // 管理内投：每个管理频道建 thread + 面板
    if (fresh.enableAdmin) {
        if (settings.adminVoteChannelIds.length) {
            for (const chId of settings.adminVoteChannelIds) {
                try {
                    const ch = await client.channels.fetch(chId);
                    if (ch?.type !== ChannelType.GuildText) { notes.push(`频道 <#${chId}> 不支持子区，跳过。`); continue; }
                    const thread = await ch.threads.create({
                        name: `募选#${fresh.id}-管理投票`,
                        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
                    });
                    const msg = await thread.send(buildVotePanel(fresh, 'admin', candidates, names));
                    saveAdminThread(fresh.id, chId, thread.id, msg.id);
                } catch { notes.push(`频道 <#${chId}> 建子区失败。`); }
            }
        } else notes.push('未配置管理内投频道，跳过管理投票。');
    }

    await closeEntryPanel(client, fresh, '🔒 自荐已结束，投票已开启');

    return { ok: true, message: `已开启投票（候选 ${candidates.length} 人）。${notes.length ? '注意：' + notes.join(' ') : ''}` };
}

// --------------------------- 结算 / 公示 ---------------------------

/** 到点/手动：统计并出结果。requireConfirm 时进入待确认，否则直接公示。 */
export async function settleRound(client: Client, round: ElectionRound): Promise<RunResult> {
    const fresh = getRound(round.id);
    if (!fresh) return { ok: false, message: '募选不存在。' };
    if (fresh.status !== 'voting') return { ok: false, message: `当前状态为「${fresh.status}」，无法结算。` };

    // 投票结束：更新投票开始通知消息
    await editNotify(client, fresh.publicChannelId, fresh.voteNotifyMessageId, `🗳️ **${fresh.title}** 投票已结束，正在统计并公示结果。`);

    const results = computeRoundResults(fresh);
    const winners = results.filter(r => r.elected).map(r => r.userId);
    setRoundWinners(fresh.id, winners);

    if (fresh.requireConfirm) {
        updateRound(fresh.id, { status: 'pending_confirm' });
        await postConfirmPrompt(client, fresh, results);
        return { ok: true, message: '已生成结果，等待管理员确认后公示。' };
    }

    await publishResults(client, fresh, results);
    updateRound(fresh.id, { status: 'closed' });
    await disableVotePanels(client, fresh);
    return { ok: true, message: `已结算并公示（当选 ${winners.length} 人）。` };
}

/** 测试用：不改动状态，按现有票重新计算并公示一次（会新发一条结果消息 + 新的明细子区）。 */
export async function republish(client: Client, round: ElectionRound): Promise<RunResult> {
    const fresh = getRound(round.id);
    if (!fresh) return { ok: false, message: '募选不存在。' };
    const results = computeRoundResults(fresh);
    if (!results.length) return { ok: false, message: '本场没有候选人/投票可公示。' };
    await publishResults(client, fresh, results);
    return { ok: true, message: `已重新公示（候选 ${results.length} 人，状态未变）。` };
}

/** 公示一个待确认的场次（确认按钮 / 公示命令调用）。 */
export async function publishPending(client: Client, round: ElectionRound): Promise<RunResult> {
    const fresh = getRound(round.id);
    if (!fresh) return { ok: false, message: '募选不存在。' };
    if (fresh.status !== 'pending_confirm') return { ok: false, message: `当前状态为「${fresh.status}」，无待确认结果。` };

    const results = computeRoundResults(fresh);
    await publishResults(client, fresh, results);
    updateRound(fresh.id, { status: 'closed' });
    await disableVotePanels(client, fresh);
    return { ok: true, message: '已公示。' };
}

/** 作废一个待确认的场次（不公示）。 */
export async function rejectPending(client: Client, round: ElectionRound): Promise<RunResult> {
    const fresh = getRound(round.id);
    if (!fresh) return { ok: false, message: '募选不存在。' };
    if (fresh.status !== 'pending_confirm') return { ok: false, message: `当前状态为「${fresh.status}」，无待确认结果。` };

    updateRound(fresh.id, { status: 'cancelled' });
    setRoundWinners(fresh.id, []);
    await disableVotePanels(client, fresh);
    return { ok: true, message: '已作废，未公示。' };
}

function shareText(round: ElectionRound, r: CandidateResult): string {
    const parts: string[] = [];
    if (round.enablePublic) parts.push(`民 ${(r.publicShare * 100).toFixed(1)}%`);
    if (round.enableAdmin) parts.push(`管 ${(r.adminShare * 100).toFixed(1)}%`);
    return parts.length ? `（${parts.join(' / ')}）` : '';
}

function buildResultEmbed(round: ElectionRound, results: CandidateResult[], names: Map<string, string>, pending = false): EmbedBuilder {
    const winners = results.filter(r => r.elected);
    const rank = results.map(r =>
        `${r.elected ? '🏆' : '▫️'} #${r.rank} ${nameTag(names, r.userId)} — 综合 **${(r.finalScore * 100).toFixed(1)}%** ${shareText(round, r)}`,
    );
    const weights: string[] = [];
    if (round.enablePublic) weights.push(`大众×${round.weightPublic}`);
    if (round.enableAdmin) weights.push(`管理×${round.weightAdmin}`);

    return new EmbedBuilder()
        .setTitle(`${pending ? '🕵️ 待确认' : '📢'} 募选结果：${round.title}`)
        .setColor(pending ? 0xfaa61a : 0xeb459e)
        .setDescription(
            [
                `**空位数**：${round.vacancyCount}｜**加权**：${weights.join(' + ') || '—'}`,
                `**当选**：${winners.map(w => nameTag(names, w.userId)).join('、') || '（无）'}`,
                '',
                '**完整排名：**',
                ...rank,
            ].join('\n').slice(0, 4000),
        )
        .setFooter({ text: `募选 #${round.id}` });
}

/** 把结果发到公示频道。 */
async function publishResults(client: Client, round: ElectionRound, results: CandidateResult[]): Promise<void> {
    const settings = getSettings(round.guildId);
    const guild = await fetchGuild(client, round.guildId);
    const names = guild ? await resolveNames(guild, results.map(r => r.userId)) : new Map<string, string>();
    const embed = buildResultEmbed(round, results, names, false);
    if (settings.resultChannelId) {
        try {
            const ch = await client.channels.fetch(settings.resultChannelId);
            if (ch?.isTextBased() && ch.isSendable()) {
                const msg = await ch.send({ embeds: [embed] });
                updateRound(round.id, { resultChannelId: ch.id, resultMessageId: msg.id });
                // 在公示频道开子区，公布实名投票明细（失败不影响主公示）
                await publishVoteDetails(round, results, msg)
                    .catch(err => console.error(`[Election] 募选 #${round.id} 发布得票明细失败：`, err));
                return;
            }
        } catch { /* 落到下面的告警 */ }
    }
    console.warn(`[Election] 募选 #${round.id} 结算完成，但未配置可用的公示频道，结果未发出。`);
}

// 两票合计 ≤ 此值时全展示；超过则大众/管理分别只展示前 N。
const DETAIL_TOTAL_ALL = 50;
const DETAIL_PUBLIC_CAP = 40;
const DETAIL_ADMIN_CAP = 10;

/** 竖排列表（每行「昵称 <@id>」）；超过 limit 时截断并在末尾补一行 `......`。 */
function listSection(names: Map<string, string>, ids: string[], limit: number): string {
    if (!ids.length) return '（无）';
    const lines = ids.slice(0, limit).map(id => nameTag(names, id));
    if (ids.length > limit) lines.push('......');
    return lines.join('\n');
}

/** 为单个候选人生成完整得票的 markdown 表格文件内容。 */
function candidateMarkdown(round: ElectionRound, r: CandidateResult, names: Map<string, string>, pv: string[], av: string[]): string {
    const table = (ids: string[]) => {
        if (!ids.length) return '（无）\n';
        const rows = ids.map((id, i) => `| ${i + 1} | ${names.get(id) ?? '—'} | ${id} |`);
        return ['| # | 昵称 | 用户ID |', '| ---: | --- | --- |', ...rows].join('\n') + '\n';
    };
    const parts = [
        `# 募选 #${round.id}｜${round.title}`,
        `## #${r.rank} ${names.get(r.userId) ?? r.userId}（${r.userId}）${r.elected ? ' — 当选' : ''}`,
        `- 综合得票率：${(r.finalScore * 100).toFixed(2)}%`,
        `- 大众票：${pv.length}　管理票：${av.length}`,
        '',
    ];
    if (round.enablePublic) parts.push(`### 大众投票者（${pv.length} 人）`, table(pv));
    if (round.enableAdmin) parts.push(`### 管理投票者（${av.length} 人）`, table(av));
    return parts.join('\n');
}

/**
 * 结算后在公示频道从结果消息开一个子区，公布实名投票明细：
 * 每位候选人一条独立 embed，竖排列出大众投票者（前 25）与管理投票者（前 10）；
 * 谁超出上限，就给这条 embed 附一个只含该候选人完整名单的 md 表格文件。@ 只显示名字、不 ping。
 */
async function publishVoteDetails(round: ElectionRound, results: CandidateResult[], resultMsg: Message): Promise<void> {
    let thread;
    try {
        thread = await resultMsg.startThread({
            name: `募选#${round.id} 得票明细`,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        });
    } catch {
        return; // 没有建子区权限就跳过，不影响主公示
    }

    const pubVoters = getVotersByCandidate(round.id, 'public');
    const admVoters = getVotersByCandidate(round.id, 'admin');

    // 解析候选人 + 所有投票者的昵称
    const allIds = new Set<string>();
    for (const r of results) allIds.add(r.userId);
    for (const arr of [...pubVoters.values(), ...admVoters.values()]) for (const id of arr) allIds.add(id);
    const names = resultMsg.guild ? await resolveNames(resultMsg.guild, allIds) : new Map<string, string>();

    await thread.send({ content: `📊 **募选 #${round.id}｜${round.title} 得票明细**（实名公开）`, allowedMentions: { parse: [] } }).catch(() => {});

    for (const r of results) {
        const pv = pubVoters.get(r.userId) ?? [];
        const av = admVoters.get(r.userId) ?? [];

        // 合计 ≤50 全展示；超过则大众取前 40、管理取前 10
        const showAll = pv.length + av.length <= DETAIL_TOTAL_ALL;
        const pubLimit = showAll ? pv.length : DETAIL_PUBLIC_CAP;
        const admLimit = showAll ? av.length : DETAIL_ADMIN_CAP;
        const incomplete = pv.length > pubLimit || av.length > admLimit;

        const body = [`${nameTag(names, r.userId)}　·　综合 **${(r.finalScore * 100).toFixed(1)}%**　·　大众 ${pv.length} / 管理 ${av.length}`, ''];
        if (round.enablePublic) body.push(`**🟢 大众投票者（${pv.length}）**`, listSection(names, pv, pubLimit), '');
        if (round.enableAdmin) body.push(`**🟡 管理投票者（${av.length}）**`, listSection(names, av, admLimit));

        const embed = new EmbedBuilder()
            .setTitle(`#${r.rank} ${names.get(r.userId) ?? r.userId}${r.elected ? ' 🏆' : ''}`)
            .setColor(r.elected ? 0xeb459e : 0x99aab5)
            .setDescription(body.join('\n').slice(0, 4096));
        if (incomplete) embed.setFooter({ text: '投票人过多，此处仅展示部分，完整名单见附件' });

        const files = incomplete
            ? [new AttachmentBuilder(Buffer.from(candidateMarkdown(round, r, names, pv, av), 'utf8'), { name: `vote_${round.id}_rank${r.rank}.md` })]
            : [];

        await thread.send({ embeds: [embed], files, allowedMentions: { parse: [] } }).catch(() => {});
    }
}

/** 待确认时，把结果预览 + 确认/作废按钮发到管理区（首个管理频道，退化为私信发起人）。 */
async function postConfirmPrompt(client: Client, round: ElectionRound, results: CandidateResult[]): Promise<void> {
    const guild = await fetchGuild(client, round.guildId);
    const names = guild ? await resolveNames(guild, results.map(r => r.userId)) : new Map<string, string>();
    const embed = buildResultEmbed(round, results, names, true);
    embed.setDescription(`${embed.data.description ?? ''}\n\n_请管理员确认是否公示。_`);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${CONFIRM_BTN}${round.id}`).setLabel('✅ 确认公示').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${REJECT_BTN}${round.id}`).setLabel('❌ 作废').setStyle(ButtonStyle.Danger),
    );
    const settings = getSettings(round.guildId);
    const firstAdmin = settings.adminVoteChannelIds[0];
    if (firstAdmin) {
        try {
            const ch = await client.channels.fetch(firstAdmin);
            if (ch?.isTextBased() && ch.isSendable()) {
                await ch.send({ embeds: [embed], components: [row] });
                return;
            }
        } catch { /* 退化到私信 */ }
    }
    try {
        const user = await client.users.fetch(round.createdBy);
        await user.send({ content: `募选 #${round.id} 结果待你确认公示：`, embeds: [embed], components: [row] });
    } catch {
        console.warn(`[Election] 募选 #${round.id} 待确认，但无法送达确认入口。可用 /募选管理 公示 手动公示。`);
    }
}

/** 把纯文本公告发到公示频道（流选/自动当选用）。 */
async function announce(client: Client, round: ElectionRound, content: string): Promise<void> {
    const settings = getSettings(round.guildId);
    if (!settings.resultChannelId) return;
    try {
        const ch = await client.channels.fetch(settings.resultChannelId);
        if (ch?.isTextBased() && ch.isSendable()) await ch.send({ content });
    } catch { /* 忽略 */ }
}

// --------------------------- 确认/作废按钮 ---------------------------

export async function handleConfirmButton(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.guildId) return;
    const roundId = Number(interaction.customId.slice(CONFIRM_BTN.length));
    const round = getRound(roundId);
    if (!round || round.guildId !== interaction.guildId) {
        await interaction.reply({ content: '❌ 该募选不存在。', flags: MessageFlags.Ephemeral });
        return;
    }
    if (!canManageElection(interaction.guildId, interaction.member as GuildMember | null)) {
        await interaction.reply({ content: '❌ 只有募选管理员可以确认公示。', flags: MessageFlags.Ephemeral });
        return;
    }
    await interaction.deferUpdate();
    const res = await publishPending(interaction.client, round);
    await interaction.editReply({
        content: res.ok ? '✅ 已确认并公示结果。' : `⚠️ ${res.message}`,
        components: [],
    });
}

export async function handleRejectButton(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.guildId) return;
    const roundId = Number(interaction.customId.slice(REJECT_BTN.length));
    const round = getRound(roundId);
    if (!round || round.guildId !== interaction.guildId) {
        await interaction.reply({ content: '❌ 该募选不存在。', flags: MessageFlags.Ephemeral });
        return;
    }
    if (!canManageElection(interaction.guildId, interaction.member as GuildMember | null)) {
        await interaction.reply({ content: '❌ 只有募选管理员可以作废结果。', flags: MessageFlags.Ephemeral });
        return;
    }
    await interaction.deferUpdate();
    const res = await rejectPending(interaction.client, round);
    await interaction.editReply({
        content: res.ok ? '❌ 已作废本次结果，未公示。' : `⚠️ ${res.message}`,
        components: [],
    });
}
