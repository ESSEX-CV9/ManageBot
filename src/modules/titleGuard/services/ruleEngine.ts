// src/modules/titleGuard/services/ruleEngine.ts
//
// ④ 规则判定。纯函数：标题 + TAG + 配置 → 违规清单。
//
// ============================================================
// 这一层只回答两个问题：撞了没有，以及归谁管。
// ============================================================
//
// 四种互斥关系（RuleCode）：
//   W  关键字 × 关键字    标题里同时出现互斥分类组的词
//   G  TAG × TAG          帖子同时挂了互斥的 TAG
//   X  TAG × 关键字       挂着某个 TAG，标题里却出现它不兼容的关键字（有方向）
//   B  污染词             词面含别组受保护关键字的词，如「纯爱牛」含「纯爱」
//
// 归谁管（Arbiter），只看一件事：**这个冲突靠哪些命中才成立。**
//
//   全靠明写标签区里的词就能成立  → 程序。作者亲手把词放进方括号，那就是在盖章，
//                                    没什么可问的，按保留顺序直接改。
//   非得搭上标题主体里的词才成立  → LLM。**程序在主体里一概不下结论。**
//
// 第二条是硬规矩，没有例外。一句话里的「绿帽」到底是在给作品归类，
// 还是在描述主角的癖好，光看标题的字面切不开——
//   明明是绿帽癖的我，怎么会被辣妹逆推，这辈子好像只能搞纯爱了
// 这是一部纯爱作品。程序要是在这儿抢答，就会把它改成 NTR，
// 既冤枉了作者，又污染了 NTR 的搜索结果。
//
// 词档（本体 / 关联）**不参与路由**，它只在送进模型之后起作用：
// 本体词在主体里从严（写了「纯爱」两个字，搜索就一定命中，没得辩），
// 关联词在主体里结合上下文（它没污染任何一个受保护关键字）。
// 见 llmJudge 里的提示词。

import { normalize } from './normalizer';
import { segment } from './segmenter';
import { compileDict, makeIsWholeDictWord, match, type CompiledDict } from './matcher';
import type {
    AppliedTag,
    Arbiter,
    Declaration,
    DetectInput,
    DetectResult,
    GroupId,
    GuardConfig,
    Match,
    Segment,
    Violation,
    WordTier,
} from './types';

/** 预编译一次配置，反复检测同一批帖子时复用 */
export interface CompiledConfig {
    dict: CompiledDict;
    isWholeDictWord: (text: string) => boolean;
    /**
     * TAG 维度：分类组 → 它所属的**每一个**互斥集合的下标。
     * 一个组可以同时属于好几个集合，见 compileConfig 里的说明。
     */
    tagGroupToSet: Map<GroupId, number[]>;
    /** 关键字维度：同上 */
    wordGroupToSet: Map<GroupId, number[]>;
    /** 交叉互斥：TAG 分类组 → 这个 TAG 在场时标题里不许出现的关键字分类组 */
    crossByTag: Map<GroupId, Set<GroupId>>;
    raw: GuardConfig;
}

export function compileConfig(config: GuardConfig): CompiledConfig {
    const dict = compileDict(config.dict, config.segmenterWords ?? []);
    const tagGroupToSet = new Map<GroupId, number[]>();
    const wordGroupToSet = new Map<GroupId, number[]>();

    // 一个分类组**可以同时属于好几个互斥集合**，这不是配错了，是必须支持的配法。
    //
    // 现行规则就是这样：关键字维度配的是「纯爱/NTR」和「纯爱/NTL」两组，
    // 而不是「纯爱/NTR/NTL」一组——因为 NTR 和 NTL 在关键字层面是兼容的
    //（一部作品可以两样都有，标题里两个词并排写没问题），
    // 只有纯爱分别和它们互斥。这两种配法完全不是一回事。
    config.exclusiveSets.forEach((set, index) => {
        const target = set.dimension === 'tag' ? tagGroupToSet : wordGroupToSet;
        for (const group of set.groups) {
            const list = target.get(group);
            if (list) { if (!list.includes(index)) list.push(index); }
            else target.set(group, [index]);
        }
    });

    const crossByTag = new Map<GroupId, Set<GroupId>>();
    for (const c of config.crossExclusions ?? []) {
        let banned = crossByTag.get(c.tagGroup);
        if (!banned) { banned = new Set(); crossByTag.set(c.tagGroup, banned); }
        banned.add(c.wordGroup);
    }

    return {
        dict,
        isWholeDictWord: makeIsWholeDictWord(dict),
        tagGroupToSet,
        wordGroupToSet,
        crossByTag,
        raw: config,
    };
}

