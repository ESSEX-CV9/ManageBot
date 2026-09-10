// src/modules/titleGuard/services/ruleEngine.ts
//
// ④ 规则判定。纯函数：标题 + TAG + 配置 → 违规清单。
//
// 六条规则：
//   T1 黑名单词      任意段命中黑名单词                       不需要 LLM
//   T2 标记段冲突    同一标记段内出现同一互斥集合的 ≥2 个组   不需要 LLM
//   T3 主体段冲突    主体段出现同一互斥集合的 ≥2 个组         需要 LLM 定性
//   T4 标题与TAG矛盾 主体段的组与 TAG 的组同属一集合但不同    需要 LLM 定性
//   G1 TAG 互斥      同一互斥集合内挂了 ≥2 个 TAG             不需要 LLM
//   G2 TAG 禁令      标题含某组的分类标记 → 禁挂指定 TAG      标记段不需要 / 主体段需要
//
// LLM 只回答一个问题：**主体段里的这些分类词，是在做分类标记，还是自然语言的一部分？**
// 只有 T3/T4（以及由主体段触发的 G2）会走它，绝大多数帖子根本不会调。

import { normalize } from './normalizer';
import { segment } from './segmenter';
import { compileDict, makeIsWholeDictWord, match, type CompiledDict } from './matcher';
import type {
    AppliedTag,
    DetectInput,
    DetectResult,
    GroupId,
    GuardConfig,
    Match,
    Violation,
} from './types';

/** 预编译一次配置，反复检测同一批帖子时复用 */
export interface CompiledConfig {
    dict: CompiledDict;
    isWholeDictWord: (text: string) => boolean;
    /** TAG 维度：分类组 → 所属互斥集合下标 */
    tagGroupToSet: Map<GroupId, number>;
    /** 关键字维度：分类组 → 所属互斥集合下标 */
    wordGroupToSet: Map<GroupId, number>;
    /** 交叉互斥：TAG 分类组 → 这个 TAG 在场时标题里不许出现的关键字分类组 */
    crossByTag: Map<GroupId, Set<GroupId>>;
    raw: GuardConfig;
}

