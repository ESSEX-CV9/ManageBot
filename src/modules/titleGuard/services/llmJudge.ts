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
// 同时支持两种 OpenAI 兼容协议（Chat Completions / Responses），内部统一成 judge() 一个接口。

import crypto from 'crypto';
import type { GroupId, GuardConfig } from './types';

/**
 * 判定结果缓存。由调用方注入——机器人注入 SQLite 实现，
 * 调试台可以传内存实现或干脆不传（每次都真调）。
 * 这样这个文件只依赖 fetch，不牵扯数据层。
 */
export interface JudgementCache {
    get(key: string): Judgement | null;
    set(key: string, value: Judgement): void;
}

export type LlmProtocol = 'chat' | 'responses';

/**
 * 怎么让模型交出结构化结果。
 *   forced —— 带 tools 且 tool_choice 强制指定函数。最可靠，但**思考模式的模型往往不支持**
 *             （典型报错：Thinking mode does not support this tool_choice）
 *   auto   —— 带 tools，但让模型自己决定调不调
 *   json   —— 完全不用 tools，要求模型直接输出 JSON，程序自己从回复里抠出来
 * 'cascade' 表示按 forced → auto → json 依次降级，成功哪个就记住哪个。
 */
export type CallMode = 'forced' | 'auto' | 'json';
export type ToolMode = CallMode | 'cascade';

export interface LlmConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    protocol: LlmProtocol;
    timeoutMs: number;
    /** 默认 cascade：自动降级，不用管模型支不支持 tool_choice */
    toolMode?: ToolMode;
}

export function readLlmConfig(): LlmConfig | null {
    const baseUrl = (process.env.TITLEGUARD_LLM_BASE_URL || '').trim().replace(/\/+$/, '');
    const apiKey = (process.env.TITLEGUARD_LLM_API_KEY || '').trim();
    const model = (process.env.TITLEGUARD_LLM_MODEL || '').trim();
    if (!baseUrl || !apiKey || !model) return null;

    const protocolRaw = (process.env.TITLEGUARD_LLM_PROTOCOL || 'chat').trim().toLowerCase();
    const protocol: LlmProtocol = protocolRaw === 'responses' ? 'responses' : 'chat';

    const timeout = Number(process.env.TITLEGUARD_LLM_TIMEOUT_MS);
    const rawMode = (process.env.TITLEGUARD_LLM_TOOL_MODE || 'cascade').trim().toLowerCase();
    const toolMode: ToolMode =
        rawMode === 'forced' || rawMode === 'auto' || rawMode === 'json' ? rawMode : 'cascade';

    return {
        baseUrl,
        apiKey,
        model,
        protocol,
        timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 20000,
        toolMode,
    };
}

// ---------- 输入输出 ----------

export interface JudgeHit {
    word: string;
    group: GroupId;
    where: 'marker' | 'body';
}

/**
 * 社区既定的分类规则。必须喂给模型——否则它遇到「TAG 同时挂了 NTR 和纯爱」
 * 只会说「无法唯一确定应保留哪一组，故转人工」，而程序这边其实有确定答案（按优先级取）。
 */
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

export type JudgeFailure =
    | 'disabled'         // 没配 LLM 或被关掉
    | 'moderation'       // 被内容审核拦了
    | 'network'          // 网络/超时/5xx
    | 'parse'            // 模型没调工具或参数解析失败
    | 'tool_unsupported' // 模型不支持这种工具调用方式（思考模式常见）
    | 'unknown';

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
function renderRules(rules: JudgeRules): string[] {
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

// ---------- 协议适配 ----------

interface RawCall {
    argumentsJson: string;
}

function isModerationError(status: number, body: string): boolean {
    if (status === 451) return true;
    return /content[_\s-]?filter|content[_\s-]?policy|moderation|safety|risk[_\s-]?control|敏感|违规内容|内容审核/i
        .test(body);
}

/**
 * 模型不支持这种工具调用方式。
 * 典型：思考/推理模式的模型拒绝强制 tool_choice——
 *   `Thinking mode does not support this tool_choice`
 * 碰到这类报错要降级换个姿势，而不是当成网络错误直接放弃。
 */
function isToolChoiceError(body: string): boolean {
    return /tool_choice|tool[_\s-]?call|function[_\s-]?call(ing)?|thinking mode|reasoning mode|不支持.*工具/i
        .test(body);
}

/**
 * 从模型的自由文本里抠出 JSON 对象。
 * 思考模式的回复常见形态：前面一堆推理过程，中间夹 ```json 代码块，或者直接跟一个裸对象。
 * 用括号配对而不是正则，避免被 JSON 字符串里的花括号骗到。
 */
function extractJson(text: string): string | null {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidates = [fenced ? fenced[1] : null, text].filter(Boolean) as string[];

    for (const source of candidates) {
        const start = source.indexOf('{');
        if (start < 0) continue;

        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let i = start; i < source.length; i++) {
            const ch = source[i];
            if (escaped) { escaped = false; continue; }
            if (ch === '\\') { escaped = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) return source.slice(start, i + 1);
            }
        }
    }
    return null;
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

