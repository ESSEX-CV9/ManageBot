// 把**真正发出去**的提示词原样渲染到文件里，供人工核对。只读 seed-dict.json，不写。
//
// 为什么要有这个：提示词靠手抄核对，抄的和发的迟早对不上。
// 这里调的是 buildJudgeSpec / buildScreenSpec / buildReviewSpec 本尊，
// 拿到的就是机器人发出去的那一份，一个字不差。
//
// 跑：npx ts-node src/modules/titleGuard/tools/dumpPrompts.ts [输出路径]

import fs from 'fs';
import path from 'path';

import { normalize, shouldForceAsciiBoundary } from '../services/normalizer';
import { compileConfig, detect } from '../services/ruleEngine';
import { buildPlan, pendingHits, planProgramStage, previewTagPlan } from '../services/rewriter';
import { buildRetryFeedback } from '../services/planner';
import {
    buildJudgeHits, buildJudgeRules, buildJudgeSpec,
    type JudgeInput, type Judgement,
} from '../services/llmJudge';
import { buildScreenSpec, buildReviewSpec } from '../services/llmAppeal';
import type { AppliedTag, DetectResult, DictEntry, GuardConfig, WordTier } from '../services/types';

// ============================================================
// 从种子文件拼出配置
// ============================================================

const seed = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'seed-dict.json'), 'utf8'),
) as Record<string, any>;

/**
 * 种子文件里目前还没有「词档」这一列（线上是管理组在面板里标的）。
 * 这里按社区定下的那六个本体词现场标一下，否则导出来的提示词里
 * 每个词都是「关联词」，看不出两档尺子的差别。
 */
const CORE_WORDS = ['纯爱', 'ntr', 'ntl', '百合', '百破', '百合破坏'];

const toEntry = (e: any): DictEntry => {
    const word = normalize(e.word).text.trim();
    const tier: WordTier = e.tier === '本体' || CORE_WORDS.includes(word) ? '本体' : '关联';
    return {
        word,
        kind: e.kind,
        group: e.kind === '白名单' ? null : (e.group || null),
        tier,
        scope: e.scope ?? '全标题',
        replaceTo: e.replaceTo || null,
        asciiBoundary: shouldForceAsciiBoundary(word),
    };
};

const config: GuardConfig = {
    dict: [
        ...(seed.dict ?? []).map(toEntry),
        ...(seed.whitelist ?? []).map((w: string) => toEntry({ word: w, kind: '白名单', group: null })),
    ].filter(d => d.word),
    exclusiveSets: seed.exclusiveSets ?? [],
    crossExclusions: seed.crossExclusions ?? [],
    segmenterWords: seed.segmenterWords ?? [],
    groupPriority: seed.groupPriority ?? {},
    multiRouteGroup: seed.multiRouteGroup ?? null,
};
const compiled = compileConfig(config);

const forumTags: AppliedTag[] = Object.entries(seed.tagGroups ?? {}).map(([name, g]) => ({
    tagId: 'forum_' + name, tagName: name, group: (g as string) || null,
}));
const tagsOf = (names: string[]): AppliedTag[] => names.map(n => ({
    tagId: 'forum_' + n, tagName: n, group: (seed.tagGroups ?? {})[n] || null,
}));

// ============================================================
// 跟机器人走同一条路拼出 JudgeInput
// ============================================================

function judgeInputOf(
    title: string,
    tags: AppliedTag[],
    forumName: string,
    extra: { bodyExcerpt?: string; retryFeedback?: string } = {},
): { input: JudgeInput; detectResult: DetectResult } {
    const detectResult = detect({ title, tags, config }, compiled);
    const stage = planProgramStage({ detectResult, tags, forumTags, compiled });
    const pending = pendingHits(detectResult, stage);

    return {
        detectResult,
        input: {
            title,
            forumName,
            segments: detectResult.segments.map(seg => ({
                kind: seg.kind === 'marker' && seg.confident ? '标签区' as const : '正文' as const,
                text: seg.text,
            })),
            hits: buildJudgeHits(detectResult, pending, config),
            tags: tags.map(t => ({ name: t.tagName, group: t.group })),
            violations: detectResult.violations.map(v => v.message),
            tagPlan: previewTagPlan({ detectResult, tags, forumTags, compiled }),
            rules: buildJudgeRules(config),
            ...extra,
        },
    };
}

// ============================================================
// 样例
// ============================================================

// 样例一：跨段冲突。标签区里明写了纯爱，正文里却有 NTR 关联词，
//         所以程序判不了，整条要交给模型 —— 正是最常走的那条路。
const TITLE = '【纯爱/1v1】明明是绿帽癖的我，怎么会被辣妹逆推，这辈子好像只能搞纯爱了';
const TAG_NAMES = ['NTR'];
const FORUM = '游戏区';
const BODY = '这是一篇温馨的恋爱故事。男主嘴上说着自己有奇怪的癖好，'
    + '实际上从头到尾只喜欢女主一个人，结局是两人修成正果。';
const APPEAL = '「绿帽癖」只是在写男主的人设，整篇其实是纯爱，机器人判错了。';

const tags = tagsOf(TAG_NAMES);
const { input: judgeInput, detectResult } = judgeInputOf(TITLE, tags, FORUM, { bodyExcerpt: BODY });

const out: string[] = [];
const H = (t: string) => out.push('', '='.repeat(78), t, '='.repeat(78), '');
const S = (t: string) => out.push('', '─'.repeat(78), '── ' + t, '─'.repeat(78), '');

