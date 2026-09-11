// src/modules/titleGuard/services/rewriter.test.ts
//
// 改写器测试。重点验两件事：
//   1. 标记段改写能改对，且改完能过复核
//   2. 「只能删字不能加字」这道安全阀确实拦得住

import test from 'node:test';
import assert from 'node:assert/strict';

import { compileConfig, detect, judgeHitsOf } from './ruleEngine';
import { buildPlan, isDeletionOnly, tidyTitle, validateNewTitle } from './rewriter';
import type { AppliedTag, DictEntry, GuardConfig } from './types';
import type { Judgement } from './llmJudge';

function word(
    w: string,
    kind: DictEntry['kind'],
    group: string | null,
    extra: Partial<DictEntry> = {},
): DictEntry {
    return {
        word: w.toLowerCase(),
        kind,
        group,
        scope: '全标题',
        replaceTo: null,
        asciiBoundary: /^[a-z0-9]+$/i.test(w),
        ...extra,
    };
}

const CONFIG: GuardConfig = {
    dict: [
        word('纯爱', '分类词', '纯爱'),
        word('NTR', '分类词', 'NTR'),
        word('NTL', '分类词', 'NTL'),
        word('牛头人', '分类词', 'NTR'),
        word('百合', '分类词', '百合'),
        word('百合破坏', '分类词', '百破'),
        word('纯爱牛', '黑名单', 'NTR', { replaceTo: 'NTR' }),
        word('多路线', '中性标记', null),
    ],
    // 三个维度分开配。百合和百破在关键字层面不互斥（「百合破坏」本来就带「百合」两个字），
    // 只有交叉互斥：挂了百合 TAG 就不许标题里写百破。
    exclusiveSets: [
        { dimension: 'tag', groups: ['纯爱', 'NTR', 'NTL'] },
        { dimension: 'word', groups: ['纯爱', 'NTR', 'NTL'] },
    ],
    crossExclusions: [
        { tagGroup: '百合', wordGroup: '百破' },
        { tagGroup: '纯爱', wordGroup: 'NTR' },
        { tagGroup: '纯爱', wordGroup: 'NTL' },
        { tagGroup: 'NTR', wordGroup: '纯爱' },
        { tagGroup: 'NTR', wordGroup: 'NTL' },
        { tagGroup: 'NTL', wordGroup: '纯爱' },
        { tagGroup: 'NTL', wordGroup: 'NTR' },
    ],
    // 社区既定规则：NTR > NTL > 纯爱
    groupPriority: { NTR: 40, NTL: 20, 纯爱: 10 },
    // 分词词库：测试里用几条来验证补词/拆词确实生效
    segmenterWords: [
        { word: '牛逼', action: '补词' },
        { word: '戴绿帽', action: '拆词' },
    ],
    multiRouteGroup: '多路线',
};

const compiled = compileConfig(CONFIG);

function tag(name: string, group: string | null): AppliedTag {
    return { tagId: `tag_${name}`, tagName: name, group };
}

/** 论坛里有「多路线」这个 TAG */
const AVAILABLE: AppliedTag[] = [
    { tagId: 'tag_多路线', tagName: '多路线', group: '多路线' },
];

function plan(title: string, tags: AppliedTag[], judgement?: Judgement | null) {
    const detectResult = detect({ title, tags, config: CONFIG }, compiled);
    return buildPlan({ detectResult, tags, availableTags: AVAILABLE, compiled, judgement });
}

// ---------- 标记段改写 ----------

test('改写：【NTL NTR】+ NTR TAG → 【NTR】', () => {
    const p = plan('【NTL NTR】某某的故事', [tag('NTR', 'NTR')]);
    assert.equal(p.autoFixable, true);
    assert.equal(p.keepGroup, 'NTR');
    // NTR(40) > NTL(20)，是优先级判出来的，不是「因为 TAG 挂的是 NTR」
    assert.equal(p.keepSource, 'priority');
    assert.equal(p.newTitle, '【NTR】某某的故事');
});

test('改写：【NTL+NTR+多路线】+ NTL TAG → 留 NTR，多路线不动', () => {
    // TAG 挂的是 NTL，但 NTR(40) > NTL(20)，优先级说了算：
    // 标题留 NTR，NTL 的 TAG 也一并摘掉。中性标记「多路线」不受影响。
    const p = plan('【NTL+NTR+多路线】某某', [tag('NTL', 'NTL')]);
    assert.equal(p.autoFixable, true);
    assert.equal(p.keepGroup, 'NTR');
    assert.equal(p.newTitle, '【NTR+多路线】某某');
    assert.deepEqual(p.removeTagIds, ['tag_NTL']);
});

