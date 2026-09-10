// src/modules/titleGuard/services/engine.test.ts
//
// 引擎层回归测试。用 Node 内置的 node:test，不引第三方依赖。
// 跑：  npm run test:guard
//
// 这里的词典**只是测试数据**——线上词典由管理组通过 /标题规范 词典 维护，代码不内置。

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize } from './normalizer';
import { segment, tokenizeMarker } from './segmenter';
import { compileConfig, detect } from './ruleEngine';
import type { AppliedTag, DictEntry, GuardConfig, RuleCode } from './types';

// ---------- 测试用词典 ----------

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

const TEST_CONFIG: GuardConfig = {
    dict: [
        // 纯爱组
        word('纯爱', '分类词', '纯爱'),
        word('真爱', '分类词', '纯爱'),
        word('1v1', '分类词', '纯爱'),
        // NTR 组
        word('NTR', '分类词', 'NTR'),
        word('NTRS', '分类词', 'NTR'),
        word('牛头人', '分类词', 'NTR'),
        word('绿帽', '分类词', 'NTR'),
        // NTL 组
        word('NTL', '分类词', 'NTL'),
        word('黄毛', '分类词', 'NTL'),
        // 逆NTR 是独立一组，不能算成 NTR
        word('逆NTR', '分类词', '逆NTR'),
        // 百合线
        word('百合', '分类词', '百合'),
        word('GL', '分类词', '百合'),
        word('百破', '分类词', '百破'),
        word('百合破坏', '分类词', '百破'),
        // 黑名单：有干净替代写法，必须换
        word('纯爱牛', '黑名单', 'NTR', { replaceTo: 'NTR' }),
        word('真爱牛', '黑名单', 'NTR', { replaceTo: 'NTR' }),
        word('纯爱NTR', '黑名单', 'NTR', { replaceTo: 'NTR' }),
        // 白名单：吃掉误判
        word('纯爱战士', '白名单', null),
        word('拉拉队', '白名单', null),
        // 中性标记
        word('多路线', '中性标记', null),
    ],
    // 三个维度分开配。这里刻意让「百合 / 百破」只有交叉互斥、没有关键字互斥，
    // 因为「百合破坏」本来就得写「百合」两个字，标题里并存完全正当。
    exclusiveSets: [
        { dimension: 'tag', groups: ['纯爱', 'NTR', 'NTL', '逆NTR'] },
        { dimension: 'word', groups: ['纯爱', 'NTR', 'NTL', '逆NTR'] },
    ],
    crossExclusions: [
        // 挂百合 TAG 就不许标题里写百破（百破自己没有 TAG，不能借百合的用）
        { tagGroup: '百合', wordGroup: '百破' },
        // 纯爱 / NTR / NTL / 逆NTR 两两交叉，双向
        { tagGroup: '纯爱', wordGroup: 'NTR' },
        { tagGroup: '纯爱', wordGroup: 'NTL' },
        { tagGroup: '纯爱', wordGroup: '逆NTR' },
        { tagGroup: 'NTR', wordGroup: '纯爱' },
        { tagGroup: 'NTR', wordGroup: 'NTL' },
        { tagGroup: 'NTR', wordGroup: '逆NTR' },
        { tagGroup: 'NTL', wordGroup: '纯爱' },
        { tagGroup: 'NTL', wordGroup: 'NTR' },
        { tagGroup: 'NTL', wordGroup: '逆NTR' },
        { tagGroup: '逆NTR', wordGroup: '纯爱' },
        { tagGroup: '逆NTR', wordGroup: 'NTR' },
        { tagGroup: '逆NTR', wordGroup: 'NTL' },
    ],
    // 社区既定规则：NTR > NTL > 纯爱
    groupPriority: { NTR: 40, '逆NTR': 30, NTL: 20, 纯爱: 10 },
    // 分词词库：测试里用几条来验证补词/拆词确实生效
    segmenterWords: [
        { word: '牛逼', action: '补词' },
        { word: '戴绿帽', action: '拆词' },
    ],
    multiRouteGroup: '多路线',
};

const compiled = compileConfig(TEST_CONFIG);

function tag(name: string, group: string | null): AppliedTag {
    return { tagId: `tag_${name}`, tagName: name, group };
}

