// src/modules/titleGuard/services/rewriter.ts
//
// ⑥ 整改方案生成。输入检测结果，输出「标题改成什么、TAG 摘掉哪些」。
//
// 最重要的一条是 §5.5 的安全阀：**LLM 给的新标题只能是原标题删字的结果**。
// 用子序列校验硬卡死，模型再怎么发挥失常，最坏也只能把标题删短，不可能凭空编出新标题。
// 唯一允许「加字」的路径是黑名单词的替换目标（纯爱牛 → NTR），那是词典里预先定义好的，可控。

import { normalize, toSourceRange } from './normalizer';
import { tokenizeMarker } from './segmenter';
import { detect, pickByPriority, type CompiledConfig } from './ruleEngine';
import type { AppliedTag, DetectResult, ForumTag, GroupId, Match, Violation } from './types';
import type { Judgement } from './llmJudge';

/** 保留哪个分类组是怎么定下来的——通知里要写清楚，作者才服 */
export type KeepSource = 'author' | 'tag' | 'priority' | 'rule' | 'llm' | 'none';

export const KEEP_SOURCE_LABEL: Record<KeepSource, string> = {
    author: '作者自己选的',
    tag: '按帖子挂的 TAG 推断',
    priority: '按社区既定的分类优先级',
    rule: '按交叉互斥规则本身的规定',
    llm: '按语义判定结果',
    none: '未能确定',
};

export interface RewritePlan {
    /** 原标题 */
    originalTitle: string;
    /** 建议的新标题；无需改标题时与原标题相同 */
    newTitle: string;
    /** 要摘掉的 TAG id */
    removeTagIds: string[];
    /** 要补上的 TAG id（目前只有「多路线」） */
    addTagIds: string[];
    /** 决定保留的分类组 */
    keepGroup: GroupId | null;
    keepSource: KeepSource;
    /** 能不能自动执行。false 时必须转人工 */
    autoFixable: boolean;
    /** 不能自动执行的原因 */
    blockedReason: string | null;
    /** 给人看的改动说明 */
    notes: string[];
}

// ============================================================
// 决定保留哪个分类组
// ============================================================

export interface KeepDecisionInput {
    violations: Violation[];
    tags: AppliedTag[];
    compiled: CompiledConfig;
    /** 交叉互斥判出来的赢家。它们已经被规则钦定，排在所有推断之前 */
    crossWinners?: { group: GroupId; byPriority: boolean }[];
    /** 交叉互斥判输、即将被摘掉的分类。不管在哪一侧，都不能再当保留组 */
    crossLosers?: Set<GroupId>;
    /** 作者通过自助面板明确选择的 */
    authorChoice?: GroupId | null;
    judgement?: Judgement | null;
}

/**
 * 按顺序取第一个能定的：
 *   作者选择 → 交叉互斥的赢家 → TAG 唯一 → TAG 冲突按优先级
 *   → LLM 建议 → 标题冲突按优先级（保底） → 定不了。
 *
 * 交叉互斥的赢家排得靠前，是因为那已经是规则算出来的结论，不是推断。
 * 判输的一方则一律排除——不然「标题写 NTR、TAG 挂纯爱」会因为
 * 「纯爱是唯一的 TAG」而被判成保留纯爱，可纯爱正是要摘掉的那个。
 *
 * 注意「标题里声明了什么」不在这条链上。标题和 TAG 谁说了算，
 * 不是靠位置决定的，而是靠分类优先级——那件事在 decideCrossLoser 里办。
 *
 * 「按优先级」是社区既定规则（NTR > NTL > 纯爱）。它出现在两处：
 *   1. 帖子挂了多个互斥 TAG 时，留优先级最高的；
 *   2. 连 TAG 都没有、只有标题在打架时，也照优先级留一个——**这是保底**。
 *
 * 有了保底这一档，「作者到期不改就按权重自动整」才真正兑现，
 * 而不是一遇到没 TAG 的帖子就卡在人工队列里。
 */