out.push('# 标题规范模块 · 实际发出去的提示词全文');
out.push('');
out.push('样例标题：' + TITLE);
out.push('样例 TAG：' + TAG_NAMES.join('、'));
out.push('样例论坛：' + FORUM);
out.push('样例首楼：' + BODY);
out.push('样例申诉理由：' + APPEAL);
out.push('');
out.push('程序判出来的冲突：');
for (const v of detectResult.violations) {
    out.push(`  [${v.rule}/${v.arbiter}] ${v.message}`);
}
out.push('');
out.push('（这份是直接从代码里渲染出来的，不是手抄）');

// ============ 一、标题裁决 ============
const spec1 = buildJudgeSpec(judgeInput);
H('【一】标题裁决 —— 冲突沾上标题主体时，每个帖子都会发这一份');
S('system');
out.push(spec1.systemPrompt);
S('user');
out.push(spec1.userPrompt);
S('user 末尾追加（只在 json 降级模式下）');
out.push(spec1.jsonInstruction.trim());

// ============ 二、打回重写 ============
//
// 故意造一份会被打回的答卷：模型拿「只是形容词」放过了正文里的本体词「纯爱」。
// 这正是老版本真实犯过的错，校验必须拦住它。
const badJudgement: Judgement = {
    verdict: 'NTR',
    verdictReason: '标题里出现绿帽癖，判为 NTR 作品。',
    finalTagGroups: ['NTR'],
    decisions: judgeInput.hits.map((h, i) => ({
        hit: i + 1,
        action: '保留' as const,
        why: h.tier === '本体'
            ? '这两个字在句子里只是个形容词，不是分类标记'
            : '这是在描述人物癖好',
    })),
    confidence: 'high',
};

const badPlan = buildPlan({ detectResult, tags, forumTags, compiled, judgement: badJudgement });

H('【二】打回重写 —— 模型的答卷没过校验时，在【一】的 user 末尾追加这一段');
out.push('这里故意让模型犯老版本犯过的错：拿「只是个形容词」放过正文里的本体词「纯爱」。');
out.push('');
out.push('模型这一版的答卷：');
out.push('  定性：' + badJudgement.verdict);
for (const d of badJudgement.decisions) {
    const w = judgeInput.hits[d.hit - 1];
    out.push(`  [${d.hit}] 「${w?.word}」(${w?.tier}词/${w?.where}) → ${d.action}：${d.why}`);
}
out.push('');

if (badPlan.modelRejection) {
    const feedback = buildRetryFeedback(badPlan.modelRejection);
    const { input: retryInput } = judgeInputOf(TITLE, tags, FORUM, {
        bodyExcerpt: BODY,
        retryFeedback: feedback,
    });
    S('追加的那一段');
    out.push(feedback);
    S('追加之后，user 完整长这样');
    out.push(buildJudgeSpec(retryInput).userPrompt);
} else {
    out.push('⚠️ 这条样例没触发打回（方案：'
        + (badPlan.autoFixable ? '可自动整改' : badPlan.blockedReason ?? '—') + '）。');
    out.push('   校验没拦住这份明显不合规的答卷，这本身就是个 bug，去看 validateModelPlan。');
}

// ============ 三、申诉安检 ============
const spec3 = buildScreenSpec(APPEAL);
H('【三】申诉安检 —— 作者点「申请复核」填了理由之后，先发这一份');
S('system');
out.push(spec3.systemPrompt);
S('user');
out.push(spec3.userPrompt);
S('user 末尾追加（只在 json 降级模式下）');
out.push(spec3.jsonInstruction.trim());

// ============ 四、申诉复核 ============
//
// 复核要基于一份**真的能执行**的方案，所以这里给一份合规答卷跑出来的方案。
const goodJudgement: Judgement = {
    verdict: '纯爱',
    verdictReason: '首楼写明男主从头到尾只喜欢女主、结局修成正果，绿帽癖只是人设。',
    finalTagGroups: ['纯爱'],
    decisions: judgeInput.hits.map((h, i) => ({
        hit: i + 1,
        action: '保留' as const,
        why: h.tier === '本体' ? '本篇就是这一类，不用改' : '这是在描述人物癖好，不是在给作品归类',
    })),
    confidence: 'high',
};
const plan = buildPlan({ detectResult, tags, forumTags, compiled, judgement: goodJudgement });

const names = new Map(forumTags.map(t => [t.tagId, t.tagName]));
const spec4 = buildReviewSpec({
    title: TITLE,
    forumName: FORUM,
    tags: tags.map(t => ({ name: t.tagName, group: t.group })),
    hits: judgeInput.hits.map(h => ({ word: h.word, group: h.group, where: h.where })),
    violationMessages: detectResult.violations.map(v => v.message),
    plan: {
        titleChanged: plan.newTitle !== TITLE,
        newTitle: plan.newTitle,
        removeTagNames: plan.removeTagIds.map(t => names.get(t) ?? t),
        addTagNames: plan.addTagIds.map(t => names.get(t) ?? t),
    },
    priorReason: goodJudgement.verdictReason,
    rules: judgeInput.rules,
    appealText: APPEAL,
});
H('【四】申诉复核 —— 安检通过之后发这一份');
S('system');
out.push(spec4.systemPrompt);
S('user');
out.push(spec4.userPrompt);
S('user 末尾追加（只在 json 降级模式下）');
out.push(spec4.jsonInstruction.trim());

const dest = process.argv[2] ?? path.join(__dirname, '_prompts.txt');
fs.writeFileSync(dest, out.join('\n'), 'utf8');
console.log('写到：' + dest);
console.log('共 ' + out.join('\n').split('\n').length + ' 行');
