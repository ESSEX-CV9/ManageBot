// src/modules/titleGuard/services/titleEdit.ts
//
// 标题改写的机制层。只管「怎么动字」，不管「该不该动」。
//
// 这一层存在的意义是**把模型关进笼子**。
//
// 老做法是让模型直接交一个新标题回来，程序再校验。问题是模型一旦拿到写标题的权力，
// 它会顺手做一堆没让它做的事——比如把整句「这辈子好像只能搞纯爱了」删掉，
// 只因为里面有「纯爱」两个字。校验能发现标题变短了，却发现不了作品被改性了。
//
// 新做法是模型只能对**程序已经圈出来的那几处命中**表态，每处三选一：
//
//   删除  —— 连它所在的那一小块一起删（标签区里是整个 token，正文里是整个小句）
//   替换  —— 只把命中那几个字换成另一个词，句子结构原样保留
//   保留  —— 不动，但得说清楚为什么这处不算分类声明
//
// 标题最终由程序拼出来，模型碰不到一个自由字符。它连「替换成什么」都只能
// 从词典里挑（见 resolveReplacement），编不出词典外的东西。

import { normalize, toSourceRange } from './normalizer';
import { tokenizeMarker } from './segmenter';
import type { DetectResult, GuardConfig, Match } from './types';

// ============================================================
// 坐标与拼接
// ============================================================

export interface SpanEdit {
    /** 归一化坐标 */
    start: number;
    end: number;
    /** 替换成什么；空串表示删除 */
    replacement: string;
}

/** 把一组编辑应用到原文（编辑坐标是归一化坐标，先映射回原文） */
export function applySpanEdits(detectResult: DetectResult, edits: SpanEdit[]): string {
    if (edits.length === 0) return detectResult.normalized.original;

    const mapped = edits
        .map(e => ({
            ...toSourceRange(detectResult.normalized, e.start, e.end),
            replacement: e.replacement,
        }))
        .sort((a, b) => a.start - b.start);

    const src = detectResult.normalized.original;
    let out = '';
    let cursor = 0;
    for (const e of mapped) {
        if (e.start < cursor) continue; // 重叠编辑，跳过后来的
        out += src.slice(cursor, e.start) + e.replacement;
        cursor = e.end;
    }
    out += src.slice(cursor);
    return out;
}

/**
 * 收尾清理：合并连续分隔符、去空括号、压空格。
 *
 * 必须**循环到稳定**：删掉 token 后括号里可能剩下 `【//】`，
 * 得先把分隔符清掉才会露出「空括号」这个形态，单趟顺序执行清不干净。
 */
export function tidyTitle(title: string): string {
    let current = title;

    for (let round = 0; round < 6; round++) {
        const next = current
            // 空括号：【】 [] （） () 〖〗 〔〕
            .replace(/【\s*】|\[\s*\]|（\s*）|\(\s*\)|〖\s*〗|〔\s*〕/g, '')
            // 括号内首尾多余的分隔符
            .replace(/([【\[（(〖〔])\s*[+、,，/|·&~；;]+\s*/g, '$1')
            .replace(/\s*[+、,，/|·&~；;]+\s*([】\]）)〗〕])/g, '$1')
            // 连续分隔符压成一个
            .replace(/([+、,，/|·&~；;])\s*(?:[+、,，/|·&~；;]\s*)+/g, '$1')
            // 括号内侧的残留空白（删掉一个 token 后常见：【 NTR】、【NTL 】）
            .replace(/([【\[（(〖〔])\s+/g, '$1')
            .replace(/\s+([】\]）)〗〕])/g, '$1')
            .replace(/\s{2,}/g, ' ')
            .trim();

        if (next === current) break;
        current = next;
    }

    return current;
}

/** 小句的边界。删主体段里的分类词时，删到这些符号为止 */
const CLAUSE_BREAKS = new Set([
    '，', ',', '。', '！', '!', '？', '?', '；', ';', '：', ':', '…', '、',
    '~', '～', '—', '-', '/', '|', '·',
]);

/**
 * 找出**包着这个命中的那一整块**，这是「删除」这个动作真正会删掉的范围。
 *
 * 标记段里，这一块就是 token：「可纯爱」「NTL？」「有纯爱版」这类，
 * 作者是把修饰词和分类词写成一个整体，只抠掉关键词会剩下没意义的残渣。
 *
 * 主体段里没有 token，就取**小句**——从命中往两边扩，扩到标点或段落边界为止。
 * 「纯爱版已第四次更新」这种句尾的更新说明，整句删掉才干净；
 * 只删「纯爱」两个字会剩个「版已第四次更新」，比不删还难看。
 *
 * 但这也意味着**正文里的「删除」代价很大**，能吃掉半句话。所以拼提示词时
 * 一定要把这个范围的原文摆给模型看（见 deletionPreview），让它自己权衡是删还是换。
 */
export function enclosingToken(
    result: DetectResult,
    m: Match,
): { start: number; end: number } | null {
    const seg = result.segments[m.segmentIndex];
    if (!seg) return null;

    if (m.segmentKind === 'marker') {
        const token = tokenizeMarker(seg).find(t => t.start <= m.start && t.end >= m.end);
        return token ? { start: token.start, end: token.end } : null;
    }

    const text = result.normalized.text;
    let start = m.start;
    while (start > seg.start && !CLAUSE_BREAKS.has(text[start - 1])) start--;
    let end = m.end;
    while (end < seg.end && !CLAUSE_BREAKS.has(text[end])) end++;

    // 掐掉两头的空白，别把相邻小句之间的空格也吃进来
    while (start < m.start && text[start] === ' ') start++;
    while (end > m.end && text[end - 1] === ' ') end--;

    return { start, end };
}