function run(title: string, tags: AppliedTag[] = []) {
    return detect({ title, tags, config: TEST_CONFIG }, compiled);
}

function rules(title: string, tags: AppliedTag[] = []): RuleCode[] {
    return [...new Set(run(title, tags).violations.map(v => v.rule))].sort();
}

// ---------- 归一化 ----------

test('归一化：全角转半角、大小写统一', () => {
    assert.equal(normalize('【ＮＴＲ】').text, '【ntr】');
});

test('归一化：装饰符号不能成为绕过手段', () => {
    assert.equal(normalize('纯★爱').text, '纯爱');
    assert.deepEqual(rules('【纯★爱 NTR】某某'), ['T2']);
});

test('归一化：映射能还原回原文坐标', () => {
    const n = normalize('【ＮＴＲ】故事');
    // 归一化后 'ntr' 位于 [1,4)，原文里对应全角 ＮＴＲ 也在 [1,4)
    assert.equal(n.original.slice(n.srcStart[1], n.srcEnd[3]), 'ＮＴＲ');
});

// ---------- 结构切分 ----------

test('切分：方括号内是标记段', () => {
    const segs = segment(normalize('【ntr 长篇】某某的故事').text);
    assert.equal(segs[0].kind, 'marker');
    assert.equal(segs[0].text, 'ntr 长篇');
    assert.equal(segs[1].kind, 'body');
});

test('切分：书名号不是标记括号', () => {
    // 这是关键回归点。若把《》当标记括号，整个标题会变成标记段，
    // 「百合破坏」就会被判成 T2 直接改错，而不是交给 LLM 定性。
    const segs = segment(normalize('《真正的橘子味世界不允许百合破坏的存在！》').text);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].kind, 'body');
});

test('切分：引号也不是标记括号', () => {
    const segs = segment(normalize('「百合」的日常').text);
    assert.ok(segs.every(s => s.kind === 'body'));
});

test('切分：未闭合括号标记为结构不规范', () => {
    const segs = segment(normalize('【ntr 某某的故事').text);
    const marker = segs.find(s => s.kind === 'marker');
    assert.ok(marker);
    assert.equal(marker.wellFormed, false);
});

test('切分：首尾分隔结构也算标记段', () => {
    const segs = segment(normalize('NTR | 某某的故事').text, {
        isWholeDictWord: compiled.isWholeDictWord,
    });
    assert.equal(segs[0].kind, 'marker');
    assert.equal(segs[0].text, 'ntr');
});

// ---------- 中文词边界 ----------

test('分词闸：主体段里「百合花」不该命中「百合」', () => {
    // 字凑巧连在一起，其实分属两个词。这类误判占了主体段命中的将近一成，
    // 最典型的是「女同学/女同事」被当成百合。
    const r = run('绽放在深渊光芒之上的百合花');
    assert.ok(!r.matches.some(m => m.entry.word === '百合'),
        '百合花里的百合不该命中：' + r.matches.map(m => m.entry.word).join(','));
});

test('分词闸：标记段不过这道闸', () => {
    // 标记段是标签罗列不是句子，分词器的语言模型在那儿不适用，
    // 硬套会把作者明写的标签判没。
    const r = run('【百合花/纯爱】某某');
    assert.ok(r.matches.some(m => m.entry.word === '百合'), '标记段里的百合应照常命中');
});

test('分词闸：正当的主体段命中不受影响', () => {
    const r = run('纯爱牛头人日记');
    const words = r.matches.map(m => m.entry.word).sort();
    assert.deepEqual(words, ['牛头人', '纯爱']);
});

test('分词词库·补词：分词器不认识「牛逼」时会漏放「纯爱牛」', () => {
    // 不补词的话分词器切成「纯爱/牛/逼」，黑名单词「纯爱牛」正好横跨两个完整的词，
    // 边界检查放行 —— 于是「我说纯爱牛逼」被判成黑名单违规。
    const noTuning = { ...TEST_CONFIG, segmenterWords: [] };
    const c1 = compileConfig(noTuning);
    const r1 = detect({ title: '我说纯爱牛逼', tags: [], config: noTuning }, c1);
    assert.ok(r1.matches.some(m => m.entry.word === '纯爱牛'), '不补词时会误命中');

    // 补上「牛逼」，切成「纯爱/牛逼」，「纯爱牛」就横跨不过去了
    const r2 = run('我说纯爱牛逼');
    assert.ok(!r2.matches.some(m => m.entry.word === '纯爱牛'), '补词后不该再命中');
    assert.ok(r2.matches.some(m => m.entry.word === '纯爱'), '「纯爱」本身确实在，应照常命中');
});