/**
 * 多个分类组里挑优先级最高的。社区既定规则：NTR > NTL > 纯爱。
 * 未配优先级的组按 0 算；全都没配就返回 null（交给上层转人工）。
 */
export function pickByPriority(groups: GroupId[], config: GuardConfig): GroupId | null {
    if (groups.length === 0) return null;
    if (groups.length === 1) return groups[0];

    let best: GroupId | null = null;
    let bestScore = -Infinity;
    let tied = false;

    for (const g of groups) {
        const score = config.groupPriority?.[g] ?? 0;
        if (score > bestScore) { best = g; bestScore = score; tied = false; }
        else if (score === bestScore) tied = true;
    }

    // 全部并列（比如都没配优先级）就别硬猜，交给人工
    return tied && bestScore === 0 ? null : best;
}

// ============================================================
// 命中的两个属性：声明力 和 词档
// ============================================================

/**
 * 这处命中算不算「作者在盖章」。
 *
 *   声明 —— 写在明写的标签区里（规规矩矩的方括号、竖线夹住的区块）。
 *   待定 —— 落在标题主体里，或落在靠排版猜出来的区块里。程序不下结论。
 *
 * 注意后缀和前缀一视同仁：`某某某[纯爱/救赎]` 和 `【纯爱】某某某`
 * 都是作者在贴标签，没理由区别对待。
 */
export function declarationOf(m: Match, segments: Segment[]): Declaration {
    const seg = segments[m.segmentIndex];
    return m.segmentKind === 'marker' && seg?.confident ? '声明' : '待定';
}

/** 词档。词典里没标的一律按「关联」算——本体词是明确列举的那六个 */
export function tierOf(m: Match): WordTier {
    return m.entry.tier === '本体' ? '本体' : '关联';
}

/** 参与互斥判定的命中：分类词或污染词，且映射到了分类组 */
export function classifyingGroup(m: Match): GroupId | null {
    if (m.entry.kind === '白名单' || m.entry.kind === '中性标记') return null;
    return m.entry.group;
}

/**
 * 要拿去问模型的那些命中，**编号顺序的唯一来源**。
 *
 * 模型是按编号回答「这处怎么处理」的，所以拼提示词的地方和解析回答的地方
 * 必须用同一份列表。各写各的迟早错位——错位的后果是删错词。
 */
export function judgeHitsOf(result: DetectResult): Match[] {
    return result.matches.filter(m => classifyingGroup(m));
}

// ============================================================
// 检测
// ============================================================

function tagGroups(tags: AppliedTag[]): Map<GroupId, AppliedTag[]> {
    const result = new Map<GroupId, AppliedTag[]>();
    for (const t of tags) {
        if (!t.group) continue;
        const list = result.get(t.group);
        if (list) list.push(t);
        else result.set(t.group, [t]);
    }
    return result;
}

/** 一句话说清某个组的词都出现在哪儿，管理组一眼能看出是不是跨段撞的 */
function whereOf(hits: Match[], segments: Segment[]): string {
    const kinds = new Set(hits.map(
        h => declarationOf(h, segments) === '声明' ? '标签区' : '正文'));
    return [...kinds].join('和');
}

/**
 * 把标题命中按「所属的**关键字**互斥集合」分桶，返回集合下标 → 该集合内出现的不同组。
 * 只看关键字维度——TAG 之间互不互斥是另一回事，跟标题里写了什么无关。
 */
