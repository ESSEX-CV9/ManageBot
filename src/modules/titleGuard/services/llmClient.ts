// src/modules/titleGuard/services/llmClient.ts
//
// 和 OpenAI 兼容接口打交道的那一层管道，不含任何业务判断。
//
// 抽出来是因为模块里现在有三种问模型的场合，它们问的问题完全不同，
// 但「怎么问」的麻烦事一模一样：
//   - 分类定性（llmJudge.ts）
//   - 申诉复核、申诉文本安检（llmAppeal.ts）
//
// 这些麻烦事包括：两种协议（Chat Completions / Responses）、
// 三种要结构化结果的姿势（forced / auto / json）、思考模式模型不支持强制 tool_choice、
// 内容审核拦截、以及从一堆推理过程里把 JSON 抠出来。

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

export const MODE_LABEL: Record<CallMode, string> = {
    forced: '强制 tool call',
    auto: '模型自行决定是否调用工具',
    json: 'JSON 输出',
};

/**
 * 默认**闲置**超时 4 分钟——连续这么久一个字节都没回来才算卡死。
 *
 * 注意这不是总时长。思考模式的模型光推理就能跑好几分钟，
 * 拿总时长当超时会把生成到一半的调用自己掐断，报出来还是「请求超时」，
 * 看着像接口坏了。只要还在往回吐数据，这个计时器就一直被刷新。
 */
const DEFAULT_TIMEOUT_MS = 240000;

export interface LlmConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    protocol: LlmProtocol;
    /**
     * **闲置**超时：连续这么久没收到任何数据就放弃。不是总时长。
     * 见 postJson。
     */
    timeoutMs: number;
    /** 默认 cascade：自动降级，不用管模型支不支持 tool_choice */
    toolMode?: ToolMode;
    /**
     * 走不走流式。默认走。
     *
     * 开着才能让「闲置超时」真的有意义：非流式请求的服务端要等模型整段生成完
     * 才发第一个字节，这期间连接上一片死寂，闲置超时和总超时就成了同一个数。
     * 开流之后 token 一个个回来，计时器一直被刷新，只有**真卡住**才触发。
     *
     * 万一对面的接口开流就出问题（少数网关不支持流式 tool call），
     * 用 TITLEGUARD_LLM_STREAM=0 关掉，功能不受影响，只是超时又退化回总时长。
     */
    stream?: boolean;
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

    const rawStream = (process.env.TITLEGUARD_LLM_STREAM || '').trim().toLowerCase();
    const stream = !(rawStream === '0' || rawStream === 'false' || rawStream === 'off');

    return {
        baseUrl,
        apiKey,
        model,
        protocol,
        timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
        toolMode,
        stream,
    };
}

export type LlmFailure =
    | 'disabled'         // 没配 LLM 或被关掉
    | 'moderation'       // 被内容审核拦了
    | 'network'          // 网络/超时/5xx
    | 'parse'            // 模型没调工具或参数解析失败
    | 'tool_unsupported' // 模型不支持这种工具调用方式（思考模式常见）
    | 'unknown';

export class LlmError extends Error {
    constructor(public kind: LlmFailure, message: string) {
        super(message);
        this.name = 'LlmError';
    }
}

/** 一次结构化调用要问什么。业务层只需要填这几样，剩下的管道自己搞定 */
export interface CallSpec {
    /** 工具名。也用来在返回里认领结果 */
    toolName: string;
    toolDescription: string;
    /** JSON Schema */
    parameters: Record<string, unknown>;
    systemPrompt: string;
    userPrompt: string;
    /** json 模式下追加到用户提示末尾的格式说明——没有 tool schema 兜着，只能写在提示里 */
    jsonInstruction: string;
}

// ---------- 错误分类 ----------

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

/**
 * 从模型的自由文本里抠出 JSON 对象。
 * 思考模式的回复常见形态：前面一堆推理过程，中间夹代码块，或者直接跟一个裸对象。
 * 用括号配对而不是正则，避免被 JSON 字符串里的花括号骗到。
 */
