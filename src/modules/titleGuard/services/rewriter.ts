// src/modules/titleGuard/services/rewriter.ts
//
// ⑥ 整改方案生成。输入检测结果，输出「标题改成什么、TAG 摘哪些补哪些」。
//
// ============================================================
// 分两段，边界就是「归谁管」那条线
// ============================================================
//
// 【第一段·程序】处理 arbiter === '程序' 的违规。
//   全都是作者明写在标签区里的声明，或者纯粹 TAG 之间打架，按保留顺序直接改。
//   **这一段绝不碰标题主体里的一个字。**
//
// 【第二段·模型】第一段做完还剩 arbiter === 'LLM' 的违规才走。
//   模型拿到的是：标题、切分、还在场的命中清单（标明词档和位置）、
//   原 TAG、第一段改完之后的 TAG、以及首楼节选。
//   它按三步走——先给帖子定性，再核 TAG，最后逐处决定删/换/留。
//
// 两段的编辑用的是**同一套坐标**（原标题归一化后的下标），最后一次性拼出新标题。
// 不做「改完再检测一遍接着改」的串联，那样第二段看到的标题和它被问的时候不是同一个，
// 编号会错位，错位的后果是删错词。
//
// 第二段交回来的答卷要过校验（validateModelPlan）。没过就打回重写，
// 并且告诉它**具体还剩哪条没解决**，而不是笼统一句「不合规」。

import { detect, pickByPriority, declarationOf, classifyingGroup, tierOf,
    type CompiledConfig } from './ruleEngine';
import {
    applyDecisions,
    applySpanEdits,
    enclosingToken,
    isDeletionOnly,
    tidyTitle,
    tokenizeMarker,
    type SpanEdit,
} from './titleEdit';
import { normalize } from './normalizer';
import type {
    AppliedTag,
    DetectResult,
    ForumTag,
    GroupId,
    GuardConfig,
    Match,
    Violation,
} from './types';
import type { Judgement } from './llmJudge';

export { tidyTitle, isDeletionOnly, tokenizeMarker };

/** 保留哪个分类组是怎么定下来的——通知里要写清楚，作者才服 */
export type KeepSource = 'author' | 'tag' | 'priority' | 'rule' | 'llm' | 'none';

export const KEEP_SOURCE_LABEL: Record<KeepSource, string> = {
    author: '按作者自己在标签区里的声明',
    tag: '按帖子挂的 TAG 推断',
    priority: '按社区既定的分类保留顺序',
    rule: '按互斥规则本身的规定',
    llm: '按模型对作品的定性',
    none: '未能确定',
};

export interface RewritePlan {
    /** 原标题 */
    originalTitle: string;
    /** 建议的新标题；无需改标题时与原标题相同 */
    newTitle: string;
    /** 要摘掉的 TAG id */
    removeTagIds: string[];
    /** 要补上的 TAG id */
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
    /**
     * 还在等模型表态。
     * 这不是「转人工」——调用方该做的是去调模型，而不是叫管理组来。
     */
    awaitingModel: boolean;
    /**
     * 模型的答卷没过校验。
     * 有值就说明「还能再抢救一下」：带着这里的理由让它重写一次，
     * 比直接转人工强，模型上一次多半只是没意识到整改后 TAG 也跟着变了。
     */
    modelRejection: ModelRejection | null;
}

/**
 * 模型的答卷被打回了。
 * remaining 是用人话写的「还剩哪条没解决」，直接贴进重写提示词里。
 */
export interface ModelRejection {
    /** 模型这一版改出来的标题 */
    titleTried: string;
    /** 一句话说明为什么不能用 */
    reason: string;
    /** 改完仍然存在的问题，原话 */
    remaining: string[];
    /** 按模型的方案执行后，帖子会挂的 TAG */
    tagsAfter: string[];
}

// ============================================================
// TAG 小工具
// ============================================================

function tagOfGroup(forumTags: ForumTag[], group: GroupId): ForumTag | null {
    return forumTags.find(t => t.group === group) ?? null;
}

/** 两个分类组在 TAG 维度上是不是互斥（挂了一个就不能挂另一个） */
function tagGroupsClash(a: GroupId, b: GroupId, compiled: CompiledConfig): boolean {
    if (a === b) return false;
    const setsOfA = compiled.tagGroupToSet.get(a) ?? [];
    const setsOfB = compiled.tagGroupToSet.get(b) ?? [];
    return setsOfA.some(i => setsOfB.includes(i));
}

