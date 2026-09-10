// src/modules/titleGuard/services/segmenter.ts
//
// ② 结构切分：把标题切成「标记段」和「主体段」。
//
// 这一步是整套判定可靠性的分水岭。标记段里的分类词默认就是在做分类标记（方括号里
// 本来就是放标签的地方），可以直接判；主体段是自然语言，得靠 TAG + LLM 定性。
//
// 三条铁律：
//   1. 书名号和引号（《》「」『』〈〉<>）**不是**标记括号。
//      反例：《真正的橘子味世界不允许百合破坏的存在！》——若把《》当标记括号，
//      整个标题会变成标记段，「百合破坏」就会被直接判成标记段冲突而误改。
//   2. 括号嵌套时取**最外层**。
//      反例：【摇滚主唱/前任文学/狗(形容词)/不洁/内含 abo 伪骨 ntr(？)/音乐播放器】
//      若取最内层，整个【】会被里面的 () 撕成「主体+(形容词)+主体+(？)+主体」，
//      本来明明白白写在标签区里的 ntr 反而掉进主体段，只能去麻烦 LLM。
//   3. 后续的词典匹配逐段独立进行，绝不跨段边界。
//      反例：「XXXX百合】破坏了美好XXXXX」，「百合」在标记段末尾、「破坏」在主体段开头，
//      跨段匹配会拼出一个根本不存在的「百合破坏」。
//
// 另外，标签区不一定用括号。实际标题里大量出现这两种写法：
//   【牛头人杯】|手枪卡/纯爱战神/NTR|身为 ntr 本子男主的我……   ← 竖线夹出来的
//   8.31补全所有立绘/纯爱人设阶段已加入【二创/古风/NTL】作为……  ← 斜杠罗列 + 紧贴括号
// 这两种都得认出来，否则里面的分类词会被当成自然语言，白白丢给 LLM。

import type { Segment, SegmentPosition } from './types';

/**
 * 标记括号。
 * 全角圆括号（）经 NFKC 已变成半角 ()，所以这里只列半角形态。
 */
const MARKER_BRACKETS: ReadonlyArray<readonly [string, string]> = [
    ['【', '】'],
    ['[', ']'],
    ['〖', '〗'],
    ['〔', '〕'],
    ['(', ')'],
];

/** 明确**不是**标记括号的成对符号（书名号 / 引号）。仅作文档说明，代码里不处理。 */
export const NON_MARKER_BRACKETS = ['《》', '〈〉', '「」', '『』', '<>'] as const;

const OPEN_TO_CLOSE = new Map(MARKER_BRACKETS);
const CLOSERS = new Set(MARKER_BRACKETS.map(([, close]) => close));

/** 标记段内部用来切 token 的分隔符 */
export const TOKEN_SEPARATORS = new Set([
    ' ', '+', '、', '/', ',', '|', '·', '&', '~', ';', '；',
]);

/**
 * 区块分隔符（竖线）。中文正文里几乎不会出现，一旦出现基本就是作者在划分区块。
 * 全角｜经 NFKC 已变成半角 |。
 */
const PIPES = new Set(['|', '‖']);

/** 罗列条目用的分隔符。不含空格——空格在正文里太常见，拿它切会把正常句子切碎。 */
const LIST_SEPARATORS = new Set(['/', '、', '+', '·', '&']);

/**
 * 句读符号。一节文字里只要出现，就说明它是句子而不是标签。
 * 注意不含小数点：「8.31补全所有立绘」这种日期/版本号开头的标签很常见。
 */
const SENTENCE_MARKS = new Set([
    ',', '，', '。', '!', '！', '?', '？', ';', '；', ':', '：', '…',
]);

/** 单节标签的字数上限。超过这个长度基本就是句子了 */
const MAX_PIECE_LEN = 12;

/** 未闭合括号往后延伸时的截断符 */
const EDGE_SEPARATORS = new Set(['|', '/', '-', '—', '–', '·']);