function wordConflicts(
    matches: Match[],
    compiled: CompiledConfig,
): Map<number, Map<GroupId, Match[]>> {
    const result = new Map<number, Map<GroupId, Match[]>>();

    for (const m of matches) {
        const group = classifyingGroup(m);
        if (!group) continue;

        // 一个组可能同属好几个集合，每个都要进——
        // 「纯爱」既和 NTR 互斥又和 NTL 互斥，两边的冲突都得报出来
        for (const setIndex of compiled.wordGroupToSet.get(group) ?? []) {
            let bucket = result.get(setIndex);
            if (!bucket) { bucket = new Map(); result.set(setIndex, bucket); }

            const list = bucket.get(group);
            if (list) list.push(m);
            else bucket.set(group, [m]);
        }
    }

    return result;
}

/**
 * 检测一个帖子的标题与 TAG。
 */
export function detect(input: DetectInput, precompiled?: CompiledConfig): DetectResult {
    const compiled = precompiled ?? compileConfig(input.config);

    const normalized = normalize(input.title);
    const segments = segment(normalized.text, { isWholeDictWord: compiled.isWholeDictWord });
    const matches = match(segments, compiled.dict);

    const violations: Violation[] = [];
    const declared = (m: Match) => declarationOf(m, segments) === '声明';

    // ---------- B 污染词 ----------
    //
    // 「纯爱牛」这种词的特殊之处不是它的意思，而是它的**字面**：
    // 它含着「纯爱」两个字，所以搜「纯爱」的人会搜到一部 NTR 作品——直接污染。
    //
    // 但它照样按位置分流，没有例外：
    //   写在标签区里 → 作者自己盖的章，程序直接判，强制换成 NTR。
    //   落在主体里   → 送模型，因为字面匹配很容易咬错。作者写的可能是
    //                  「纯爱牛娘」这种被切断的词，也可能是「纯爱牛逼」这种大白话，
    //                  照污染词表硬换会把好好一句话改成病句。这两种都得读过首楼才分得清。
    for (const m of matches) {
        if (m.entry.kind !== '黑名单') continue;
        violations.push({
            rule: 'B',
            message: `标题含污染词「${m.entry.word}」`
                + (m.entry.replaceTo ? `，应改为「${m.entry.replaceTo}」` : '，应删除')
                + (declared(m) ? '' : '（在正文里，待定性）'),
            hits: [m],
            groups: m.entry.group ? [m.entry.group] : [],
            tagIds: [],
            arbiter: declared(m) ? '程序' : 'LLM',
        });
    }

    // ---------- W 关键字 × 关键字 ----------
    //
    // **算的是整条标题，不分段。** 搜索污染不看那两个字分别待在哪儿：
    //   在这个充满NTR的黄游世界里由她来守护你[纯爱/救赎/手枪卡]
    // NTR 在正文、纯爱在后缀标签区，搜「纯爱」照样会搜到这部 NTR 作品。
    //
    // 位置只决定归谁管，判据是「这个冲突靠哪些命中才成立」：
    //   光看标签区里的词，两个互斥组就已经都齐了 → 程序。
    //   标签区里只齐了一个组，另一个组只在主体里出现 → LLM。
    //     跨段冲突走的就是这一支。
    //   两个组都只在主体里 → 也是 LLM。
    //
    // 为什么不能像以前那样「这个组在别处标签区坐实过，主体里的就不用问了」：
    // 坐实的是**这个组**，不是**这一处命中**。
    //   【NTR】…这辈子只能搞纯爱了
    // NTR 在标签区坐实了没错，但主体里那个「纯爱」是不是在归类，仍然没有答案。
    for (const [, byGroup] of wordConflicts(matches, compiled)) {
        if (byGroup.size < 2) continue;

        const groups = [...byGroup.keys()];
        const hits = groups.flatMap(g => byGroup.get(g)!);

        // 光凭标签区里的词，能不能凑齐两个互斥组
        const settledGroups = groups.filter(g => byGroup.get(g)!.some(declared));
        const arbiter: Arbiter = settledGroups.length >= 2 ? '程序' : 'LLM';

        if (arbiter === '程序') {
            const zones = [...new Set(
                hits.filter(declared).map(h => segments[h.segmentIndex].text))];
            violations.push({
                rule: 'W',
                message: zones.length > 1
                    ? `标题的标签区里同时声明了互斥分类：${settledGroups.join(' / ')}`
                        + `（分别位于「${zones.join('」和「')}」）`
                    : `标记段「${zones[0]}」里同时声明了互斥分类：${settledGroups.join(' / ')}`,
                hits,
                groups,
                tagIds: [],
                arbiter,
            });
            continue;
        }

        violations.push({
            rule: 'W',
            message: '标题里同时出现互斥分类：'
                + groups.map(g => `${g}（${whereOf(byGroup.get(g)!, segments)}）`).join(' / '),
            hits,
            groups,
            tagIds: [],
            arbiter,
        });
    }

    // ---------- G TAG × TAG ----------
    //
    // 跟标题里写了什么无关，纯粹是 TAG 之间打架，永远由程序按保留顺序裁决。
    const byTagGroup = tagGroups(input.tags);
    const tagSetBuckets = new Map<number, GroupId[]>();
    for (const group of byTagGroup.keys()) {
        for (const setIndex of compiled.tagGroupToSet.get(group) ?? []) {
            const list = tagSetBuckets.get(setIndex);
            if (list) { if (!list.includes(group)) list.push(group); }
            else tagSetBuckets.set(setIndex, [group]);
        }
    }
    for (const [, groups] of tagSetBuckets) {
        if (groups.length < 2) continue;
        violations.push({
            rule: 'G',
            message: `帖子同时挂了互斥的 TAG：${groups.join(' / ')}`,
            hits: [],
            groups,
            tagIds: groups.flatMap(g => byTagGroup.get(g)!.map(t => t.tagId)),
            arbiter: '程序',
        });
    }

    // ---------- X TAG × 关键字 ----------
    //
    // 挂了某个 TAG，标题里就不许出现某类关键字。有方向：
    //「TAG 纯爱 × 关键字 NTR」和「TAG NTR × 关键字 纯爱」是两条独立的规矩。
    //
    // 归谁管还是看那些关键字落在哪儿：
    //   明写在标签区里 → 程序。而且裁决方向是定死的：**标题赢，改 TAG。**
    //     理由是标题是作者一个字一个字敲进去的，他知道自己在写什么；
    //     TAG 是发帖时随手点的，点错太常见了。
    //     标题那边的分类要是有对应的 TAG 就换上去，没有就直接摘掉——
    //     百合TAG × 百破词就属于后者：百破没有自己的 TAG，摘掉百合即可，标题一个字不动。
    //   落在主体里 → LLM，由它先给帖子定性再决定动哪边。
    for (const [tagGroup, tagsOfGroup] of byTagGroup) {
        const banned = compiled.crossByTag.get(tagGroup);
        if (!banned) continue;

        for (const wordGroup of banned) {
            const hits = matches.filter(m => classifyingGroup(m) === wordGroup);
            if (hits.length === 0) continue;

            const anyDeclared = hits.some(declared);
            violations.push({
                rule: 'X',
                message: anyDeclared
                    ? `标题的标签区声明了「${wordGroup}」，帖子却挂着「${tagGroup}」TAG`
                    : `标题正文提到「${wordGroup}」，帖子却挂着「${tagGroup}」TAG（待定性）`,
                hits,
                // 顺序固定为 [关键字侧, TAG 侧]，下游靠它分辨哪一边是哪一边
                groups: [wordGroup, tagGroup],
                tagIds: tagsOfGroup.map(t => t.tagId),
                arbiter: anyDeclared ? '程序' : 'LLM',
            });
        }
    }

    return {
        normalized,
        segments,
        matches,
        violations,
        needsLlm: violations.some(v => v.arbiter === 'LLM'),
    };
}
