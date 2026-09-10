// src/modules/titleGuard/services/llmJudge.ts
//
// ⑤ LLM 判定。它**只回答一个问题**：
//     主体段里的这些分类词，是在给作品做分类标记，还是自然语言的一部分？
//
// 三条硬约束：
//   1. 强制 tool call。不让模型自由输出 JSON——那永远有概率裹一层 markdown 或多说两句。
//      tool_choice 直接指定函数，模型只能填参数。
//   2. 默认不喂首楼正文。TAG 已经是最强信号，正文边际价值有限，
//      而成人向内容极易被 provider 的内容审核拦截。只在「把握低」时才二次调用带正文。
//   3. 遇到内容审核类错误 → 自动降级为不带正文重试 → 仍失败则转人工，流程绝不卡死。
//
// 怎么调接口（两种协议、三种姿势、降级重试）全在 llmClient.ts，这里只管问什么。

import crypto from 'crypto';

import {
    callCascade, callOnce, knownMode, readLlmConfig, toFailure,
    type CallMode, type CallSpec, type LlmConfig, type LlmFailure,
} from './llmClient';
import type { GroupId, GuardConfig } from './types';

export {
    MODE_LABEL, describeLlmConfig, readLlmConfig,
    type CallMode, type LlmConfig, type LlmProtocol, type ToolMode,
} from './llmClient';

/**
 * 判定结果缓存。由调用方注入——机器人注入 SQLite 实现，
 * 调试台可以传内存实现或干脆不传（每次都真调）。
 * 这样这个文件只依赖 fetch，不牵扯数据层。
 */
export interface JudgementCache {
    get(key: string): Judgement | null;
    set(key: string, value: Judgement): void;
}

// ---------- 输入输出 ----------

export interface JudgeHit {
    word: string;
    group: GroupId;
    where: 'marker' | 'body';
}

/**
 * 喂给模型的社区规则。三个维度都得给全，少一个模型就会自己脑补。
 * 尤其是「TAG 互斥」和「关键字互斥」是两套独立配置——
 * 只给一套的话，模型会默认另一套跟它一样。
 */
export interface JudgeRules {
    /** TAG 之间的互斥集合 */
    tagExclusiveSets: GroupId[][];
    /** 标题关键字之间的互斥集合 */
    wordExclusiveSets: GroupId[][];
    /** 交叉互斥：挂了 tagGroup 的 TAG，标题里就不许出现 wordGroup 的关键字。有方向 */
    crossExclusions: { tagGroup: GroupId; wordGroup: GroupId }[];
    /** 分类组优先级，数值大的优先保留。三种互斥都靠它裁决 */
    priority: Record<GroupId, number>;
}

/** 从词表配置拼出喂给模型的规则说明。三处调用点共用，免得各拼各的拼漏 */
export function buildJudgeRules(config: GuardConfig): JudgeRules {
    return {
        tagExclusiveSets: config.exclusiveSets
            .filter(x => x.dimension === 'tag').map(x => x.groups),
        wordExclusiveSets: config.exclusiveSets
            .filter(x => x.dimension === 'word').map(x => x.groups),
        crossExclusions: (config.crossExclusions ?? [])
            .map(c => ({ tagGroup: c.tagGroup, wordGroup: c.wordGroup })),
        priority: config.groupPriority ?? {},
    };
}

export interface JudgeInput {
    title: string;
    forumName: string;
    hits: JudgeHit[];
    tags: { name: string; group: GroupId | null }[];
    /** 社区既定的互斥关系与优先级 */
    rules?: JudgeRules;
    /** 首楼摘录。默认不传；只在第一次判定「把握低」且论坛开了开关时才带上 */
    bodyExcerpt?: string;
}

export interface Judgement {
    /** 这些词是不是在做分类标记 */
    isClassification: boolean;
    conflictingGroups: GroupId[];
    /** 建议保留哪个分类组 */
    suggestedKeep: GroupId | null;
    /** 建议的新标题。程序会强制校验「只能是原标题删字的结果」 */
    suggestedTitle: string | null;
    confidence: 'high' | 'medium' | 'low';
    reason: string;
}

export type JudgeFailure = LlmFailure;

export type JudgeOutcome =
    | { ok: true; judgement: Judgement; cached: boolean; usedBody: boolean; mode: CallMode }
    | { ok: false; kind: JudgeFailure; error: string; triedModes?: CallMode[] };

