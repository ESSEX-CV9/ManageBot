// src/modules/election/commands/electionTestCommand.ts
//
// 募选测试命令 /募选测试（仅测试模式）。
// 用来在测试服凭空造数据，把整条流程跑通，不依赖真实候选池 API：
//   注入候选池 / 注入自荐（造候选人）/ 模拟投票 / 清空。
//
// 仅当 .env 的 ELECTION_TEST_MODE=true 时，core/index.ts 才会注册本命令；
// 执行时再校验一次测试模式与管理权限，双保险。

import { SlashCommandBuilder, MessageFlags, type GuildMember } from 'discord.js';
import type { Command } from '../../../core/types';
import { canManageElection, isElectionTestMode } from '../services/electionPermission';
import { openVoting, settleRound, publishPending, republish } from '../services/electionRunner';
import {
    addToPool,
    listPool,
    getRound,
    listNominations,
    countNominations,
    upsertNomination,
    replaceVotes,
    clearPool,
    clearRoundVotes,
    clearRoundNominations,
    type ParsedPoolEntry,
    type VoteKind,
} from '../services/electionDatabase';

// 生成一个测试用的假用户 id（18 位，9000... 开头，真实用户不会命中）
function fakeId(seq: number): string {
    return (900000000000000000n + BigInt(seq)).toString();
}
// 每次调用换一个随机基数，避免多次注入的假 id 相互覆盖
function freshBase(): number {
    return Math.floor(Math.random() * 1_000_000_000);
}

// 收集"包含自己 + 指定真实用户 + N 个虚拟用户"的 id 集合
function collectIds(interaction: Parameters<Command['execute']>[0], includeSelf: boolean, fakeCount: number): string[] {
    const ids = new Set<string>();
    if (includeSelf) ids.add(interaction.user.id);
    for (const key of ['用户1', '用户2', '用户3']) {
        const u = interaction.options.getUser(key);
        if (u) ids.add(u.id);
    }
    const base = freshBase();
    for (let i = 0; i < fakeCount; i++) ids.add(fakeId(base + i));
    return [...ids];
}

const data = new SlashCommandBuilder()
    .setName('募选测试')
    .setDescription('（测试模式）造假数据跑通募选流程')
    .addSubcommand(sub =>
        sub.setName('注入候选池')
            .setDescription('把自己/指定用户/若干虚拟用户加入候选池')
            .addBooleanOption(o => o.setName('包含自己').setDescription('默认是'))
            .addIntegerOption(o => o.setName('虚拟数量').setDescription('额外生成的虚拟成员数').setMinValue(0).setMaxValue(100))
            .addUserOption(o => o.setName('用户1').setDescription('加入候选池的真实用户'))
            .addUserOption(o => o.setName('用户2').setDescription('加入候选池的真实用户'))
            .addUserOption(o => o.setName('用户3').setDescription('加入候选池的真实用户')))
    .addSubcommand(sub =>
        sub.setName('注入自荐')
            .setDescription('给某场直接塞入候选人（跳过自荐按钮）')
            .addIntegerOption(o => o.setName('场次id').setDescription('募选编号').setRequired(true))
            .addIntegerOption(o => o.setName('虚拟数量').setDescription('生成的虚拟候选人数').setMinValue(0).setMaxValue(25))
            .addBooleanOption(o => o.setName('包含自己').setDescription('默认否'))
            .addUserOption(o => o.setName('用户1').setDescription('作为候选人的真实用户'))
            .addUserOption(o => o.setName('用户2').setDescription('作为候选人的真实用户'))
            .addUserOption(o => o.setName('用户3').setDescription('作为候选人的真实用户')))
    .addSubcommand(sub =>
        sub.setName('模拟投票')
            .setDescription('给投票中的某场灌入随机票')
            .addIntegerOption(o => o.setName('场次id').setDescription('募选编号').setRequired(true))
            .addIntegerOption(o => o.setName('大众票数').setDescription('模拟的大众投票人数').setMinValue(0).setMaxValue(500))
            .addIntegerOption(o => o.setName('管理票数').setDescription('模拟的管理投票人数').setMinValue(0).setMaxValue(500)))
    .addSubcommand(sub =>
        sub.setName('跳阶段')
            .setDescription('直接把某场推进到指定阶段（投票会强制开，忽略人数限制）')
            .addIntegerOption(o => o.setName('场次id').setDescription('募选编号').setRequired(true))
            .addStringOption(o => o.setName('目标').setDescription('要跳到的阶段').setRequired(true)
                .addChoices(
                    { name: '开启投票（强制）', value: 'voting' },
                    { name: '结算出结果', value: 'settle' },
                    { name: '公示（待确认时）', value: 'publish' },
                )))
    .addSubcommand(sub =>
        sub.setName('重新公示')
            .setDescription('不改状态，按现有票重新公示一次结果（测试查看用）')
            .addIntegerOption(o => o.setName('场次id').setDescription('募选编号').setRequired(true)))
    .addSubcommand(sub =>
        sub.setName('清空')
            .setDescription('清理测试数据')
            .addIntegerOption(o => o.setName('场次id').setDescription('清空该场的自荐与投票'))
            .addBooleanOption(o => o.setName('含候选池').setDescription('同时清空整个候选池（默认否）')));