export interface SegmentOptions {
    /**
     * 判断「一整段文字是否恰好是一个词典词」。
     * 用于识别「NTR | 某某的故事」这种首尾标记结构。
     * 不提供时只按括号和结构符号切分。
     */
    isWholeDictWord?: (text: string) => boolean;
}

interface RawPair {
    open: string;
    close: string;
    closeIdx: number;  // 未闭合时为 -1
    innerStart: number;
    innerEnd: number;
    outerStart: number;
    outerEnd: number;
}

/**
 * 找出所有**最外层**括号对。嵌套在别人肚子里的括号是那一段的内容，不另起一段。
 */
function findBracketPairs(text: string): RawPair[] {
    const stack: { open: string; idx: number }[] = [];
    const closed: RawPair[] = [];

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (OPEN_TO_CLOSE.has(ch)) {
            stack.push({ open: ch, idx: i });
            continue;
        }
        if (!CLOSERS.has(ch)) continue;

        // 从栈顶往下找能配上的左括号（容忍「【(】」这类错配）
        for (let s = stack.length - 1; s >= 0; s--) {
            if (OPEN_TO_CLOSE.get(stack[s].open) !== ch) continue;
            const { open, idx } = stack[s];
            stack.length = s; // 丢弃中间那些没闭合的
            closed.push({
                open,
                close: ch,
                closeIdx: i,
                innerStart: idx + 1,
                innerEnd: i,
                outerStart: idx,
                outerEnd: i + 1,
            });
            break;
        }
    }

    const result = closed.filter(p => !closed.some(q =>
        q !== p && q.outerStart <= p.outerStart && p.outerEnd <= q.outerEnd));

    // 栈里剩下的是没闭合的左括号。往后延伸到最近的分隔符或另一个括号为止，
    // 别让一个漏打的「【」把整条标题都吞成标记段。
    for (const { open, idx } of stack) {
        let end = text.length;
        for (let i = idx + 1; i < text.length; i++) {
            const ch = text[i];
            if (EDGE_SEPARATORS.has(ch) || OPEN_TO_CLOSE.has(ch) || CLOSERS.has(ch)) { end = i; break; }
        }
        if (result.some(p => idx < p.outerEnd && p.outerStart < end)) continue;
        result.push({
            open,
            close: '',
            closeIdx: -1,
            innerStart: idx + 1,
            innerEnd: end,
            outerStart: idx,
            outerEnd: end,
        });
    }

    return result.sort((a, b) => a.outerStart - b.outerStart);
}

/** 按罗列分隔符把一段文字拆成若干「节」 */
function splitPieces(text: string): string[] {
    const out: string[] = [];
    let buf = '';
    for (const ch of text) {
        if (LIST_SEPARATORS.has(ch)) { out.push(buf); buf = ''; continue; }
        buf += ch;
    }
    out.push(buf);
    return out.map(p => p.trim()).filter(p => p.length > 0);
}

/** 每一节都又短又没有句读——长得像标签清单，而不是句子 */
function looksLikeTagList(pieces: string[]): boolean {
    return pieces.length > 0 && pieces.every(p =>
        [...p].length <= MAX_PIECE_LEN && ![...p].some(c => SENTENCE_MARKS.has(c)));
}

interface MarkerSpan {
    /** 参与词典匹配的内容区间（不含括号/竖线本身） */
    start: number;
    end: number;
    /** 含括号、竖线在内的完整占位区间 */
    outerStart: number;
    outerEnd: number;
    wellFormed: boolean;
    confident: boolean;
    bracket: Segment['bracket'];
}

/**
 * 在「括号之外」的一块文字里找标签区。
 *
 * 先按竖线切块，再看每块像不像标签清单。认定标签区需要**形状**加**依据**两个条件：
 *   形状——每节都短、没句读；
 *   依据——被竖线夹住，或者紧贴着一个括号标记段，或者整块本身就是词典词。
 * 光有形状不行：「他不是纯爱战神/而是NTR之王」形状也过得去，但它孤零零杵在那儿，
 * 没有任何结构依据说明作者在标标签，只能当句子。
 *
 * confident 表示「有多确信这是标签区」：
 *   竖线夹住的、整块是词典词的 → 确信，冲突可以直接自动整改；
 *   仅仅靠斜杠罗列 + 紧贴括号推出来的 → 不确信，冲突要交给 LLM 定性。
 */