function applyTagChanges(
    tags: AppliedTag[],
    removeTagIds: Iterable<string>,
    addTagIds: Iterable<string>,
    forumTags: ForumTag[],
): AppliedTag[] {
    const removed = new Set(removeTagIds);
    const out = tags.filter(t => !removed.has(t.tagId));
    for (const id of addTagIds) {
        if (out.some(t => t.tagId === id)) continue;
        const found = forumTags.find(t => t.tagId === id);
        if (found) out.push(found);
    }
    return out;
}

// ============================================================
// 第一段：程序裁决
// ============================================================

export interface ProgramStage {
    /** 这一段产生的标题编辑，坐标是原标题归一化后的下标 */
    edits: SpanEdit[];
    /** 这一段动过的命中。第二段不用再管它们 */
    handled: Set<Match>;
    removeTagIds: Set<string>;
    addTagIds: Set<string>;
    /** 执行完这一段之后帖子会挂的 TAG */
    tagsAfter: AppliedTag[];
    keepGroup: GroupId | null;
    keepSource: KeepSource;
    notes: string[];
    /** 程序本该判、却判不了的（比如涉事分类没配保留顺序）。有内容就得转人工 */
    blocked: string[];
}

/**
 * 跑第一段。
 *
 * 也被 previewTagPlan 拿去算「自动整改后 TAG 长什么样」——
 * 问模型的时候必须把这个结果告诉它，否则它是在对着一份过期的 TAG 做判断。
 * 两处共用同一个函数，不会各算各的然后对不上。
 */
