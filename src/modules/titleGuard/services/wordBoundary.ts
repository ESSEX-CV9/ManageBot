// src/modules/titleGuard/services/wordBoundary.ts
//
// 中文分词闸：只让「正好是一个词」的命中通过。
//
// 为什么需要它：词典匹配是按字面找子串的，中文没有空格，很容易咬进一句大白话——
//   「班上的乖乖女同学」   里找到「女同」→ 误判成百合
//   「章鱼妹妹库拉拉」     里找到「拉拉」→ 误判成百合
//   「我说纯爱牛逼」       里找到「纯爱牛」→ 误判成黑名单词
// 这些不是语义问题，是**词根本不在那儿**：字凑巧连在一起，但分属两个词。
// 拿分词器切一遍，只保留起止都落在词边界上的命中，这类误判整片消失。
//
// 两条边界：
//   1. **只管主体段。** 标记段是标签罗列（「ntl/后宫/有纯爱版」），不是句子，
//      分词器的语言模型在那儿不适用，硬套反而会把正当的标签判没。
//   2. **黑名单词不进分词器词库。** 黑名单收的是「不该出现的写法」（纯爱牛），
//      它本来就不是汉语词。灌进去的话分词器会主动把「纯爱牛逼」切成「纯爱牛/逼」，
//      正好把要挡的误判又造回来。
//
// 分类词典里的行话（百破、寝取、NTL……）分词器不认识，得灌进去，
// 否则它会把「百破逆袭」粘成一个词，害得正当命中反被挡掉。
// 词频给得低一些：够让它被认成一个词，又不至于压过「女同学」这种常用词。

import { createRequire } from 'node:module';

import type { SegmenterWord } from './types';

/** 分类词典里的行话灌进分词器时的词频。50 ≈「确实是个词但不常用」，实测这一档误挡最少 */
const JARGON_FREQUENCY = 50;

/** 「补词」的词频。要足够高，压得过分词器原本的切法 */
const ADD_FREQUENCY = 500;

/** 「拆词」的词频。0 = 词还在库里但概率压到最低，分词器就改走拆开那条路 */
const SPLIT_FREQUENCY = 0;

/** 分词器实例缓存上限。词表一改就换一份，留几份够用了 */
const MAX_CACHED = 4;

export interface BoundaryOracle {
    /**
     * 这段文字里所有词边界的下标（含 0 和末尾）。
     * 分词器不可用时返回 null —— 调用方据此放行全部命中，退回加装分词器之前的行为。
     */
    boundariesOf(text: string): Set<number> | null;
    /** 分词器有没有真的加载起来 */
    available: boolean;
}

interface JiebaLike {
    cut(sentence: string, hmm?: boolean): string[];
    loadDict(dict: Uint8Array): void;
}

const NOOP: BoundaryOracle = { boundariesOf: () => null, available: false };

let loadFailed = false;

/** 懒加载分词器。装不上就一次性告警，然后整套逻辑退回原样，绝不让机器人起不来 */
function loadJieba(lines: string[]): JiebaLike | null {
    if (loadFailed) return null;
    try {
        const require = createRequire(__filename);
        const { Jieba } = require('@node-rs/jieba') as { Jieba: { withDict(d: Uint8Array): JiebaLike } };
        const { dict } = require('@node-rs/jieba/dict') as { dict: Uint8Array };

        const jieba = Jieba.withDict(dict);
        if (lines.length > 0) {
            jieba.loadDict(Buffer.from(lines.join('\n') + '\n', 'utf8'));
        }
        return jieba;
    } catch (err) {
        loadFailed = true;
        console.warn('[TitleGuard] 中文分词器加载失败，主体段的词边界检查已关闭。'
            + '匹配会退回纯字面模式，「女同学」里的「女同」这类误判会重新出现。原因：',
            err instanceof Error ? err.message : err);
        return null;
    }
}

const cache = new Map<string, BoundaryOracle>();

/**
 * 按一份词表建一个边界判定器。
 * 同一份词表复用同一个分词器实例——每次新建都要重新载入几 MB 的基础词库，
 * 而调试台是每个请求都重编译一次词典的。
 */
export function getBoundaryOracle(jargon: string[], tuning: SegmenterWord[] = []): BoundaryOracle {
    // 手工配的排在后面：同一个词重复出现时后来者覆盖前者，
    // 管理组因此能推翻行话的默认词频
    const normalized = [
        ...[...new Set(jargon.map(w => w.trim()).filter(Boolean))].sort()
            .map(w => `${w} ${JARGON_FREQUENCY}`),
        ...tuning
            .filter(t => t.word?.trim())
            .map(t => `${t.word.trim()} ${t.action === '拆词' ? SPLIT_FREQUENCY : ADD_FREQUENCY}`),
    ];
    const key = normalized.join('\n');

    const hit = cache.get(key);
    if (hit) return hit;

    const jieba = loadJieba(normalized);
    const oracle: BoundaryOracle = jieba
        ? {
            available: true,
            boundariesOf(text: string) {
                const set = new Set<number>([0]);
                let at = 0;
                // hmm=true：让它用统计模型兜住词库里没有的词，切得更贴近真实语感
                for (const token of jieba.cut(text, true)) {
                    at += token.length;
                    set.add(at);
                }
                return set;
            },
        }
        : NOOP;

    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
    cache.set(key, oracle);
    return oracle;
}

/** 仅供测试/诊断：分词器到底能不能用 */
export function isSegmenterAvailable(): boolean {
    return getBoundaryOracle([]).available;
}

/** 仅供调试台：把一段文字按当前词库切一遍，让人肉眼看分词结果 */
export function cutForDebug(
    text: string, jargon: string[], tuning: SegmenterWord[] = [],
): string[] | null {
    const oracle = getBoundaryOracle(jargon, tuning);
    if (!oracle.available) return null;
    const bounds = [...(oracle.boundariesOf(text) ?? [])].sort((a, b) => a - b);
    const out: string[] = [];
    for (let i = 1; i < bounds.length; i++) out.push(text.slice(bounds[i - 1], bounds[i]));
    return out;
}