export function compileConfig(config: GuardConfig): CompiledConfig {
    const dict = compileDict(config.dict, config.segmenterWords ?? []);
    const tagGroupToSet = new Map<GroupId, number>();
    const wordGroupToSet = new Map<GroupId, number>();

    config.exclusiveSets.forEach((set, index) => {
        const target = set.dimension === 'tag' ? tagGroupToSet : wordGroupToSet;
        for (const group of set.groups) {
            // 同一维度里一个组只该属于一个集合；重复配置时以先出现的为准
            if (!target.has(group)) target.set(group, index);
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

/** 参与互斥判定的命中：分类词或黑名单词，且映射到了分类组 */
function classifyingGroup(m: Match): GroupId | null {
    if (m.entry.kind === '白名单' || m.entry.kind === '中性标记') return null;
    return m.entry.group;
}

/**
 * 把标题命中按「所属的**关键字**互斥集合」分桶，返回集合下标 → 该集合内出现的不同组。
 * 只看关键字维度——TAG 之间互不互斥是另一回事，跟标题里写了什么无关。
 */
function groupsBySet(
    matches: Match[],
    compiled: CompiledConfig,
): Map<number, Map<GroupId, Match[]>> {
    const result = new Map<number, Map<GroupId, Match[]>>();

    for (const m of matches) {
        const group = classifyingGroup(m);
        if (!group) continue;
        const setIndex = compiled.wordGroupToSet.get(group);
        if (setIndex === undefined) continue;

        let bucket = result.get(setIndex);
        if (!bucket) { bucket = new Map(); result.set(setIndex, bucket); }

        const list = bucket.get(group);
        if (list) list.push(m);
        else bucket.set(group, [m]);
    }

    return result;
}

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

/**
 * 检测一个帖子的标题与 TAG。
 */
export function detect(input: DetectInput, precompiled?: CompiledConfig): DetectResult {
    const compiled = precompiled ?? compileConfig(input.config);

    const normalized = normalize(input.title);
    const segments = segment(normalized.text, { isWholeDictWord: compiled.isWholeDictWord });
    const matches = match(segments, compiled.dict);

    const violations: Violation[] = [];

    /**
     * 在这条标题里已经坐实是分类词的组。
     *
     * 只要一个组在**明写的标签区**（规规矩矩的括号、竖线夹住的区块）里出现过，
     * 作者就已经用行动回答了「这个词是不是分类标记」——是。
     * 那么它在同一条标题别处的出现（正文里、靠排版推断的区块里）也不必再问 LLM 了。
     *
     * 反例说明为什么要有这条：
     *   8月21日更新（NTL/后宫/有纯爱版）……（ntl和纯爱两个改版）纯爱版已第四次更新
     * 纯爱 明明白白写在两个括号里，可就因为句尾那一处落在正文段，
     * 整条帖子都要去问一遍模型「纯爱算不算分类词」——问了个早有答案的问题。
     */
    const established = new Set<GroupId>();
    for (const m of matches) {
        if (m.segmentKind !== 'marker') continue;
        if (!segments[m.segmentIndex]?.confident) continue;
        const group = classifyingGroup(m);
        if (group) established.add(group);
    }
    /** 涉事的组是不是都已经坐实了。都坐实就不用麻烦 LLM */
    const allEstablished = (groups: GroupId[]) => groups.every(g => established.has(g));

    // ---------- T1 黑名单词 ----------
    //
    // 黑名单词写在明写的标签区里，是不是在做分类标记没有疑问，直接判。
    // 但落在正文里就得先定性——黑名单是按字面匹配的，很容易咬进一句大白话：
    //   「……状态栏/我说纯爱牛逼！」里的「纯爱牛」其实是「纯爱」+「牛逼」，
    //   照黑名单换成 NTR 就成了「我说NTR逼！」，比不改还糟。
    const blacklisted = matches.filter(m => m.entry.kind === '黑名单');
    for (const m of blacklisted) {
        const inMarker = m.segmentKind === 'marker' && segments[m.segmentIndex]?.confident;
        violations.push({
            rule: 'T1',
            message: `标题含黑名单词「${m.entry.word}」` +
                (m.entry.replaceTo ? `，应改为「${m.entry.replaceTo}」` : '，应删除'),
            hits: [m],
            groups: m.entry.group ? [m.entry.group] : [],
            tagIds: [],
            needsLlm: !inMarker,
        });
    }

    // ---------- T2 标记段冲突 ----------
    // 标记段是作者明写标签的地方，所以**跨标记段**也算冲突。
    // 反例：8.31补全所有立绘/纯爱人设阶段已加入【二创/古风/武侠/NTL/母猪】作为三流武者的你……
    // 纯爱和 NTL 分处两个标签区，只在单段内比对的话这条会被判成合规，等于漏放。
    const markerMatches = matches.filter(m => m.segmentKind === 'marker');
    for (const [, byGroup] of groupsBySet(markerMatches, compiled)) {
        if (byGroup.size < 2) continue;
        const groups = [...byGroup.keys()];
        const hits = groups.flatMap(g => byGroup.get(g)!);
        const segIndexes = [...new Set(hits.map(h => h.segmentIndex))].sort((a, b) => a - b);
        const zones = segIndexes.map(i => segments[i].text);
        // 只要有一个标签区是「推出来的」而不是括号明写的，就先让 LLM 定性再动手。
        // 「纯爱人设阶段已加入」形状上像标签，但也可能只是一句更新说明，删错了作者会很不高兴。
        // 不过要是这些组在别处的明写标签区里已经坐实了，那就没什么可问的了。
        const inferred = segIndexes.some(i => !segments[i].confident) && !allEstablished(groups);
        violations.push({
            rule: 'T2',
            message: zones.length > 1
                ? `标题的标签区里同时出现互斥分类：${groups.join(' / ')}`
                    + `（分别位于「${zones.join('」和「')}」）`
                : `标记段「${zones[0]}」里同时出现互斥分类：${groups.join(' / ')}`,
            hits,
            groups,
            tagIds: [],
            needsLlm: inferred,
        });
    }

    // ---------- T3 主体段冲突 ----------
    const bodyMatches = matches.filter(m => m.segmentKind === 'body');
    const bodyBySet = groupsBySet(bodyMatches, compiled);
    for (const [, byGroup] of bodyBySet) {
        if (byGroup.size < 2) continue;
        const groups = [...byGroup.keys()];
        violations.push({
            rule: 'T3',
            message: `标题正文里同时出现互斥分类：${groups.join(' / ')}`,
            hits: groups.flatMap(g => byGroup.get(g)!),
            groups,
            tagIds: [],
            // T3 恒为 true。「这些词算不算分类词」也许早有答案，
            // 但正文里两个分类打架时该怎么改写，仍然只有模型能给方案——
            // 这里要是标成 false，enforcer 就不会去问模型，而改写又给不出，帖子会永远卡住。
            needsLlm: true,
        });
    }

    // ---------- G1 TAG 互斥 ----------
    const byTagGroup = tagGroups(input.tags);
    const tagSetBuckets = new Map<number, GroupId[]>();
    for (const group of byTagGroup.keys()) {
        const setIndex = compiled.tagGroupToSet.get(group);
        if (setIndex === undefined) continue;
        const list = tagSetBuckets.get(setIndex);
        if (list) list.push(group);
        else tagSetBuckets.set(setIndex, [group]);
    }
    for (const [, groups] of tagSetBuckets) {
        if (groups.length < 2) continue;
        violations.push({
            rule: 'G1',
            message: `帖子同时挂了互斥的 TAG：${groups.join(' / ')}`,
            hits: [],
            groups,
            tagIds: groups.flatMap(g => byTagGroup.get(g)!.map(t => t.tagId)),
            needsLlm: false,
        });
    }

    // ---------- T4 交叉互斥（TAG × 标题关键字）----------
    //
    // 这是横跨两个维度的第三种互斥：挂了某个 TAG，标题里就不许出现某类关键字。
    // 有方向——「TAG 纯爱 × 关键字 NTR」和「TAG NTR × 关键字 纯爱」是两条独立的规矩。
    //
    // 判定只负责报「撞上了」，至于该摘 TAG 还是该删标题里的词，
    // 由 rewriter 按分类优先级裁决：优先级低的那一边输，不管它在哪一侧。
    //
    // 标签区里明写的关键字，是不是分类标记没有疑问，直接判；
    // 正文里提到的、以及靠排版推断出来的标签区，先让 LLM 定性。
    for (const [tagGroup, tagsOfGroup] of byTagGroup) {
        const banned = compiled.crossByTag.get(tagGroup);
        if (!banned) continue;

        for (const wordGroup of banned) {
            const hits = matches.filter(m => classifyingGroup(m) === wordGroup);
            if (hits.length === 0) continue;

            const inMarker = hits.every(h => h.segmentKind === 'marker');
            // 全落在明写的标签区里，或者这个组在标题别处已经坐实过 —— 两种都算板上钉钉
            const declared = (inMarker && hits.every(h => segments[h.segmentIndex].confident))
                || established.has(wordGroup);

            violations.push({
                rule: 'T4',
                message: (inMarker
                    ? `标题的标签区写了「${wordGroup}」，帖子却挂着「${tagGroup}」TAG`
                    : `标题正文提到「${wordGroup}」，帖子却挂着「${tagGroup}」TAG`)
                    + (declared ? '' : '（待定性）'),
                hits,
                // 顺序固定为 [关键字侧, TAG 侧]，改写器靠它分辨哪一边是哪一边
                groups: [wordGroup, tagGroup],
                tagIds: tagsOfGroup.map(t => t.tagId),
                needsLlm: !declared,
            });
        }
    }

    return {
        normalized,
        segments,
        matches,
        violations,
        needsLlm: violations.some(v => v.needsLlm),
    };
}