export function planProgramStage(input: {
    detectResult: DetectResult;
    tags: AppliedTag[];
    forumTags: ForumTag[];
    compiled: CompiledConfig;
    /**
     * 作者在自助面板上亲手选的「我这篇是哪一类」。
     * 只要他选的那一类确实在冲突里，就压过社区保留顺序——
     * 保留顺序是没人表态时的兜底，作者本人开口了就该听他的。
     */
    authorChoice?: GroupId | null;
}): ProgramStage {
    const { detectResult, tags, forumTags, compiled, authorChoice } = input;
    const config = compiled.raw;
    const segments = detectResult.segments;
    const declared = (m: Match) => declarationOf(m, segments) === '声明';

    const edits: SpanEdit[] = [];
    const handled = new Set<Match>();
    const removeTagIds = new Set<string>();
    const addTagIds = new Set<string>();
    const notes: string[] = [];
    const blocked: string[] = [];
    let keepGroup: GroupId | null = null;
    let keepSource: KeepSource = 'none';

    const setKeep = (g: GroupId, source: KeepSource) => {
        if (!keepGroup) { keepGroup = g; keepSource = source; }
    };

    /**
     * 这组冲突里该留哪一个。
     * 作者自己选过就听他的，否则按社区既定的保留顺序。
     */
    const survivorOf = (groups: GroupId[]): { group: GroupId | null; source: KeepSource } => {
        if (authorChoice && groups.includes(authorChoice)) {
            return { group: authorChoice, source: 'author' };
        }
        return { group: pickByPriority(groups, config), source: 'priority' };
    };

    const dropToken = (m: Match) => {
        const span = enclosingToken(detectResult, m) ?? { start: m.start, end: m.end };
        edits.push({ start: span.start, end: span.end, replacement: '' });
        handled.add(m);
    };

    const program = detectResult.violations.filter(v => v.arbiter === '程序');

    // ---------- B 污染词（只处理明写在标签区里的）----------
    for (const v of program) {
        if (v.rule !== 'B') continue;
        for (const m of v.hits) {
            if (!declared(m)) continue;
            if (m.entry.replaceTo) {
                edits.push({ start: m.start, end: m.end, replacement: m.entry.replaceTo });
                handled.add(m);
                notes.push(`标签区的「${m.entry.word}」换成「${m.entry.replaceTo}」`
                    + `——这个词里带着别人的分类名，会污染那个词的搜索结果`);
            } else {
                dropToken(m);
                notes.push(`删掉标签区的「${m.entry.word}」`);
            }
            if (m.entry.group) setKeep(m.entry.group, 'rule');
        }
    }

    // ---------- W 标签区里自己打架 ----------
    //
    // 只删**标签区里**输掉那一方的词。同一个组要是在正文里也有，一律留着不动——
    // 正文归模型管。留下来的那处会在下一轮检测里跟幸存组撞上，自然被路由去问模型。
    for (const v of program) {
        if (v.rule !== 'W') continue;

        const settled = v.groups.filter(
            g => v.hits.some(h => classifyingGroup(h) === g && declared(h)));
        const { group: survivor, source } = survivorOf(settled);
        if (!survivor) {
            blocked.push(`标签区里同时声明了 ${settled.join(' / ')}，`
                + '这几类没配保留顺序，程序不替作者做主');
            continue;
        }
        setKeep(survivor, source);

        for (const m of v.hits) {
            if (!declared(m)) continue;
            if (classifyingGroup(m) === survivor) continue;
            dropToken(m);
        }
        notes.push(`标签区里 ${settled.join(' / ')} 互斥，按保留顺序留下「${survivor}」`);
    }

    // ---------- G TAG × TAG ----------
    const byGroupTag = new Map<GroupId, AppliedTag[]>();
    for (const t of tags) {
        if (!t.group) continue;
        const list = byGroupTag.get(t.group);
        if (list) list.push(t);
        else byGroupTag.set(t.group, [t]);
    }

    for (const v of program) {
        if (v.rule !== 'G') continue;

        const { group: survivor, source } = survivorOf(v.groups);
        if (!survivor) {
            blocked.push(`帖子同时挂了 ${v.groups.join(' / ')} 这几个互斥 TAG，`
                + '它们没配保留顺序，程序不替作者做主');
            continue;
        }
        setKeep(survivor, source);

        for (const g of v.groups) {
            if (g === survivor) continue;
            for (const t of byGroupTag.get(g) ?? []) removeTagIds.add(t.tagId);
        }
        notes.push(`TAG ${v.groups.join(' / ')} 互斥，按保留顺序留下「${survivor}」`);

        // 原本挂了好几个互斥分类，作者的意思通常是「有多条线」，补上这个中性 TAG
        if (config.multiRouteGroup) {
            const mr = tagOfGroup(forumTags, config.multiRouteGroup);
            if (mr && !tags.some(t => t.tagId === mr.tagId)) {
                addTagIds.add(mr.tagId);
                notes.push(`补上「${mr.tagName}」TAG`);
            }
        }
    }

    // ---------- X TAG × 标签区里的关键字 ----------
    //
    // 方向是定死的：**标题赢，改 TAG。**
    // 标题是作者一个字一个字敲的，TAG 是发帖时随手点的，点错太常见。
    for (const v of program) {
        if (v.rule !== 'X') continue;
        const [wordGroup, tagGroup] = v.groups;

        for (const id of v.tagIds) removeTagIds.add(id);
        setKeep(wordGroup, 'author');

        const replacement = tagOfGroup(forumTags, wordGroup);
        if (replacement && !tags.some(t => t.tagId === replacement.tagId)) {
            addTagIds.add(replacement.tagId);
            notes.push(`标签区声明的是「${wordGroup}」，把「${tagGroup}」TAG 换成「${replacement.tagName}」`);
        } else {
            notes.push(`标签区声明的是「${wordGroup}」，摘掉冲突的「${tagGroup}」TAG`
                + (replacement ? '' : `（本论坛没有「${wordGroup}」TAG，只摘不补）`));
        }
    }

    // ---------- 补 TAG 前先看看会不会又撞上 ----------
    //
    // 摘一个补一个的时候很容易自己给自己造一条新的 TAG 冲突：
    // 比如 X 规则要补 NTR TAG，而 G 规则刚决定留下 NTL TAG，两者在 TAG 维度互斥。
    const keptGroups = tags
        .filter(t => t.group && !removeTagIds.has(t.tagId))
        .map(t => t.group!) as GroupId[];

    for (const id of [...addTagIds]) {
        const candidate = forumTags.find(t => t.tagId === id);
        if (!candidate?.group) continue;
        const clash = keptGroups.find(g => tagGroupsClash(candidate.group!, g, compiled));
        if (clash) {
            addTagIds.delete(id);
            notes.push(`本来想补「${candidate.tagName}」TAG，但它和保留下来的「${clash}」互斥，作罢`);
        }
    }

    return {
        edits,
        handled,
        removeTagIds,
        addTagIds,
        tagsAfter: applyTagChanges(tags, removeTagIds, addTagIds, forumTags),
        keepGroup,
        keepSource,
        notes,
        blocked,
    };
}

