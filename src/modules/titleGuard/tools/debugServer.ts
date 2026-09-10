// src/modules/titleGuard/tools/debugServer.ts
//
// 本地调试台。起一个 HTTP 服务，浏览器里就能：
//   1. 粘贴单条标题，看引擎怎么切分、命中了哪些词、判了哪些规则、打算怎么改
//   2. 导入真实的帖子标题 xlsx，批量跑一遍，逐条查看
//   3. 直接改词表（分类词 / 黑名单 / 白名单 / 互斥集合 / 优先级 / TAG 禁令）并立即生效
//
// 跑：  npm run guard:ui        然后打开 http://127.0.0.1:5180
//
// 后台调用的是**线上同一套引擎代码**（normalizer / segmenter / matcher / ruleEngine / rewriter），
// 不是另写一套，所以这里看到的判定结果和机器人实际行为一致。
// 唯一的差别：不调 LLM——需要 LLM 定性的会明确标出来。
//
// 词表存在 tools/seed-dict.json，改完即时生效，离线分析脚本 analyzeTitles.ts 读的是同一份。

import http from 'node:http';
import path from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import ExcelJS from 'exceljs';

import { compileConfig, detect, type CompiledConfig } from '../services/ruleEngine';
import { buildPlan } from '../services/rewriter';
import { matchWithDebug, compileDict, makeIsWholeDictWord } from '../services/matcher';
import { normalize, shouldForceAsciiBoundary } from '../services/normalizer';
import { segment, POSITION_LABEL, tokenizeMarker } from '../services/segmenter';
import { cutForDebug } from '../services/wordBoundary';
import { buildNoticeContent, buildDoneMessage, type NoticeContent } from '../services/noticeContent';
import {
    judge, MODE_LABEL, buildJudgeRules,
    type Judgement, type LlmConfig, type LlmProtocol, type ToolMode,
} from '../services/llmJudge';
import type {
    AppliedTag,
    DictEntry,
    DictKind,
    DictScope,
    GuardConfig,
} from '../services/types';

const PORT = Number(process.env.TITLEGUARD_UI_PORT || 5180);
const DICT_PATH = path.join(__dirname, 'seed-dict.json');
const HTML_PATH = path.join(__dirname, 'debug-ui.html');

// ============================================================
// 词表
// ============================================================

interface SeedEntry {
    word: string;
    kind: DictKind;
    group: string | null;
    scope?: DictScope;
    replaceTo?: string | null;
    note?: string;
}

interface Seed {
    exclusiveSets: { dimension: 'tag' | 'word'; groups: string[]; note?: string }[];
    crossExclusions: { tagGroup: string; wordGroup: string; note?: string }[];
    segmenterWords?: { word: string; action: '补词' | '拆词'; note?: string }[];
    tagGroups: Record<string, string>;
    groupPriority?: Record<string, number>;
    multiRouteGroup?: string | null;
    dict: SeedEntry[];
    whitelist: string[];
    [key: string]: unknown;
}

function loadSeed(): Seed {
    return JSON.parse(readFileSync(DICT_PATH, 'utf8')) as Seed;
}

function seedToConfig(seed: Seed): GuardConfig {
    const toEntry = (e: SeedEntry): DictEntry => {
        const word = normalize(e.word).text.trim();
        return {
            word,
            kind: e.kind,
            group: e.kind === '白名单' ? null : (e.group || null),
            scope: e.scope ?? '全标题',
            replaceTo: e.replaceTo || null,
            asciiBoundary: shouldForceAsciiBoundary(word),
            note: e.note,
        };
    };

    return {
        dict: [
            ...(seed.dict ?? []).map(toEntry),
            ...(seed.whitelist ?? []).map(w => toEntry({ word: w, kind: '白名单', group: null })),
        ].filter(d => d.word),
        exclusiveSets: seed.exclusiveSets ?? [],
        crossExclusions: seed.crossExclusions ?? [],
        segmenterWords: seed.segmenterWords ?? [],
        groupPriority: seed.groupPriority ?? {},
        multiRouteGroup: seed.multiRouteGroup ?? null,
    };
}

// ============================================================
// 词表体检
// ============================================================

export interface ConfigIssue {
    level: 'error' | 'warn';
    message: string;
}

/**
 * 检查词表里互相矛盾或者不生效的配置。
 * 这类问题肉眼很难发现——比如某个分类组配了优先级却没进任何互斥集合，
 * 它就永远不会参与冲突判定，配了等于没配。
 */
