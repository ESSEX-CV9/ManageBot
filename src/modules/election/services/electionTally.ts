// src/modules/election/services/electionTally.ts
//
// 纯计票/排名逻辑（无 Discord 依赖，便于推理与测试）。
//
// 规则（设计冻结）：
//   得票率_i = 该候选票数_i / 该类总票数
//   最终得分_i = (w民 × 大众得票率_i + w管 × 管理得票率_i) / (启用项权重之和)
//     · 只启用一种时该种占 100%（分母只含它）
//   排名降序取前 vacancyCount 名当选；并列按 tieBreak 指定的那一类得票率高者优先。

import type { ElectionRound, Tally } from './electionDatabase';

export interface CandidateResult {
    userId: string;
    publicVotes: number;
    adminVotes: number;
    publicShare: number;   // 0~1
    adminShare: number;    // 0~1
    finalScore: number;    // 0~1
    rank: number;          // 从 1 起
    elected: boolean;
}

/**
 * 计算一场募选的排名与当选者。
 * @param candidateIds 候选人（= 自荐名单，投票开启时已锁定）
 */
export function computeResults(
    round: ElectionRound,
    candidateIds: string[],
    publicTally: Tally,
    adminTally: Tally,
): CandidateResult[] {
    const wPublic = round.enablePublic ? round.weightPublic : 0;
    const wAdmin = round.enableAdmin ? round.weightAdmin : 0;
    let totalW = wPublic + wAdmin;
    // 兜底：启用项权重和为 0（如把启用类的权重填成 0）时按启用项均分，避免除零。
    let wp = wPublic;
    let wa = wAdmin;
    if (totalW <= 0) {
        wp = round.enablePublic ? 1 : 0;
        wa = round.enableAdmin ? 1 : 0;
        totalW = wp + wa || 1;
    }

    const results: CandidateResult[] = candidateIds.map(userId => {
        const pv = publicTally.counts.get(userId) ?? 0;
        const av = adminTally.counts.get(userId) ?? 0;
        const publicShare = publicTally.totalVotes > 0 ? pv / publicTally.totalVotes : 0;
        const adminShare = adminTally.totalVotes > 0 ? av / adminTally.totalVotes : 0;
        const finalScore = (wp * publicShare + wa * adminShare) / totalW;
        return { userId, publicVotes: pv, adminVotes: av, publicShare, adminShare, finalScore, rank: 0, elected: false };
    });

    const tieShare = (r: CandidateResult) => (round.tieBreak === 'admin' ? r.adminShare : r.publicShare);
    results.sort((a, b) => {
        if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
        // 并列：按 tie-break 指定类别的得票率
        if (tieShare(b) !== tieShare(a)) return tieShare(b) - tieShare(a);
        return 0;
    });

    results.forEach((r, i) => {
        r.rank = i + 1;
        r.elected = i < round.vacancyCount;
    });
    return results;
}