test('改写：尾部标记段 某某【NTL 纯爱】+ NTL TAG', () => {
    const p = plan('某某【NTL 纯爱】', [tag('NTL', 'NTL')]);
    assert.equal(p.autoFixable, true);
    assert.equal(p.newTitle, '某某【NTL】');
});

test('改写：黑名单词整词替换为规范写法', () => {
    const p = plan('【纯爱牛】某某', [tag('NTR', 'NTR')]);
    assert.equal(p.autoFixable, true);
    assert.equal(p.newTitle, '【NTR】某某');
});

// ---------- 交叉互斥：优先级低的那边输，不管它在哪一侧 ----------

/** 论坛里 TAG 齐全的场景 */
const FULL_FORUM: AppliedTag[] = [
    ...AVAILABLE,
    tag('NTR', 'NTR'),
    tag('NTL', 'NTL'),
    tag('纯爱', '纯爱'),
    tag('百合', '百合'),
];

function planWithForum(title: string, tags: AppliedTag[]) {
    const detectResult = detect({ title, tags, config: CONFIG }, compiled);
    return buildPlan({ detectResult, tags, availableTags: FULL_FORUM, compiled });
}

test('交叉互斥：输的是 TAG 那边 → 摘 TAG，标题一个字不动', () => {
    // 标题写 NTR(40)、TAG 挂纯爱(10) → 纯爱输，而纯爱在 TAG 侧
    const p = planWithForum('【NTR】某某', [tag('纯爱', '纯爱')]);
    assert.equal(p.autoFixable, true);
    assert.equal(p.newTitle, '【NTR】某某', '赢的一方在标题里，标题不该动');
    assert.deepEqual(p.removeTagIds, ['tag_纯爱']);
    assert.deepEqual(p.addTagIds, ['tag_NTR'], '摘完要补上和标题一致的 TAG');
});

test('交叉互斥：输的是关键字那边 → 删标题里的词，TAG 不动', () => {
    // 反过来：标题写纯爱(10)、TAG 挂 NTR(40) → 还是纯爱输，这回纯爱在关键字侧
    const p = planWithForum('【纯爱】某某', [tag('NTR', 'NTR')]);
    assert.equal(p.autoFixable, true);
    assert.equal(p.newTitle, '某某', '标题里的纯爱该被删掉');
    assert.deepEqual(p.removeTagIds, [], 'NTR TAG 赢了，不该动');
    assert.deepEqual(p.addTagIds, [], '被删掉的分类不该反过来补成 TAG');
});

test('交叉互斥：NTL 撞上 NTR TAG，NTL 优先级更低，删标题里的 NTL', () => {
    const p = planWithForum('【NTL】某某的故事', [tag('NTR', 'NTR')]);
    assert.equal(p.autoFixable, true);
    assert.equal(p.newTitle, '某某的故事');
    assert.deepEqual(p.removeTagIds, []);
});

test('交叉互斥：论坛里没有对应 TAG 时，摘掉输的那个就行，不硬补', () => {
    // AVAILABLE 里只有「多路线」，没有 NTR
    const p = plan('【NTR】某某', [tag('纯爱', '纯爱')]);
    assert.equal(p.autoFixable, true);
    assert.equal(p.newTitle, '【NTR】某某');
    assert.deepEqual(p.removeTagIds, ['tag_纯爱']);
    assert.deepEqual(p.addTagIds, []);
});

test('交叉互斥：两边优先级都没配 → 按规矩本身办，摘 TAG', () => {
    // 百合和百破都没配优先级，规矩写的是「挂百合 TAG 就不许标题里写百破」
    const p = planWithForum('【百合破坏】某某', [tag('百合', '百合')]);
    assert.equal(p.autoFixable, true);
    assert.equal(p.newTitle, '【百合破坏】某某', '标题不该动');
    assert.deepEqual(p.removeTagIds, ['tag_百合']);
    assert.deepEqual(p.addTagIds, [], '百破没有自己的 TAG，只摘不补');
});

