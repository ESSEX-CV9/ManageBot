// src/modules/titleGuard/services/engine.test.ts
//
// 引擎层回归测试。用 Node 内置的 node:test，不引第三方依赖。
// 跑：  npm run test:guard
//
// 这里的词典**只是测试数据**——线上词典由管理组通过 /标题规范 词表 维护，代码不内置。
// 不过互斥关系是照社区现行规则抄的，因为这套规则的几个关键点
//（NTR 和 NTL 在 TAG 层互斥、在关键字层兼容）只有配对了才测得出来。

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalize } from './normalizer';
import { segment, tokenizeMarker } from './segmenter';
import { compileConfig, detect, declarationOf, tierOf } from './ruleEngine';
import type { AppliedTag, Arbiter, DictEntry, GuardConfig, RuleCode } from './types';

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
        // 默认关联词。本体词就那六个，下面逐个标出来
        tier: '关联',
        scope: '全标题',
        replaceTo: null,
        asciiBoundary: /^[a-z0-9]+$/i.test(w),
        ...extra,
    };
}

/** 本体词：词面就是大家打进搜索框的那几个字 */
const core = (w: string, group: string) => word(w, '分类词', group, { tier: '本体' });

const TEST_CONFIG: GuardConfig = {
    dict: [
        // 纯爱组
        core('纯爱', '纯爱'),
        word('纯爱向', '分类词', '纯爱'),
        word('真爱', '分类词', '纯爱'),
        word('1v1', '分类词', '纯爱'),
        // NTR 组
        core('NTR', 'NTR'),
        word('NTRS', '分类词', 'NTR'),
        word('牛头人', '分类词', 'NTR'),
        word('绿帽', '分类词', 'NTR'),
        word('出轨', '分类词', 'NTR'),
        word('苦主', '分类词', 'NTR'),
        // 逆NTR 归在 NTR 组里，是兼容词，自己没有 TAG。
        // 单列一条是为了让最大覆盖吃掉它，别被拆成一个裸的 NTR
        word('逆NTR', '分类词', 'NTR'),
        // NTL 组
        core('NTL', 'NTL'),
        word('黄毛', '分类词', 'NTL'),
        // 百合线
        core('百合', '百合'),
        word('GL', '分类词', '百合'),
        word('女同', '分类词', '百合'),
        core('百破', '百破'),
        core('百合破坏', '百破'),
        // 污染词：词面里裹着别组的受保护关键字，必须换
        word('纯爱牛', '黑名单', 'NTR', { replaceTo: 'NTR' }),
        word('真爱牛', '黑名单', 'NTR', { replaceTo: 'NTR' }),
        word('纯爱NTR', '黑名单', 'NTR', { replaceTo: 'NTR' }),
        // 白名单：吃掉误判
        word('纯爱战士', '白名单', null),
        word('拉拉队', '白名单', null),
        // 中性标记
        word('多路线', '中性标记', null),
    ],

    // 三个维度分开配，这是整套规则最容易配错的地方。
    //
    // 关键字维度必须写成「纯爱/NTR」和「纯爱/NTL」**两组**，不能合成一组三个——
    // 因为 NTR 和 NTL 在关键字层面是兼容的（一部作品可以两样都有，
    // 标题里两个词并排写没问题），只有纯爱分别和它们互斥。
    // 合成一组的话，NTR 和 NTL 也会被判成互斥，那是错的。
    //
    // 百合 / 百破 在关键字层面完全不互斥（「百合破坏」本来就得写百合两个字），
    // 所以这儿一条都不配，它们只在交叉互斥里出现。
    exclusiveSets: [
        { dimension: 'tag', groups: ['纯爱', 'NTR', 'NTL'] },
        { dimension: 'word', groups: ['纯爱', 'NTR'] },
        { dimension: 'word', groups: ['纯爱', 'NTL'] },
    ],

    // 交叉互斥有方向，反过来不一定成立。
    // 注意这里**没有**「NTR TAG × NTL 词」和「NTL TAG × NTR 词」——不写就是兼容。
    crossExclusions: [
        { tagGroup: '纯爱', wordGroup: 'NTR' },
        { tagGroup: '纯爱', wordGroup: 'NTL' },
        { tagGroup: 'NTR', wordGroup: '纯爱' },
        { tagGroup: 'NTL', wordGroup: '纯爱' },
        // 挂百合 TAG 就不许标题里写百破（百破自己没有 TAG）
        { tagGroup: '百合', wordGroup: '百破' },
    ],

    // 社区既定的 TAG 保留顺序：NTR > NTL > 纯爱
    groupPriority: { NTR: 40, NTL: 20, 纯爱: 10 },

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

/** 这条标题判出来的「规则 → 谁裁决」，路由测试全靠它 */
function routing(title: string, tags: AppliedTag[] = []): [RuleCode, Arbiter][] {
    return run(title, tags).violations
        .map(v => [v.rule, v.arbiter] as [RuleCode, Arbiter])
        .sort();
}

// ---------- 归一化 ----------

test('归一化：全角转半角、大小写统一', () => {
    assert.equal(normalize('【ＮＴＲ】').text, '【ntr】');
});

test('归一化：装饰符号不能成为绕过手段', () => {
    assert.equal(normalize('纯★爱').text, '纯爱');
    assert.deepEqual(rules('【纯★爱 NTR】某某'), ['W']);
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
    // 「百合破坏」就会被当成作者盖章、由程序直接动手，而不是交给模型定性。
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
    // 被竖线夹住是很强的结构证据，作者确实在贴标签
    assert.equal(markers[1].confident, true);
    // 竖线本身不该留下来自成一段
    const bodies = segs.filter(s => s.kind === 'body');
    assert.equal(bodies.length, 1);
    assert.ok(bodies[0].text.startsWith('身为'), bodies[0].text);
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
    // 不补词的话分词器切成「纯爱/牛/逼」，污染词「纯爱牛」正好横跨两个完整的词，
    // 边界检查放行 —— 于是「我说纯爱牛逼」被判成污染词违规。
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
    // 若用最左最长会先吃掉污染词「纯爱牛」、剩「头人日记」→ 误判成污染词
    const r = run('纯爱牛头人日记');
    const words = r.matches.map(m => m.entry.word).sort();
    assert.deepEqual(words, ['牛头人', '纯爱']);
});

test('匹配：污染词单独出现时正常命中', () => {
    const r = run('【纯爱牛】某某');
    assert.deepEqual(r.matches.map(m => m.entry.word), ['纯爱牛']);
});

test('匹配：白名单词吃掉误判', () => {
    assert.deepEqual(rules('纯爱战士的日常'), []);
    assert.deepEqual(rules('拉拉队的夏天'), []);
});

test('匹配：逆NTR 不会被拆成裸的 NTR', () => {
    // 「逆NTR」若被拆开，剩下的 NTR 会跟纯爱撞出一条不存在的冲突
    const r = run('【逆NTR】某某');
    assert.deepEqual(r.matches.map(m => m.entry.word), ['逆ntr']);
    assert.deepEqual(rules('【逆NTR】某某'), []);
});

test('匹配：逆NTR 和 NTR 兼容（同属 NTR 组）', () => {
    assert.deepEqual(rules('【NTR/逆NTR】某某'), []);
});

test('匹配：ASCII 词强制词边界', () => {
    // gl 不应命中 english，ntr 不应命中 ntrs 之外的乱码
    assert.deepEqual(rules('English Diary 纯爱'), []);
    const r = run('【NTRS】某某');
    assert.deepEqual(r.matches.map(m => m.entry.word), ['ntrs']);
});

// ============================================================
// 词档
// ============================================================

test('词档：本体词就那几个，其余都是关联词', () => {
    const r = run('【纯爱】戴绿帽的日子');
    const byWord = new Map(r.matches.map(m => [m.entry.word, tierOf(m)]));
    assert.equal(byWord.get('纯爱'), '本体');
    assert.equal(byWord.get('绿帽'), '关联');
});

// ============================================================
// 声明力：标签区 vs 标题主体
// ============================================================

test('声明力：明写在标签区里的算声明', () => {
    const r = run('【纯爱】某某的故事');
    const hit = r.matches.find(m => m.entry.word === '纯爱')!;
    assert.equal(declarationOf(hit, r.segments), '声明');
});

test('声明力：后缀标签区和前缀一视同仁', () => {
    // 社区里两种写法都很常见，没理由区别对待
    const r = run('某某的故事[纯爱/救赎]');
    const hit = r.matches.find(m => m.entry.word === '纯爱')!;
    assert.equal(hit.segmentKind, 'marker');
    assert.equal(declarationOf(hit, r.segments), '声明');
});

test('声明力：落在主体里的一律待定', () => {
    const r = run('这辈子好像只能搞纯爱了');
    const hit = r.matches.find(m => m.entry.word === '纯爱')!;
    assert.equal(declarationOf(hit, r.segments), '待定');
});

// ============================================================
// 路由：冲突归谁裁决
// ============================================================

test('路由：冲突全在标签区里就成立 → 程序判', () => {
    for (const title of ['【NTL 纯爱】某某', '某某【NTL+纯爱+多路线】', '【纯爱】某某（NTR）']) {
        const v = run(title).violations.find(x => x.rule === 'W');
        assert.ok(v, `应判 W: ${title}`);
        assert.equal(v.arbiter, '程序', title);
    }
});

test('路由：后缀标签区里的冲突同样由程序判', () => {
    const v = run('某某的故事[纯爱/NTR]').violations.find(x => x.rule === 'W');
    assert.ok(v);
    assert.equal(v.arbiter, '程序');
});

test('路由：跨段冲突（标签区 × 主体）→ 交给模型', () => {
    // 标签区里只凑齐了纯爱一个组，另一个组只在正文里出现，
    // 程序不能在正文里下结论
    const v = run('【纯爱】某某其实是ntr的故事').violations.find(x => x.rule === 'W');
    assert.ok(v);
    assert.equal(v.arbiter, 'LLM');
});

test('路由：冲突全在主体里 → 交给模型', () => {
    const v = run('纯爱牛头人日记').violations.find(x => x.rule === 'W');
    assert.ok(v);
    assert.equal(v.arbiter, 'LLM');
    assert.deepEqual([...v.groups].sort(), ['NTR', '纯爱']);
});

test('路由：靠排版猜出来的标签区不算盖章，还是交给模型', () => {
    const title = '8.31补全所有立绘/纯爱人设阶段已加入【二创/古风/武侠/NTL/母猪】作为三流武者的你';
    const segs = segment(normalize(title).text, { isWholeDictWord: compiled.isWholeDictWord });
    const markers = segs.filter(s => s.kind === 'marker');
    // 前一个只是形状像标签清单，没有括号或竖线兜底，不确信
    assert.equal(markers[0].confident, false);
    assert.equal(markers[1].confident, true);

    const v = run(title).violations.find(x => x.rule === 'W');
    assert.ok(v);
    assert.deepEqual([...v.groups].sort(), ['NTL', '纯爱']);
    assert.equal(v.arbiter, 'LLM');
});

test('路由：某个组在别处盖过章，也不能替主体里那一处作答', () => {
    // 关键回归点。老版本有条「这个组坐实过就不用问了」的捷径——
    // 可坐实的是**这个组**，不是**这一处命中**。
    // 【NTR】盖了章没错，但正文里那个「纯爱」是不是在归类，仍然没有答案。
    const v = run('【NTR】这辈子好像只能搞纯爱了').violations.find(x => x.rule === 'W');
    assert.ok(v);
    assert.equal(v.arbiter, 'LLM');
});

test('路由：TAG 之间打架永远由程序判', () => {
    const v = run('某某的故事', [tag('纯爱', '纯爱'), tag('NTR', 'NTR')]).violations
        .find(x => x.rule === 'G');
    assert.ok(v);
    assert.equal(v.arbiter, '程序');
    assert.equal(v.tagIds.length, 2);
});

test('路由：污染词照样按位置分流', () => {
    const inMarker = run('【纯爱牛】某某').violations.find(x => x.rule === 'B');
    assert.ok(inMarker);
    assert.equal(inMarker.arbiter, '程序');
    assert.equal(inMarker.hits[0].entry.replaceTo, 'NTR');
});

// ============================================================
// 互斥关系本身
// ============================================================

test('NTR 和 NTL：TAG 层互斥，关键字层兼容', () => {
    // 这是整套规则最容易配错、也最容易理解错的一条
    assert.deepEqual(rules('【NTR/NTL】某某'), [], '关键字层面两个词可以并排写');

    const v = run('某某的故事', [tag('NTR', 'NTR'), tag('NTL', 'NTL')]).violations
        .find(x => x.rule === 'G');
    assert.ok(v, 'TAG 层面只能挂一个');
});

test('交叉互斥有方向：NTR TAG 和 NTL 关键字兼容', () => {
    assert.deepEqual(rules('【NTL】某某', [tag('NTR', 'NTR')]), [],
        '规则里没写这一条，没写就是兼容，不许自己加戏');
    assert.deepEqual(rules('【NTR】某某', [tag('NTL', 'NTL')]), []);
});

test('交叉互斥：纯爱和 NTR/NTL 两个方向都禁', () => {
    assert.ok(rules('【NTR】某某', [tag('纯爱', '纯爱')]).includes('X'));
    assert.ok(rules('【纯爱】某某', [tag('NTR', 'NTR')]).includes('X'));
    assert.ok(rules('【NTL】某某', [tag('纯爱', '纯爱')]).includes('X'));
    assert.ok(rules('【纯爱】某某', [tag('NTL', 'NTL')]).includes('X'));
});

test('多路线是中性标记，不能豁免冲突', () => {
    assert.ok(rules('【NTL 纯爱 多路线】某某').includes('W'));
    // 但主分类 + 多路线是合法的
    assert.deepEqual(rules('【NTR 多路线】某某'), []);
});

// ============================================================
// 百合 / 百破
// ============================================================

test('百合和百破的关键字并存不算冲突', () => {
    // 「百合破坏」本来就得写百合两个字，没挂百合 TAG 时完全正当
    const r = run('【百合/百合破坏】某某', []);
    assert.deepEqual(r.violations, [], JSON.stringify(r.violations.map(v => v.message)));
});

test('百破关键字 × 百合 TAG：写在标签区里 → 程序判，标题不动', () => {
    const r = run('【百合破坏】某某', [tag('百合', '百合')]);
    const v = r.violations.find(x => x.rule === 'X');
    assert.ok(v);
    assert.equal(v.arbiter, '程序');
    assert.deepEqual(v.groups, ['百破', '百合'], 'groups 固定是 [关键字侧, TAG 侧]');
});

test('百破关键字 × 百合 TAG：落在正文里 → 交给模型', () => {
    const r = run('《真正的橘子味世界不允许百合破坏的存在！》', [tag('百合', '百合')]);

    // 必须落在主体段，不能被书名号骗成标记段
    const hit = r.matches.find(m => m.entry.word === '百合破坏');
    assert.ok(hit, '应命中「百合破坏」');
    assert.equal(hit.segmentKind, 'body');

    const v = r.violations.find(x => x.rule === 'X');
    assert.ok(v, '应触发交叉互斥');
    assert.equal(v.arbiter, 'LLM');

    // 关键：没有任何一条能让程序直接动手的违规
    assert.ok(r.violations.every(x => x.arbiter === 'LLM'), '不得存在程序可直接执行的违规');
});

// ============================================================
// TAG 互斥和关键字互斥是两套配置
// ============================================================

test('两套配置各管各的', () => {
    const both = run('【纯爱/NTR】某某', [tag('纯爱', '纯爱'), tag('NTR', 'NTR')]);
    assert.ok(both.violations.some(v => v.rule === 'W'), '关键字互斥应报 W');
    assert.ok(both.violations.some(v => v.rule === 'G'), 'TAG 互斥应报 G');

    // 只有 TAG 打架、标题干净 → 只报 G
    const tagOnly = run('某某的故事', [tag('纯爱', '纯爱'), tag('NTR', 'NTR')]);
    assert.deepEqual(routing('某某的故事', [tag('纯爱', '纯爱'), tag('NTR', 'NTR')]),
        [['G', '程序']]);
    assert.ok(!tagOnly.violations.some(v => v.rule === 'W' || v.rule === 'X'));
});

// ============================================================
// 合规标题不应产生噪音
// ============================================================

test('合规标题不报违规', () => {
    const clean: [string, AppliedTag[]][] = [
        ['【NTR】某某的故事', [tag('NTR', 'NTR')]],
        ['【NTL 多路线】某某', [tag('NTL', 'NTL')]],
        ['【百合】某某的日常', [tag('百合', '百合')]],
        ['某某的故事（完结）', [tag('纯爱', '纯爱')]],
        ['纯爱战士的日常', [tag('纯爱', '纯爱')]],
        ['某某的故事[NTR/NTL]', [tag('NTR', 'NTR')]],
    ];
    for (const [title, tags] of clean) {
        assert.deepEqual(rules(title, tags), [], `不该报违规: ${title}`);
    }
});