test('分词词库·拆词：分词器把「戴绿帽」粘成一个词时会漏判', () => {
    // 不拆词的话「绿帽」抠不出来，真正的 NTR 反而漏掉
    const noTuning = { ...TEST_CONFIG, segmenterWords: [] };
    const c1 = compileConfig(noTuning);
    const r1 = detect({ title: '爱他就给他戴绿帽', tags: [], config: noTuning }, c1);
    assert.ok(!r1.matches.some(m => m.entry.word === '绿帽'), '不拆词时会漏判');

    const r2 = run('爱他就给他戴绿帽');
    assert.ok(r2.matches.some(m => m.entry.word === '绿帽'), '拆词后应命中');
});

// ---------- 匹配 ----------

test('匹配：绝不跨段边界', () => {
    // 「百合」在标记段末尾、「破坏」在主体段开头，跨段会拼出不存在的「百合破坏」
    const r = run('【治愈 百合】破坏了美好的一天');
    const words = r.matches.map(m => m.entry.word);
    assert.ok(words.includes('百合'));
    assert.ok(!words.includes('百合破坏'));
});

test('匹配：最大覆盖而非最左最长', () => {
    // 若用最左最长会先吃掉黑名单词「纯爱牛」、剩「头人日记」→ 误判成 T1
    const r = run('纯爱牛头人日记');
    const words = r.matches.map(m => m.entry.word).sort();
    assert.deepEqual(words, ['牛头人', '纯爱']);
});

test('匹配：黑名单词单独出现时正常命中', () => {
    const r = run('【纯爱牛】某某');
    assert.deepEqual(r.matches.map(m => m.entry.word), ['纯爱牛']);
});

test('匹配：白名单词吃掉误判', () => {
    assert.deepEqual(rules('纯爱战士的日常'), []);
    assert.deepEqual(rules('拉拉队的夏天'), []);
});

test('匹配：逆NTR 是独立一组，不算 NTR', () => {
    // 「逆NTR」若被拆成「NTR」，会和「纯爱」判成冲突
    const r = run('【逆NTR】某某');
    assert.deepEqual(r.matches.map(m => m.entry.word), ['逆ntr']);
    assert.deepEqual(rules('【逆NTR】某某'), []);
});

test('匹配：ASCII 词强制词边界', () => {
    // gl 不应命中 english，ntr 不应命中 ntrs 之外的乱码
    assert.deepEqual(rules('English Diary 纯爱'), []);
    const r = run('【NTRS】某某');
    assert.deepEqual(r.matches.map(m => m.entry.word), ['ntrs']);
});

// ---------- 规则判定 ----------

test('T1：黑名单词命中即违规', () => {
    const r = run('【纯爱牛】某某');
    const v = r.violations.find(x => x.rule === 'T1');
    assert.ok(v);
    assert.equal(v.needsLlm, false);
    assert.equal(v.hits[0].entry.replaceTo, 'NTR');
});

test('T2：标记段内互斥冲突，不需要 LLM', () => {
    for (const title of ['【NTL NTR】某某', '某某【NTL 纯爱】', '【NTL+NTR+多路线】某某']) {
        const r = run(title);
        const v = r.violations.find(x => x.rule === 'T2');
        assert.ok(v, `应判 T2: ${title}`);
        assert.equal(v.needsLlm, false);
    }
});

test('T2：多路线是中性标记，不能豁免冲突', () => {
    // 提案明文：【NTL NTR 多路线】依然违规
    assert.ok(rules('【NTL NTR 多路线】某某').includes('T2'));
    // 但主分类 + 多路线是合法的
    assert.deepEqual(rules('【NTR 多路线】某某'), []);
});

test('T2：跨标记段也算冲突', () => {
    // 从前只在单段内比对，两个分类分处两个标签区就被判成合规，等于漏放。
    // 标记段本来就是作者明写标签的地方，写在哪一个标签区里都是一次分类声明。
    const r = run('【纯爱】某某（NTR）');
    const v = r.violations.find(x => x.rule === 'T2');
    assert.ok(v, '跨标记段的互斥分类应判 T2');
    assert.deepEqual([...v.groups].sort(), ['NTR', '纯爱']);
    // 两边都是规规矩矩的括号，可以直接改
    assert.equal(v.needsLlm, false);
});