function findMarkerZones(
    text: string,
    gapStart: number,
    gapEnd: number,
    bracketLeft: boolean,
    bracketRight: boolean,
    isWholeDictWord?: (t: string) => boolean,
): MarkerSpan[] {
    const slice = text.slice(gapStart, gapEnd);
    if (!slice.trim()) return [];

    const runs: { start: number; end: number; pipeLeft: boolean; pipeRight: boolean }[] = [];
    let runStart = 0;
    let pipeLeft = false;
    for (let i = 0; i < slice.length; i++) {
        if (!PIPES.has(slice[i])) continue;
        runs.push({ start: runStart, end: i, pipeLeft, pipeRight: true });
        runStart = i + 1;
        pipeLeft = true;
    }
    runs.push({ start: runStart, end: slice.length, pipeLeft, pipeRight: false });

    const zones: MarkerSpan[] = [];

    runs.forEach((run, j) => {
        const raw = slice.slice(run.start, run.end);
        const trimmed = raw.trim();
        if (!trimmed) return;

        const lead = raw.indexOf(trimmed);
        const start = gapStart + run.start + lead;
        const end = start + trimmed.length;

        const pieces = splitPieces(trimmed);
        const shaped = looksLikeTagList(pieces);
        const whole = isWholeDictWord?.(trimmed) ?? false;
        const allDict = isWholeDictWord !== undefined
            && pieces.length > 0 && pieces.every(p => isWholeDictWord(p));
        const touchesBracket = (j === 0 && bracketLeft) || (j === runs.length - 1 && bracketRight);
        const anchored = run.pipeLeft || run.pipeRight || touchesBracket;

        let confident: boolean;
        if (whole || allDict) confident = true;
        else if (shaped && run.pipeLeft && run.pipeRight) confident = true;
        else if (shaped && pieces.length >= 2 && anchored) confident = false;
        else return; // 不像标签区，留给主体段

        zones.push({
            start,
            end,
            // 把夹住它的竖线一起吃掉，免得剩下一根「|」自成一个主体段
            outerStart: gapStart + run.start - (run.pipeLeft ? 1 : 0),
            outerEnd: gapStart + run.end + (run.pipeRight ? 1 : 0),
            wellFormed: true,
            confident,
            bracket: null,
        });
    });

    return zones;
}

/**
 * 把归一化后的标题切成有序的段列表。
 * 括号和竖线这类结构符号本身不归任何段——否则「【」会单独变成一个主体段。
 */