export function extractJson(text: string): string | null {
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

// ---------- HTTP ----------
//
// 超时算的是**闲置时间**，不是总时长：只要还有数据在往回流，就一直等下去；
// 连续这么久一个字节都没来，才算它死了。
//
// 以前是给整个请求包一个总定时器，那是错的——思考模式的模型光推理就能跑好几分钟，
// 生成到一半会被自己这边掐断，报出来还是「请求超时」，看着像接口坏了。
//
// 光改语义还不够：非流式请求的服务端要等模型全部生成完才发第一个字节，
// 「闲置时间」和「总时长」就成了同一个数。所以要配合 stream:true 用——
// token 一个个吐回来，闲置计时器就一直被刷新，只有**真卡住**才会触发。

/** 一个事件一个事件地吐 SSE 的 data 部分。多行 data 按规范用 \n 拼起来 */
function* sseEvents(raw: string): Generator<string> {
    for (const block of raw.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, ''));
        if (data.length > 0) yield data.join('\n');
    }
}

/**
 * 把 Chat Completions 的流式增量拼回成一个非流式的响应体。
 *
 * 这么做是为了让**解析那一段完全不用知道有没有开流**：
 * callChat 拿到的永远是同一个形状，开不开流只影响传输。
 *
 * tool_call 的 arguments 是一小段一小段回来的，必须按 index 分别累加——
 * 拼错了就是一串残缺 JSON，上层只会报「参数不是合法 JSON」，很难查。
 */
function assembleChatSse(raw: string): string {
    let content = '';
    const calls = new Map<number, { name?: string; args: string }>();

    for (const data of sseEvents(raw)) {
        if (data === '[DONE]') break;
        let ev: {
            choices?: {
                delta?: {
                    content?: string | null;
                    tool_calls?: {
                        index?: number;
                        function?: { name?: string; arguments?: string };
                    }[];
                };
            }[];
        };
        try { ev = JSON.parse(data); } catch { continue; }

        const delta = ev.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string') content += delta.content;

        for (const tc of delta.tool_calls ?? []) {
            const i = typeof tc.index === 'number' ? tc.index : 0;
            const cur = calls.get(i) ?? { args: '' };
            if (tc.function?.name) cur.name = tc.function.name;
            if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments;
            calls.set(i, cur);
        }
    }

    const toolCalls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ type: 'function', function: { name: v.name ?? '', arguments: v.args } }));

    return JSON.stringify({
        choices: [{ message: { content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) } }],
    });
}

/**
 * Responses API 的流式拼装。
 * 它最后会发一个 response.completed，里面就是完整的非流式对象，有就直接用；
 * 没有（被中途掐了、或实现不全）才退回自己按增量拼。
 */
function assembleResponsesSse(raw: string): string {
    let completed: unknown = null;
    let text = '';
    const argsById = new Map<string, string>();
    const nameById = new Map<string, string>();

    for (const data of sseEvents(raw)) {
        if (data === '[DONE]') break;
        let ev: {
            type?: string;
            delta?: string;
            item_id?: string;
            response?: unknown;
            item?: { id?: string; type?: string; name?: string };
        };
        try { ev = JSON.parse(data); } catch { continue; }

        if (ev.type === 'response.completed' && ev.response) {
            completed = ev.response;
        } else if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
            text += ev.delta;
        } else if (ev.type === 'response.function_call_arguments.delta' && typeof ev.delta === 'string') {
            const id = String(ev.item_id ?? '0');
            argsById.set(id, (argsById.get(id) ?? '') + ev.delta);
        } else if (ev.type === 'response.output_item.added' && ev.item?.type === 'function_call') {
            nameById.set(String(ev.item.id ?? '0'), String(ev.item.name ?? ''));
        }
    }

    if (completed) return JSON.stringify(completed);

    return JSON.stringify({
        output: [...argsById.entries()].map(([id, args]) => ({
            type: 'function_call', name: nameById.get(id) ?? '', arguments: args,
        })),
        output_text: text,
    });
}