test('切分：括号嵌套取最外层', () => {
    // 反例来自真实标题。取最内层的话，整个【】会被里面的 () 撕成
    // 「主体 +(形容词)+ 主体 +(？)+ 主体」，写在标签区里的 ntr 反而掉进主体段。
    const title = '【摇滚主唱/前任文学/狗(形容词)/不洁/内含abo 伪骨 ntr(？)/音乐播放器】好的前任就应该像是死了一样，前任草草你呀';
    const segs = segment(normalize(title).text);
    const markers = segs.filter(s => s.kind === 'marker');
    assert.equal(markers.length, 1);
    assert.equal(markers[0].position, 'prefix');
    assert.ok(markers[0].text.includes('ntr(?)'), markers[0].text);

    // 段内切 token 时嵌套括号不拆开，删 ntr 不会剩一个孤零零的「(?)」
    const tokens = tokenizeMarker(markers[0]).map(t => t.text);
    assert.ok(tokens.includes('狗(形容词)'), tokens.join(' | '));
    assert.ok(tokens.includes('ntr(?)'), tokens.join(' | '));
});

test('切分：竖线夹出来的标签区', () => {
    const title = '【牛头人杯】|手枪卡/纯爱战神/NTR|身为ntr本子男主的我，在高维善意存在的帮助下将女主夺回';
    const segs = segment(normalize(title).text, { isWholeDictWord: compiled.isWholeDictWord });
    const markers = segs.filter(s => s.kind === 'marker');
    assert.equal(markers.length, 2);
    assert.equal(markers[1].text, '手枪卡/纯爱战神/ntr');
    // 被竖线夹住是很强的结构证据，冲突可以直接自动整改
    assert.equal(markers[1].confident, true);
    // 竖线本身不该留下来自成一段
    const bodies = segs.filter(s => s.kind === 'body');
    assert.equal(bodies.length, 1);
    assert.ok(bodies[0].text.startsWith('身为'), bodies[0].text);
});

test('切分：斜杠罗列 + 紧贴括号，认作标签区但不确信', () => {
    const title = '8.31补全所有立绘/纯爱人设阶段已加入【二创/古风/武侠/NTL/母猪】作为三流武者的你通过下蛊将武林各色美女变成母猪';
    const segs = segment(normalize(title).text, { isWholeDictWord: compiled.isWholeDictWord });
    const markers = segs.filter(s => s.kind === 'marker');
    assert.equal(markers.length, 2);
    assert.equal(markers[0].text, '8.31补全所有立绘/纯爱人设阶段已加入');
    // 只是形状像标签清单，没有括号或竖线兜底，不确信
    assert.equal(markers[0].confident, false);
    assert.equal(markers[1].confident, true);

    // 纯爱 与 NTL 分处两个标签区 → T2，但因为有不确信的标签区，先让 LLM 定性
    const r = run(title);
    const v = r.violations.find(x => x.rule === 'T2');
    assert.ok(v);
    assert.deepEqual([...v.groups].sort(), ['NTL', '纯爱']);
    assert.equal(v.needsLlm, true);
});

test('切分：光有斜杠但没有结构依据，仍算句子', () => {
    // 形状上勉强像标签清单，但孤零零杵在那儿，没有任何结构说明作者在标标签
    const segs = segment(normalize('他不是纯爱战神/而是ntr之王').text, {
        isWholeDictWord: compiled.isWholeDictWord,
    });
    assert.ok(segs.every(s => s.kind === 'body'), JSON.stringify(segs.map(s => s.kind)));
});

test('切分：单侧竖线且不是词典词，不算标签区', () => {
    const segs = segment(normalize('NTR | 某某的故事').text, {
        isWholeDictWord: compiled.isWholeDictWord,
    });
    assert.equal(segs[0].kind, 'marker');
    assert.equal(segs[1].kind, 'body');
    assert.equal(segs[1].text.trim(), '某某的故事');
});

