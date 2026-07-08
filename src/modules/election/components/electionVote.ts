// src/modules/election/components/electionVote.ts
//
// 投票器：投票面板 + 投票按钮（弹出仅本人可见的候选人选择）+ 候选人选择记票。
// customId：
//   投票按钮   elect_vote_<roundId>_<kind>
//   候选选择   elect_ballot_<roundId>_<kind>
// kind ∈ { public（大众）, admin（管理内投） }。身份核验靠点击者的用户与身份组。

import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    MessageFlags,
    type ButtonInteraction,
    type StringSelectMenuInteraction,
    type Guild,
    type GuildMember,
} from 'discord.js';

import {
    getRound,
    getSettings,
    listNominations,
    getVoterSelections,
    replaceVotes,
    type ElectionRound,
    type VoteKind,
    type Nomination,
} from '../services/electionDatabase';
import { hasAnyRole } from '../services/electionPermission';
import { nameTag, resolveNames } from '../services/nameResolver';

const VOTE_BTN = 'elect_vote_';
const BALLOT_SEL = 'elect_ballot_';
const MAX_OPTIONS = 25; // Discord 单个选择菜单上限

export const voteButtonId = (roundId: number, kind: VoteKind) => `${VOTE_BTN}${roundId}_${kind}`;
const ballotSelectId = (roundId: number, kind: VoteKind) => `${BALLOT_SEL}${roundId}_${kind}`;

export const isVoteButton = (id: string) => id.startsWith(VOTE_BTN);
export const isBallotSelect = (id: string) => id.startsWith(BALLOT_SEL);

const sec = (ms: number) => Math.floor(ms / 1000);
const kindLabel = (k: VoteKind) => (k === 'public' ? '大众投票' : '管理内部投票');

function parseVoteId(customId: string, prefix: string): { roundId: number; kind: VoteKind } | null {
    const rest = customId.slice(prefix.length); // "<id>_<kind>"
    const idx = rest.indexOf('_');
    if (idx < 0) return null;
    const roundId = Number(rest.slice(0, idx));
    const kind = rest.slice(idx + 1) as VoteKind;
    if (!Number.isInteger(roundId) || (kind !== 'public' && kind !== 'admin')) return null;
    return { roundId, kind };
}

/** 构建投票面板（发到大众投票频道 / 管理 thread）。names 提供候选人昵称。 */
export function buildVotePanel(round: ElectionRound, kind: VoteKind, candidates: Nomination[], names: Map<string, string>) {
    const lines = candidates.slice(0, MAX_OPTIONS).map((c, i) => {
        const preview = (c.statement ?? '').replace(/\s+/g, ' ').trim();
        const shown = preview ? `\n> ${preview.slice(0, 120)}${preview.length > 120 ? '…' : ''}` : '';
        return `**${i + 1}.** ${nameTag(names, c.userId)}${shown}`;
    });
    // 联合投票（大众票 + 管理票都启用）：在大众投票器上标明本轮加权情况
    const joint = round.enablePublic && round.enableAdmin;
    const jointLines: string[] = [];
    if (joint && kind === 'public') {
        const wp = round.weightPublic;
        const wa = round.weightAdmin;
        const tot = wp + wa;
        const pubPct = tot > 0 ? Math.round((wp / tot) * 100) : 50;
        const admPct = 100 - pubPct;
        jointLines.push(`🤝 **本轮为联合投票**：最终得分 = 大众得票率 × ${pubPct}% + 管理内部得票率 × ${admPct}%。`);
    }

    const embed = new EmbedBuilder()
        .setTitle(`🗳️ ${kindLabel(kind)}：${round.title}`)
        .setColor(kind === 'public' ? 0x57f287 : 0xfee75c)
        .setDescription(
            [
                `**空位数**：${round.vacancyCount}（每人最多可选 ${round.vacancyCount} 名）`,
                `**投票截止**：<t:${sec(round.voteDeadline)}:f>（<t:${sec(round.voteDeadline)}:R>）`,
                ...jointLines,
                '',
                '⚠️ 本次为**实名投票**，投票情况将在结束后公示。',
                '点击下方「投票 / 改票」进行投票。可重复点击修改，一人一票。',
                '',
                '**候选人：**',
                ...lines,
            ].join('\n').slice(0, 4000),
        )
        .setFooter({ text: `募选 #${round.id}` });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(voteButtonId(round.id, kind))
            .setLabel('🗳️ 投票 / 改票')
            .setStyle(ButtonStyle.Primary),
    );
    return { embeds: [embed], components: [row] };
}