// ---------- 工具定义 ----------

const TOOL_NAME = 'submit_judgement';

const TOOL_PARAMETERS = {
    type: 'object',
    properties: {
        is_classification: {
            type: 'boolean',
            description: '这些分类词在标题里是否承担「作品分类/检索标记」的作用。'
                + '若它们只是自然语言句子的组成部分（作品名、剧情陈述、角色描述），填 false。',
        },
        conflicting_groups: {
            type: 'array',
            items: { type: 'string' },
            description: '实际发生冲突的分类组名。不冲突时填空数组。',
        },
        suggested_keep: {
            type: 'string',
            description: '建议保留哪一个分类组（应与帖子 TAG 一致）。无法判断时填空字符串。',
        },
        suggested_title: {
            type: 'string',
            description: '建议的新标题。**只允许从原标题里删除字符**，不得新增或改写任何字。'
                + '判输的那个分类词必须删干净，出现几次删几次；'
                + '只删关键词会留残渣时，把包着它的整块（修饰词、词组、整节标签、整句说明）一起删。'
                + '只有在 is_classification 为 false、标题根本不用改时才填空字符串。',
        },
        confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: '判断把握程度。拿不准就填 low，会转交人工，不会被自动执行。',
        },
        reason: {
            type: 'string',
            description: '一句话理由，会存档供管理组复核。',
        },
    },
    required: ['is_classification', 'conflicting_groups', 'suggested_keep', 'suggested_title', 'confidence', 'reason'],
    additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `你是社区论坛的标题分类审核助手。

## 这件事是为了什么

社区规范标题里的分类词，是为了让**关键词搜索**可靠。

举例：一部 NTL 作品，标题里留着「纯爱」两个字，搜「纯爱」的人就会搜到它。
对搜索的人来说这就是噪音，对写纯爱的作者来说这就是污染。

所以规矩是：同一篇作品不能同时声明互相排斥的分类，
判输的那个分类词必须从标题里**彻底消失**——不是少一点，是一个都不剩。

## 你的唯一任务

判断：**标题里命中的这些分类词，究竟是在给作品做分类标记，还是只是自然语言句子的一部分。**

- 若标题是一个完整的句子，分类词是句中成分（作品名的一部分、剧情陈述、角色描述），那它**不是**分类标记。
- 若标题没有句子结构、分类词直接并列或叠加堆砌，那它**是**分类标记。
- 帖子当前挂的 TAG 是重要参考：TAG 表明了作者对作品分类的正式声明。

## 社区的分类规矩长什么样

TAG 和标题关键字是**两套独立的东西**。同一对分类在这两个维度上互不互斥，
是分开配置的，四种组合都可能出现。此外还有第三种「交叉互斥」，
指的是某个 TAG 和某类标题关键字不能并存。

具体配置在下面给你，**以给你的配置为准，不要凭常识推断**。
比如「百合」和「百破」这两个关键字很可能是允许并存的——
「百合破坏」本来就得写「百合」两个字。

## 不归你管的事

**「该保留哪一个」由程序按社区既定的优先级自动决定，不需要你来定夺。**
是摘 TAG 还是删标题里的词，也由程序按优先级裁决，你不必操心。

所以：
- 遇到「TAG 同时挂了两个互斥分类」这种情况，**不存在「无法确定」**——
  程序会按优先级取数值最高的那个。不要输出「无法唯一确定应保留哪一组，故转人工」这类结论。
- suggested_keep 只是给程序的参考。按下面提供的优先级填一个即可，不必纠结。
- confidence **只反映你对「是不是分类标记」这一判断的把握**。
  不要因为「不知道该保留哪个」「情况复杂」就填 low。

## 关于 suggested_title

**唯一的硬指标：判输的那个分类词，在新标题里一个都不能剩。**
它在标题里出现几次，就得删几次——括号里的、正文里的、句尾的，一处都不能漏。

- 只能从原标题里**删除**字符，绝对不能新增、替换或改写任何一个字。
- **该整块删就整块删。** 只抠掉关键词那两个字往往会留下残渣：
  「可纯爱」剩个「可」，「有纯爱版」剩个「有版」，「纯爱版已第四次更新」剩个「版已第四次更新」。
  修饰词、整个词组、整节标签、整句更新说明——包着它的那一块一起删掉才对。
- **括号里是标签区，本来就是罗列，不需要读成句子。**
  删完只剩几个孤零零的标签是正常结果，别拿「不成句」当理由不删。
- 空掉的括号、多出来的分隔符、末尾的标点，程序会自己收拾干净，你不用管。
- 通顺是次要目标：在「删干净」的前提下尽量让剩下的读得通，
  而不是反过来拿「删了不通顺」当借口把词留在标题里。

**suggested_title 只有一种情况可以留空：** 你判定这些词根本不是分类标记
（is_classification = false），标题本来就不用改。
除此之外一律要给出改写后的标题，不许用「删了不通顺」「无法处理」「交给程序」搪塞。

拿不准「是不是分类标记」才填 low。错误的 high 会导致作者的标题被误改。`;