function validateSeed(seed: Seed): ConfigIssue[] {
    const issues: ConfigIssue[] = [];

    const sets = seed.exclusiveSets ?? [];
    const cross = seed.crossExclusions ?? [];
    const priority = seed.groupPriority ?? {};
    const tagSets = sets.filter(x => x.dimension === 'tag');
    const wordSets = sets.filter(x => x.dimension === 'word');

    /** 参与了任何一条规则的分类组。没参与任何规则的，配了也是摆设 */
    const known = new Set<string>([
        ...sets.flatMap(x => x.groups),
        ...cross.flatMap(c => [c.tagGroup, c.wordGroup]),
        ...(seed.multiRouteGroup ? [seed.multiRouteGroup] : []),
    ]);

    // 1. 互斥集合本身
    for (const set of sets) {
        const label = set.dimension === 'tag' ? 'TAG 互斥' : '关键字互斥';
        if (set.groups.length < 2) {
            issues.push({
                level: 'warn',
                message: `${label}集合「${set.groups.join('/') || '(空)'}」只有 ${set.groups.length} 个分类组，`
                    + '至少要两个才谈得上互斥。',
            });
            continue;
        }
        const missing = set.groups.filter(g => priority[g] === undefined);
        if (missing.length > 0) {
            issues.push({
                level: 'warn',
                message: `${label}集合 ${set.groups.join(' / ')} 里的 ${missing.join('、')} 没配优先级，`
                    + '这几个撞上时定不了保留哪个，只能转人工。',
            });
        }
    }

    // 2. 配了优先级却一条规则都没参与 —— 配了也白配
    for (const group of Object.keys(priority)) {
        if (!known.has(group)) {
            issues.push({
                level: 'error',
                message: `分类组「${group}」配了优先级 ${priority[group]}，`
                    + '但它没出现在任何互斥集合或交叉规则里，永远不会参与判定。',
            });
        }
    }

    // 2b. 只配了一半：TAG 互斥了但关键字没管，或者反过来。
    // 这不一定是错的（四种组合都成立），但十有八九是配漏了，值得提醒一句。
    const asPairs = (list: typeof sets) => {
        const out = new Set<string>();
        for (const set of list) {
            for (const x of set.groups) for (const y of set.groups) {
                if (x < y) out.add(x + '\u0000' + y);
            }
        }
        return out;
    };
    const tagPairs = asPairs(tagSets);
    const wordPairs = asPairs(wordSets);
    for (const pair of tagPairs) {
        if (wordPairs.has(pair)) continue;
        const [x, y] = pair.split('\u0000');
        issues.push({
            level: 'warn',
            message: `${x} 和 ${y} 的 TAG 互斥，但标题关键字不互斥——`
                + '确认一下是有意为之，还是漏配了关键字互斥。',
        });
    }
    for (const pair of wordPairs) {
        if (tagPairs.has(pair)) continue;
        const [x, y] = pair.split('\u0000');
        issues.push({
            level: 'warn',
            message: `${x} 和 ${y} 的标题关键字互斥，但 TAG 不互斥——`
                + '确认一下是有意为之，还是漏配了 TAG 互斥。',
        });
    }

    // 2c. 互斥了、却没配对应的交叉互斥。
    // 「纯爱和 NTR 在标题里不能并存」和「挂 NTR TAG 就不许标题里写纯爱」是两条规矩，
    // 少配后者，挂着 NTR TAG、标题里写纯爱的帖子就没人管——而这正是最常见的一种污染。
    {
        const crossPairs = new Set(cross.map(c => c.tagGroup + '\u0000' + c.wordGroup));
        const missing: string[] = [];
        for (const set of wordSets) {
            for (const a of set.groups) {
                for (const b of set.groups) {
                    if (a === b) continue;
                    // a 有 TAG 才谈得上「挂 a 的 TAG」
                    if (!Object.values(seed.tagGroups ?? {}).includes(a)) continue;
                    if (crossPairs.has(a + '\u0000' + b)) continue;
                    missing.push(`${a} TAG × ${b} 关键字`);
                }
            }
        }
        if (missing.length > 0) {
            issues.push({
                level: 'warn',
                message: `这些组合在关键字维度互斥，却没有对应的交叉互斥规则：`
                    + `${missing.slice(0, 8).join('、')}${missing.length > 8 ? ` 等 ${missing.length} 条` : ''}。`
                    + '意思是「挂着前者的 TAG、标题里写了后者」这种帖子目前不会被判违规。',
            });
        }
    }

    // 3. 词典引用了没人管的分类组
    const usedGroups = new Set(
        (seed.dict ?? [])
            .filter(d => (d.kind === '分类词' || d.kind === '黑名单') && d.group)
            .map(d => d.group as string),
    );
    for (const group of usedGroups) {
        if (!known.has(group)) {
            issues.push({
                level: 'warn',
                message: `有词条归到分类组「${group}」，但它没出现在任何互斥集合或交叉规则里，`
                    + '这些词命中了不会触发任何规则。',
            });
        }
    }

    // 4. 词条本身的配置
    for (const d of seed.dict ?? []) {
        if (!d.word?.trim()) {
            issues.push({ level: 'error', message: '有词条的「词」是空的。' });
            continue;
        }
        // 只有分类词和黑名单需要分类组；白名单和中性标记本来就不参与互斥判定
        if ((d.kind === '分类词' || d.kind === '黑名单') && !d.group) {
            issues.push({ level: 'error', message: `词条「${d.word}」是${d.kind}，但没指定分类组。` });
        }
        if ((d.kind === '白名单' || d.kind === '中性标记') && d.group) {
            issues.push({ level: 'warn', message: `${d.kind}「${d.word}」填了分类组，会被忽略。` });
        }
        if (d.kind === '黑名单' && !d.replaceTo) {
            issues.push({
                level: 'warn',
                message: `黑名单词「${d.word}」没填「替换为」，命中后会被直接删掉而不是换成规范写法。`,
            });
        }
    }

    // 5. 重复词
    const seen = new Map<string, number>();
    for (const w of [...(seed.dict ?? []).map(d => d.word), ...(seed.whitelist ?? [])]) {
        const key = normalize(w ?? '').text.trim();
        if (!key) continue;
        seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [word, count] of seen) {
        if (count > 1) {
            issues.push({ level: 'error', message: `词「${word}」重复出现了 ${count} 次，后面的会覆盖前面的。` });
        }
    }

    // 6. 交叉互斥
    {
        const dictGroups = new Set((seed.dict ?? []).map(d => d.group));
        const mappedGroups = new Set(Object.values(seed.tagGroups ?? {}));
        for (const c of seed.crossExclusions ?? []) {
            if (c.tagGroup === c.wordGroup) {
                issues.push({
                    level: 'error',
                    message: `交叉互斥「${c.tagGroup} TAG × ${c.wordGroup} 关键字」两边是同一个组，`
                        + '等于禁止自己，配错了。',
                });
                continue;
            }
            if (!mappedGroups.has(c.tagGroup)) {
                issues.push({
                    level: 'warn',
                    message: `交叉互斥要禁的「${c.tagGroup}」TAG 没有任何 TAG 映射到它，这条不会生效。`,
                });
            }
            if (!dictGroups.has(c.wordGroup)) {
                issues.push({
                    level: 'error',
                    message: `交叉互斥里的关键字分类「${c.wordGroup}」没有任何词条，永远不会命中。`,
                });
            }
            const tp = priority[c.tagGroup];
            const wp = priority[c.wordGroup];
            if (tp === undefined && wp === undefined) {
                issues.push({
                    level: 'warn',
                    message: `${c.tagGroup} 和 ${c.wordGroup} 都没配优先级，`
                        + '这条交叉互斥撞上时只能按默认办法摘 TAG。',
                });
            }
        }
    }

    // 7. TAG 映射
    for (const [tagName, group] of Object.entries(seed.tagGroups ?? {})) {
        if (!tagName.trim()) {
            issues.push({ level: 'error', message: 'TAG 映射里有空的 TAG 名。' });
            continue;
        }
        if (!group.trim()) {
            issues.push({ level: 'warn', message: `TAG「${tagName}」没映射到分类组。` });
            continue;
        }
        if (!known.has(group)) {
            issues.push({
                level: 'warn',
                message: `TAG「${tagName}」映射到「${group}」，但这个组没出现在任何互斥集合`
                    + '或交叉规则里，挂不挂都不影响判定。',
            });
        }
    }

    // 8. 多路线
    if (seed.multiRouteGroup && !Object.values(seed.tagGroups ?? {}).includes(seed.multiRouteGroup)) {
        issues.push({
            level: 'warn',
            message: `「多路线」分类组设为「${seed.multiRouteGroup}」，`
                + '但 TAG 映射里没有任何 TAG 指向它，摘完互斥 TAG 后补不上。',
        });
    }

    // 同一句话可能被不同条目各报一次（比如三条交叉互斥都指向同一个缺失的 TAG），去重
    const seenMsg = new Set<string>();
    return issues.filter(i => {
        const key = i.level + i.message;
        if (seenMsg.has(key)) return false;
        seenMsg.add(key);
        return true;
    });
}