export function decideKeepGroup(input: KeepDecisionInput): { group: GroupId | null; source: KeepSource } {
    if (input.authorChoice) return { group: input.authorChoice, source: 'author' };

    const losers = input.crossLosers ?? new Set<GroupId>();

    // 交叉互斥已经判出赢家，且几条判下来是同一个 → 就是它
    const winners = new Set((input.crossWinners ?? []).map(w => w.group));
    if (winners.size === 1) {
        const group = [...winners][0];
        const byPriority = (input.crossWinners ?? []).every(w => w.byPriority);
        return { group, source: byPriority ? 'priority' : 'rule' };
    }

    // TAG 指向的分类组（只看参与 TAG 互斥判定的，且没在交叉互斥里判输）
    const tagGroups = new Set<GroupId>();
    for (const t of input.tags) {
        if (!t.group || losers.has(t.group)) continue;
        if (input.compiled.tagGroupToSet.has(t.group)) tagGroups.add(t.group);
    }
    if (tagGroups.size === 1) return { group: [...tagGroups][0], source: 'tag' };

    if (tagGroups.size > 1) {
        const picked = pickByPriority([...tagGroups], input.compiled.raw);
        if (picked) return { group: picked, source: 'priority' };
    }

    if (input.judgement?.suggestedKeep && input.judgement.confidence !== 'low') {
        return { group: input.judgement.suggestedKeep, source: 'llm' };
    }

    // 保底：TAG 帮不上忙时，就按标题里打架的那几个分类比优先级
    const titleGroups = new Set<GroupId>();
    for (const v of input.violations) {
        if (v.rule !== 'T2' && v.rule !== 'T3') continue;
        for (const g of v.groups) {
            if (losers.has(g)) continue;
            if (input.compiled.wordGroupToSet.has(g)) titleGroups.add(g);
        }
    }
    if (titleGroups.size > 0) {
        const picked = pickByPriority([...titleGroups], input.compiled.raw);
        if (picked) return { group: picked, source: 'priority' };
    }

    return { group: null, source: 'none' };
}

// ============================================================
// 交叉互斥：该摘 TAG 还是该删标题里的词
// ============================================================

/** 交叉互斥判下来输的是哪一边 */
export type CrossLoser = 'tag' | 'word';

/**
 * 一条交叉互斥违规，输的是 TAG 那边还是关键字那边。
 *
 * 规矩很简单：**比分类优先级，低的那边输**，不管它站在哪一侧。
 *   挂纯爱 TAG、标题写 NTR，NTR 优先级高 → 纯爱输 → 摘掉纯爱 TAG；
 *   挂 NTR TAG、标题写纯爱，还是纯爱输 → 这回纯爱在关键字侧 → 删掉标题里的纯爱。
 *
 * 优先级没配、或者两边一样高时，按规矩本身的写法办——
 * 交叉互斥这条规矩是写在 TAG 头上的（「不得挂 X TAG」），所以摘 TAG。
 * 何况改 TAG 成本低也好回退，拿不准时动 TAG 比动作者的标题稳妥。
 */
export function decideCrossLoser(
    violation: Violation,
    compiled: CompiledConfig,
): { loser: CrossLoser; winner: GroupId; wordGroup: GroupId; tagGroup: GroupId; byPriority: boolean } {
    // detect() 里固定按 [关键字侧, TAG 侧] 的顺序塞进去
    const [wordGroup, tagGroup] = violation.groups;
    const priority = compiled.raw.groupPriority ?? {};
    const wordScore = priority[wordGroup] ?? 0;
    const tagScore = priority[tagGroup] ?? 0;

    const loser: CrossLoser = wordScore < tagScore ? 'word' : 'tag';
    return {
        loser,
        winner: loser === 'word' ? tagGroup : wordGroup,
        wordGroup,
        tagGroup,
        // 两边分数一样（含都没配）时不是优先级定的，是按规矩本身的默认方向定的
        byPriority: wordScore !== tagScore,
    };
}

// ============================================================
// 安全阀：只能删字，不能加字
// ============================================================

/**
 * candidate 是否是 original 删去若干字符的结果（子序列关系）。
 * 大小写和全半角按归一化后比较，避免模型顺手把全角括号敲成半角就被判违规。
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

export interface TitleValidation {
    ok: boolean;
    reason: string | null;
}

/**
 * 校验一个候选新标题能不能用。三条全过才算数（设计文档 §5.5）：
 *   1. 只能是原标题删字的结果
 *   2. 重跑检测不得仍然违规
 *   3. 长度合规（Discord 帖子标题上限 100）
 */
