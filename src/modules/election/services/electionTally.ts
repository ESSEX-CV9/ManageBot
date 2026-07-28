// src/modules/election/services/electionTally.ts
//
// 纯计票/排名逻辑（无 Discord 依赖，便于推理与测试）。
//
// 规则（设计冻结）：
//   得票率_i = 该候选票数_i / 该类总票数
//   最终得分_i = (w民 × 大众得票率_i + w管 × 管理得票率_i) / (启用项权重之和)
//     · 只启用一种时该种占 100%（分母只含它）
//   排名降序取前 vacancyCount 名当选；并列按 tieBreak 指定的那一类得票率高者优先。
//   两项都完全相同、且这一组正好跨在录取线上时，规则已无法分出胜负：
//   标记 tied 交给管理员人工裁定，绝不按名单顺序偷偷定谁当选。

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
    /** 与他人完全平票且这组人跨在录取线上：规则分不出胜负，待人工裁定（此时 elected 恒为 false）。 */
    tied: boolean;
}

// 得票率是除法算出来的浮点数，用容差比较避免 1e-17 级误差被当成「分出高下」。
const EPS = 1e-9;
const near = (a: number, b: number) => Math.abs(a - b) < EPS;

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
        return { userId, publicVotes: pv, adminVotes: av, publicShare, adminShare, finalScore, rank: 0, elected: false, tied: false };
    });

    const tieShare = (r: CandidateResult) => (round.tieBreak === 'admin' ? r.adminShare : r.publicShare);
    results.sort((a, b) => {
        if (!near(a.finalScore, b.finalScore)) return b.finalScore - a.finalScore;
        // 并列：按 tie-break 指定类别的得票率
        if (!near(tieShare(a), tieShare(b))) return tieShare(b) - tieShare(a);
        return 0; // 完全平票，顺序无意义，下面判断是否需要人工裁定
    });

    results.forEach((r, i) => {
        r.rank = i + 1;
        r.elected = i < round.vacancyCount;
    });

    // 扫描完全平票组：只有正好跨在录取线上的那一组才是问题（组内谁进谁不进无从判断），
    // 整组标记 tied 且一律不自动当选，剩下的名额留给管理员裁定。
    for (let start = 0; start < results.length;) {
        let end = start + 1;
        while (end < results.length
            && near(results[end].finalScore, results[start].finalScore)
            && near(tieShare(results[end]), tieShare(results[start]))) end++;
        if (start < round.vacancyCount && end > round.vacancyCount) {
            for (let i = start; i < end; i++) {
                results[i].tied = true;
                results[i].elected = false;
            }
        }
        start = end;
    }
    return results;
}

/** 平票裁定所需信息：待裁定的候选人，以及他们争夺的剩余名额数。 */
export function tieInfo(vacancyCount: number, results: CandidateResult[]): { tied: CandidateResult[]; seats: number } {
    const tied = results.filter(r => r.tied);
    return { tied, seats: vacancyCount - results.filter(r => r.elected).length };
}