export function segment(text: string, options: SegmentOptions = {}): Segment[] {
    if (!text) return [];

    const pairs = findBracketPairs(text);

    const markers: MarkerSpan[] = pairs
        .filter(p => p.innerEnd > p.innerStart)
        .map(p => ({
            start: p.innerStart,
            end: p.innerEnd,
            outerStart: p.outerStart,
            outerEnd: p.outerEnd,
            wellFormed: p.closeIdx >= 0,
            // 没闭合的括号结构本身就不规范，判定要降一档
            confident: p.closeIdx >= 0,
            bracket: { open: p.open, close: p.close },
        }));

    // 括号之外的每一块，再找一遍非括号的标签区
    let cursor = 0;
    const gaps: { start: number; end: number }[] = [];
    for (const p of pairs) {
        if (p.outerStart > cursor) gaps.push({ start: cursor, end: p.outerStart });
        cursor = Math.max(cursor, p.outerEnd);
    }
    if (cursor < text.length) gaps.push({ start: cursor, end: text.length });

    for (const gap of gaps) {
        markers.push(...findMarkerZones(
            text,
            gap.start,
            gap.end,
            gap.start > 0,
            gap.end < text.length,
            options.isWholeDictWord,
        ));
    }

    markers.sort((a, b) => a.outerStart - b.outerStart);

    const segments: Segment[] = [];
    let at = 0;

    const pushBody = (start: number, end: number) => {
        if (end <= start) return;
        const body = text.slice(start, end);
        if (!body.trim()) return;
        // 纯粹的分隔符残渣不成段
        if ([...body].every(c => PIPES.has(c) || LIST_SEPARATORS.has(c) || c === ' ')) return;
        segments.push({
            kind: 'body',
            position: 'body',
            start,
            end,
            text: body,
            wellFormed: true,
            confident: true,
            bracket: null,
        });
    };

    for (const m of markers) {
        if (m.start < at) continue; // 内容已被前一段吃掉
        pushBody(at, Math.max(at, m.outerStart));
        segments.push({
            kind: 'marker',
            position: 'middle', // 下面统一定位
            start: m.start,
            end: m.end,
            text: text.slice(m.start, m.end),
            wellFormed: m.wellFormed,
            confident: m.confident,
            bracket: m.bracket,
        });
        at = Math.max(at, m.outerEnd);
    }
    pushBody(at, text.length);

    assignPositions(segments);
    return segments;
}

/**
 * 给标记段定位：
 *   从头连续的标记段 = 前缀，直到撞上第一段有实质内容的正文；
 *   从尾往前同理 = 后缀；夹在正文中间的 = 中部。
 *
 * 「【A】【B】正文」里 A 和 B 都算前缀——作者是把它们当一整块标签区在用。
 */
function assignPositions(segments: Segment[]): void {
    const substantial = (s: Segment) => s.kind === 'body' && s.text.trim().length > 0;

    let head = 0;
    while (head < segments.length && !substantial(segments[head])) {
        if (segments[head].kind === 'marker') segments[head].position = 'prefix';
        head++;
    }

    let tail = segments.length - 1;
    while (tail >= 0 && !substantial(segments[tail])) {
        if (segments[tail].kind === 'marker') {
            // 整条标题都没有正文时，前缀优先，不要被后缀覆盖
            segments[tail].position = tail >= head ? 'suffix' : segments[tail].position;
        }
        tail--;
    }

    for (let i = head; i <= tail; i++) {
        const seg = segments[i];
        if (seg.kind === 'marker' && seg.position === 'body') seg.position = 'middle';
    }
}

/** 位置的中文名，给调试界面用 */
export const POSITION_LABEL: Record<SegmentPosition, string> = {
    prefix: '前缀标记',
    middle: '中部标记',
    suffix: '后缀标记',
    body: '主体',
};

/**
 * 把一个标记段按分隔符切成 token（带在全串中的绝对坐标）。
 * 改写标记段时要靠它定位「删哪个 token、连带删哪个分隔符」。
 *
 * 嵌套括号里的分隔符不切：「狗(形容词)」「ntr(？)」要整块进出，
 * 否则删掉 ntr 会剩一个孤零零的「(？)」。
 */
export function tokenizeMarker(seg: Segment): { text: string; start: number; end: number }[] {
    const tokens: { text: string; start: number; end: number }[] = [];
    let buf = '';
    let bufStart = seg.start;
    let depth = 0;

    const flush = (end: number) => {
        const trimmed = buf.trim();
        if (trimmed) {
            const lead = buf.indexOf(trimmed);
            tokens.push({ text: trimmed, start: bufStart + lead, end: bufStart + lead + trimmed.length });
        }
        buf = '';
        bufStart = end + 1;
    };

    for (let i = 0; i < seg.text.length; i++) {
        const ch = seg.text[i];
        if (OPEN_TO_CLOSE.has(ch)) depth++;
        else if (CLOSERS.has(ch) && depth > 0) depth--;
        else if (depth === 0 && TOKEN_SEPARATORS.has(ch)) {
            flush(seg.start + i);
            continue;
        }
        buf += ch;
    }
    flush(seg.end);

    return tokens;
}
