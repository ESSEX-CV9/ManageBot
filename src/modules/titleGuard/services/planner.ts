// src/modules/titleGuard/services/planner.ts
//
// 出方案 → 模型的答卷没过校验就打回重写 → 再出一次方案。
//
// 为什么要有这一步：模型给的是一组「这处删、那处换」的动作，程序拼完标题会重跑一遍规则。
// 跑出来还违规的原因通常就那么几种，而且几乎都是它**没意识到某件事**，不是它不讲理：
//   - 它不知道整改会把 TAG 也换掉，于是留下的关键字跟新 TAG 撞了；
//   - 它拿「这词在句子里只是个形容词」放过了一个本体词；
//   - 它漏答了清单里的某一处。
// 这几种直接转人工都太亏了。把具体哪条没过摊开告诉它，它自己就能改对。
//
// 机器人和调试台共用这里，免得两边各写一套、过一阵子就对不上。

import { buildPlan, type BuildPlanInput, type ModelRejection, type RewritePlan } from './rewriter';
import type { Judgement } from './llmJudge';

/** 最多打回几次。一次足够——再不对就是真的需要人看了，而且每次都是真金白银 */
export const MAX_REWRITES = 1;

/** 把「哪儿还不合规」写成模型看得懂的话 */
export function buildRetryFeedback(rejection: ModelRejection): string {
    const lines = [
        '【重要】你上一版方案**不能用**，请重新给一遍。',
        '',
        `按你的处理拼出来的标题是：${rejection.titleTried}`,
        '',
        `问题在于：${rejection.reason}`,
        '',
        '具体还剩这些没解决：',
        ...(rejection.remaining.length > 0
            ? rejection.remaining.map(m => `  - ${m}`)
            : [`  - ${rejection.reason}`]),
        '',
    ];

    if (rejection.tagsAfter.length > 0) {
        lines.push(
            `另外提醒：按你定的方案，这个帖子最终会挂 ${rejection.tagsAfter.join('、')}。`,
            '**上面那些冲突就是按这份最终 TAG 算出来的**——'
            + '帖子现在挂的 TAG 本身可能就是错的，正在被一起纠正，'
            + '所以别拿现在挂的 TAG 去推敲标题该留什么。',
        );
    } else {
        lines.push('另外提醒：按你定的方案，这个帖子最终不会挂任何分类 TAG。');
    }

    lines.push(
        '',
        '重新过一遍那两把尺子：',
        '  本体词在正文里也必须处理掉，「只是个形容词」「删了不通顺」都不算理由；',
        '  觉得删了不通顺，就选「替换」，别选「保留」。',
        '  关联词才可以判「保留」，而且要说清楚它在这儿描述的是什么。',
        '清单里每一处都要给处理，一处都别漏。',
    );
    return lines.join('\n');
}

export interface PlanWithModelResult {
    plan: RewritePlan;
    /** 最终采用的判定结论（可能是重写之后那一次的） */
    judgement: Judgement | null;
    /** 打回重写了几次 */
    rewrites: number;
}

/**
 * 出方案，模型的答卷被打回就让它重写，重写完再出一次。
 *
 * `rewrite` 由调用方提供——它拿着反馈去真调一次模型，返回新的结论；
 * 返回 null 表示问不到（没配 LLM、调用失败等），那就到此为止。
 */
export async function planWithModel(
    base: BuildPlanInput,
    rewrite: (feedback: string) => Promise<Judgement | null>,
): Promise<PlanWithModelResult> {
    let judgement = base.judgement ?? null;
    let plan = buildPlan({ ...base, judgement });
    let rewrites = 0;

    while (rewrites < MAX_REWRITES && plan.modelRejection) {
        const next = await rewrite(buildRetryFeedback(plan.modelRejection));
        if (!next) break;

        rewrites++;
        judgement = next;
        // 重写之后还是不合规也照样采用这一版的结论——
        // 让管理组看到模型最后到底给了什么，比回退到上一版更有用
        plan = buildPlan({ ...base, judgement });
    }

    return { plan, judgement, rewrites };
}