const command: Command = {
    data,
    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: '❌ 只能在服务器中使用。', flags: MessageFlags.Ephemeral });
        }
        if (!isElectionTestMode()) {
            return interaction.reply({ content: '❌ 测试模式未开启（需在 .env 设 ELECTION_TEST_MODE=true 并重启）。', flags: MessageFlags.Ephemeral });
        }
        const guildId = interaction.guild.id;
        if (!canManageElection(guildId, interaction.member as GuildMember | null)) {
            return interaction.reply({ content: '❌ 你没有募选管理权限。', flags: MessageFlags.Ephemeral });
        }

        const sub = interaction.options.getSubcommand();

        // ---- 注入候选池 ----
        if (sub === '注入候选池') {
            const includeSelf = interaction.options.getBoolean('包含自己') ?? true;
            const fake = interaction.options.getInteger('虚拟数量') ?? 0;
            const ids = collectIds(interaction, includeSelf, fake);
            if (!ids.length) {
                return interaction.reply({ content: '⚠️ 没指定任何成员（关掉了"包含自己"又没填用户/虚拟数量）。', flags: MessageFlags.Ephemeral });
            }
            const now = Date.now();
            const entries: ParsedPoolEntry[] = ids.map(id => ({ userId: id, displayName: null, passedAt: now }));
            addToPool(guildId, entries);
            return interaction.reply({
                content: `✅ 已注入 ${ids.length} 名候选池成员，当前在池 **${listPool(guildId).length}** 人。`,
                flags: MessageFlags.Ephemeral,
            });
        }

        // ---- 注入自荐 ----
        if (sub === '注入自荐') {
            const roundId = interaction.options.getInteger('场次id', true);
            const round = getRound(roundId);
            if (!round || round.guildId !== guildId) {
                return interaction.reply({ content: `❌ 未找到募选 #${roundId}。`, flags: MessageFlags.Ephemeral });
            }
            const includeSelf = interaction.options.getBoolean('包含自己') ?? false;
            const fake = interaction.options.getInteger('虚拟数量') ?? 0;
            const ids = collectIds(interaction, includeSelf, fake);
            if (!ids.length) {
                return interaction.reply({ content: '⚠️ 没指定任何候选人。', flags: MessageFlags.Ephemeral });
            }
            const now = Date.now();
            addToPool(guildId, ids.map(id => ({ userId: id, displayName: null, passedAt: now }))); // 顺带进池，数据一致
            ids.forEach((id, i) => upsertNomination(roundId, id, `【测试】候选人 ${i + 1} 的自荐宣言`));
            return interaction.reply({
                content: `✅ 已给募选 #${roundId} 注入 ${ids.length} 名候选人，本场自荐共 **${countNominations(roundId)}** 人。`,
                flags: MessageFlags.Ephemeral,
            });
        }

        // ---- 模拟投票 ----
        if (sub === '模拟投票') {
            const roundId = interaction.options.getInteger('场次id', true);
            const round = getRound(roundId);
            if (!round || round.guildId !== guildId) {
                return interaction.reply({ content: `❌ 未找到募选 #${roundId}。`, flags: MessageFlags.Ephemeral });
            }
            const candidates = listNominations(roundId).map(n => n.userId);
            if (!candidates.length) {
                return interaction.reply({ content: '⚠️ 本场没有候选人，先用 `/募选测试 注入自荐`。', flags: MessageFlags.Ephemeral });
            }
            const maxPick = Math.min(round.vacancyCount, candidates.length);
            const injectKind = (kind: VoteKind, count: number) => {
                const base = freshBase();
                for (let i = 0; i < count; i++) {
                    const voterId = fakeId(base + i);
                    const k = 1 + Math.floor(Math.random() * maxPick); // 每人随机选 1..maxPick 名
                    const shuffled = [...candidates].sort(() => Math.random() - 0.5).slice(0, k);
                    replaceVotes(roundId, kind, voterId, shuffled);
                }
            };
            const pub = interaction.options.getInteger('大众票数') ?? 0;
            const adm = interaction.options.getInteger('管理票数') ?? 0;
            injectKind('public', pub);
            injectKind('admin', adm);
            return interaction.reply({
                content: `✅ 已给募选 #${roundId} 模拟投票：大众 ${pub} 人、管理 ${adm} 人（候选 ${candidates.length}，每人最多选 ${maxPick}）。\n用 \`/募选管理 结算 场次id:${roundId}\` 看结果。`,
                flags: MessageFlags.Ephemeral,
            });
        }

        // ---- 跳阶段 ----
        if (sub === '跳阶段') {
            const roundId = interaction.options.getInteger('场次id', true);
            const round = getRound(roundId);
            if (!round || round.guildId !== guildId) {
                return interaction.reply({ content: `❌ 未找到募选 #${roundId}。`, flags: MessageFlags.Ephemeral });
            }
            const target = interaction.options.getString('目标', true);
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const res = target === 'voting'
                ? await openVoting(interaction.client, round, true)
                : target === 'settle'
                    ? await settleRound(interaction.client, round)
                    : await publishPending(interaction.client, round);
            return interaction.editReply(res.ok ? `✅ #${roundId}：${res.message}` : `⚠️ #${roundId}：${res.message}`);
        }

        // ---- 重新公示 ----
        if (sub === '重新公示') {
            const roundId = interaction.options.getInteger('场次id', true);
            const round = getRound(roundId);
            if (!round || round.guildId !== guildId) {
                return interaction.reply({ content: `❌ 未找到募选 #${roundId}。`, flags: MessageFlags.Ephemeral });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const res = await republish(interaction.client, round);
            return interaction.editReply(res.ok ? `✅ #${roundId}：${res.message}` : `⚠️ #${roundId}：${res.message}`);
        }

        // ---- 清空 ----
        if (sub === '清空') {
            const roundId = interaction.options.getInteger('场次id');
            const withPool = interaction.options.getBoolean('含候选池') ?? false;
            const parts: string[] = [];
            if (roundId !== null) {
                const round = getRound(roundId);
                if (!round || round.guildId !== guildId) {
                    return interaction.reply({ content: `❌ 未找到募选 #${roundId}。`, flags: MessageFlags.Ephemeral });
                }
                const v = clearRoundVotes(roundId);
                const n = clearRoundNominations(roundId);
                parts.push(`场次 #${roundId}：清掉 ${n} 条自荐、${v} 条投票`);
            }
            if (withPool) {
                const p = clearPool(guildId);
                parts.push(`候选池：清掉 ${p} 条记录`);
            }
            if (!parts.length) {
                return interaction.reply({ content: '⚠️ 没指定要清什么（填个场次id，或勾选"含候选池"）。', flags: MessageFlags.Ephemeral });
            }
            return interaction.reply({ content: `✅ 已清空：\n• ${parts.join('\n• ')}`, flags: MessageFlags.Ephemeral });
        }
    },
};

export default command;
