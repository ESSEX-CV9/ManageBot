// src/modules/titleGuard/services/rewriter.test.ts
//
// 整改方案测试。分三块：
//   一、程序那一段：标签区和 TAG 之间的冲突，按保留顺序直接改，**绝不碰正文**
//   二、模型那一段：删/换/留三选一落成新标题，以及校验拦不拦得住乱来的答卷
//   三、人工那一段：作者自己敲标题时的安全阀

import test from 'node:test';
import assert from 'node:assert/strict';

import { compileConfig, detect } from './ruleEngine';
import {
    buildPlan, isDeletionOnly, pendingHits, planProgramStage, previewTagPlan,
    tidyTitle, validateNewTitle,
} from './rewriter';
import type { AppliedTag, DictEntry, GuardConfig } from './types';
import type { Judgement } from './llmJudge';
import type { HitDecision } from './titleEdit';

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
        tier: '关联',
        scope: '全标题',
        replaceTo: null,
        asciiBoundary: /^[a-z0-9]+$/i.test(w),
        ...extra,
    };
}

const core = (w: string, group: string) => word(w, '分类词', group, { tier: '本体' });

const CONFIG: GuardConfig = {
    dict: [
        core('纯爱', '纯爱'),
        word('1v1', '分类词', '纯爱'),
        core('NTR', 'NTR'),
        word('牛头人', '分类词', 'NTR'),
        word('绿帽', '分类词', 'NTR'),
        core('NTL', 'NTL'),
        word('黄毛', '分类词', 'NTL'),
        core('百合', '百合'),
        core('百合破坏', '百破'),
        word('纯爱牛', '黑名单', 'NTR', { replaceTo: 'NTR' }),
        word('多路线', '中性标记', null),
    ],
    // 关键字维度必须成对配：NTR 和 NTL 在这一层是兼容的
    exclusiveSets: [
        { dimension: 'tag', groups: ['纯爱', 'NTR', 'NTL'] },
        { dimension: 'word', groups: ['纯爱', 'NTR'] },
        { dimension: 'word', groups: ['纯爱', 'NTL'] },
    ],
    crossExclusions: [
        { tagGroup: '百合', wordGroup: '百破' },
        { tagGroup: '纯爱', wordGroup: 'NTR' },
        { tagGroup: '纯爱', wordGroup: 'NTL' },
        { tagGroup: 'NTR', wordGroup: '纯爱' },
        { tagGroup: 'NTL', wordGroup: '纯爱' },
    ],
    groupPriority: { NTR: 40, NTL: 20, 纯爱: 10 },
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

/** 论坛里能挂的全部 TAG */
const FORUM_TAGS: AppliedTag[] = [
    tag('纯爱', '纯爱'),
    tag('NTR', 'NTR'),
    tag('NTL', 'NTL'),
    tag('百合', '百合'),
    tag('多路线', '多路线'),
];

function plan(title: string, tags: AppliedTag[], judgement?: Judgement | null) {
    const detectResult = detect({ title, tags, config: CONFIG }, compiled);
    return buildPlan({ detectResult, tags, forumTags: FORUM_TAGS, compiled, judgement });
}

/** 这条标题还剩哪几处要问模型（编号 1 起，和提示词里一致） */
function pending(title: string, tags: AppliedTag[]) {
    const detectResult = detect({ title, tags, config: CONFIG }, compiled);
    const stage = planProgramStage({ detectResult, tags, forumTags: FORUM_TAGS, compiled });
    return pendingHits(detectResult, stage);
}

/** 造一份模型答卷：对每一处待定命中给同一种处理 */
function answer(
    title: string,
    tags: AppliedTag[],
    verdict: string,
    finalTagGroups: string[],
    decide: (word: string, index: number) => HitDecision,
): Judgement {
    return {
        verdict,
        verdictReason: '（测试用）',
        finalTagGroups,
        decisions: pending(title, tags).map((m, i) => decide(m.entry.word, i + 1)),
        confidence: 'high',
    };
}

// ============================================================
// 一、程序那一段
// ============================================================

test('程序段：【纯爱 NTR】+ NTR TAG → 【NTR】', () => {
    const p = plan('【纯爱 NTR】某某的故事', [tag('NTR', 'NTR')]);
    assert.equal(p.autoFixable, true);
    assert.equal(p.keepGroup, 'NTR');
    // NTR(40) > 纯爱(10)，是保留顺序判出来的，不是「因为 TAG 挂的是 NTR」
    assert.equal(p.keepSource, 'priority');
    assert.equal(p.newTitle, '【NTR】某某的故事');
});

test('程序段：TAG 挂错了也不影响，保留顺序说了算', () => {
    // TAG 挂的是纯爱，但 NTR(40) > 纯爱(10)：标题留 NTR，纯爱的 TAG 一并摘掉。
    // 中性标记「多路线」不受影响。
    const p = plan('【纯爱+NTR+多路线】某某', [tag('纯爱', '纯爱')]);
    assert.equal(p.autoFixable, true);
    assert.equal(p.keepGroup, 'NTR');
    assert.ok(p.newTitle.includes('多路线'), p.newTitle);
    assert.ok(!p.newTitle.includes('纯爱'), p.newTitle);
});

test('程序段：作者自己选过就压过保留顺序', () => {
    const detectResult = detect({
        title: '【纯爱 NTR】某某的故事', tags: [], config: CONFIG,
    }, compiled);
    const p = buildPlan({
        detectResult, tags: [], forumTags: FORUM_TAGS, compiled, authorChoice: '纯爱',
    });
    assert.equal(p.keepGroup, '纯爱');
    assert.equal(p.keepSource, 'author');
    assert.equal(p.newTitle, '【纯爱】某某的故事');
});

test('程序段：TAG 之间打架 → 留优先级高的，补多路线', () => {
    const p = plan('某某的故事', [tag('纯爱', '纯爱'), tag('NTR', 'NTR')]);
    assert.equal(p.autoFixable, true);
    assert.equal(p.keepGroup, 'NTR');
    assert.equal(p.newTitle, '某某的故事', '纯 TAG 冲突不该动标题');
    assert.deepEqual(p.removeTagIds, ['tag_纯爱']);
    assert.deepEqual(p.addTagIds, ['tag_多路线']);
});

test('程序段：标签区声明 × TAG 冲突 → 标题赢，改 TAG', () => {
    // 标题是作者一个字一个字敲的，TAG 是随手点的
    const p = plan('【纯爱】某某的故事', [tag('NTR', 'NTR')]);
    assert.equal(p.autoFixable, true);
    assert.equal(p.newTitle, '【纯爱】某某的故事', '标题一个字都不该动');
    assert.deepEqual(p.removeTagIds, ['tag_NTR']);
    assert.deepEqual(p.addTagIds, ['tag_纯爱']);
    assert.equal(p.keepSource, 'author');
});

test('程序段：百破关键字 × 百合 TAG → 摘掉百合 TAG，标题不动', () => {
    // 百破没有自己的 TAG，所以只摘不补 —— 这就是「不保留 > 百合TAG」
    const p = plan('【百合破坏】某某', [tag('百合', '百合')]);
    assert.equal(p.autoFixable, true);
    assert.equal(p.newTitle, '【百合破坏】某某');
    assert.deepEqual(p.removeTagIds, ['tag_百合']);
    assert.deepEqual(p.addTagIds, []);
});

test('程序段：标签区里的污染词换成规范写法', () => {
    const p = plan('【纯爱牛】某某的故事', []);
    assert.equal(p.autoFixable, true);
    assert.equal(p.newTitle, '【NTR】某某的故事');
});

test('程序段：绝不碰标题主体', () => {
    // 标签区里凑齐了冲突，程序可以处理标签区那一半；
    // 正文里那个「纯爱」不归它管，得留给模型
    const p = plan('【纯爱】某某其实是ntr的故事', []);
    assert.equal(p.awaitingModel, true, '有正文冲突时应该在等模型，而不是转人工');
    assert.equal(p.autoFixable, false);
    assert.equal(p.blockedReason, null, '等模型不是「转人工的理由」');
});

test('程序段：previewTagPlan 和真方案算的是同一份', () => {
    const detectResult = detect({
        title: '【纯爱】某某的故事', tags: [tag('NTR', 'NTR')], config: CONFIG,
    }, compiled);
    const preview = previewTagPlan({
        detectResult, tags: [tag('NTR', 'NTR')], forumTags: FORUM_TAGS, compiled,
    });
    assert.deepEqual(preview.after, ['纯爱']);
    assert.ok(preview.changes.some(c => c.includes('NTR')), preview.changes.join('；'));
});

// ============================================================
// 二、模型那一段
// ============================================================

const GREEN_HAT = '明明是绿帽癖的我，怎么会被辣妹逆推，这辈子好像只能搞纯爱了';

test('模型段：正文里的关联词判成描述 → 标题一个字不改', () => {
    // 这条是整套规范的核心用例。「绿帽癖」是在写人设，不是在给作品归类；
    // 真正表明类型的是句尾那个「只能搞纯爱了」。
    const tags = [tag('NTR', 'NTR')];
    const hits = pending(GREEN_HAT, tags);
    assert.ok(hits.length >= 2, '应该有绿帽和纯爱两处待定：'
        + hits.map(h => h.entry.word).join('、'));

    const j = answer(GREEN_HAT, tags, '纯爱', ['纯爱'], (w, i) => ({
        hit: i,
        action: '保留',
        why: w === '绿帽' ? '这是在描述主角的癖好，不是给作品归类' : '本篇就是纯爱',
    }));

    const p = plan(GREEN_HAT, tags, j);
    assert.equal(p.modelRejection, null,
        '不该被打回：' + JSON.stringify(p.modelRejection));
    assert.equal(p.newTitle, GREEN_HAT, '标题一个字都不该动');
    assert.equal(p.keepGroup, '纯爱');
    assert.equal(p.keepSource, 'llm');
    // TAG 从 NTR 改成纯爱
    assert.deepEqual(p.removeTagIds, ['tag_NTR']);
    assert.deepEqual(p.addTagIds, ['tag_纯爱']);
});

test('模型段：本体词在正文里拿「只是形容词」蒙混 → 打回', () => {
    // 老版本真实犯过的错。「纯爱」两个字只要留在标题里，搜它就一定命中，
    // 跟它在句子里当什么成分没关系。
    const title = '纯爱牛头人日记';
    const tags = [tag('NTR', 'NTR')];
    const j = answer(title, tags, 'NTR', ['NTR'], (w, i) => ({
        hit: i,
        action: '保留',
        why: '这几个字在句子里只是个形容词，不算分类标记',
    }));

    const p = plan(title, tags, j);
    assert.ok(p.modelRejection, '必须打回');
    assert.ok(p.modelRejection.remaining.some(m => m.includes('本体词')),
        p.modelRejection.remaining.join(' / '));
});

test('模型段：替换只动那几个字，句子结构不变', () => {
    const title = '这辈子好像只能搞纯爱了';
    const tags = [tag('NTR', 'NTR')];
    const j = answer(title, tags, 'NTR', ['NTR'], (w, i) => ({
        hit: i,
        action: '替换',
        replaceWith: 'NTR',
        why: '本篇是 NTR 作品',
    }));

    const p = plan(title, tags, j);
    assert.equal(p.modelRejection, null, JSON.stringify(p.modelRejection));
    assert.equal(p.newTitle, '这辈子好像只能搞NTR了');
});

test('模型段：删除会连带删掉整个小句', () => {
    const title = '某某的故事，这辈子好像只能搞纯爱了', tags = [tag('NTR', 'NTR')];
    const j = answer(title, tags, 'NTR', ['NTR'], (w, i) => ({
        hit: i, action: '删除', why: '本篇是 NTR 作品',
    }));

    const p = plan(title, tags, j);
    assert.equal(p.modelRejection, null, JSON.stringify(p.modelRejection));
    assert.ok(!p.newTitle.includes('纯爱'), p.newTitle);
    assert.ok(p.newTitle.startsWith('某某的故事'), p.newTitle);
});

test('模型段：替换词不在词表里 → 打回，不许自己编词', () => {
    const title = '这辈子好像只能搞纯爱了', tags = [tag('NTR', 'NTR')];
    const j = answer(title, tags, 'NTR', ['NTR'], (w, i) => ({
        hit: i,
        action: '替换',
        replaceWith: '一部温馨治愈的作品',
        why: '换个说法',
    }));

    const p = plan(title, tags, j);
    assert.ok(p.modelRejection, '必须打回');
    assert.ok(p.modelRejection.remaining.some(m => m.includes('词表')),
        p.modelRejection.remaining.join(' / '));
});

test('模型段：漏答一处 → 打回', () => {
    const title = '纯爱牛头人日记', tags = [tag('NTR', 'NTR')];
    const hits = pending(title, tags);
    assert.ok(hits.length >= 2);

    const j: Judgement = {
        verdict: 'NTR',
        verdictReason: '（测试用）',
        finalTagGroups: ['NTR'],
        // 只答第一处，故意漏掉其余
        decisions: [{ hit: 1, action: '删除', why: '本篇是 NTR' }],
        confidence: 'high',
    };

    const p = plan(title, tags, j);
    assert.ok(p.modelRejection, '必须打回');
    assert.ok(p.modelRejection.remaining.some(m => m.includes('没给处理方式')),
        p.modelRejection.remaining.join(' / '));
});

test('模型段：模型定的 TAG 自己互斥 → 打回', () => {
    const title = '某某的故事，纯爱牛头人日记', tags = [tag('NTR', 'NTR')];
    const j = answer(title, tags, 'NTR', ['NTR', '纯爱'], (w, i) => ({
        hit: i, action: '删除', why: '（测试用）',
    }));

    const p = plan(title, tags, j);
    assert.ok(p.modelRejection, '必须打回');
    assert.ok(p.modelRejection.remaining.some(m => m.includes('互斥')),
        p.modelRejection.remaining.join(' / '));
});

test('模型段：本论坛没有的 TAG → 打回', () => {
    const title = '纯爱牛头人日记', tags = [tag('NTR', 'NTR')];
    const j = answer(title, tags, '百破', ['百破'], (w, i) => ({
        hit: i, action: '删除', why: '（测试用）',
    }));

    const p = plan(title, tags, j);
    assert.ok(p.modelRejection, '必须打回');
    assert.ok(p.modelRejection.remaining.some(m => m.includes('百破')),
        p.modelRejection.remaining.join(' / '));
});

// ============================================================
// 三、人工那一段
// ============================================================

test('安全阀：只能删字不能加字', () => {
    assert.equal(isDeletionOnly('【纯爱 NTR】某某', '【NTR】某某'), true);
    assert.equal(isDeletionOnly('【NTL】某某', '【NTL】某某的新篇章'), false);
    // 归一化之后比，作者顺手把全角敲成半角不该被当成加字
    assert.equal(isDeletionOnly('【ＮＴＲ】某某', '【NTR】某某'), true);
});

test('作者手敲的标题：仍然要过一遍检测', () => {
    const tags = [tag('NTR', 'NTR')];
    const bad = validateNewTitle('【纯爱 NTR】某某', '【纯爱 NTR】某某', tags, compiled);
    assert.equal(bad.ok, false);

    const good = validateNewTitle('【纯爱 NTR】某某', '【NTR】某某', tags, compiled);
    assert.equal(good.ok, true, good.reason ?? '');
});

test('作者手敲的标题：正文里的冲突照样算数', () => {
    // 没有模型参与，不能给「把词挪进正文就没事」留后门
    const r = validateNewTitle(
        '纯爱牛头人日记', '纯爱牛头人日记', [tag('NTR', 'NTR')], compiled,
    );
    assert.equal(r.ok, false);
});

test('收尾清理：空括号和多余分隔符', () => {
    assert.equal(tidyTitle('【】某某的故事'), '某某的故事');
    assert.equal(tidyTitle('【/NTR/】某某'), '【NTR】某某');
    assert.equal(tidyTitle('【NTR//多路线】某某'), '【NTR/多路线】某某');
    assert.equal(tidyTitle('【 NTR 】某某'), '【NTR】某某');
});