/**
 * 「自动整改之后 TAG 会变成什么样」，问模型之前必须先算出来告诉它。
 * 直接复用第一段，不另写一份。
 */
export function previewTagPlan(input: {
    detectResult: DetectResult;
    tags: AppliedTag[];
    forumTags: ForumTag[];
    compiled: CompiledConfig;
}): { after: string[]; changes: string[] } {
    const stage = planProgramStage(input);
    const after = stage.tagsAfter.map(t => t.tagName);
    const changes: string[] = [];

    for (const id of stage.removeTagIds) {
        const t = input.tags.find(x => x.tagId === id);
        if (t) changes.push(`摘掉「${t.tagName}」`);
    }
    for (const id of stage.addTagIds) {
        const t = input.forumTags.find(x => x.tagId === id);
        if (t) changes.push(`补上「${t.tagName}」`);
    }

    return { after, changes };
}

// ============================================================
// 第二段要问模型的是哪几处
// ============================================================

/**
 * 还在场、需要模型表态的命中，**编号顺序的唯一来源**。
 *
 * 只包含「参与了某条 LLM 裁决违规」且「第一段没动过」的命中。
 * 拼提示词的地方和解析回答的地方都从这儿取，各写各的迟早错位。
 */
export function pendingHits(detectResult: DetectResult, stage: ProgramStage): Match[] {
    const inPlay = new Set<Match>();
    for (const v of detectResult.violations) {
        if (v.arbiter !== 'LLM') continue;
        for (const h of v.hits) {
            if (!stage.handled.has(h)) inPlay.add(h);
        }
    }
    // 按在标题里的先后排，编号才符合阅读顺序
    return detectResult.matches.filter(m => inPlay.has(m));
}

// ============================================================
// 第三段：校验模型的答卷
// ============================================================

/**
 * 模型交回来的方案能不能用。
 *
 * 放行的口子只有两个，都卡得很死：
 *
 * 一、**本篇自己那一类的本体词**。作品定性为纯爱，标题里写着「纯爱」，
 *     那不是污染，那正是它该出现的地方。所以只有**别的类**的本体词必须清掉。
 *
 * 二、**正文里的关联词**，模型明确判了「保留」并说明它在描述人物或情节。
 *     这类词没污染任何一个受保护关键字（绿帽、黄毛的词面里既没有「NTR」
 *     也没有「纯爱」），留着不会让搜索串行。
 *
 * 其余一律打回：
 *   - 别的类的本体词还留在正文里 → 不行。那几个字只要在标题里，
 *     搜它就一定命中，跟它在句子里当什么成分毫无关系。
 *   - 标签区里还剩冲突 → 不行，那本来就轮不到模型定夺。
 *   - 模型定的 TAG 自己就互斥 → 不行。
 */
