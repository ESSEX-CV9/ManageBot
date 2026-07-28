// src/modules/election/services/electionRunner.ts
//
// 募选流程编排：开启投票 / 建管理 thread / 结算 / 公示 / 二次确认。
// 被调度器（到点自动）与管理命令（手动）共同调用，因此每个入口都会重新读取
// 最新状态并做幂等保护，避免重复推进。

import {
    ChannelType,
    PermissionFlagsBits,
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
    type GuildTextBasedChannel,
    type Message,
} from 'discord.js';

import {
    getRound,
    updateRound,
    setRoundWinners,
    getSettings,
    listNominations,
    listActiveNominations,
    countNominations,
    countActiveNominations,
    getNomination,
    rejectNomination,
    restoreNomination,
    tallyVotes,
    getVotersByCandidate,
    listAdminThreads,
    saveAdminThread,
    type ElectionRound,
    type RoundStatus,
    type Nomination,
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

/** 重新读取票数并计算某场的完整排名（投票已冻结，随时可复算）。仅计入未被打回的候选人。 */
export function computeRoundResults(round: ElectionRound): CandidateResult[] {
    const candidateIds = listActiveNominations(round.id).map(n => n.userId);
    const pub = tallyVotes(round.id, 'public');
    const adm = tallyVotes(round.id, 'admin');
    return computeResults(round, candidateIds, pub, adm);
}

// --------------------------- 小工具 ---------------------------

/** 自荐结束时：保持入口消息不变，只把自荐按钮变灰并改文字；不传文字则还原成可用的自荐按钮（失败静默）。 */
async function closeEntryPanel(client: Client, round: ElectionRound, buttonLabel?: string): Promise<void> {
    if (!round.entryChannelId || !round.entryMessageId) return;
    try {
        const ch = await client.channels.fetch(round.entryChannelId);
        if (ch?.isTextBased()) {
            const msg = await ch.messages.fetch(round.entryMessageId);
            await msg.edit(buildEntryMessage(round, countActiveNominations(round.id), buttonLabel));
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

// --------------------------- 开启公示 ---------------------------

/**
 * 到点/手动：结束自荐、锁定候选名单，进入公示期。
 * 公示期内管理员可用 `/募选管理 打回` 剔除不合适的候选人；到点自动开投票。
 * 无人自荐则直接流选（公示无意义，跳过）。
 */
export async function openPublicity(client: Client, round: ElectionRound): Promise<RunResult> {
    const fresh = getRound(round.id);
    if (!fresh) return { ok: false, message: '募选不存在。' };
    if (fresh.status !== 'nominating') return { ok: false, message: `当前状态为「${fresh.status}」，无法进入公示期。` };

    const candidates = listActiveNominations(fresh.id);

    // 无有效候选人：直接流选（没有可公示/可投的对象）。区分「无人报名」与「报名者均被打回」。
    if (candidates.length === 0) {
        const allRejected = countNominations(fresh.id) > 0;
        const why = allRejected ? '报名者均被打回' : '无人报名';
        updateRound(fresh.id, { status: 'closed' });
        setRoundWinners(fresh.id, []);
        await closeEntryPanel(client, fresh, `🔒 已结束（${why}）`);
        await editNotify(client, fresh.entryChannelId, fresh.nominateNotifyMessageId, `📢 **${fresh.title}** 自荐已结束（${why}）。`);
        await announce(client, fresh, `📢 募选 **#${fresh.id}｜${fresh.title}** 流选：自荐阶段${why}。`);
        return { ok: true, message: `${why}，已流选关闭。` };
    }

    updateRound(fresh.id, { status: 'publicity' });
    await closeEntryPanel(client, fresh, '🔒 自荐已结束，公示中');
    await editNotify(client, fresh.entryChannelId, fresh.nominateNotifyMessageId,
        `📢 **${fresh.title}** 自荐已结束，进入公示期，投票 <t:${sec(fresh.publicityDeadline)}:R> 开始。`);

    // 公示名单发到结果公示频道（无频道则静默跳过）
    await postPublicity(client, getRound(fresh.id)!);

    return { ok: true, message: `已进入公示期（候选 ${candidates.length} 人），投票将于公示截止后开启。` };
}

// --------------------------- 投票面板：发送 / 补发 ---------------------------

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** [权限位, 中文名]，用于把「发送失败」翻译成管理员能直接去改的权限项。 */
type PermNeed = readonly [bigint, string];

const PERM_SEND: PermNeed[] = [
    [PermissionFlagsBits.ViewChannel, '查看频道'],
    [PermissionFlagsBits.SendMessages, '发送消息'],
    [PermissionFlagsBits.EmbedLinks, '嵌入链接'],
];
const PERM_THREAD: PermNeed[] = [
    [PermissionFlagsBits.CreatePublicThreads, '创建公开子区'],
    [PermissionFlagsBits.SendMessagesInThreads, '在子区发言'],
];

/** 列出机器人在该频道缺少的权限中文名（拿不到成员/权限时返回空，交给真正的发送去报错）。 */
function missingPerms(ch: GuildTextBasedChannel, me: GuildMember | null, needs: PermNeed[]): string[] {
    if (!me) return [];
    const perms = ch.permissionsFor(me);
    if (!perms) return [];
    return needs.filter(([bit]) => !perms.has(bit)).map(([, label]) => label);
}

/** 取回一条已记录的面板消息；频道/消息被删或没权限读则返回 null（视作面板不在位）。 */
async function fetchPanelMessage(client: Client, channelId: string | null, messageId: string | null): Promise<Message | null> {
    if (!channelId || !messageId) return null;
    try {
        const ch = await client.channels.fetch(channelId);
        if (!ch?.isTextBased()) return null;
        return await ch.messages.fetch(messageId);
    } catch {
        return null;
    }
}

export interface PanelReport {
    /** 失败/降级说明，逐条给管理员看。 */
    notes: string[];
    /** 大众面板当前是否在位（本次新发或此前已存在）。 */
    publicOk: boolean;
    /** 面板在位的管理频道数 / 已配置的管理频道数。 */
    adminOk: number;
    adminTotal: number;
}

/**
 * 发送投票面板（大众频道 + 各管理频道）。
 * 幂等：已存在的面板只刷新内容不重发，因此开投票失败后可以反复重跑来补发。
 * 单个频道失败不影响其它频道；失败原因（含缺失的权限）写进 notes 并打日志。
 * 管理频道没有建子区权限时，降级为直接在频道内发面板，而不是整个管理投票丢失。
 */
async function sendVotePanels(
    client: Client, round: ElectionRound, candidates: Nomination[], names: Map<string, string>,
): Promise<PanelReport> {
    const settings = getSettings(round.guildId);
    const notes: string[] = [];
    let publicOk = false;
    let adminOk = 0;

    const guild = await fetchGuild(client, round.guildId);
    const me = guild ? (guild.members.me ?? await guild.members.fetchMe().catch(() => null)) : null;

    // ---- 大众投票面板 ----
    if (round.enablePublic) {
        const chId = settings.publicVoteChannelId;
        if (!chId) {
            notes.push('未配置大众投票频道，跳过大众投票面板。');
        } else {
            const existing = await fetchPanelMessage(client, round.publicChannelId, round.publicMessageId);
            if (existing) {
                await existing.edit(buildVotePanel(round, 'public', candidates, names)).catch(() => {});
                publicOk = true;
            } else {
                try {
                    const ch = await client.channels.fetch(chId);
                    if (!ch?.isTextBased() || ch.isDMBased()) throw new Error('频道不存在或不是服务器文字频道');
                    const lack = missingPerms(ch, me, PERM_SEND);
                    if (lack.length) throw new Error(`机器人缺少权限：${lack.join('、')}`);
                    if (!ch.isSendable()) throw new Error('机器人在该频道无法发送消息');

                    const msg = await ch.send(buildVotePanel(round, 'public', candidates, names));
                    updateRound(round.id, { publicChannelId: ch.id, publicMessageId: msg.id });
                    publicOk = true;

                    // 投票开始通知：额外 @ 通知身份组，并记下消息 id 便于结束时改文案
                    if (settings.voteNotifyRoleIds.length) {
                        const mentions = settings.voteNotifyRoleIds.map(id => `<@&${id}>`).join(' ');
                        const notifyMsg = await ch.send({
                            content: `${mentions}\n🗳️ **${round.title}** 大众投票开始！\n👉 前往投票：${msg.url}\n投票截止 <t:${sec(round.voteDeadline)}:R>`,
                            allowedMentions: { roles: settings.voteNotifyRoleIds },
                        }).catch(() => null);
                        if (notifyMsg) updateRound(round.id, { voteNotifyMessageId: notifyMsg.id });
                    }
                } catch (e) {
                    notes.push(`大众投票面板发送失败（<#${chId}>：${errText(e)}）。`);
                    console.error(`[Election] 募选 #${round.id} 大众投票面板发送失败（频道 ${chId}）：`, e);
                }
            }
        }
    }

    // ---- 管理内投面板：每个管理频道一个子区（不行则直接发频道） ----
    const adminChannels = round.enableAdmin ? settings.adminVoteChannelIds : [];
    if (round.enableAdmin && !adminChannels.length) notes.push('未配置管理内投频道，跳过管理投票。');

    const recorded = new Map(listAdminThreads(round.id).map(t => [t.channelId, t]));
    for (const chId of adminChannels) {
        const rec = recorded.get(chId);
        const existing = rec ? await fetchPanelMessage(client, rec.threadId, rec.messageId) : null;
        if (existing) {
            await existing.edit(buildVotePanel(round, 'admin', candidates, names)).catch(() => {});
            adminOk++;
            continue;
        }
        try {
            const ch = await client.channels.fetch(chId);
            if (!ch?.isTextBased() || ch.isDMBased()) throw new Error('频道不存在或不是服务器文字频道');

            // 优先开子区；没权限或建失败就退回频道内直接发面板（投票功能不受影响）
            let target: GuildTextBasedChannel = ch;
            let threadId = ch.id;
            if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) {
                const lackThread = missingPerms(ch, me, PERM_THREAD);
                if (lackThread.length) {
                    notes.push(`<#${chId}> 缺少${lackThread.join('、')}权限，管理投票面板已改为直接发在频道里。`);
                } else {
                    try {
                        const thread = await ch.threads.create({
                            name: `募选#${round.id}-管理投票`,
                            autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
                        });
                        target = thread;
                        threadId = thread.id;
                    } catch (e) {
                        notes.push(`<#${chId}> 建子区失败（${errText(e)}），管理投票面板已改为直接发在频道里。`);
                        console.error(`[Election] 募选 #${round.id} 建管理投票子区失败（频道 ${chId}）：`, e);
                    }
                }
            }

            if (target.id === ch.id) {
                const lack = missingPerms(ch, me, PERM_SEND);
                if (lack.length) throw new Error(`机器人缺少权限：${lack.join('、')}`);
            }
            const msg = await target.send(buildVotePanel(round, 'admin', candidates, names));
            saveAdminThread(round.id, chId, threadId, msg.id);
            adminOk++;
        } catch (e) {
            notes.push(`<#${chId}> 管理投票面板发送失败（${errText(e)}）。`);
            console.error(`[Election] 募选 #${round.id} 管理投票面板发送失败（频道 ${chId}）：`, e);
        }
    }

    return { notes, publicOk, adminOk, adminTotal: adminChannels.length };
}

/** 把面板发送结果拼成给管理员看的一句话。 */
function panelSummary(round: ElectionRound, rep: PanelReport): string {
    const parts: string[] = [];
    if (round.enablePublic) parts.push(`大众面板${rep.publicOk ? '已就绪' : '未发出'}`);
    if (round.enableAdmin) parts.push(`管理面板 ${rep.adminOk}/${rep.adminTotal} 个频道就绪`);
    return parts.join('，');
}

/**
 * 补发/刷新一场投票中募选的面板。
 * 用于「开投票时因权限等原因面板没发出去，但状态已经变成投票中」的修复：
 * 已在位的面板只刷新，缺的补发，因此可以安全重复执行。
 */
export async function resendVotePanels(client: Client, round: ElectionRound): Promise<RunResult> {
    const fresh = getRound(round.id);
    if (!fresh) return { ok: false, message: '募选不存在。' };
    if (fresh.status !== 'voting') {
        return { ok: false, message: `当前状态为「${fresh.status}」，只有投票中的场次才需要补发投票面板。` };
    }
    const candidates = listActiveNominations(fresh.id);
    if (!candidates.length) return { ok: false, message: '本场没有有效候选人（可能已全部被打回），无法发出投票面板。' };

    const guild = await fetchGuild(client, fresh.guildId);
    const names = guild ? await resolveNames(guild, candidates.map(c => c.userId)) : new Map<string, string>();
    const rep = await sendVotePanels(client, fresh, candidates, names);
    await closeEntryPanel(client, fresh, '🔒 自荐已结束，投票已开启');

    const overdue = Date.now() > fresh.voteDeadline
        ? ' ⚠️ 本场投票截止时间已过，面板发出也无法投票，请先用 `/募选管理 顺延投票截止` 延长。'
        : '';
    const ok = (!fresh.enablePublic || rep.publicOk) && (!fresh.enableAdmin || rep.adminOk > 0);
    return {
        ok,
        message: `投票面板已检查补发（候选 ${candidates.length} 人）：${panelSummary(fresh, rep)}。`
            + (rep.notes.length ? ` 注意：${rep.notes.join(' ')}` : '') + overdue,
    };
}

// --------------------------- 开启投票 ---------------------------

/**
 * 到点/手动：结束公示、锁定候选、建立投票器。
 * @param force 测试用：强制开投票（可从自荐/公示态直接进），忽略「无候选流选」「人数≤空位自动当选」两个捷径。
 */
export async function openVoting(client: Client, round: ElectionRound, force = false): Promise<RunResult> {
    const fresh = getRound(round.id);
    if (!fresh) return { ok: false, message: '募选不存在。' };
    // 已经是投票中：多半是上次开投票时面板没发成功。别再拦着，直接走补发逻辑修复。
    if (fresh.status === 'voting') return resendVotePanels(client, fresh);
    // 正常从公示期进投票；force（测试）允许从自荐期直接强开、跳过公示。
    const allowed: RoundStatus[] = force ? ['nominating', 'publicity'] : ['publicity'];
    if (!allowed.includes(fresh.status)) return { ok: false, message: `当前状态为「${fresh.status}」，无法开启投票。` };

    const candidates = listActiveNominations(fresh.id);

    // 无候选人：无法投票（公示期把人全打回了，或强开时没有候选）
    if (candidates.length === 0) {
        if (force) return { ok: false, message: '没有候选人，无法开启投票（先注入自荐）。' };
        // 流选：无有效候选
        updateRound(fresh.id, { status: 'closed' });
        setRoundWinners(fresh.id, []);
        await closeEntryPanel(client, fresh, '🔒 已结束（无有效候选）');
        await editNotify(client, fresh.entryChannelId, fresh.nominateNotifyMessageId, `📢 **${fresh.title}** 已结束（无有效候选人）。`);
        await announce(client, fresh, `📢 募选 **#${fresh.id}｜${fresh.title}** 流选：无有效候选人（可能均已被打回）。`);
        return { ok: true, message: '无有效候选人，已流选关闭。' };
    }

    // 公示即将结束：更新自荐/公示通知消息
    await editNotify(client, fresh.entryChannelId, fresh.nominateNotifyMessageId, `📢 **${fresh.title}** 公示已结束，进入投票阶段。`);

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
    const prevStatus = fresh.status;
    updateRound(fresh.id, { status: 'voting' });
    const rep = await sendVotePanels(client, fresh, candidates, names);
    await closeEntryPanel(client, fresh, '🔒 自荐已结束，投票已开启');

    // 一个面板都没发出去：状态回退到开投票前，避免「状态已投票但没人能投」的死局。
    const anyPanel = (fresh.enablePublic && rep.publicOk) || (fresh.enableAdmin && rep.adminOk > 0);
    if (!anyPanel) {
        updateRound(fresh.id, { status: prevStatus });
        const backToNominating = prevStatus === 'nominating';
        await closeEntryPanel(client, fresh, backToNominating ? undefined : '🔒 自荐已结束，公示中');
        await editNotify(client, fresh.entryChannelId, fresh.nominateNotifyMessageId,
            backToNominating
                ? `📢 **${fresh.title}** 自荐进行中，截止 <t:${sec(fresh.nominateDeadline)}:R>。`
                : `📢 **${fresh.title}** 自荐已结束，投票即将开始。`);
        console.error(`[Election] 募选 #${fresh.id} 开投票失败：没有任何面板发送成功，已回退到公示期。`, rep.notes);
        return {
            ok: false,
            message: `开启投票失败：一个投票面板都没能发出，已回退到公示期，修好后可重新执行。原因：${rep.notes.join(' ') || '未知'}`,
        };
    }

    return {
        ok: true,
        message: `已开启投票（候选 ${candidates.length} 人）：${panelSummary(fresh, rep)}。`
            + (rep.notes.length ? ` 注意：${rep.notes.join(' ')}` : ''),
    };
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

// --------------------------- 公示期：名单展示 + 打回/恢复 ---------------------------

/** 构建公示名单消息（发到结果公示频道；打回/恢复后据此刷新）。candidates 含被打回者。 */
function buildPublicityMessage(round: ElectionRound, candidates: Nomination[], names: Map<string, string>) {
    const active = candidates.filter(c => !c.rejected);
    const rejected = candidates.filter(c => c.rejected);
    const lines = active.map((c, i) => {
        const preview = (c.statement ?? '').replace(/\s+/g, ' ').trim();
        const shown = preview ? `\n> ${preview.slice(0, 120)}${preview.length > 120 ? '…' : ''}` : '';
        return `**${i + 1}.** ${nameTag(names, c.userId)}${shown}`;
    });
    const rejectedLines = rejected.map(c =>
        `~~${nameTag(names, c.userId)}~~ — ${c.rejectReason ? `因「${c.rejectReason}」被管理组打回` : '已被管理组打回'}`);

    const embed = new EmbedBuilder()
        .setTitle(`📋 候选人公示：${round.title}`)
        .setColor(0x5865f2)
        .setDescription(
            [
                `**空位数**：${round.vacancyCount}｜**有效候选**：${active.length} 人`,
                `**投票开始**：<t:${sec(round.publicityDeadline)}:f>（<t:${sec(round.publicityDeadline)}:R>）`,
                '',
                '以下为本场候选人名单，正在公示。管理员如认为某人不宜参选，可用 `/募选管理 打回` 处理。',
                '',
                '**候选人：**',
                ...(lines.length ? lines : ['（暂无有效候选人）']),
                ...(rejectedLines.length ? ['', '**已打回（不参与投票）：**', ...rejectedLines] : []),
            ].join('\n').slice(0, 4000),
        )
        .setFooter({ text: `募选 #${round.id}` });
    return { embeds: [embed] };
}

/** 把公示名单发到结果公示频道，并记下频道/消息 id（无公示频道则静默跳过）。 */
async function postPublicity(client: Client, round: ElectionRound): Promise<void> {
    const settings = getSettings(round.guildId);
    if (!settings.resultChannelId) {
        console.warn(`[Election] 募选 #${round.id} 进入公示期，但未配置结果公示频道，名单未发出。`);
        return;
    }
    const guild = await fetchGuild(client, round.guildId);
    const candidates = listNominations(round.id);
    const names = guild ? await resolveNames(guild, candidates.map(c => c.userId)) : new Map<string, string>();
    try {
        const ch = await client.channels.fetch(settings.resultChannelId);
        if (ch?.isTextBased() && ch.isSendable()) {
            const msg = await ch.send(buildPublicityMessage(round, candidates, names));
            updateRound(round.id, { publicityChannelId: ch.id, publicityMessageId: msg.id });
        }
    } catch { /* 忽略，公示名单发送失败不阻塞流程 */ }
}

/** 打回/恢复后刷新公示名单消息（失败静默）。 */
async function refreshPublicityMessage(client: Client, round: ElectionRound): Promise<void> {
    const fresh = getRound(round.id);
    if (!fresh?.publicityChannelId || !fresh.publicityMessageId) return;
    const guild = await fetchGuild(client, fresh.guildId);
    const candidates = listNominations(fresh.id);
    const names = guild ? await resolveNames(guild, candidates.map(c => c.userId)) : new Map<string, string>();
    try {
        const ch = await client.channels.fetch(fresh.publicityChannelId);
        if (ch?.isTextBased()) {
            const msg = await ch.messages.fetch(fresh.publicityMessageId);
            await msg.edit(buildPublicityMessage(fresh, candidates, names));
        }
    } catch { /* 忽略 */ }
}

/** 给某用户发私信通知（不 ping、失败返回 false）。 */
async function dmUser(client: Client, userId: string, content: string): Promise<boolean> {
    try {
        const user = await client.users.fetch(userId);
        await user.send({ content, allowedMentions: { parse: [] } });
        return true;
    } catch {
        return false;
    }
}

// 打回/恢复允许的阶段：投票开始前（自荐期 + 公示期）都可以操作。
const REJECTABLE_STATUS: RoundStatus[] = ['nominating', 'publicity'];

/**
 * 打回一名候选人（投票开始前均可）：作废其本场参选资格 → 刷新公示名单（若已公示）→ 私信通知本人。
 */
export async function disqualifyCandidate(
    client: Client, round: ElectionRound, userId: string, byUserId: string, reason: string | null,
): Promise<RunResult> {
    const fresh = getRound(round.id);
    if (!fresh) return { ok: false, message: '募选不存在。' };
    if (!REJECTABLE_STATUS.includes(fresh.status)) {
        return { ok: false, message: `投票开始后无法打回候选人（当前状态「${fresh.status}」）。` };
    }
    const nom = getNomination(fresh.id, userId);
    if (!nom) return { ok: false, message: '该用户不是本场候选人。' };
    if (nom.rejected) return { ok: false, message: '该候选人已被打回，无需重复操作。' };

    rejectNomination(fresh.id, userId, byUserId, reason);
    await refreshPublicityMessage(client, fresh);
    const dmOk = await dmUser(client, userId,
        `📢 关于募选 **#${fresh.id}｜${fresh.title}**：\n很遗憾，管理组审核后决定**暂不通过你本场的参选**。`
        + (reason ? `\n理由：${reason}` : '')
        + `\n如有疑问可联系管理组；管理员也可在投票开始前恢复你的参选资格。`);

    const left = countActiveNominations(fresh.id);
    return {
        ok: true,
        message: `已打回该候选人，本场剩余有效候选 ${left} 人。`
            + (dmOk ? '已私信通知本人。' : '（私信未送达，可能对方关闭了私信。）'),
    };
}

/**
 * 恢复一名被打回的候选人（投票开始前均可）：恢复参选资格 → 刷新公示名单（若已公示）→ 私信通知本人。
 */
export async function restoreCandidate(client: Client, round: ElectionRound, userId: string): Promise<RunResult> {
    const fresh = getRound(round.id);
    if (!fresh) return { ok: false, message: '募选不存在。' };
    if (!REJECTABLE_STATUS.includes(fresh.status)) {
        return { ok: false, message: `投票开始后无法恢复候选人（当前状态「${fresh.status}」）。` };
    }
    const nom = getNomination(fresh.id, userId);
    if (!nom) return { ok: false, message: '该用户不是本场候选人。' };
    if (!nom.rejected) return { ok: false, message: '该候选人未被打回，无需恢复。' };

    restoreNomination(fresh.id, userId);
    await refreshPublicityMessage(client, fresh);
    const dmOk = await dmUser(client, userId,
        `📢 关于募选 **#${fresh.id}｜${fresh.title}**：\n好消息，管理组已**恢复你本场的参选资格**，你将进入接下来的投票环节。`);

    const left = countActiveNominations(fresh.id);
    return {
        ok: true,
        message: `已恢复该候选人，本场有效候选 ${left} 人。`
            + (dmOk ? '已私信通知本人。' : '（私信未送达，可能对方关闭了私信。）'),
    };
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
