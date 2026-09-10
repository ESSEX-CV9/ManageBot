// src/modules/titleGuard/services/matcher.ts
//
// ③ 段内词典匹配。
//
// 两个关键决定：
//
// 1) 逐段独立匹配，匹配结果再映射回全串坐标 —— 物理上不可能跨段误匹配。
//
// 2) 用「最大覆盖」而不是「最左最长」挑选最终切分。
//    反例：「纯爱牛头人日记」，词典里同时有黑名单词「纯爱牛」、分类词「纯爱」和「牛头人」。
//      最左最长：先吃掉 [纯爱牛]，剩「头人日记」→ 判成黑名单违规（错）
//      最大覆盖：[纯爱](2) + [牛头人](3) = 5 字 > [纯爱牛](3) → 判成纯爱/NTR 冲突（对）
//    白名单词也走同一套匹配：「纯爱战士」(4字) 覆盖 > 「纯爱」(2字)，
//    命中白名单就等于把里面的「纯爱」吃掉了，误判自动消失——管理组加个词就能修，不用改代码。
//
// 3) 主体段的命中还要过一道**中文分词**闸：起止必须落在词边界上。
//    反例：「班上的乖乖女同学」里的「女同」、「章鱼妹妹库拉拉」里的「拉拉」——
//    字凑巧连在一起，其实分属两个词。详见 wordBoundary.ts。
//    标记段不过这道闸：那里是标签罗列不是句子，分词器的语言模型不适用。
//
// 词典规模只有几百条、标题不超过 100 字，所以用「按首字建索引 + 逐位置试探」即可，
// 没必要上 Aho-Corasick，代码量和可读性差得多。

import { isAsciiWordChar } from './normalizer';
import { getBoundaryOracle, type BoundaryOracle } from './wordBoundary';
import type { DictEntry, Match, Segment, SegmenterWord } from './types';

export interface CompiledDict {
    /** 首字 → 以该字开头的词条（按词长倒序，纯为让命中列表更好读） */
    byFirstChar: Map<string, DictEntry[]>;
    /** 全部启用词条的原表，供 isWholeDictWord 用 */
    byWord: Map<string, DictEntry>;
    /** 主体段的词边界判定器 */
    boundary: BoundaryOracle;
}

export function compileDict(entries: DictEntry[], segmenterWords: SegmenterWord[] = []): CompiledDict {
    const byFirstChar = new Map<string, DictEntry[]>();
    const byWord = new Map<string, DictEntry>();

    for (const e of entries) {
        if (!e.word) continue;
        byWord.set(e.word, e);
        const head = e.word[0];
        const bucket = byFirstChar.get(head);
        if (bucket) bucket.push(e);
        else byFirstChar.set(head, [e]);
    }
    for (const bucket of byFirstChar.values()) {
        bucket.sort((a, b) => b.word.length - a.word.length);
    }

    // 把行话灌给分词器，但**不含黑名单词**——黑名单收的是不该出现的写法，
    // 不是汉语词，灌进去会让分词器主动把「纯爱牛逼」切出「纯爱牛」来。
    // 再叠上管理组手工配的补词/拆词，纠正分词器切错的地方
    const boundary = getBoundaryOracle(
        entries.filter(e => e.word && e.kind !== '黑名单').map(e => e.word),
        segmenterWords,
    );

    return { byFirstChar, byWord, boundary };
}

/** 该词条在这种段里生不生效 */
function inScope(entry: DictEntry, kind: Segment['kind']): boolean {
    if (entry.scope === '全标题') return true;
    if (entry.scope === '仅标记段') return kind === 'marker';
    return kind === 'body';
}

interface RawHit {
    entry: DictEntry;
    start: number; // 段内相对坐标
    end: number;
}

/** 在一个段的文本里找出**全部**候选命中（含互相重叠的） */
function collectHits(text: string, dict: CompiledDict, kind: Segment['kind']): RawHit[] {
    const hits: RawHit[] = [];

    // 只有主体段（自然语言）过分词闸。分词器不可用时 bounds 是 null，等于不设限。
    const bounds = kind === 'body' ? dict.boundary.boundariesOf(text) : null;

    for (let i = 0; i < text.length; i++) {
        const bucket = dict.byFirstChar.get(text[i]);
        if (!bucket) continue;

        for (const entry of bucket) {
            const end = i + entry.word.length;
            if (end > text.length) continue;
            if (text.slice(i, end) !== entry.word) continue;
            if (!inScope(entry, kind)) continue;

            // ASCII 词强制词边界：否则 gl 会命中 english、les 会命中 files
            if (entry.asciiBoundary) {
                if (isAsciiWordChar(text[i - 1])) continue;
                if (isAsciiWordChar(text[end])) continue;
            }

            // 中文词边界：起止必须都落在词的边界上，否则这个「词」是从别的词里抠出来的。
            // 注意是在挑选之前就淘汰掉，好让最大覆盖去选别的切法——
            // 「我说纯爱牛逼」淘汰掉「纯爱牛」之后，「纯爱」照样能被选中。
            if (bounds && !(bounds.has(i) && bounds.has(end))) continue;

            hits.push({ entry, start: i, end });
        }
    }

    return hits;
}