/** 当前生效的配置。改词表后重建 */
let seed = loadSeed();
let config = seedToConfig(seed);
let compiled: CompiledConfig = compileConfig(config);

function reloadConfig(next: Seed): void {
    seed = next;
    config = seedToConfig(seed);
    compiled = compileConfig(config);
}

function tagNameToGroup(name: string): string | null {
    const map = seed.tagGroups ?? {};
    const key = name.trim();
    if (map[key]) return map[key];
    const lower = key.toLowerCase();
    for (const [k, v] of Object.entries(map)) {
        if (k.toLowerCase() === lower) return v;
    }
    return null;
}

function toAppliedTags(names: string[]): AppliedTag[] {
    return names
        .map(n => n.trim())
        .filter(Boolean)
        .map((name, i) => ({ tagId: `t${i}:${name}`, tagName: name, group: tagNameToGroup(name) }));
}

// ============================================================
// LLM 配置（只存内存，进程退出即丢——API key 不该落到仓库里的文件）
// ============================================================

let llmConfig: LlmConfig | null = null;

function maskKey(key: string): string {
    if (key.length <= 8) return '****';
    return key.slice(0, 4) + '****' + key.slice(-4);
}

/** 已知服务商的预设，省得每次手敲 base_url */
const PROVIDER_PRESETS = [
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', protocol: 'chat' },
    { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', protocol: 'chat' },
    { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', protocol: 'chat' },
    { name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', protocol: 'chat' },
    { name: '阿里百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', protocol: 'chat' },
    { name: '自定义', baseUrl: '', model: '', protocol: 'chat' },
];

// ============================================================
// 单条判定（这是界面的核心：把引擎内部过程全摊开）
// ============================================================

interface AnalyzeResult {
    title: string;
    normalizedText: string;
    /** 切分结果：每段的类型、位置、内容、以及段内的 token */
    segments: {
        index: number;
        kind: string;
        position: string;
        positionLabel: string;
        text: string;
        sourceText: string;
        wellFormed: boolean;
        confident: boolean;
        bracket: string | null;
        tokens: { text: string; matched: boolean }[];
    }[];
    /** 全部候选命中，含落选的和落选原因 */
    candidates: {
        word: string;
        kind: string;
        group: string | null;
        chosen: boolean;
        supersededBy: string | null;
        segmentIndex: number;
        segmentKind: string;
        positionLabel: string;
        sourceText: string;
    }[];
    tags: { name: string; group: string | null }[];
    violations: {
        rule: string;
        message: string;
        groups: string[];
        needsLlm: boolean;
        words: string[];
        tagNames: string[];
    }[];
    plan: {
        newTitle: string;
        changed: boolean;
        removeTags: string[];
        addTags: string[];
        keepGroup: string | null;
        keepSource: string;
        autoFixable: boolean;
        blockedReason: string | null;
        notes: string[];
    } | null;
    /** 处置结论 */
    disposition: '合规' | '可自动整改' | '需LLM定性' | '转人工';
    /** 发给作者的通知原文（和 Discord 上一字不差） */
    notice: NoticeContent | null;
    /** 到期整改完成后帖内回的那条 */
    doneMessage: string | null;
    /** 真实 LLM 判定结果（只有手动发起过才有） */
    judgement: Judgement | null;
}

/**
 * 论坛里可用的全部 TAG。真机上由 readForumTags() 从 Discord 拿，
 * 调试台按词表的 TAG 映射造一份等价的，好让「摘错的 TAG、补对的 TAG」能预览出来。
 */
function availableTagsFromConfig(): AppliedTag[] {
    return Object.entries(seed.tagGroups ?? {}).map(([tagName, group]) => ({
        tagId: 'forum_' + tagName,
        tagName,
        group: group || null,
    }));
}

function analyze(
    title: string,
    tagNames: string[],
    judgement: Judgement | null = null,
): AnalyzeResult {
    const tags = toAppliedTags(tagNames);
    const norm = normalize(title);
    const isWhole = makeIsWholeDictWord(compileDict(config.dict));
    const segs = segment(norm.text, { isWholeDictWord: isWhole });
    const { candidates } = matchWithDebug(segs, compileDict(config.dict));

    const result = detect({ title, tags, config }, compiled);

    // 论坛里有「多路线」TAG 时才能补，这里按有来算，方便看到完整方案
    const availableTags = availableTagsFromConfig();

    // 有 LLM 结论时，按结论重算方案：判定「不是分类标记」就把需 LLM 的违规全部作废
    const llmCleared = judgement !== null && !judgement.isClassification;
    const effectiveViolations = llmCleared
        ? result.violations.filter(v => !v.needsLlm)
        : result.violations;

    const plan = result.violations.length > 0
        ? buildPlan({ detectResult: result, tags, availableTags, compiled, judgement, llmCleared })
        : null;

    const src = (start: number, end: number) => {
        if (norm.text.length === 0) return '';
        const s = Math.max(0, Math.min(start, norm.text.length - 1));
        const e = Math.max(0, Math.min(end - 1, norm.text.length - 1));
        return norm.original.slice(norm.srcStart[s], norm.srcEnd[e]);
    };

    const chosenSpans = candidates.filter(c => c.chosen);

    const segmentsOut = segs.map((seg, index) => {
        const tokens = seg.kind === 'marker'
            ? tokenizeMarker(seg).map(t => ({
                text: t.text,
                matched: chosenSpans.some(c => c.start >= t.start && c.end <= t.end),
            }))
            : [];
        return {
            index,
            kind: seg.kind,
            position: seg.position,
            positionLabel: POSITION_LABEL[seg.position],
            text: seg.text,
            sourceText: src(seg.start, seg.end),
            wellFormed: seg.wellFormed,
            confident: seg.confident,
            bracket: seg.bracket ? `${seg.bracket.open}${seg.bracket.close}` : null,
            tokens,
        };
    });

    const candidatesOut = candidates.map(c => ({
        word: c.word,
        kind: c.kind,
        group: c.group,
        chosen: c.chosen,
        supersededBy: c.supersededBy,
        segmentIndex: c.segmentIndex,
        segmentKind: c.segmentKind,
        positionLabel: POSITION_LABEL[segs[c.segmentIndex]?.position ?? 'body'],
        sourceText: src(c.start, c.end),
    }));

    const violationsOut = effectiveViolations.map(v => ({
        rule: v.rule,
        message: v.message,
        groups: v.groups,
        needsLlm: v.needsLlm,
        words: v.hits.map(h => h.entry.word),
        tagNames: v.tagIds.map(id => tags.find(t => t.tagId === id)?.tagName ?? id),
    }));

    let disposition: AnalyzeResult['disposition'] = '合规';
    if (effectiveViolations.length === 0) {
        disposition = '合规';
    } else if (judgement === null && effectiveViolations.some(v => v.needsLlm)) {
        disposition = '需LLM定性';
    } else if (plan?.autoFixable) {
        disposition = '可自动整改';
    } else {
        disposition = '转人工';
    }

    const removeTagNames = plan
        ? tags.filter(t => plan.removeTagIds.includes(t.tagId)).map(t => t.tagName)
        : [];
    const addTagNames = plan
        ? plan.addTagIds.map(id => availableTags.find(t => t.tagId === id)?.tagName ?? id)
        : [];

    // 通知预览：截止时间按「新帖 24 小时」算，纯为让界面能看到时间格式。
    // 还没拿到 LLM 结论时不出通知——方案没定，通知里只能写「不知道怎么办」。
    // 没有实际违规（LLM 判定放过了）就不该有通知；还没拿到判定结论也不该有
    const notice = plan && effectiveViolations.length > 0 && disposition !== '需LLM定性'
        ? buildNoticeContent({
            authorId: 'AUTHOR',
            originalTitle: title,
            newTitle: plan.newTitle,
            titleChanged: plan.newTitle !== plan.originalTitle,
            violations: effectiveViolations,
            removeTagNames,
            addTagNames,
            keepGroup: plan.keepGroup,
            keepSource: plan.keepSource,
            autoFixable: plan.autoFixable,
            blockedReason: plan.blockedReason,
            deadline: Date.now() + 24 * 3600 * 1000,
            isOldPost: false,
            normalized: norm,
        })
        : null;

    const doneMessage = plan && plan.autoFixable && disposition === '可自动整改'
        ? buildDoneMessage({
            titleChanged: plan.newTitle !== plan.originalTitle,
            newTitle: plan.newTitle,
            removeTagNames,
            addTagNames,
        })
        : null;

    return {
        title,
        normalizedText: norm.text,
        segments: segmentsOut,
        candidates: candidatesOut,
        tags: tags.map(t => ({ name: t.tagName, group: t.group })),
        violations: violationsOut,
        plan: plan
            ? {
                newTitle: plan.newTitle,
                changed: plan.newTitle !== plan.originalTitle,
                removeTags: tags.filter(t => plan.removeTagIds.includes(t.tagId)).map(t => t.tagName),
                addTags: plan.addTagIds
                    .map(id => availableTags.find(t => t.tagId === id)?.tagName ?? id),
                keepGroup: plan.keepGroup,
                keepSource: plan.keepSource,
                autoFixable: plan.autoFixable,
                blockedReason: plan.blockedReason,
                notes: plan.notes,
            }
            : null,
        disposition,
        notice,
        doneMessage,
        judgement,
    };
}

// ============================================================
// 批量：加载 xlsx 到内存
// ============================================================

interface Row {
    guild: string;
    forum: string;
    title: string;
    url: string;
    archived: boolean;
    createdAt: string;
    tagNames: string[];
}

let rows: Row[] = [];
let sourceName = '';

async function loadWorkbook(buffer: Buffer): Promise<number> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('表里没有工作表');

    const cell = (row: ExcelJS.Row, i: number): string => {
        const v = row.getCell(i).value;
        if (v === null || v === undefined) return '';
        if (typeof v === 'object') {
            const o = v as { text?: string; result?: unknown; hyperlink?: string };
            return String(o.text ?? o.result ?? o.hyperlink ?? '').trim();
        }
        return String(v).trim();
    };

    const next: Row[] = [];
    ws.eachRow((row, index) => {
        if (index === 1) return;
        const title = cell(row, 5);
        if (!title) return;
        next.push({
            guild: cell(row, 1),
            forum: cell(row, 3),
            title,
            url: cell(row, 7),
            archived: cell(row, 10) === 'true',
            createdAt: cell(row, 9).replace(/^"|"$/g, ''),
            tagNames: cell(row, 12).split('|').map(s => s.trim()).filter(Boolean),
        });
    });

    rows = next;
    return rows.length;
}

interface BatchItem {
    index: number;
    guild: string;
    forum: string;
    title: string;
    url: string;
    tags: string;
    rules: string[];
    words: string[];
    disposition: string;
    newTitle: string;
    removeTags: string[];
    addTags: string[];
    keepGroup: string | null;
    keepSource: string;
    blockedReason: string;
}

function runBatch(): { items: BatchItem[]; stats: Record<string, number>; ruleStats: Record<string, number>; wordStats: [string, number][]; forumStats: [string, number, number][] } {
    const items: BatchItem[] = [];
    const stats: Record<string, number> = { 总数: rows.length, 合规: 0, 可自动整改: 0, 需LLM定性: 0, 转人工: 0 };
    const ruleStats: Record<string, number> = {};
    const wordCount = new Map<string, number>();
    const forumTotal = new Map<string, number>();
    const forumHit = new Map<string, number>();

    rows.forEach((row, index) => {
        const key = `${row.guild} / ${row.forum}`;
        forumTotal.set(key, (forumTotal.get(key) ?? 0) + 1);

        const r = analyze(row.title, row.tagNames);
        stats[r.disposition] = (stats[r.disposition] ?? 0) + 1;

        for (const c of r.candidates) {
            if (!c.chosen || c.kind === '白名单') continue;
            wordCount.set(c.word, (wordCount.get(c.word) ?? 0) + 1);
        }

        if (r.violations.length === 0) return;
        forumHit.set(key, (forumHit.get(key) ?? 0) + 1);
        for (const rule of new Set(r.violations.map(v => v.rule))) {
            ruleStats[rule] = (ruleStats[rule] ?? 0) + 1;
        }

        items.push({
            index,
            guild: row.guild,
            forum: row.forum,
            title: row.title,
            url: row.url,
            tags: row.tagNames.join(' | '),
            rules: [...new Set(r.violations.map(v => v.rule))],
            words: [...new Set(r.candidates.filter(c => c.chosen && c.kind !== '白名单').map(c => c.word))],
            disposition: r.disposition,
            newTitle: r.plan?.changed ? r.plan.newTitle : '',
            removeTags: r.plan?.removeTags ?? [],
            addTags: r.plan?.addTags ?? [],
            keepGroup: r.plan?.keepGroup ?? null,
            keepSource: r.plan?.keepSource ?? '',
            blockedReason: r.plan?.blockedReason ?? '',
        });
    });

    const forumStats: [string, number, number][] = [...forumTotal.entries()]
        .map(([k, total]) => [k, forumHit.get(k) ?? 0, total] as [string, number, number])
        .sort((a, b) => b[2] - a[2]);

    return {
        items,
        stats,
        ruleStats,
        wordStats: [...wordCount.entries()].sort((a, b) => b[1] - a[1]),
        forumStats,
    };
}

// ============================================================
// HTTP
// ============================================================

function readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c as Buffer));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(body);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    try {
        // --- 页面 ---
        if (url.pathname === '/' || url.pathname === '/index.html') {
            if (!existsSync(HTML_PATH)) {
                res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('缺少 debug-ui.html');
                return;
            }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(readFileSync(HTML_PATH));
            return;
        }

        // --- 词表读写 ---
        if (url.pathname === '/api/dict' && req.method === 'GET') {
            json(res, {
                seed,
                stats: {
                    分类词: config.dict.filter(d => d.kind === '分类词').length,
                    黑名单: config.dict.filter(d => d.kind === '黑名单').length,
                    白名单: config.dict.filter(d => d.kind === '白名单').length,
                    中性标记: config.dict.filter(d => d.kind === '中性标记').length,
                },
                issues: validateSeed(seed),
            });
            return;
        }

        // 试切：拿当前（可能还没保存的）分词词库切一段文字，肉眼看切得对不对
        if (url.pathname === '/api/cut' && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)).toString('utf8')) as
                { text?: string; segmenterWords?: Seed['segmenterWords'] };
            const norm = normalize(body.text ?? '');
            const jargon = config.dict.filter(d => d.kind !== '黑名单').map(d => d.word);
            const tokens = cutForDebug(norm.text, jargon, body.segmenterWords ?? []);
            json(res, { ok: true, normalized: norm.text, tokens, available: tokens !== null });
            return;
        }

        // 只体检，不落盘。导入文件后先看看有没有问题，再决定要不要保存。
        if (url.pathname === '/api/dict/check' && req.method === 'POST') {
            const candidate = JSON.parse((await readBody(req)).toString('utf8')) as Seed;
            json(res, { ok: true, issues: validateSeed(candidate) });
            return;
        }

        if (url.pathname === '/api/dict' && req.method === 'POST') {
            const next = JSON.parse((await readBody(req)).toString('utf8')) as Seed;

            // 拦一手「把有词的词表存成空的」。
            // 这不是假想的风险：界面上某个面板抛异常导致词条表格没渲染出来时，
            // 保存动作会从空表格里收出一个空词典，一键抹掉全部配置。
            const nextWords = (next.dict?.length ?? 0) + (next.whitelist?.length ?? 0);
            const currentWords = (seed.dict?.length ?? 0) + (seed.whitelist?.length ?? 0);
            if (nextWords === 0 && currentWords > 0 && url.searchParams.get('force') !== '1') {
                json(res, {
                    ok: false,
                    error: `这次保存会把 ${currentWords} 条词全部清空。`
                        + '多半是页面没渲染好，已拒绝写入。刷新页面重试；'
                        + '确实要清空的话，在地址后面加 ?force=1。',
                }, 409);
                return;
            }

            // 覆盖前留一份上一版，出事了能捞回来
            try {
                if (existsSync(DICT_PATH)) writeFileSync(DICT_PATH + '.bak', readFileSync(DICT_PATH));
            } catch (err) {
                console.warn('[调试台] 备份旧词表失败：', err);
            }

            reloadConfig(next);
            writeFileSync(DICT_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
            json(res, { ok: true, words: config.dict.length, issues: validateSeed(next) });
            return;
        }

        // --- LLM 配置（只存内存） ---
        if (url.pathname === '/api/llm' && req.method === 'GET') {
            json(res, {
                configured: Boolean(llmConfig),
                presets: PROVIDER_PRESETS,
                current: llmConfig
                    ? {
                        baseUrl: llmConfig.baseUrl,
                        model: llmConfig.model,
                        protocol: llmConfig.protocol,
                        toolMode: llmConfig.toolMode ?? 'cascade',
                        timeoutMs: llmConfig.timeoutMs,
                        apiKeyMasked: maskKey(llmConfig.apiKey),
                    }
                    : null,
            });
            return;
        }

        if (url.pathname === '/api/llm' && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)).toString('utf8')) as {
                baseUrl?: string; apiKey?: string; model?: string;
                protocol?: string; timeoutMs?: number; toolMode?: string;
            };
            const baseUrl = (body.baseUrl ?? '').trim().replace(/\/+$/, '');
            const apiKey = (body.apiKey ?? '').trim();
            const model = (body.model ?? '').trim();

            if (!baseUrl || !apiKey || !model) {
                json(res, { ok: false, error: '接口地址、API Key、模型名都得填' }, 400);
                return;
            }

            const rawMode = String(body.toolMode ?? 'cascade');
            llmConfig = {
                baseUrl, apiKey, model,
                protocol: (body.protocol === 'responses' ? 'responses' : 'chat') as LlmProtocol,
                timeoutMs: Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : 30000,
                toolMode: (['forced', 'auto', 'json'].includes(rawMode) ? rawMode : 'cascade') as ToolMode,
            };
            json(res, { ok: true, apiKeyMasked: maskKey(apiKey) });
            return;
        }

        if (url.pathname === '/api/llm' && req.method === 'DELETE') {
            llmConfig = null;
            json(res, { ok: true });
            return;
        }

        // --- 连通性自检：用一条固定样例真调一次 ---
        if (url.pathname === '/api/llm-test' && req.method === 'POST') {
            if (!llmConfig) { json(res, { ok: false, error: '还没配置 LLM' }, 400); return; }
            const t0 = Date.now();
            const outcome = await judge(
                {
                    title: '《真正的橘子味世界不允许百合破坏的存在！》',
                    forumName: '测试论坛',
                    hits: [{ word: '百合破坏', group: '百破', where: 'body' }],
                    tags: [{ name: '百合', group: '百合' }],
                    rules: buildJudgeRules(config),
                },
                { config: llmConfig },
            );
            json(res, {
                ok: outcome.ok,
                elapsedMs: Date.now() - t0,
                ...(outcome.ok
                    ? {
                        judgement: outcome.judgement,
                        mode: outcome.mode,
                        modeLabel: MODE_LABEL[outcome.mode],
                        expected: '这条是完整句子，正确答案是「不是分类标记」',
                    }
                    : { kind: outcome.kind, error: outcome.error, triedModes: outcome.triedModes }),
            });
            return;
        }

        // --- 手动发起一次真实 LLM 判定 ---
        if (url.pathname === '/api/llm-judge' && req.method === 'POST') {
            if (!llmConfig) { json(res, { ok: false, error: '还没配置 LLM，先去「LLM 判定」页签填' }, 400); return; }

            const body = JSON.parse((await readBody(req)).toString('utf8')) as {
                title?: string; tags?: string[]; index?: number; forumName?: string; bodyExcerpt?: string;
            };

            const row = typeof body.index === 'number' ? rows[body.index] : undefined;
            const title = row?.title ?? body.title ?? '';
            const tagNames = row?.tagNames ?? body.tags ?? [];
            const forumName = row?.forum ?? body.forumName ?? '（未指定论坛）';
            if (!title) { json(res, { ok: false, error: '没有标题' }, 400); return; }

            // 先跑一遍检测，拿到要交给 LLM 的命中信息
            const before = analyze(title, tagNames);
            const tags = toAppliedTags(tagNames);
            const detectResult = detect({ title, tags, config }, compiled);

            const t0 = Date.now();
            const outcome = await judge(
                {
                    title,
                    forumName,
                    hits: detectResult.matches
                        .filter(m => m.entry.group)
                        .map(m => ({ word: m.entry.word, group: m.entry.group!, where: m.segmentKind })),
                    tags: tags.map(t => ({ name: t.tagName, group: t.group })),
                    rules: buildJudgeRules(config),
                },
                { config: llmConfig, bodyExcerpt: body.bodyExcerpt },
            );

            if (!outcome.ok) {
                json(res, {
                    ok: false, kind: outcome.kind, error: outcome.error,
                    triedModes: outcome.triedModes, elapsedMs: Date.now() - t0,
                });
                return;
            }

            // 拿判定结果重算一遍，得到最终方案和通知
            json(res, {
                ok: true,
                elapsedMs: Date.now() - t0,
                usedBody: outcome.usedBody,
                mode: outcome.mode,
                modeLabel: MODE_LABEL[outcome.mode],
                judgement: outcome.judgement,
                before: { disposition: before.disposition },
                after: analyze(title, tagNames, outcome.judgement),
            });
            return;
        }

        // --- 单条判定 ---
        if (url.pathname === '/api/analyze' && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)).toString('utf8')) as {
                title?: string; titles?: string[]; tags?: string[];
            };
            if (Array.isArray(body.titles)) {
                json(res, { results: body.titles.filter(Boolean).map(t => analyze(t, body.tags ?? [])) });
            } else {
                json(res, analyze(body.title ?? '', body.tags ?? []));
            }
            return;
        }

        // --- 上传 xlsx ---
        if (url.pathname === '/api/upload' && req.method === 'POST') {
            const buffer = await readBody(req);
            const count = await loadWorkbook(buffer);
            sourceName = decodeURIComponent(String(req.headers['x-filename'] ?? '上传的表'));
            json(res, { ok: true, count, sourceName });
            return;
        }

        // --- 用服务器上已有的文件 ---
        if (url.pathname === '/api/load-path' && req.method === 'POST') {
            const { file } = JSON.parse((await readBody(req)).toString('utf8')) as { file: string };
            const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
            if (!existsSync(abs)) { json(res, { ok: false, error: '文件不存在：' + abs }, 404); return; }
            const count = await loadWorkbook(readFileSync(abs));
            sourceName = path.basename(abs);
            json(res, { ok: true, count, sourceName });
            return;
        }

        // --- 批量跑 ---
        if (url.pathname === '/api/batch' && req.method === 'POST') {
            if (rows.length === 0) { json(res, { ok: false, error: '还没有导入标题表' }, 400); return; }
            const t0 = Date.now();
            const result = runBatch();
            json(res, { ok: true, sourceName, elapsedMs: Date.now() - t0, ...result });
            return;
        }

        // --- 批量里的某一行看详情 ---
        if (url.pathname === '/api/row' && req.method === 'GET') {
            const index = Number(url.searchParams.get('index'));
            const row = rows[index];
            if (!row) { json(res, { ok: false, error: '没有这一行' }, 404); return; }
            json(res, { ok: true, meta: row, result: analyze(row.title, row.tagNames) });
            return;
        }

        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
    } catch (err) {
        console.error('[TitleGuard/UI] 出错：', err);
        json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('  标题规范 · 调试台已启动');
    console.log('  ────────────────────────────────────────');
    console.log(`  打开：  http://127.0.0.1:${PORT}`);
    console.log(`  词表：  ${DICT_PATH}`);
    console.log(`  词条：  ${config.dict.length} 条`);
    console.log('');
    console.log('  后台跑的是机器人同一套引擎代码，不调 LLM。');
    console.log('  按 Ctrl+C 退出。');
    console.log('');
});