export function validateNewTitle(
    originalTitle: string,
    candidate: string,
    tags: AppliedTag[],
    compiled: CompiledConfig,
    options: { allowAddition?: boolean } = {},
): TitleValidation {
    const trimmed = candidate.trim();

    if (!trimmed) return { ok: false, reason: '新标题为空' };
    if (trimmed.length > 100) return { ok: false, reason: `新标题超长（${trimmed.length} > 100）` };

    if (!options.allowAddition && !isDeletionOnly(originalTitle, trimmed)) {
        return { ok: false, reason: '新标题包含原标题里没有的内容（只允许删字）' };
    }

    const recheck = detect({ title: trimmed, tags, config: compiled.raw }, compiled);
    const remaining = recheck.violations.filter(v => !v.needsLlm);
    if (remaining.length > 0) {
        return { ok: false, reason: `改后仍然违规：${remaining.map(v => v.rule).join(' / ')}` };
    }

    return { ok: true, reason: null };
}

// ============================================================
// 标题改写
// ============================================================

interface Edit {
    /** 归一化坐标 */
    start: number;
    end: number;
    /** 替换成什么；空串表示删除 */
    replacement: string;
}

/** 把一组编辑应用到原文（编辑坐标是归一化坐标，先映射回原文） */
function applyEdits(detectResult: DetectResult, edits: Edit[]): string {
    if (edits.length === 0) return detectResult.normalized.original;

    const mapped = edits
        .map(e => ({ ...toSourceRange(detectResult.normalized, e.start, e.end), replacement: e.replacement }))
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
 * 找出**包着这个命中的那一整块**，删的时候连它一起删。
 *
 * 标记段里，这一块就是 token：「可纯爱」「NTL？」「有纯爱版」「怪味纯爱」这类，
 * 作者是把修饰词和分类词写成一个整体，只抠掉关键词会剩下没意义的残渣。
 *
 * 主体段里没有 token，就取**小句**——从命中往两边扩，扩到标点或段落边界为止。
 * 「纯爱版已第四次更新」这种句尾的更新说明，整句删掉才干净；
 * 只删「纯爱」两个字会剩个「版已第四次更新」，比不删还难看。
 */
function enclosingToken(result: DetectResult, m: Match): { start: number; end: number } | null {
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

/**
 * 生成标题改写编辑。
 *
 * T1 黑名单词  → 整词替换为词典里的 replaceTo；没配就删除
 * T2 关键字互斥 → 删掉非保留组的 token（连同其前面的分隔符由 tidyTitle 收拾）
 * T4 交叉互斥   → 只处理「输在关键字那边」的，同样删 token
 * T3 及沾了正文的 → 不在这里处理，走 LLM 的 suggestedTitle + 三条校验
 */
function buildRuleEdits(
    result: DetectResult,
    violations: Violation[],
    keepGroup: GroupId | null,
    compiled: CompiledConfig,
): { edits: Edit[]; notes: string[] } {
    const edits: Edit[] = [];
    const notes: string[] = [];
    const seen = new Set<string>();

    const pushSpan = (span: { start: number; end: number }, note: string, replacement = '') => {
        const key = `${span.start}-${span.end}`;
        if (seen.has(key)) return;
        seen.add(key);
        edits.push({ start: span.start, end: span.end, replacement });
        notes.push(note);
    };

    const push = (m: Match, replacement: string, note: string) => {
        pushSpan({ start: m.start, end: m.end }, note, replacement);
    };

    /**
     * 删掉一个命中所在的**整个 token**，不是关键词本身。
     * 否则「可纯爱」只删掉「纯爱」会剩个孤零零的「可」，
     *「NTL？」只删「NTL」会剩个「？」，「有纯爱版」会剩「有版」。
     */
    const deleteToken = (m: Match, why: string) => {
        const span = enclosingToken(result, m) ?? { start: m.start, end: m.end };
        const where = m.segmentKind === 'marker' ? '标签区里的' : '标题里的';
        pushSpan(span, `删除${where}「${result.normalized.text.slice(span.start, span.end)}」${why}`);
    };

    for (const v of violations) {
        if (v.rule === 'T1') {
            for (const m of v.hits) {
                const to = m.entry.replaceTo ?? '';
                push(m, to, to
                    ? `黑名单词「${m.entry.word}」→「${to}」`
                    : `删除黑名单词「${m.entry.word}」`);
            }
            continue;
        }

        if (v.rule === 'T2') {
            for (const m of v.hits) {
                const group = m.entry.group;
                if (!group || group === keepGroup) continue;
                deleteToken(m, `（保留「${keepGroup ?? '?'}」）`);
            }
            continue;
        }

        // 交叉互斥输在关键字这边 → 删标题里的词。
        // 输在 TAG 那边的不走这里，由 buildPlan 去摘 TAG。
        if (v.rule === 'T4') {
            const { loser, wordGroup, tagGroup } = decideCrossLoser(v, compiled);
            if (loser !== 'word') continue;
            for (const m of v.hits) {
                if (m.entry.group !== wordGroup) continue;
                deleteToken(m, `（与「${tagGroup}」TAG 冲突，且优先级更低）`);
            }
        }
    }

    return { edits, notes };
}

// ============================================================
// 组装完整方案
// ============================================================

export interface BuildPlanInput {
    detectResult: DetectResult;
    tags: AppliedTag[];
    /** 论坛可用的全部 TAG。补「多路线」TAG 时要从这里找它的 id */
    availableTags?: ForumTag[];
    compiled: CompiledConfig;
    authorChoice?: GroupId | null;
    judgement?: Judgement | null;
    /** LLM 判定「不是分类标记」时，所有待定性的违规全部作废 */
    llmCleared?: boolean;
}

export function buildPlan(input: BuildPlanInput): RewritePlan {
    const { detectResult, tags, compiled } = input;
    const originalTitle = detectResult.normalized.original;

    // LLM 判定这些词不是分类标记 → 需要 LLM 定性的违规全部作废
    const effective = input.llmCleared
        ? detectResult.violations.filter(v => !v.needsLlm)
        : detectResult.violations;

    if (effective.length === 0) {
        return {
            originalTitle,
            newTitle: originalTitle,
            removeTagIds: [],
            addTagIds: [],
            keepGroup: null,
            keepSource: 'none',
            autoFixable: true,
            blockedReason: null,
            notes: ['无需整改'],
        };
    }

    // 标题的标签区里明写出来的分类组。只认「确信是标签区」的那些段——
    // 靠排版推断出来的、括号没闭合的都不算数，那些得先过 LLM。
    // 这里不筛互斥集合：百破这种不参与关键字互斥的组，一样是作者的分类声明。
    const titleDeclared = detectResult.matches
        .filter(m => m.segmentKind === 'marker'
            && detectResult.segments[m.segmentIndex]?.confident
            && m.entry.kind !== '白名单' && m.entry.kind !== '中性标记'
            && m.entry.group)
        .map(m => m.entry.group as GroupId);

    // 交叉互斥的输赢。只看优先级，不依赖保留组，所以可以先算出来。
    // crossWordLosers 是其中「输在关键字这边」的，它们要从标题里删掉。
    const crossWordLosers = new Set<GroupId>();
    const crossLosers = new Set<GroupId>();
    const crossWinners: { group: GroupId; byPriority: boolean }[] = [];
    for (const v of effective) {
        if (v.rule !== 'T4') continue;
        const r = decideCrossLoser(v, compiled);
        crossLosers.add(r.loser === 'word' ? r.wordGroup : r.tagGroup);
        if (r.loser === 'word') crossWordLosers.add(r.wordGroup);
        crossWinners.push({ group: r.winner, byPriority: r.byPriority });
    }

    const { group: keepGroup, source: keepSource } = decideKeepGroup({
        violations: effective,
        tags,
        compiled,
        crossWinners,
        crossLosers,
        authorChoice: input.authorChoice,
        judgement: input.judgement,
    });

    const notes: string[] = [];

    // 还有违规等着 LLM 定性、而判定结果又还没回来 → 什么都别做。
    // 反例：《真正的橘子味世界不允许百合破坏的存在！》挂百合 TAG，
    // 「百合破坏」是句子的一部分而不是分类标记，没等定性就把 TAG 摘了是误伤。
    // 真机上由 enforcer 保证先调 LLM，但这道闸不能只靠调用方记得。
    if (!input.judgement && effective.some(v => v.needsLlm)) {
        return {
            originalTitle,
            newTitle: originalTitle,
            removeTagIds: [],
            addTagIds: [],
            keepGroup: null,
            keepSource: 'none',
            autoFixable: false,
            blockedReason: '标题里的分类词还没定性，要等语义判定结果',
            notes,
        };
    }

    // ---------- TAG 改写 ----------
    const removeTagIds = new Set<string>();
    for (const v of effective) {
        if (v.rule === 'G1') {
            // 摘掉非保留组的 TAG
            for (const t of tags) {
                if (!t.group || t.group === keepGroup) continue;
                if (!v.groups.includes(t.group)) continue;
                removeTagIds.add(t.tagId);
                notes.push(`摘掉互斥 TAG「${t.tagName}」`);
            }
            continue;
        }
        if (v.rule === 'T4') {
            const { loser, wordGroup } = decideCrossLoser(v, compiled);
            // 输在关键字那边的由标题改写去处理，这里只管摘 TAG
            if (loser !== 'tag') continue;
            for (const tagId of v.tagIds) {
                removeTagIds.add(tagId);
                const t = tags.find(x => x.tagId === tagId);
                notes.push(`摘掉与标题里「${wordGroup}」冲突的 TAG「${t?.tagName ?? tagId}」`);
            }
        }
    }

    // G1 多个互斥 TAG 时，decideKeepGroup 已按社区优先级（NTR > NTL > 纯爱）选好了保留组。
    // 走到这里还定不了，说明优先级压根没配，那才是真的不敢动。
    const hasG1 = effective.some(v => v.rule === 'G1');
    if (hasG1 && !keepGroup) {
        return {
            originalTitle,
            newTitle: originalTitle,
            removeTagIds: [],
            addTagIds: [],
            keepGroup: null,
            keepSource,
            autoFixable: false,
            blockedReason: 'TAG 互相冲突，且没有配置分类优先级，无法判断该保留哪个',
            notes,
        };
    }

    // 摘掉了互斥 TAG 就补上「多路线」——原来挂多个互斥 TAG 的帖子，作者的意思
    // 通常就是「有多条线」，规范写法是「主分类 + 多路线」。
    // 注意这只作用于 TAG；标题里的「多路线」三个字机器人不会替作者加。
    const addTagIds = new Set<string>();

    // 摘掉交叉冲突的 TAG 之后，帖子可能就没有分类 TAG 了。
    // 标题声明的分类如果论坛里正好有对应 TAG，就补上去。
    // 有几个前提：
    //   · 这个 TAG 自己不能又撞上标题里别的关键字（不然摘了又补回一个违规）；
    //   · 论坛里没有对应 TAG 的（比如百破就没有），只摘不补，那只是少个标签，不算改坏。
    if (effective.some(v => v.rule === 'T4')) {
        // 标题里即将被删掉的那些分类，不能再拿来补 TAG——
        // 否则「标题写 NTL、TAG 挂 NTR」会一边删掉标题里的 NTL、一边补上 NTL 的 TAG。
        const dropped = new Set<GroupId>(crossWordLosers);
        for (const v of effective) {
            if (v.rule !== 'T2') continue;
            for (const g of v.groups) if (g !== keepGroup) dropped.add(g);
        }

        const stillDeclared = new Set(titleDeclared.filter(g => !dropped.has(g)));
        const candidates = [...stillDeclared].filter(g => {
            const banned = compiled.crossByTag.get(g);
            if (banned && [...stillDeclared].some(w => banned.has(w))) return false;
            return (input.availableTags ?? []).some(t => t.group === g);
        });

        if (candidates.length === 1) {
            const group = candidates[0];
            const already = tags.some(t => t.group === group && !removeTagIds.has(t.tagId));
            const available = (input.availableTags ?? []).find(t => t.group === group);
            if (!already && available) {
                addTagIds.add(available.tagId);
                notes.push(`补上和标题一致的「${available.tagName}」TAG`);
            }
        }
    }

    const multiRouteGroup = compiled.raw.multiRouteGroup;
    if (hasG1 && multiRouteGroup) {
        const already = tags.some(t => t.group === multiRouteGroup);
        const available = (input.availableTags ?? []).find(t => t.group === multiRouteGroup);
        if (!already && available) {
            addTagIds.add(available.tagId);
            notes.push(`补上「${available.tagName}」TAG`);
        }
    }

    // ---------- 标题改写 ----------
    //
    // 复核新标题时必须用**方案执行后的 TAG**，不能用原始 TAG。
    // 否则只要 TAG 也冲突（G1），复核就会一直看到 G1 没解决而判定「改后仍然违规」，
    // 标题改写就永远被回退——TAG 冲突 + 标题冲突的帖子会全部卡死。
    const addedTags = (input.availableTags ?? []).filter(t => addTagIds.has(t.tagId));
    const tagsAfterPlan: AppliedTag[] = [
        ...tags.filter(t => !removeTagIds.has(t.tagId)),
        ...addedTags.filter(t => !tags.some(x => x.tagId === t.tagId)),
    ];

    // T4 只有「输在关键字那边」时才要动标题，输在 TAG 那边就只是摘 TAG
    const crossNeedsTitleFix = effective.some(v =>
        v.rule === 'T4' && decideCrossLoser(v, compiled).loser === 'word');
    const needTitleFix = crossNeedsTitleFix
        || effective.some(v => v.rule === 'T1' || v.rule === 'T2' || v.rule === 'T3');
    let newTitle = originalTitle;

    if (needTitleFix) {
        // 交叉互斥判输在关键字这边 → 该删哪个词已经明确，程序自己动手：
        // 标记段里删整个 token，主体段里删整个小句。走到这一步时
        // 「这些词算不算分类标记」要么本来就没疑问，要么模型已经确认过了。
        //
        // T3 不一样：正文里两个分类打架，删哪一整句都可能把标题掏空
        // （反例：纯爱牛头人日记），那才真的需要模型给改写方案。
        // 但有个前提：正文里不能有两个互斥分类在打架。
        // 有 T3 就说明打起来了，这时候删哪一小句都可能把标题整个掏空
        // （反例：「纯爱牛头人日记」整条标题就是一小句），只能让模型给方案。
        const proseIsContested = effective.some(v => v.rule === 'T3');
        const crossTitleFixes = proseIsContested ? [] : effective.filter(v =>
            v.rule === 'T4' && decideCrossLoser(v, compiled).loser === 'word');

        const ruleViolations = [
            ...effective.filter(v => v.rule === 'T1' || v.rule === 'T2'),
            ...crossTitleFixes,
        ];
        const llmViolations = effective.filter(v => v.rule === 'T3');

        if (ruleViolations.length > 0) {
            if (!keepGroup && ruleViolations.some(v => v.rule === 'T2')) {
                return {
                    originalTitle,
                    newTitle: originalTitle,
                    removeTagIds: [...removeTagIds],
            addTagIds: [...addTagIds],
                    keepGroup: null,
                    keepSource,
                    autoFixable: false,
                    blockedReason: '标记段里有互斥分类，但 TAG 也定不了该保留哪个，需要人工确认',
                    notes,
                };
            }
            const built = buildRuleEdits(detectResult, ruleViolations, keepGroup, compiled);
            newTitle = tidyTitle(applyEdits(detectResult, built.edits));
            notes.push(...built.notes);
        }

        if (llmViolations.length > 0) {
            const suggested = input.judgement?.suggestedTitle;
            if (!suggested) {
                return {
                    originalTitle,
                    newTitle,
                    removeTagIds: [...removeTagIds],
            addTagIds: [...addTagIds],
                    keepGroup,
                    keepSource,
                    autoFixable: false,
                    blockedReason: '标题正文里的分类词需要人工判断如何改写',
                    notes,
                };
            }
            // 关键：LLM 的建议必须只能是原标题删字的结果
            const check = validateNewTitle(newTitle, suggested, tagsAfterPlan, compiled);
            if (!check.ok) {
                return {
                    originalTitle,
                    newTitle,
                    removeTagIds: [...removeTagIds],
            addTagIds: [...addTagIds],
                    keepGroup,
                    keepSource,
                    autoFixable: false,
                    blockedReason: `模型给的改写方案没通过校验：${check.reason}`,
                    notes,
                };
            }
            newTitle = tidyTitle(suggested);
            notes.push(`按判定结果改写标题（理由：${input.judgement?.reason ?? '—'}）`);
        }
    }

    // ---------- 最终复核 ----------
    if (newTitle !== originalTitle) {
        // 黑名单替换是允许「加字」的唯一路径（替换目标来自词典，可控）
        const allowAddition = effective.some(v => v.rule === 'T1' && v.hits.some(h => h.entry.replaceTo));
        const check = validateNewTitle(originalTitle, newTitle, tagsAfterPlan, compiled, { allowAddition });
        if (!check.ok) {
            return {
                originalTitle,
                newTitle: originalTitle,
                removeTagIds: [...removeTagIds],
            addTagIds: [...addTagIds],
                keepGroup,
                keepSource,
                autoFixable: false,
                blockedReason: `自动改写结果没通过复核：${check.reason}`,
                notes,
            };
        }
    }

    return {
        originalTitle,
        newTitle,
        removeTagIds: [...removeTagIds],
            addTagIds: [...addTagIds],
        keepGroup,
        keepSource,
        autoFixable: true,
        blockedReason: null,
        notes,
    };
}

/** 标记段 token 化的再导出，供面板展示用 */
export { tokenizeMarker };