/** 把互斥集合和优先级渲染成模型能直接照着办的说明 */
export function renderRules(rules: JudgeRules): string[] {
    const lines: string[] = ['本社区既定的分类规则（以此为准，不要凭常识推断）：'];

    const withPriority = (groups: GroupId[]) => [...groups]
        .sort((x, y) => (rules.priority[y] ?? 0) - (rules.priority[x] ?? 0))
        .map(g => `${g}(${rules.priority[g] ?? 0})`)
        .join(' > ');

    lines.push('', '【TAG 互斥】同一帖子只能挂其中一个 TAG：');
    if (rules.tagExclusiveSets.length === 0) lines.push('  （没有配置）');
    for (const set of rules.tagExclusiveSets) {
        if (set.length < 2) continue;
        lines.push(`  - ${withPriority(set)}`);
    }

    lines.push('', '【关键字互斥】同一标题里不能同时出现：');
    if (rules.wordExclusiveSets.length === 0) lines.push('  （没有配置）');
    for (const set of rules.wordExclusiveSets) {
        if (set.length < 2) continue;
        lines.push(`  - ${withPriority(set)}`);
    }
    lines.push('  没列在这里的分类，标题里同时出现完全正当，不算冲突。');

    lines.push('', '【交叉互斥】TAG 与标题关键字不得并存（有方向，只禁写出来的这个方向）：');
    if (rules.crossExclusions.length === 0) lines.push('  （没有配置）');
    for (const c of rules.crossExclusions) {
        lines.push(`  - 挂了「${c.tagGroup}」TAG 时，标题里不得出现「${c.wordGroup}」`);
    }

    lines.push('');
    lines.push('括号里的数字是保留优先级，数值大的留下。三种互斥撞上时都按它裁决，'
        + '所以不存在「无法确定该保留哪个」。');
    return lines;
}

function buildUserPrompt(input: JudgeInput): string {
    const lines = [
        `论坛：${input.forumName}`,
        `标题：${input.title}`,
        '',
        '标题里命中的分类词：',
        ...input.hits.map(h =>
            `  - 「${h.word}」→ 分类组「${h.group}」（位于${h.where === 'marker' ? '标记段' : '标题正文'}）`,
        ),
        '',
        '帖子当前挂的 TAG：',
        ...(input.tags.length > 0
            ? input.tags.map(t => `  - ${t.name}${t.group ? `（分类组：${t.group}）` : '（未映射分类）'}`)
            : ['  （无）']),
    ];

    if (input.rules) {
        lines.push('', ...renderRules(input.rules));
    }

    if (input.bodyExcerpt) {
        lines.push('', '首楼开头摘录（仅供判断标题语义，不要对内容本身做评价）：', input.bodyExcerpt);
    }

    lines.push('', `请调用 ${TOOL_NAME} 提交判断结果。`);
    return lines.join('\n');
}

/** json 模式下追加的输出格式说明——没有 tool schema 兜着，只能在提示里写清楚 */
const JSON_INSTRUCTION = `

请只输出一个 JSON 对象，不要输出任何其它内容。格式：
{
  "is_classification": true 或 false,
  "conflicting_groups": ["分类组名", ...],
  "suggested_keep": "建议保留的分类组名，判断不了就填空字符串",
  "suggested_title": "建议的新标题，只能从原标题删字；判输的分类词必须删干净，该整块删就整块删",
  "confidence": "high" 或 "medium" 或 "low",
  "reason": "一句话理由"
}`;