test('标签区和 TAG 一致时不折腾', () => {
    const p = planWithForum('【NTR】某某', [tag('NTR', 'NTR')]);
    assert.equal(p.newTitle, '【NTR】某某');
    assert.deepEqual(p.removeTagIds, []);
    assert.deepEqual(p.addTagIds, []);
});

test('百合破坏：关键字层面不互斥，标题里并存不该动', () => {
    const p = planWithForum('【百合/百合破坏】某某', [tag('百合', '百合')]);
    assert.equal(p.autoFixable, true);
    assert.equal(p.newTitle, '【百合/百合破坏】某某', '百合和百破不是互斥关键词，标题不该动');
    assert.deepEqual(p.removeTagIds, ['tag_百合']);
});

// ---------- 定不了保留组时必须转人工 ----------

// ---------- TAG 互斥：按社区优先级自动定，不再转人工 ----------

test('G1：多个互斥 TAG 按优先级 NTR > NTL > 纯爱 保留', () => {
    const p = plan('某某的故事', [tag('NTR', 'NTR'), tag('纯爱', '纯爱')]);
    assert.equal(p.autoFixable, true);
    assert.equal(p.keepGroup, 'NTR');
    assert.equal(p.keepSource, 'priority');
    assert.deepEqual(p.removeTagIds, ['tag_纯爱']);
});

test('G1：NTL 优先于纯爱', () => {
    const p = plan('某某的故事', [tag('NTL', 'NTL'), tag('纯爱', '纯爱')]);
    assert.equal(p.keepGroup, 'NTL');
    assert.deepEqual(p.removeTagIds, ['tag_纯爱']);
});

test('G1：三个都挂时留 NTR', () => {
    const p = plan('某某', [tag('NTR', 'NTR'), tag('NTL', 'NTL'), tag('纯爱', '纯爱')]);
    assert.equal(p.keepGroup, 'NTR');
    assert.deepEqual(p.removeTagIds.sort(), ['tag_NTL', 'tag_纯爱']);
});

test('G1：摘掉互斥 TAG 后自动补上「多路线」TAG', () => {
    const p = plan('某某的故事', [tag('NTR', 'NTR'), tag('纯爱', '纯爱')]);
    assert.deepEqual(p.addTagIds, ['tag_多路线']);
});

test('G1：已经挂了多路线就不重复补', () => {
    const p = plan('某某', [tag('NTR', 'NTR'), tag('纯爱', '纯爱'), tag('多路线', '多路线')]);
    assert.deepEqual(p.addTagIds, []);
});

test('标题里的「多路线」三个字机器人不会替作者加', () => {
    const p = plan('【NTL NTR】某某的故事', [tag('NTR', 'NTR'), tag('纯爱', '纯爱')]);
    assert.equal(p.newTitle, '【NTR】某某的故事');
    assert.ok(!p.newTitle.includes('多路线'), '标题不该被塞进多路线');
});

test('TAG 冲突时标题也按同一个保留组改写', () => {
    // 标题里有 NTL/NTR，TAG 挂着 NTL/纯爱。三处打架，但优先级只有一个答案：NTR。
    const p = plan('【NTL NTR】某某', [tag('NTL', 'NTL'), tag('纯爱', '纯爱')]);
    assert.equal(p.keepGroup, 'NTR');
    assert.equal(p.newTitle, '【NTR】某某');
    assert.deepEqual(p.removeTagIds.sort(), ['tag_NTL', 'tag_纯爱']);
});

test('保底：完全没有 TAG 时，按分类优先级留一个，不转人工', () => {
    const p = plan('【NTL NTR】某某', []);
    assert.equal(p.autoFixable, true, '有优先级就该自动改，不该卡在人工队列');
    assert.equal(p.keepGroup, 'NTR');
    assert.equal(p.keepSource, 'priority');
    assert.equal(p.newTitle, '【NTR】某某');
});

test('保底：纯爱 vs NTL 无 TAG → 留 NTL（权重更高）', () => {
    // 用户实际遇到的例子
    const p = plan('【纯爱/NTL / 手枪卡/ 可后宫/缘之空同人二创】缘之空', []);
    assert.equal(p.autoFixable, true);
    assert.equal(p.keepGroup, 'NTL');
    assert.equal(p.keepSource, 'priority');
    assert.ok(!p.newTitle.includes('纯爱'), '纯爱应被删掉：' + p.newTitle);
    assert.ok(p.newTitle.includes('NTL') || p.newTitle.includes('ntl'), 'NTL 应保留：' + p.newTitle);
});