/** 校验投票资格；不可则返回文案。 */
function checkEligibility(guildId: string, kind: VoteKind, member: GuildMember | null): string | null {
    const settings = getSettings(guildId);
    const roleIds = kind === 'public' ? settings.activeRoleIds : settings.adminVoteRoleIds;
    if (!roleIds.length) return '⚠️ 本次投票暂未开放。';
    if (!hasAnyRole(member, roleIds)) {
        const roles = roleIds.map(id => `<@&${id}>`).join('、');
        return `❌ 你没有参与${kindLabel(kind)}的资格，需要以下身份组之一：${roles}`;
    }
    return null;
}

/** 校验一场募选是否处于可投票状态。 */
function checkVotable(guildId: string, roundId: number): { round: ElectionRound } | { error: string } {
    const round = getRound(roundId);
    if (!round || round.guildId !== guildId) return { error: '❌ 该募选不存在或已被移除。' };
    if (round.status !== 'voting') return { error: '⏳ 该募选当前不在投票阶段。' };
    if (Date.now() > round.voteDeadline) return { error: '⏳ 投票已截止。' };
    return { round };
}

async function resolveName(guild: Guild, userId: string): Promise<string> {
    const cached = guild.members.cache.get(userId);
    if (cached) return cached.displayName.slice(0, 100);
    try {
        const m = await guild.members.fetch(userId);
        return m.displayName.slice(0, 100);
    } catch {
        return `用户 ${userId}`.slice(0, 100);
    }
}

/** 处理投票按钮：校验后弹出候选人选择菜单（ephemeral）。 */
export async function handleVoteButton(interaction: ButtonInteraction): Promise<void> {
    const parsed = parseVoteId(interaction.customId, VOTE_BTN);
    if (!parsed || !interaction.guild) return;
    const { roundId, kind } = parsed;

    const votable = checkVotable(interaction.guild.id, roundId);
    if ('error' in votable) {
        await interaction.reply({ content: votable.error, flags: MessageFlags.Ephemeral });
        return;
    }
    const eligErr = checkEligibility(interaction.guild.id, kind, interaction.member as GuildMember | null);
    if (eligErr) {
        await interaction.reply({ content: eligErr, flags: MessageFlags.Ephemeral });
        return;
    }

    const round = votable.round;
    const candidates = listNominations(roundId).slice(0, MAX_OPTIONS);
    if (!candidates.length) {
        await interaction.reply({ content: '⚠️ 本场没有候选人。', flags: MessageFlags.Ephemeral });
        return;
    }
    // 先占坑：解析候选人昵称可能要联网（尤其非本服成员），会超过 3 秒交互时限。
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const current = new Set(getVoterSelections(roundId, kind, interaction.user.id));

    const options = await Promise.all(candidates.map(async c => {
        const name = await resolveName(interaction.guild!, c.userId);
        const opt = new StringSelectMenuOptionBuilder().setLabel(name).setValue(c.userId).setDefault(current.has(c.userId));
        const preview = (c.statement ?? '').replace(/\s+/g, ' ').trim();
        if (preview) opt.setDescription(preview.slice(0, 100));
        return opt;
    }));

    const maxValues = Math.min(round.vacancyCount, candidates.length);
    const menu = new StringSelectMenuBuilder()
        .setCustomId(ballotSelectId(roundId, kind))
        .setPlaceholder(`选择你支持的候选人（最多 ${maxValues} 名）`)
        .setMinValues(1)
        .setMaxValues(maxValues)
        .addOptions(options);

    await interaction.editReply({
        content: `请为 **${kindLabel(kind)}｜${round.title}** 选择候选人（最多 ${maxValues} 名，提交即记录/覆盖你的投票）：`,
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    });
}

/** 处理候选人选择：记录/覆盖投票。 */
export async function handleBallotSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const parsed = parseVoteId(interaction.customId, BALLOT_SEL);
    if (!parsed || !interaction.guild) return;
    const { roundId, kind } = parsed;

    const votable = checkVotable(interaction.guild.id, roundId);
    if ('error' in votable) {
        await interaction.update({ content: votable.error, components: [] });
        return;
    }
    const eligErr = checkEligibility(interaction.guild.id, kind, interaction.member as GuildMember | null);
    if (eligErr) {
        await interaction.update({ content: eligErr, components: [] });
        return;
    }

    // 只接受本场候选人，防越权/脏值
    const validIds = new Set(listNominations(roundId).map(n => n.userId));
    const picks = interaction.values.filter(v => validIds.has(v)).slice(0, votable.round.vacancyCount);
    if (!picks.length) {
        await interaction.update({ content: '⚠️ 未选择有效候选人，投票未记录。', components: [] });
        return;
    }
    replaceVotes(roundId, kind, interaction.user.id, picks);

    const names = await resolveNames(interaction.guild, picks);
    await interaction.update({
        content: `✅ 已记录你的${kindLabel(kind)}：${picks.map(id => nameTag(names, id)).join('、')}\n（可重新点击面板按钮修改。）`,
        components: [],
    });
}