function specFor(input: JudgeInput): CallSpec {
    return {
        toolName: TOOL_NAME,
        toolDescription: '提交分类标记判断结果',
        parameters: TOOL_PARAMETERS as unknown as Record<string, unknown>,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: buildUserPrompt(input),
        jsonInstruction: JSON_INSTRUCTION,
    };
}

// ---------- 解析与校验 ----------

function parseJudgement(argumentsJson: string): Judgement {
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(argumentsJson) as Record<string, unknown>;
    } catch {
        throw new Error(`工具参数不是合法 JSON：${argumentsJson.slice(0, 200)}`);
    }

    const confidenceRaw = String(raw.confidence ?? '').toLowerCase();
    const confidence: Judgement['confidence'] =
        confidenceRaw === 'high' ? 'high' : confidenceRaw === 'medium' ? 'medium' : 'low';

    const keep = String(raw.suggested_keep ?? '').trim();
    const title = String(raw.suggested_title ?? '').trim();

    return {
        isClassification: raw.is_classification === true,
        conflictingGroups: Array.isArray(raw.conflicting_groups)
            ? raw.conflicting_groups.map(String).filter(Boolean)
            : [],
        suggestedKeep: keep || null,
        suggestedTitle: title || null,
        confidence,
        reason: String(raw.reason ?? '').trim() || '（模型未给出理由）',
    };
}

// ---------- 对外接口 ----------

function cacheKey(config: LlmConfig, input: JudgeInput): string {
    const payload = JSON.stringify({
        m: config.model,
        t: input.title,
        g: input.hits.map(h => `${h.word}:${h.group}:${h.where}`).sort(),
        tags: input.tags.map(t => `${t.name}:${t.group ?? ''}`).sort(),
        // 规则改了（比如调了优先级），旧的判定结论就该作废
        rules: input.rules
            ? {
                tagSets: input.rules.tagExclusiveSets.map(x => [...x].sort()).sort(),
                wordSets: input.rules.wordExclusiveSets.map(x => [...x].sort()).sort(),
                cross: input.rules.crossExclusions
                    .map(c => `${c.tagGroup}->${c.wordGroup}`).sort(),
                pri: Object.entries(input.rules.priority).sort(),
            }
            : null,
        body: Boolean(input.bodyExcerpt),
    });
    return crypto.createHash('sha1').update(payload).digest('hex');
}

/**
 * 判定一次。
 *
 * 流程：缓存 → 不带正文调用 → 失败一次重试 →
 *       （把握低且允许带正文时）带正文再调一次 →
 *       （被内容审核拦截时）自动降级回不带正文。
 */
export async function judge(
    input: JudgeInput,
    options: {
        bodyExcerpt?: string;
        enabled?: boolean;
        /** 覆盖 .env 里的配置（调试台用） */
        config?: LlmConfig;
        cache?: JudgementCache;
    } = {},
): Promise<JudgeOutcome> {
    if (options.enabled === false) {
        return { ok: false, kind: 'disabled', error: 'LLM 判定已在配置中关闭' };
    }

    const config = options.config ?? readLlmConfig();
    if (!config) {
        return { ok: false, kind: 'disabled', error: '未配置 TITLEGUARD_LLM_* 环境变量' };
    }

    const key = cacheKey(config, input);
    const cached = options.cache?.get(key) ?? null;
    if (cached) {
        return {
            ok: true, judgement: cached, cached: true, usedBody: false,
            mode: knownMode(config) ?? 'forced',
        };
    }

    let judgement: Judgement;
    let usedMode: CallMode;
    try {
        const r = await callCascade(config, specFor(input), parseJudgement);
        judgement = r.value;
        usedMode = r.mode;
    } catch (err) {
        return { ok: false, ...toFailure(err) };
    }

    // 把握低且允许带正文时，补一次带正文的判定
    let usedBody = false;
    if (judgement.confidence === 'low' && options.bodyExcerpt) {
        try {
            judgement = await callOnce(
                config, specFor({ ...input, bodyExcerpt: options.bodyExcerpt }),
                usedMode, parseJudgement, true,
            );
            usedBody = true;
        } catch (err) {
            // 被内容审核拦了就保留不带正文的结果，绝不让流程卡死
            console.warn('[TitleGuard] 带正文重判失败，沿用不带正文的结果：',
                err instanceof Error ? err.message : err);
        }
    }

    options.cache?.set(key, judgement);
    return { ok: true, judgement, cached: false, usedBody, mode: usedMode };
}