/** 删掉这处命中会连带删掉的原文。拼提示词时摆给模型看，让它知道代价 */
export function deletionPreview(result: DetectResult, m: Match): string {
    const span = enclosingToken(result, m) ?? { start: m.start, end: m.end };
    const src = toSourceRange(result.normalized, span.start, span.end);
    return result.normalized.original.slice(src.start, src.end);
}

/** 这处命中本身在原文里长什么样 */
export function hitText(result: DetectResult, m: Match): string {
    const src = toSourceRange(result.normalized, m.start, m.end);
    return result.normalized.original.slice(src.start, src.end);
}

// ============================================================
// 模型的三选一
// ============================================================

export type HitAction = '删除' | '替换' | '保留';

export interface HitDecision {
    /** 命中编号，1 起，对应 judgeHitsOf 的顺序 */
    hit: number;
    action: HitAction;
    /** action='替换' 时换成什么词 */
    replaceWith?: string;
    /** 为什么这么处理。保留必须给理由，否则没法校验 */
    why: string;
}

/**
 * 模型只能从词典里挑替换词，编不出词典外的东西。
 *
 * 允许的范围：任何一条词典记录的词面，或污染词配的替换目标（纯爱牛 → NTR）。
 * 这样「把绿帽换成 NTR」「把纯爱牛换成 NTR」都走得通，
 * 而「把纯爱换成这是一部温馨治愈的作品」这种自由发挥走不通。
 */
export function resolveReplacement(
    config: GuardConfig,
    wanted: string,
): { ok: true; word: string } | { ok: false; reason: string } {
    const want = normalize(wanted).text.trim();
    if (!want) return { ok: false, reason: '替换词是空的' };

    for (const e of config.dict) {
        if (normalize(e.word).text === want) return { ok: true, word: e.word };
        if (e.replaceTo && normalize(e.replaceTo).text === want) {
            return { ok: true, word: e.replaceTo };
        }
    }
    return {
        ok: false,
        reason: `「${wanted}」不在词表里。替换词只能从词表里挑，不能自己编`,
    };
}

export interface AppliedDecisions {
    /**
     * 这些处理对应的标题编辑，坐标是原标题归一化后的下标。
     *
     * 这里**不直接拼标题**，是故意的：程序那一段也有自己的编辑，
     * 两段必须合到一起一次性应用。分两次拼会让第二段看到的标题
     * 和它被问的时候不是同一个，编号跟着错位。
     */
    edits: SpanEdit[];
    /** 模型判成「保留」的那些命中 */
    kept: Match[];
    /** 模型动过的那些命中 */
    touched: Match[];
    /** 指令本身有毛病的地方，要原样打回给模型 */
    problems: string[];
}

/**
 * 把模型的三选一落成新标题。
 *
 * 没被提到的命中一律按「保留」处理，但会记一条 problem——
 * 模型漏答比答错更危险：漏答会让一处冲突悄无声息地留在标题里。
 */
export function applyDecisions(
    result: DetectResult,
    hits: Match[],
    decisions: HitDecision[],
    config: GuardConfig,
): AppliedDecisions {
    const problems: string[] = [];
    const byHit = new Map<number, HitDecision>();

    for (const d of decisions) {
        if (!Number.isInteger(d.hit) || d.hit < 1 || d.hit > hits.length) {
            problems.push(`没有第 ${d.hit} 处命中，编号只到 ${hits.length}`);
            continue;
        }
        if (byHit.has(d.hit)) {
            problems.push(`第 ${d.hit} 处给了两个互相打架的处理方式`);
            continue;
        }
        byHit.set(d.hit, d);
    }

    const edits: SpanEdit[] = [];
    const kept: Match[] = [];
    const touched: Match[] = [];

    hits.forEach((m, i) => {
        const d = byHit.get(i + 1);
        if (!d) {
            problems.push(`第 ${i + 1} 处命中「${m.entry.word}」没给处理方式`);
            kept.push(m);
            return;
        }

        if (d.action === '保留') {
            if (!d.why?.trim()) {
                problems.push(`第 ${i + 1} 处判了保留却没说理由`);
            }
            kept.push(m);
            return;
        }

        if (d.action === '删除') {
            const span = enclosingToken(result, m) ?? { start: m.start, end: m.end };
            edits.push({ start: span.start, end: span.end, replacement: '' });
            touched.push(m);
            return;
        }

        // 替换
        const resolved = resolveReplacement(config, d.replaceWith ?? '');
        if (!resolved.ok) {
            problems.push(`第 ${i + 1} 处要替换，但${resolved.reason}`);
            kept.push(m);
            return;
        }
        edits.push({ start: m.start, end: m.end, replacement: resolved.word });
        touched.push(m);
    });

    return { edits, kept, touched, problems };
}

// ============================================================
// 人工路径的安全阀
// ============================================================

/**
 * candidate 是否是 original 删去若干字符的结果（子序列关系）。
 * 大小写和全半角按归一化后比较，避免有人顺手把全角括号敲成半角就被判违规。
 *
 * 模型路径用不上这个（新标题是程序拼的，模型碰不到自由字符），
 * 它是给**作者自助改标题**那条路用的：人手敲进来的标题要卡住「越改越长」。
 */
export function isDeletionOnly(original: string, candidate: string): boolean {
    const a = normalize(original).text;
    const b = normalize(candidate).text;
    if (b.length > a.length) return false;

    let i = 0;
    for (const ch of b) {
        const found = a.indexOf(ch, i);
        if (found < 0) return false;
        i = found + 1;
    }
    return true;
}

export { tokenizeMarker };