async function postJson(
    config: LlmConfig, path: string, payload: unknown,
): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
        const res = await fetch(`${config.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        return { status: res.status, text: await res.text() };
    } finally {
        clearTimeout(timer);
    }
}

const TOOL_DEF = {
    type: 'function',
    function: { name: TOOL_NAME, description: '提交分类标记判断结果', parameters: TOOL_PARAMETERS },
};

function classifyHttpError(status: number, text: string): LlmError {
    if (isModerationError(status, text)) {
        return new LlmError('moderation', `HTTP ${status}: ${text.slice(0, 300)}`);
    }
    // 4xx 且提到 tool_choice / thinking mode → 是调用姿势不对，换个姿势还有救
    if (status >= 400 && status < 500 && isToolChoiceError(text)) {
        return new LlmError('tool_unsupported', `HTTP ${status}: ${text.slice(0, 300)}`);
    }
    return new LlmError('network', `HTTP ${status}: ${text.slice(0, 300)}`);
}

/** Chat Completions */
async function callChat(config: LlmConfig, input: JudgeInput, mode: CallMode): Promise<RawCall> {
    const userContent = buildUserPrompt(input) + (mode === 'json' ? JSON_INSTRUCTION : '');

    const payload: Record<string, unknown> = {
        model: config.model,
        temperature: 0,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent },
        ],
    };

    if (mode === 'forced') {
        payload.tools = [TOOL_DEF];
        payload.tool_choice = { type: 'function', function: { name: TOOL_NAME } };
    } else if (mode === 'auto') {
        payload.tools = [TOOL_DEF];
        payload.tool_choice = 'auto';
    }

    const { status, text } = await postJson(config, '/chat/completions', payload);
    if (status < 200 || status >= 300) throw classifyHttpError(status, text);

    const data = JSON.parse(text) as {
        choices?: {
            message?: {
                content?: string | null;
                tool_calls?: { function?: { arguments?: string } }[];
            };
        }[];
    };
    const message = data.choices?.[0]?.message;

    const args = message?.tool_calls?.[0]?.function?.arguments;
    if (args) return { argumentsJson: args };

    // 没调工具（json 模式本来就不带 tools，auto 模式也可能不调）→ 从正文里抠 JSON
    const extracted = extractJson(message?.content ?? '');
    if (extracted) return { argumentsJson: extracted };

    throw new LlmError('parse',
        mode === 'json' ? '回复里找不到 JSON 对象' : '模型未调用工具，回复里也没有 JSON');
}

/** Responses API：tools 扁平 + tool_choice.name，结果在 output[] 里找 function_call */
async function callResponses(config: LlmConfig, input: JudgeInput, mode: CallMode): Promise<RawCall> {
    const userContent = buildUserPrompt(input) + (mode === 'json' ? JSON_INSTRUCTION : '');

    const payload: Record<string, unknown> = {
        model: config.model,
        temperature: 0,
        instructions: SYSTEM_PROMPT,
        input: [{ role: 'user', content: userContent }],
    };

    if (mode !== 'json') {
        payload.tools = [{
            type: 'function',
            name: TOOL_NAME,
            description: '提交分类标记判断结果',
            parameters: TOOL_PARAMETERS,
        }];
        payload.tool_choice = mode === 'forced' ? { type: 'function', name: TOOL_NAME } : 'auto';
    }

    const { status, text } = await postJson(config, '/responses', payload);
    if (status < 200 || status >= 300) throw classifyHttpError(status, text);

    const data = JSON.parse(text) as {
        output?: {
            type?: string; name?: string; arguments?: string;
            content?: { type?: string; text?: string }[];
        }[];
        output_text?: string;
    };

    const call = data.output?.find(o => o.type === 'function_call' && o.name === TOOL_NAME)
        ?? data.output?.find(o => o.type === 'function_call');
    if (call?.arguments) return { argumentsJson: call.arguments };

    // 没调工具 → 把所有文本片段拼起来抠 JSON
    const textOut = data.output_text
        ?? (data.output ?? [])
            .flatMap(o => o.content ?? [])
            .map(c => c.text ?? '')
            .join('\n');
    const extracted = extractJson(textOut);
    if (extracted) return { argumentsJson: extracted };

    throw new LlmError('parse',
        mode === 'json' ? '回复里找不到 JSON 对象' : '模型未调用工具，回复里也没有 JSON');
}

class LlmError extends Error {
    constructor(public kind: JudgeFailure, message: string) {
        super(message);
        this.name = 'LlmError';
    }
}

// ---------- 解析与校验 ----------

function parseJudgement(argumentsJson: string): Judgement {
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(argumentsJson) as Record<string, unknown>;
    } catch {
        throw new LlmError('parse', `工具参数不是合法 JSON：${argumentsJson.slice(0, 200)}`);
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

/**
 * 记住每个「接口 + 模型」实际能用哪种调用姿势，避免每次都从 forced 撞一遍。
 * 只存在内存里，重启后重新试探。
 */
const workingMode = new Map<string, CallMode>();

function modeKey(config: LlmConfig): string {
    return `${config.baseUrl}::${config.model}::${config.protocol}`;
}

function rememberMode(config: LlmConfig, mode: CallMode): void {
    workingMode.set(modeKey(config), mode);
}

/** 降级顺序：上次成功的那个排最前，其余按可靠性排 */
function orderedModes(config: LlmConfig): CallMode[] {
    const all: CallMode[] = ['forced', 'auto', 'json'];
    const known = workingMode.get(modeKey(config));
    if (!known) return all;
    return [known, ...all.filter(m => m !== known)];
}

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
            mode: workingMode.get(modeKey(config)) ?? 'forced',
        };
    }

    const call = config.protocol === 'responses' ? callResponses : callChat;

    /**
     * 用指定姿势调一次。
     * retryOnParse 只在**最后一种**姿势上打开：中间的姿势解析失败了直接降级就好，
     * 原地重试一次纯属多花一次调用。
     */
    const attempt = async (
        payload: JudgeInput, mode: CallMode, retryOnParse: boolean,
    ): Promise<Judgement> => {
        try {
            return parseJudgement((await call(config, payload, mode)).argumentsJson);
        } catch (err) {
            if (retryOnParse && err instanceof LlmError && err.kind === 'parse') {
                return parseJudgement((await call(config, payload, mode)).argumentsJson);
            }
            throw err;
        }
    };

    /**
     * 按 forced → auto → json 依次降级。
     * 思考模式的模型会拒绝强制 tool_choice（Thinking mode does not support this tool_choice），
     * 碰到这类报错就换下一种姿势，而不是直接判失败。
     * 成功哪个就记住哪个，下次直接从它开始，不用每次都撞一遍墙。
     */
    const cascade = async (payload: JudgeInput): Promise<{ judgement: Judgement; mode: CallMode }> => {
        const configured = config.toolMode ?? 'cascade';
        const modes: CallMode[] = configured === 'cascade'
            ? orderedModes(config)
            : [configured];

        const tried: CallMode[] = [];
        let lastError: LlmError | Error | null = null;

        for (let i = 0; i < modes.length; i++) {
            const mode = modes[i];
            const isLast = i === modes.length - 1;
            tried.push(mode);
            try {
                const judgement = await attempt(payload, mode, isLast);
                rememberMode(config, mode);
                return { judgement, mode };
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                const kind = err instanceof LlmError ? err.kind : 'unknown';
                // 只有「姿势不对」和「解析不出来」才值得换姿势重试；
                // 网络不通、被内容审核拦下，换几次都一样。
                if (kind !== 'tool_unsupported' && kind !== 'parse') throw err;
                console.warn(`[TitleGuard] LLM ${mode} 模式不可用（${kind}），降级重试：`
                    + `${lastError.message.slice(0, 160)}`);
            }
        }

        const err = lastError ?? new LlmError('unknown', '所有调用方式都失败了');
        throw Object.assign(err, { triedModes: tried });
    };

    let judgement: Judgement;
    let usedMode: CallMode;
    try {
        const r = await cascade(input);
        judgement = r.judgement;
        usedMode = r.mode;
    } catch (err) {
        const kind = err instanceof LlmError ? err.kind : 'unknown';
        return {
            ok: false,
            kind,
            error: err instanceof Error ? err.message : String(err),
            triedModes: (err as { triedModes?: CallMode[] }).triedModes,
        };
    }

    // 把握低且允许带正文时，补一次带正文的判定
    let usedBody = false;
    if (judgement.confidence === 'low' && options.bodyExcerpt) {
        try {
            const better = await attempt({ ...input, bodyExcerpt: options.bodyExcerpt }, usedMode, true);
            judgement = better;
            usedBody = true;
        } catch (err) {
            // 被内容审核拦了就保留不带正文的结果，绝不让流程卡死
            const kind = err instanceof LlmError ? err.kind : 'unknown';
            console.warn(`[TitleGuard] 带正文重判失败（${kind}），沿用不带正文的结果：`,
                err instanceof Error ? err.message : err);
        }
    }

    options.cache?.set(key, judgement);
    return { ok: true, judgement, cached: false, usedBody, mode: usedMode };
}

/** 供配置面板显示：LLM 是否已配好 */
export function describeLlmConfig(): string {
    const config = readLlmConfig();
    if (!config) return '未配置（缺 TITLEGUARD_LLM_BASE_URL / API_KEY / MODEL）';
    const known = workingMode.get(modeKey(config));
    return `${config.model} @ ${config.baseUrl}`
        + `（${config.protocol === 'chat' ? 'Chat Completions' : 'Responses API'}`
        + `${known ? ` · ${MODE_LABEL[known]}` : ''}）`;
}

export const MODE_LABEL: Record<CallMode, string> = {
    forced: '强制 tool call',
    auto: '模型自行决定是否调用工具',
    json: 'JSON 输出',
};