function validateModelPlan(input: {
    finalTitle: string;
    finalTags: AppliedTag[];
    keptWords: Set<string>;
    /** 模型给这篇定的性。它自己那一类的本体词可以留在标题里 */
    verdict: GroupId;
    compiled: CompiledConfig;
    problems: string[];
}): { ok: true } | { ok: false; reason: string; remaining: string[] } {
    const { finalTitle, finalTags, keptWords, verdict, compiled, problems } = input;

    if (problems.length > 0) {
        return { ok: false, reason: '处理指令本身有问题', remaining: problems };
    }
    if (!finalTitle.trim()) {
        return { ok: false, reason: '改出来的标题是空的', remaining: ['标题不能删成空的'] };
    }
    if (finalTitle.length > 100) {
        return {
            ok: false,
            reason: `改出来的标题超长（${finalTitle.length} > 100）`,
            remaining: [`Discord 帖子标题最多 100 个字符，现在是 ${finalTitle.length} 个`],
        };
    }

    const recheck = detect(
        { title: finalTitle, tags: finalTags, config: compiled.raw },
        compiled,
    );

    const remaining: string[] = [];
    for (const v of recheck.violations) {
        if (v.arbiter === '程序') {
            remaining.push(`${v.message}——这条在标签区里，本来就该处理掉`);
            continue;
        }

        // 逐处看这条冲突还剩哪些命中，够不够格被放过
        const offenders: string[] = [];
        for (const h of v.hits) {
            const declaredHere = declarationOf(h, recheck.segments) === '声明';
            if (declaredHere) {
                offenders.push(`标签区里还留着「${h.entry.word}」`);
                continue;
            }
            // 本篇自己那一类的词不算污染，写在标题里天经地义
            if (classifyingGroup(h) === verdict) continue;

            if (tierOf(h) === '本体') {
                offenders.push(`正文里还留着本体词「${h.entry.word}」，`
                    + `可你把这篇定性成了「${verdict}」`
                    + '——这几个字只要在标题里，别人搜它就一定搜得到，'
                    + '不管它在句子里是什么成分，所以不能用「只是描述」放过；'
                    + '觉得删了不通顺就用「替换」');
                continue;
            }
            if (!keptWords.has(h.entry.word)) {
                offenders.push(`正文里的「${h.entry.word}」你一句话都没说，得表个态`);
            }
            // 关联词 + 明确判了保留 → 放行
        }

        if (offenders.length > 0) remaining.push(`${v.message}：${offenders.join('；')}`);
    }

    // 模型自己定的 TAG 别打架
    const groups = finalTags.map(t => t.group).filter(Boolean) as GroupId[];
    for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
            if (tagGroupsClash(groups[i], groups[j], compiled)) {
                remaining.push(`你定的 TAG 里「${groups[i]}」和「${groups[j]}」本身就互斥，只能留一个`);
            }
        }
    }

    if (remaining.length > 0) {
        return { ok: false, reason: '按你的方案改完之后还是不合规', remaining };
    }
    return { ok: true };
}

// ============================================================
// 组装
// ============================================================

export interface BuildPlanInput {
    detectResult: DetectResult;
    tags: AppliedTag[];
    forumTags: ForumTag[];
    compiled: CompiledConfig;
    /** 作者在自助面板上亲手选的分类，压过社区保留顺序 */
    authorChoice?: GroupId | null;
    /** 模型的答卷。没有就先只跑第一段 */
    judgement?: Judgement | null;
}

export function buildPlan(input: BuildPlanInput): RewritePlan {
    const { detectResult, tags, forumTags, compiled, authorChoice, judgement } = input;
    const originalTitle = detectResult.normalized.original;

    const stage = planProgramStage({ detectResult, tags, forumTags, compiled, authorChoice });
    const pending = pendingHits(detectResult, stage);

    const base = {
        originalTitle,
        keepGroup: stage.keepGroup,
        keepSource: stage.keepSource,
        notes: [...stage.notes],
    };

    // ---------- 只有第一段 ----------
    if (pending.length === 0) {
        const newTitle = tidyTitle(applySpanEdits(detectResult, stage.edits));
        const blocked = stage.blocked.length > 0 ? stage.blocked.join('；') : null;
        return {
            ...base,
            newTitle,
            removeTagIds: [...stage.removeTagIds],
            addTagIds: [...stage.addTagIds],
            autoFixable: !blocked,
            blockedReason: blocked,
            awaitingModel: false,
            modelRejection: null,
        };
    }

    // ---------- 还等着模型 ----------
    if (!judgement) {
        return {
            ...base,
            newTitle: originalTitle,
            removeTagIds: [],
            addTagIds: [],
            autoFixable: false,
            blockedReason: null,
            awaitingModel: true,
            modelRejection: null,
        };
    }

    // ---------- 第二段：落实模型的处理 ----------
    const applied = applyDecisions(detectResult, pending, judgement.decisions, compiled.raw);

    // 两段的编辑坐标是同一套，合起来一次拼出来
    const allEdits = [...stage.edits, ...applied.edits];
    const finalTitle = tidyTitle(applySpanEdits(detectResult, allEdits));

    // 模型可以推翻第一段定的 TAG，所以 TAG 以它给的最终清单为准
    const wanted = resolveModelTags(judgement.finalTagGroups, tags, forumTags);
    const removeTagIds = tags.filter(t => !wanted.some(w => w.tagId === t.tagId)).map(t => t.tagId);
    const addTagIds = wanted.filter(w => !tags.some(t => t.tagId === w.tagId)).map(w => w.tagId);

    const problems = [...applied.problems];
    const missing = judgement.finalTagGroups.filter(g => !tagOfGroup(forumTags, g));
    if (missing.length > 0) {
        problems.push(`本论坛没有 ${missing.join(' / ')} 这些 TAG，换一个能挂的`);
    }

    const check = validateModelPlan({
        finalTitle,
        finalTags: wanted,
        keptWords: new Set(applied.kept.map(m => m.entry.word)),
        verdict: judgement.verdict,
        compiled,
        problems,
    });

    if (!check.ok) {
        return {
            ...base,
            newTitle: originalTitle,
            removeTagIds: [],
            addTagIds: [],
            autoFixable: false,
            blockedReason: null,
            awaitingModel: false,
            modelRejection: {
                titleTried: finalTitle,
                reason: check.reason,
                remaining: check.remaining,
                tagsAfter: wanted.map(t => t.tagName),
            },
        };
    }

    const notes = [...base.notes];
    notes.push(`模型把这篇定性为「${judgement.verdict}」：${judgement.verdictReason}`);
    for (const d of judgement.decisions) {
        const m = pending[d.hit - 1];
        if (!m) continue;
        if (d.action === '保留') {
            notes.push(`正文里的「${m.entry.word}」不算分类声明，留着：${d.why}`);
        } else if (d.action === '替换') {
            notes.push(`「${m.entry.word}」换成「${d.replaceWith}」：${d.why}`);
        } else {
            notes.push(`删掉「${m.entry.word}」所在的那一小块：${d.why}`);
        }
    }

    const blocked = stage.blocked.length > 0 ? stage.blocked.join('；') : null;
    return {
        ...base,
        newTitle: finalTitle,
        removeTagIds,
        addTagIds,
        keepGroup: judgement.verdict || stage.keepGroup,
        keepSource: judgement.verdict ? 'llm' : stage.keepSource,
        autoFixable: !blocked,
        blockedReason: blocked,
        notes,
        awaitingModel: false,
        modelRejection: null,
    };
}