test('G1：TAG 互斥', () => {
    const r = run('某某的故事', [tag('纯爱', '纯爱'), tag('NTR', 'NTR')]);
    const v = r.violations.find(x => x.rule === 'G1');
    assert.ok(v);
    assert.equal(v.needsLlm, false);
    assert.equal(v.tagIds.length, 2);
});

// ---------- 两个基准样例（设计文档 §5.2） ----------

test('例 A：《真正的橘子味世界不允许百合破坏的存在！》+ 百合 TAG → 走 LLM，不直接改', () => {
    const r = run('《真正的橘子味世界不允许百合破坏的存在！》', [tag('百合', '百合')]);

    // 必须落在主体段，不能被当成标记段
    const hit = r.matches.find(m => m.entry.word === '百合破坏');
    assert.ok(hit, '应命中「百合破坏」');
    assert.equal(hit.segmentKind, 'body');

    // 百合和百破在关键字层面不互斥，所以标题本身没问题。
    // 该管的是交叉互斥：挂了百合 TAG，标题里就不该出现百破。
    const t4 = r.violations.find(v => v.rule === 'T4');
    assert.ok(t4, '应触发交叉互斥');
    // 命中落在主体段，必须先定性，不能直接动手
    assert.equal(t4.needsLlm, true);

    // 关键：没有任何一条能直接动手的违规
    assert.ok(r.violations.every(v => v.needsLlm), '例 A 不得存在可直接执行的违规');
});

test('例 B：《纯爱牛头人日记》→ 判成纯爱/NTR 冲突，走 LLM', () => {
    const r = run('纯爱牛头人日记', [tag('NTR', 'NTR')]);

    // 不能被吃成黑名单词「纯爱牛」
    assert.ok(!r.violations.some(v => v.rule === 'T1'), '不应误判成 T1 黑名单');

    const t3 = r.violations.find(v => v.rule === 'T3');
    assert.ok(t3, '应触发 T3');
    assert.equal(t3.needsLlm, true);
    assert.deepEqual([...t3.groups].sort(), ['NTR', '纯爱']);
});

test('例 A 的对照组：标记段里写百合破坏 + 百合 TAG → 可直接判', () => {
    const r = run('【百合破坏】某某', [tag('百合', '百合')]);
    const t4 = r.violations.find(v => v.rule === 'T4');
    assert.ok(t4);
    assert.equal(t4.needsLlm, false, '标记段里的分类标记无需 LLM 定性');
    assert.deepEqual(t4.groups, ['百破', '百合'], 'groups 固定是 [关键字侧, TAG 侧]');
});

test('百合和百破的关键字并存不算冲突', () => {
    // 没挂百合 TAG 时，标题里同时出现百合和百破完全正当
    const r = run('【百合/百合破坏】某某', []);
    assert.deepEqual(r.violations, [], JSON.stringify(r.violations.map(v => v.message)));
});

test('TAG 互斥和关键字互斥是两套配置', () => {
    // 这份测试词表里两个维度配得一样，所以两边都该报
    const both = run('【纯爱/NTR】某某', [tag('纯爱', '纯爱'), tag('NTR', 'NTR')]);
    assert.ok(both.violations.some(v => v.rule === 'T2'), '关键字互斥应报 T2');
    assert.ok(both.violations.some(v => v.rule === 'G1'), 'TAG 互斥应报 G1');

    // 只有 TAG 打架、标题干净 → 只报 G1
    const tagOnly = run('某某的故事', [tag('纯爱', '纯爱'), tag('NTR', 'NTR')]);
    assert.ok(tagOnly.violations.some(v => v.rule === 'G1'));
    assert.ok(!tagOnly.violations.some(v => v.rule === 'T2' || v.rule === 'T4'));
});

// ---------- 合规标题不应产生噪音 ----------

test('合规标题不报违规', () => {
    const clean: [string, AppliedTag[]][] = [
        ['【NTR】某某的故事', [tag('NTR', 'NTR')]],
        ['【NTL 多路线】某某', [tag('NTL', 'NTL')]],
        ['【百合】某某的日常', [tag('百合', '百合')]],
        ['某某的故事（完结）', [tag('纯爱', '纯爱')]],
        ['纯爱战士的日常', [tag('纯爱', '纯爱')]],
    ];
    for (const [title, tags] of clean) {
        assert.deepEqual(rules(title, tags), [], `不该报违规: ${title}`);
    }
});