test('保底：优先级没配时才真的转人工', () => {
    const noPriority = { ...CONFIG, groupPriority: {} };
    const c2 = compileConfig(noPriority);
    const dr = detect({ title: '【NTL NTR】某某', tags: [], config: noPriority }, c2);
    const p = buildPlan({ detectResult: dr, tags: [], compiled: c2 });
    assert.equal(p.autoFixable, false);
    assert.equal(p.keepGroup, null);
});

// ---------- 删的单位是整个 token，不是关键词 ----------

test('改写：「可纯爱」整块删掉，不留孤零零的「可」', () => {
    const p = plan('【乱伦/姐弟/NTL/可纯爱/隐奸】某某', [tag('NTL', 'NTL')]);
    assert.equal(p.newTitle, '【乱伦/姐弟/NTL/隐奸】某某');
});

test('改写：「NTL？」整块删掉，不留「？」', () => {
    // TAG 挂 NTR，标题里的 NTL 和纯爱都输给它，两个 token 整块删掉
    const p = plan('【NTL？/纯爱/肘击】某某', [tag('NTR', 'NTR')]);
    assert.equal(p.keepGroup, 'NTR');
    assert.equal(p.newTitle, '【肘击】某某');
});

test('改写：标记段被删空后整个括号一起消失', () => {
    const p = plan('【更新】【NTL/纯爱】某某', [tag('NTL', 'NTL'), tag('纯爱', '纯爱')]);
    assert.ok(!p.newTitle.includes('【】'), '不该留下空括号：' + p.newTitle);
});

// ---------- 只能删字，不能加字 ----------

test('子序列校验：删字通过', () => {
    assert.equal(isDeletionOnly('纯爱牛头人日记', '牛头人日记'), true);
    assert.equal(isDeletionOnly('【NTL NTR】某某', '【NTR】某某'), true);
});

test('子序列校验：加字、改字一律拦下', () => {
    assert.equal(isDeletionOnly('纯爱牛头人日记', 'NTR牛头人日记'), false);
    assert.equal(isDeletionOnly('牛头人日记', '牛头人的日记'), false);
    assert.equal(isDeletionOnly('某某', '某某某'), false);
});

test('子序列校验：顺序变了也拦下', () => {
    assert.equal(isDeletionOnly('abc定', '定cba'), false);
});

test('LLM 给了会加字的标题 → 放弃自动改，转人工', () => {
    const bad: Judgement = {
        falseMatches: [],
        conflictingGroups: ['纯爱', 'NTR'],
        suggestedKeep: 'NTR',
        suggestedTitle: '【NTR】牛头人日记', // 凭空加了「【NTR】」
        confidence: 'high',
        reason: '测试用',
    };
    const p = plan('纯爱牛头人日记', [tag('NTR', 'NTR')], bad);
    assert.equal(p.autoFixable, false);
    assert.match(p.blockedReason ?? '', /校验/);
});

test('LLM 给了合法的删字标题 → 采纳', () => {
    const good: Judgement = {
        falseMatches: [],
        conflictingGroups: ['纯爱', 'NTR'],
        suggestedKeep: 'NTR',
        suggestedTitle: '牛头人日记',
        confidence: 'high',
        reason: '标题无句子结构，两个分类词直接叠加',
    };
    const p = plan('纯爱牛头人日记', [tag('NTR', 'NTR')], good);
    assert.equal(p.autoFixable, true);
    assert.equal(p.newTitle, '牛头人日记');
});

test('LLM 把握低时不采纳它的保留建议，改走优先级保底', () => {
    const unsure: Judgement = {
        falseMatches: [],
        conflictingGroups: ['纯爱', 'NTR'],
        suggestedKeep: 'NTR',
        suggestedTitle: '牛头人日记',
        confidence: 'low',
        reason: '拿不准',
    };
    const p = plan('纯爱牛头人日记', [], unsure);
    // 不是采纳 LLM，而是按优先级——结果凑巧同为 NTR，但依据不同
    assert.equal(p.keepSource, 'priority');
    assert.equal(p.keepGroup, 'NTR');
});

// ---------- 模型只能否掉「误判的那几个字」 ----------