/** 模型给的是分类组名，翻成本论坛真实存在的 TAG */
function resolveModelTags(
    groups: GroupId[],
    current: AppliedTag[],
    forumTags: ForumTag[],
): AppliedTag[] {
    const out: AppliedTag[] = [];

    // 不参与分类的 TAG（画风、平台之类）原样留着，模型管不着
    for (const t of current) {
        if (!t.group) out.push(t);
    }
    for (const g of groups) {
        const found = tagOfGroup(forumTags, g);
        if (found && !out.some(t => t.tagId === found.tagId)) out.push(found);
    }
    return out;
}

// ============================================================
// 人工路径：作者自己敲了一个新标题
// ============================================================

export interface TitleValidation {
    ok: boolean;
    reason: string | null;
    /** 改完之后仍然存在的违规，用人话写的那一版 */
    remaining?: string[];
}

/**
 * 校验一个**人手敲进来**的候选标题能不能用。
 *
 * 跟模型路径不是一回事：模型交的是删/换指令，标题由程序拼，天然安全；
 * 人是直接把一串字打进来的，所以这儿要卡三条——
 *   1. 只能是原标题删字的结果（不许越改越长，也不许夹带私货）
 *   2. 重跑检测不得仍然违规
 *   3. 长度合规（Discord 帖子标题上限 100）
 *
 * 第 2 条里「正文里待模型定性」的违规**照样算数**。作者自助改标题是没有模型参与的，
 * 放过它们等于给了一条「把词挪进正文就没事」的后门。
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
    if (trimmed.length > 100) {
        return { ok: false, reason: `新标题超长（${trimmed.length} > 100）` };
    }
    if (!options.allowAddition && !isDeletionOnly(originalTitle, trimmed)) {
        return { ok: false, reason: '新标题包含原标题里没有的内容（只允许删字）' };
    }

    const recheck = detect({ title: trimmed, tags, config: compiled.raw }, compiled);
    if (recheck.violations.length > 0) {
        return {
            ok: false,
            reason: `改后仍然违规：${recheck.violations.map(v => v.rule).join(' / ')}`,
            remaining: recheck.violations.map(v => v.message),
        };
    }

    return { ok: true, reason: null, remaining: [] };
}

/** 给通知文案用：这条违规涉及的分类组，人话版 */
export function violationGroups(v: Violation): string {
    return v.groups.join(' / ');
}

/** 词表里有没有这个词，归一化后比。配置面板校验用 */
export function dictHasWord(config: GuardConfig, word: string): boolean {
    const want = normalize(word).text;
    return config.dict.some(e => normalize(e.word).text === want);
}
