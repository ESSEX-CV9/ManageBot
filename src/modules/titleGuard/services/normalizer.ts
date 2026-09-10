// src/modules/titleGuard/services/normalizer.ts
//
// ① 归一化。把标题统一成可匹配的形式，同时保留「归一化位置 → 原文位置」的映射
// —— 后面改写标题时要靠这张映射把命中区间还原回原文坐标。
//
// 做的事：
//   - Unicode NFKC（全角→半角、①→1、Ａ→A）
//   - ASCII 转小写
//   - 去掉零宽字符和纯装饰符号（防止「纯★爱」这类绕过）
//   - 连续空白压成一个空格
//
// 不做的事：
//   - 不做通用繁简转换。繁体写法（寢取）直接在词典里单独登记，比通用转换可控得多。

import type { NormalizedTitle } from './types';

/** 零宽/不可见字符（零宽空格、方向控制符、BOM、软连字符），直接丢弃 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/u;

/**
 * 纯装饰符号，直接丢弃。
 * 注意：这里**不能**包含任何会被当作分隔符的字符（· | / - 等），
 * 否则会破坏 segmenter 的切分。
 */
const DECORATIVE = new Set([
    ...'★☆✰✩✪✧✦❂✵✶✷❉❊❋✿❀❁✾♡♥❤❥♠♣♦◆◇◈■□▣▢▲△▼▽●○◎◉⊙※〓♪♫♬♩☀☂☁⚡✔✓✅❗❕‼',
    ...'✨🌟⭐💫🔥💖💕💗💘💝🎀🎉🎊👑🏆📢📌🔖',
]);

/**
 * 归一化标题。
 *
 * 逐「码点」处理而不是逐 UTF-16 单元，否则 emoji 和补充平面汉字会被劈成两半。
 * NFKC 可能把 1 个码点展开成多个字符（㈱ → (株)），所以映射表按输出字符逐个记。
 */
export function normalize(input: string): NormalizedTitle {
    const out: string[] = [];
    const srcStart: number[] = [];
    const srcEnd: number[] = [];

    let cursor = 0;          // 在原文中的 UTF-16 下标
    let lastWasSpace = false;

    for (const ch of input) {
        const from = cursor;
        const to = cursor + ch.length;
        cursor = to;

        if (INVISIBLE.test(ch)) continue;
        if (DECORATIVE.has(ch)) continue;

        // 连续空白压成一个空格（空格本身是标记段内的 token 分隔符，不能全删）
        if (/\s/u.test(ch)) {
            if (lastWasSpace) continue;
            out.push(' ');
            srcStart.push(from);
            srcEnd.push(to);
            lastWasSpace = true;
            continue;
        }
        lastWasSpace = false;

        const folded = ch.normalize('NFKC').toLowerCase();
        for (const c of folded) {
            out.push(c);
            srcStart.push(from);
            srcEnd.push(to);
        }
    }

    return { original: input, text: out.join(''), srcStart, srcEnd };
}

/**
 * 把归一化文本上的区间 [start, end) 映射回原文区间。
 * 空区间返回一个原文中的插入点。
 */
export function toSourceRange(
    n: NormalizedTitle,
    start: number,
    end: number,
): { start: number; end: number } {
    if (n.text.length === 0) return { start: 0, end: 0 };

    const s = Math.max(0, Math.min(start, n.text.length - 1));
    if (end <= start) {
        return { start: n.srcStart[s], end: n.srcStart[s] };
    }
    const e = Math.max(0, Math.min(end - 1, n.text.length - 1));
    return { start: n.srcStart[s], end: n.srcEnd[e] };
}

/**
 * 纯 ASCII 的词（NTR / GL / les / 1v1）必须强制词边界，
 * 否则 GL 会命中 english、les 会命中 files。
 */
export function shouldForceAsciiBoundary(word: string): boolean {
    return /^[ -~]+$/.test(word) && /[a-z0-9]/i.test(word);
}

/** 判断一个字符是否为 ASCII 字母或数字（ASCII 词边界检查用） */
export function isAsciiWordChar(ch: string | undefined): boolean {
    if (!ch) return false;
    return /[a-z0-9]/.test(ch);
}