test('模型说「是句子成分」不算数：百合破坏 + 百合 TAG 照样摘 TAG', () => {
    // 关键字层面百合和百破并不互斥（「百合破坏」四个字里天然含百合），
    // 唯一的冲突是「百合 TAG × 百破 关键字」的交叉互斥，
    // 常规处置就是摘掉百合 TAG、标题一个字不动。
    //
    // 模型没有「因为整条读起来像句子所以放过」这种权力——
    // 它只能指出某几个字在这儿不是那个意思，而这里「百合破坏」就是那个词。
    const noFalseMatch: Judgement = {
        falseMatches: [],
        conflictingGroups: ['百破'],
        suggestedKeep: null,
        suggestedTitle: null,
        confidence: 'high',
        reason: '百合破坏在这儿就是那个分类词',
    };
    const p = plan('《真正的橘子味世界不允许百合破坏的存在！》', [tag('百合', '百合')], noFalseMatch);
    assert.equal(p.newTitle, '《真正的橘子味世界不允许百合破坏的存在！》', '标题不该动');
    assert.deepEqual(p.removeTagIds, ['tag_百合'], '该摘掉百合 TAG');
    assert.equal(p.autoFixable, true);
});

test('对照组：标记段里的百合破坏 + 百合 TAG → 同样是摘 TAG', () => {
    const p = plan('【百合破坏】某某', [tag('百合', '百合')]);
    assert.equal(p.autoFixable, true);
    assert.deepEqual(p.removeTagIds, ['tag_百合']);
});

test('模型标出误判命中 → 只有被标的那一处不算数，冲突跟着消失', () => {
    // 模型是**按编号**指认误判的，编号来自 judgeHitsOf()。
    // 这条测的是机制：标了第几处，第几处就不参与判定。
    // 「这一处到底算不算误判」是模型的判断，不归这里管。
    const title = '纯爱战士也逃不过NTR的结局';
    const detectResult = detect({ title, tags: [], config: CONFIG }, compiled);
    const hits = judgeHitsOf(detectResult);
    const nth = hits.findIndex(h => h.entry.word === '纯爱') + 1;
    assert.ok(nth > 0, '这条标题应该命中「纯爱」');
    assert.ok(detectResult.violations.some(v => v.rule === 'T3'), '没标误判之前应该有关键字冲突');

    const p = plan(title, [], {
        falseMatches: [nth],
        conflictingGroups: [],
        suggestedKeep: null,
        suggestedTitle: null,
        confidence: 'high',
        reason: '「纯爱战士」是个梗，这两个字在这儿不是分类',
    });
    // 只剩 NTR 一个分类，冲突不成立 → 什么都不用改
    assert.equal(p.newTitle, title);
    assert.deepEqual(p.removeTagIds, []);
    assert.equal(p.autoFixable, true);
});

test('模型没标误判 → 冲突照旧成立，该改还得改', () => {
    const title = '纯爱战士也逃不过NTR的结局';
    const p = plan(title, [], {
        falseMatches: [],
        conflictingGroups: ['纯爱', 'NTR'],
        suggestedKeep: 'NTR',
        suggestedTitle: 'NTR的结局',
        confidence: 'high',
        reason: '两个都是真的分类词',
    });
    assert.notEqual(p.newTitle, title, '标题该被改');
});

// ---------- 收尾清理 ----------

test('收尾清理：空括号、连续分隔符、首尾空格', () => {
    assert.equal(tidyTitle('【】某某'), '某某');
    assert.equal(tidyTitle('【NTR++多路线】某某'), '【NTR+多路线】某某');
    assert.equal(tidyTitle('【 + NTR】某某'), '【NTR】某某');
    assert.equal(tidyTitle('  某某  '), '某某');
});

// ---------- 标题校验的其余两条 ----------

test('校验：超长拦下', () => {
    const long = '啊'.repeat(101);
    const check = validateNewTitle(long, long, [], compiled, { allowAddition: true });
    assert.equal(check.ok, false);
    assert.match(check.reason ?? '', /超长/);
});

test('校验：改完仍然违规就拦下', () => {
    const check = validateNewTitle('【NTL NTR】某某', '【NTL NTR】某某', [], compiled, { allowAddition: true });
    assert.equal(check.ok, false);
    assert.match(check.reason ?? '', /仍然违规/);
});

test('校验：空标题拦下', () => {
    const check = validateNewTitle('某某', '  ', [], compiled, { allowAddition: true });
    assert.equal(check.ok, false);
});