/**
 * 从互相重叠的候选里，挑出「覆盖字符数最多」的一组互不重叠的命中。
 * 覆盖数相同时取命中条数更少的（更长的词优先，语义上更具体）。
 */
function pickMaxCoverage(hits: RawHit[], length: number): RawHit[] {
    if (hits.length === 0) return [];

    const endingAt = new Map<number, RawHit[]>();
    for (const h of hits) {
        const bucket = endingAt.get(h.end);
        if (bucket) bucket.push(h);
        else endingAt.set(h.end, [h]);
    }

    // dp[i] = 用 text[0..i) 能达到的最优解
    const coverage = new Array<number>(length + 1).fill(0);
    const count = new Array<number>(length + 1).fill(0);
    const from = new Array<RawHit | null>(length + 1).fill(null);

    for (let i = 1; i <= length; i++) {
        // 不在 i-1 处结束任何命中
        coverage[i] = coverage[i - 1];
        count[i] = count[i - 1];
        from[i] = null;

        for (const h of endingAt.get(i) ?? []) {
            const cov = coverage[h.start] + (h.end - h.start);
            const cnt = count[h.start] + 1;
            if (cov > coverage[i] || (cov === coverage[i] && cnt < count[i])) {
                coverage[i] = cov;
                count[i] = cnt;
                from[i] = h;
            }
        }
    }

    const chosen: RawHit[] = [];
    let i = length;
    while (i > 0) {
        const h = from[i];
        if (h) {
            chosen.push(h);
            i = h.start;
        } else {
            i--;
        }
    }
    return chosen.reverse();
}

/**
 * 对切好的段列表跑匹配，返回最终采纳的命中（全串坐标）。
 */
export function match(segments: Segment[], dict: CompiledDict): Match[] {
    return matchWithDebug(segments, dict).matches;
}

/** 一个候选命中，以及它有没有被最终采纳 */
export interface Candidate {
    word: string;
    kind: DictEntry['kind'];
    group: string | null;
    start: number;
    end: number;
    segmentIndex: number;
    segmentKind: Segment['kind'];
    chosen: boolean;
    /** 没被采纳时，是被哪个更长的词吃掉的 */
    supersededBy: string | null;
}

/**
 * 带调试信息的匹配：除了最终采纳的命中，还返回**全部候选**以及它们为什么落选。
 * 调试界面要靠它解释「为什么这个词没被识别出来」。
 */
export function matchWithDebug(
    segments: Segment[],
    dict: CompiledDict,
): { matches: Match[]; candidates: Candidate[] } {
    const matches: Match[] = [];
    const candidates: Candidate[] = [];

    segments.forEach((seg, segmentIndex) => {
        const hits = collectHits(seg.text, dict, seg.kind);
        const chosen = pickMaxCoverage(hits, seg.text.length);
        const chosenKeys = new Set(chosen.map(h => `${h.start}-${h.end}-${h.entry.word}`));

        for (const h of chosen) {
            matches.push({
                entry: h.entry,
                start: seg.start + h.start,
                end: seg.start + h.end,
                segmentIndex,
                segmentKind: seg.kind,
            });
        }

        for (const h of hits) {
            const isChosen = chosenKeys.has(`${h.start}-${h.end}-${h.entry.word}`);
            // 落选的：找出是哪个采纳了的命中盖住了它
            const eater = isChosen
                ? null
                : chosen.find(c => c.start <= h.start && c.end >= h.end && c !== h)
                    ?? chosen.find(c => c.start < h.end && c.end > h.start);

            candidates.push({
                word: h.entry.word,
                kind: h.entry.kind,
                group: h.entry.group,
                start: seg.start + h.start,
                end: seg.start + h.end,
                segmentIndex,
                segmentKind: seg.kind,
                chosen: isChosen,
                supersededBy: eater ? eater.entry.word : null,
            });
        }
    });

    matches.sort((a, b) => a.start - b.start);
    candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    return { matches, candidates };
}

/**
 * 一整段文字是否恰好等于某个词典词（供 segmenter 识别首尾标记结构）。
 * 只认分类词/黑名单/中性标记——白名单词本来就不该把一段升格成标记段。
 */
export function makeIsWholeDictWord(dict: CompiledDict): (text: string) => boolean {
    return (text: string) => {
        const entry = dict.byWord.get(text);
        return Boolean(entry && entry.kind !== '白名单');
    };
}