async function postJson(
    config: LlmConfig, path: string, payload: unknown,
): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** 重新开始计时。每收到一块数据就调一次 */
    const arm = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { idle = true; controller.abort(); }, config.timeoutMs);
    };
    arm();

    try {
        const res = await fetch(`${config.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${config.apiKey}`,
                accept: 'text/event-stream, application/json',
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        arm(); // 响应头回来了，重新计时

        // 逐块读，每块都刷新闲置计时器。
        // 不用 res.text()——那要等整个 body 收完才返回，中途收到的数据刷新不了计时器。
        const decoder = new TextDecoder();
        const parts: string[] = [];
        const body = res.body as ReadableStream<Uint8Array> | null;
        if (body) {
            const reader = body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                arm();
                if (value) parts.push(decoder.decode(value, { stream: true }));
            }
            parts.push(decoder.decode());
        }
        const raw = parts.join('');

        // 请求了流式但对面回的是普通 JSON（或者这是个错误响应）→ 原样返回，
        // 上层的解析逻辑一个字都不用改
        const isSse = (res.headers.get('content-type') ?? '').includes('text/event-stream');
        if (!isSse || res.status < 200 || res.status >= 300) {
            return { status: res.status, text: raw };
        }

        return {
            status: res.status,
            text: config.protocol === 'responses'
                ? assembleResponsesSse(raw)
                : assembleChatSse(raw),
        };
    } catch (err) {
        // 光把 AbortError 抛出去，上层只会看到「This operation was aborted」，
        // 归类成 unknown，排查的人根本猜不到是超时
        if (idle) {
            const secs = Math.round(config.timeoutMs / 1000);
            throw new LlmError('network',
                `连续 ${secs} 秒没收到任何数据，判定为卡住了。`
                + '（算的是两次数据之间的间隔，不是总时长；模型慢不会触发这个。）'
                + ' 要调就改 TITLEGUARD_LLM_TIMEOUT_MS。');
        }
        throw new LlmError('network', err instanceof Error ? err.message : String(err));
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Chat Completions */
async function callChat(config: LlmConfig, spec: CallSpec, mode: CallMode): Promise<string> {
    const userContent = spec.userPrompt + (mode === 'json' ? spec.jsonInstruction : '');

    const payload: Record<string, unknown> = {
        model: config.model,
        temperature: 0,
        messages: [
            { role: 'system', content: spec.systemPrompt },
            { role: 'user', content: userContent },
        ],
        // 开流不是为了「边生成边显示」——没人看这个过程。
        // 是为了让连接上一直有数据，闲置超时才量得出「卡住了」和「模型在慢慢想」的区别
        ...(config.stream === false ? {} : { stream: true }),
    };

    const toolDef = {
        type: 'function',
        function: { name: spec.toolName, description: spec.toolDescription, parameters: spec.parameters },
    };
    if (mode === 'forced') {
        payload.tools = [toolDef];
        payload.tool_choice = { type: 'function', function: { name: spec.toolName } };
    } else if (mode === 'auto') {
        payload.tools = [toolDef];
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
    if (args) return args;

    // 没调工具（json 模式本来就不带 tools，auto 模式也可能不调）→ 从正文里抠 JSON
    const extracted = extractJson(message?.content ?? '');
    if (extracted) return extracted;

    throw new LlmError('parse',
        mode === 'json' ? '回复里找不到 JSON 对象' : '模型未调用工具，回复里也没有 JSON');
}

/** Responses API：tools 扁平 + tool_choice.name，结果在 output[] 里找 function_call */
async function callResponses(config: LlmConfig, spec: CallSpec, mode: CallMode): Promise<string> {
    const userContent = spec.userPrompt + (mode === 'json' ? spec.jsonInstruction : '');

    const payload: Record<string, unknown> = {
        model: config.model,
        temperature: 0,
        instructions: spec.systemPrompt,
        input: [{ role: 'user', content: userContent }],
        ...(config.stream === false ? {} : { stream: true }),
    };

    if (mode !== 'json') {
        payload.tools = [{
            type: 'function',
            name: spec.toolName,
            description: spec.toolDescription,
            parameters: spec.parameters,
        }];
        payload.tool_choice = mode === 'forced' ? { type: 'function', name: spec.toolName } : 'auto';
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

    const call = data.output?.find(o => o.type === 'function_call' && o.name === spec.toolName)
        ?? data.output?.find(o => o.type === 'function_call');
    if (call?.arguments) return call.arguments;

    // 没调工具 → 把所有文本片段拼起来抠 JSON
    const textOut = data.output_text
        ?? (data.output ?? [])
            .flatMap(o => o.content ?? [])
            .map(c => c.text ?? '')
            .join('\n');
    const extracted = extractJson(textOut);
    if (extracted) return extracted;

    throw new LlmError('parse',
        mode === 'json' ? '回复里找不到 JSON 对象' : '模型未调用工具，回复里也没有 JSON');
}

// ---------- 姿势记忆 ----------

/**
 * 记住每个「接口 + 模型」实际能用哪种调用姿势，避免每次都从 forced 撞一遍。
 * 只存在内存里，重启后重新试探。
 */
const workingMode = new Map<string, CallMode>();

export function modeKey(config: LlmConfig): string {
    return `${config.baseUrl}::${config.model}::${config.protocol}`;
}

export function knownMode(config: LlmConfig): CallMode | undefined {
    return workingMode.get(modeKey(config));
}

/** 降级顺序：上次成功的那个排最前，其余按可靠性排 */
function orderedModes(config: LlmConfig): CallMode[] {
    const all: CallMode[] = ['forced', 'auto', 'json'];
    const known = workingMode.get(modeKey(config));
    if (!known) return all;
    return [known, ...all.filter(m => m !== known)];
}

// ---------- 对外：一次结构化调用 ----------

/**
 * 用指定姿势调一次并解析。
 * retryOnParse 只在**最后一种**姿势上打开：中间的姿势解析失败了直接降级就好，
 * 原地重试一次纯属多花一次调用。
 */
export async function callOnce<T>(
    config: LlmConfig, spec: CallSpec, mode: CallMode,
    parse: (argumentsJson: string) => T,
    retryOnParse = false,
): Promise<T> {
    const call = config.protocol === 'responses' ? callResponses : callChat;
    try {
        return parse(await call(config, spec, mode));
    } catch (err) {
        if (retryOnParse && err instanceof LlmError && err.kind === 'parse') {
            return parse(await call(config, spec, mode));
        }
        throw err;
    }
}

/**
 * 按 forced → auto → json 依次降级地调一次。
 * 思考模式的模型会拒绝强制 tool_choice（Thinking mode does not support this tool_choice），
 * 碰到这类报错就换下一种姿势，而不是直接判失败。
 * 成功哪个就记住哪个，下次直接从它开始，不用每次都撞一遍墙。
 */
export async function callCascade<T>(
    config: LlmConfig, spec: CallSpec, parse: (argumentsJson: string) => T,
): Promise<{ value: T; mode: CallMode }> {
    const configured = config.toolMode ?? 'cascade';
    const modes: CallMode[] = configured === 'cascade' ? orderedModes(config) : [configured];

    const tried: CallMode[] = [];
    let lastError: LlmError | Error | null = null;

    for (let i = 0; i < modes.length; i++) {
        const mode = modes[i];
        const isLast = i === modes.length - 1;
        tried.push(mode);
        try {
            const value = await callOnce(config, spec, mode, parse, isLast);
            workingMode.set(modeKey(config), mode);
            return { value, mode };
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
}

/** 把抛出来的异常整理成统一的失败结果，省得每个调用点各写一遍 try/catch */
export function toFailure(err: unknown): { kind: LlmFailure; error: string; triedModes?: CallMode[] } {
    return {
        kind: err instanceof LlmError ? err.kind : 'unknown',
        error: err instanceof Error ? err.message : String(err),
        triedModes: (err as { triedModes?: CallMode[] }).triedModes,
    };
}

/** 供配置面板显示：LLM 是否已配好 */
export function describeLlmConfig(): string {
    const config = readLlmConfig();
    if (!config) return '未配置（缺 TITLEGUARD_LLM_BASE_URL / API_KEY / MODEL）';
    const known = knownMode(config);
    return `${config.model} @ ${config.baseUrl}`
        + `（${config.protocol === 'chat' ? 'Chat Completions' : 'Responses API'}`
        + `${known ? ` · ${MODE_LABEL[known]}` : ''}`
        + `${config.stream === false ? ' · 非流式' : ' · 流式'}`
        + ` · 闲置超时 ${Math.round(config.timeoutMs / 1000)} 秒）`;
}
