// src/modules/titleGuard/tools/analyzeTitles.ts
//
// 离线分析工具：拿真实帖子标题的导出表跑一遍完整检测链路，看规则会判出什么。
// 不连 Discord、不碰数据库、不调 LLM——纯粹用来在上线前调准词典。
//
// 用法：
//   npx tsx src/modules/titleGuard/tools/analyzeTitles.ts <标题表.xlsx> [选项]
//
// 选项：
//   --dict <path>     词典种子 JSON，默认 tools/seed-dict.json
//   --marker-only     把所有词的生效范围强制改成「仅标记段」，用来对比误判差异
//   --out <path>      结果导出到 xlsx
//   --samples <n>     每类打印多少条样本，默认 8
//
// 输入表需要这些列（就是 /论坛标题 导出 的格式）：
//   服务器 | 服务器ID | 论坛 | 论坛ID | 帖子标题 | 帖子ID | 帖子链接 | 作者ID | 创建时间 | 已归档 | 已锁定 | TAG | TAG ID

import path from 'path';
import { readFileSync } from 'fs';
import ExcelJS from 'exceljs';

import { compileConfig, detect } from '../services/ruleEngine';
import { buildPlan } from '../services/rewriter';
// 只引纯函数，别把数据层拉起来——那会顺手建一个 sqlite 文件
import { normalize, shouldForceAsciiBoundary } from '../services/normalizer';
import type {
    AppliedTag,
    DictEntry,
    DictKind,
    DictScope,
    GuardConfig,
    RuleCode,
} from '../services/types';

// ============================================================
// 参数
// ============================================================

interface Options {
    input: string;
    dictPath: string;
    markerOnly: boolean;
    out: string | null;
    samples: number;
}

function parseArgs(argv: string[]): Options {
    const args = argv.slice(2);
    const input = args.find(a => !a.startsWith('--'));
    if (!input) {
        console.error('用法：npx tsx src/modules/titleGuard/tools/analyzeTitles.ts <标题表.xlsx> [--dict x.json] [--marker-only] [--out 结果.xlsx]');
        process.exit(1);
    }

    const pick = (flag: string): string | null => {
        const i = args.indexOf(flag);
        return i >= 0 && args[i + 1] ? args[i + 1] : null;
    };

    return {
        input,
        dictPath: pick('--dict') ?? path.join(__dirname, 'seed-dict.json'),
        markerOnly: args.includes('--marker-only'),
        out: pick('--out'),
        samples: Number(pick('--samples') ?? 8),
    };
}

// ============================================================
// 词典种子
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
    /** 分类组优先级，数值大的优先保留（NTR > NTL > 纯爱） */
    groupPriority?: Record<string, number>;
    /** 「多路线」中性 TAG 的分类组名 */
    multiRouteGroup?: string | null;
    dict: SeedEntry[];
    whitelist: string[];
}

function loadSeed(file: string, markerOnly: boolean): { config: GuardConfig; tagGroups: Map<string, string> } {
    const seed = JSON.parse(readFileSync(file, 'utf8')) as Seed;

    const toEntry = (e: SeedEntry): DictEntry => {
        const word = normalize(e.word).text.trim();
        return {
            word,
            kind: e.kind,
            group: e.kind === '白名单' ? null : e.group,
            scope: markerOnly && e.kind !== '白名单' ? '仅标记段' : (e.scope ?? '全标题'),
            replaceTo: e.replaceTo ?? null,
            asciiBoundary: shouldForceAsciiBoundary(word),
            note: e.note,
        };
    };

    const dict = [
        ...seed.dict.map(toEntry),
        ...(seed.whitelist ?? []).map(w => toEntry({ word: w, kind: '白名单', group: null })),
    ];

    const tagGroups = new Map(
        Object.entries(seed.tagGroups ?? {}).map(([name, group]) => [name.trim().toLowerCase(), group]),
    );

    return {
        config: {
            dict,
            exclusiveSets: seed.exclusiveSets ?? [],
            crossExclusions: seed.crossExclusions ?? [],
            segmenterWords: seed.segmenterWords ?? [],
            groupPriority: seed.groupPriority ?? {},
            multiRouteGroup: seed.multiRouteGroup ?? null,
        },
        tagGroups,
    };
}

// ============================================================
// 读表
// ============================================================

interface ThreadRow {
    guild: string;
    forum: string;
    title: string;
    threadId: string;
    url: string;
    authorId: string;
    createdAt: string;
    archived: boolean;
    tagNames: string[];
    tagIds: string[];
}

async function readThreads(file: string): Promise<ThreadRow[]> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('表里没有工作表');

    const rows: ThreadRow[] = [];
    const cell = (row: ExcelJS.Row, i: number): string => {
        const v = row.getCell(i).value;
        if (v === null || v === undefined) return '';
        if (typeof v === 'object') {
            const o = v as { text?: string; result?: unknown; hyperlink?: string };
            return String(o.text ?? o.result ?? o.hyperlink ?? '').trim();
        }
        return String(v).trim();
    };

    ws.eachRow((row, index) => {
        if (index === 1) return;
        const title = cell(row, 5);
        if (!title) return;

        const split = (s: string) => s.split('|').map(x => x.trim()).filter(Boolean);

        rows.push({
            guild: cell(row, 1),
            forum: cell(row, 3),
            title,
            threadId: cell(row, 6),
            url: cell(row, 7),
            authorId: cell(row, 8),
            createdAt: cell(row, 9).replace(/^"|"$/g, ''),
            archived: cell(row, 10) === 'true',
            tagNames: split(cell(row, 12)),
            tagIds: split(cell(row, 13)),
        });
    });

    return rows;
}

// ============================================================
// 主流程
// ============================================================

interface Flagged {
    row: ThreadRow;
    rules: RuleCode[];
    messages: string[];
    needsLlm: boolean;
    matchedWords: string[];
    suggestedTitle: string;
    removeTags: string[];
    addTags: string[];
    keepGroup: string;
    keepSource: string;
    autoFixable: boolean;
    blockedReason: string;
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv);
    const { config, tagGroups } = loadSeed(options.dictPath, options.markerOnly);
    const compiled = compileConfig(config);

    console.log('='.repeat(72));
    console.log('标题规范 · 离线分析');
    console.log('='.repeat(72));
    console.log(`标题表　　：${path.basename(options.input)}`);
    console.log(`词典种子　：${path.basename(options.dictPath)}（${config.dict.length} 词，`
        + `其中白名单 ${config.dict.filter(d => d.kind === '白名单').length} 个）`);
    const setsOf = (dim: 'tag' | 'word') => config.exclusiveSets
        .filter(x => x.dimension === dim).map(x => x.groups.join('/')).join('　') || '无';
    console.log(`TAG 互斥　：${setsOf('tag')}`);
    console.log(`关键字互斥：${setsOf('word')}`);
    console.log(`交叉互斥　：${config.crossExclusions.length} 条`
        + `（挂 X 的 TAG 就不许标题里出现 Y）`);
    console.log(`生效范围　：${options.markerOnly ? '⚠️ 强制「仅标记段」（对比模式）' : '按词典各自配置'}`);

    const rows = await readThreads(options.input);
    console.log(`\n读入 ${rows.length} 条帖子。开始检测…\n`);

    const flagged: Flagged[] = [];
    const ruleCount = new Map<RuleCode, number>();
    const wordCount = new Map<string, number>();
    const forumFlagged = new Map<string, number>();
    const forumTotal = new Map<string, number>();
    const unmappedTags = new Map<string, number>();

    let anyMatch = 0;

    for (const row of rows) {
        const key = `${row.guild} / ${row.forum}`;
        forumTotal.set(key, (forumTotal.get(key) ?? 0) + 1);

        const tags: AppliedTag[] = row.tagNames.map((name, i) => {
            const group = tagGroups.get(name.trim().toLowerCase()) ?? null;
            if (!group) unmappedTags.set(name, (unmappedTags.get(name) ?? 0) + 1);
            return { tagId: row.tagIds[i] ?? `idx${i}`, tagName: name, group };
        });

        const result = detect({ title: row.title, tags, config }, compiled);

        for (const m of result.matches) {
            if (m.entry.kind === '白名单') continue;
            wordCount.set(m.entry.word, (wordCount.get(m.entry.word) ?? 0) + 1);
        }
        if (result.matches.some(m => m.entry.kind !== '白名单')) anyMatch++;

        if (result.violations.length === 0) continue;

        // 论坛里确实有「多路线」这个 TAG，喂给 buildPlan 才能统计出「会补多路线」的数量
        const availableTags = config.multiRouteGroup
            ? [{ tagId: 'multi-route', tagName: '多路线', group: config.multiRouteGroup }]
            : [];
        const plan = buildPlan({ detectResult: result, tags, availableTags, compiled });
        const rules = [...new Set(result.violations.map(v => v.rule))];
        for (const r of rules) ruleCount.set(r, (ruleCount.get(r) ?? 0) + 1);
        forumFlagged.set(key, (forumFlagged.get(key) ?? 0) + 1);

        flagged.push({
            row,
            rules,
            messages: result.violations.map(v => v.message),
            needsLlm: result.violations.some(v => v.needsLlm),
            matchedWords: result.matches.filter(m => m.entry.kind !== '白名单').map(m => m.entry.word),
            suggestedTitle: plan.newTitle !== plan.originalTitle ? plan.newTitle : '',
            removeTags: tags.filter(t => plan.removeTagIds.includes(t.tagId)).map(t => t.tagName),
            addTags: plan.addTagIds.length > 0 ? ['多路线'] : [],
            keepGroup: plan.keepGroup ?? '',
            keepSource: plan.keepSource,
            autoFixable: plan.autoFixable,
            blockedReason: plan.blockedReason ?? '',
        });
    }

    // ---------- 汇总 ----------

    const pct = (n: number) => `${(n / rows.length * 100).toFixed(2)}%`;
    const needsLlm = flagged.filter(f => f.needsLlm);
    const autoFixable = flagged.filter(f => f.autoFixable && !f.needsLlm);
    const toHuman = flagged.filter(f => !f.autoFixable && !f.needsLlm);

    console.log('─'.repeat(72));
    console.log('总览');
    console.log('─'.repeat(72));
    console.log(`帖子总数　　　　　${rows.length}`);
    console.log(`命中过任意关键词　${anyMatch}（${pct(anyMatch)}）`);
    console.log(`判定违规　　　　　${flagged.length}（${pct(flagged.length)}）`);
    console.log(`  ├ 可直接自动整改　${autoFixable.length}`);
    console.log(`  ├ 需 LLM 定性　　 ${needsLlm.length}`);
    console.log(`  └ 直接转人工　　　${toHuman.length}`);

    console.log('\n' + '─'.repeat(72));
    console.log('各条规则命中数（一个帖子可能命中多条）');
    console.log('─'.repeat(72));
    const RULE_DESC: Record<RuleCode, string> = {
        T1: '标题含黑名单词',
        T2: '标题关键字互斥',
        T3: '标题正文关键字互斥',
        T4: 'TAG 与关键字交叉互斥',
        G1: 'TAG 之间互斥',
    };
    for (const rule of ['T1', 'T2', 'G1', 'T3', 'T4'] as RuleCode[]) {
        const n = ruleCount.get(rule) ?? 0;
        // T4 落在标签区里时不用问 LLM，只有沾了正文才要，所以这里不再一刀切标注
        const llm = rule === 'T3' ? '  ← 需 LLM' : rule === 'T4' ? '  ← 落在正文时需 LLM' : '';
        console.log(`  ${rule}  ${RULE_DESC[rule].padEnd(20)} ${String(n).padStart(6)}${llm}`);
    }

    console.log('\n' + '─'.repeat(72));
    console.log('关键词命中次数（不含白名单）');
    console.log('─'.repeat(72));
    for (const [word, n] of [...wordCount].sort((a, b) => b[1] - a[1])) {
        const entry = config.dict.find(d => d.word === word);
        console.log(`  ${word.padEnd(12)} ${String(n).padStart(6)}   ${entry?.kind ?? ''} ${entry?.group ?? ''}`);
    }

    console.log('\n' + '─'.repeat(72));
    console.log('各论坛违规率');
    console.log('─'.repeat(72));
    for (const [forum, total] of [...forumTotal].sort((a, b) => b[1] - a[1])) {
        const hit = forumFlagged.get(forum) ?? 0;
        if (total < 20) continue;
        console.log(`  ${forum.padEnd(38)} ${String(hit).padStart(5)} / ${String(total).padStart(5)}`
            + `  ${(hit / total * 100).toFixed(1)}%`);
    }

    const unmapped = [...unmappedTags].sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (unmapped.length > 0) {
        console.log('\n' + '─'.repeat(72));
        console.log('未映射到分类组的 TAG（前 12，多数是题材标签，正常）');
        console.log('─'.repeat(72));
        console.log('  ' + unmapped.map(([n, c]) => `${n}(${c})`).join('　'));
    }

    // ---------- 样本 ----------

    const printSamples = (label: string, list: Flagged[]) => {
        if (list.length === 0) return;
        console.log('\n' + '─'.repeat(72));
        console.log(`${label}　样本 ${Math.min(options.samples, list.length)} / ${list.length}`);
        console.log('─'.repeat(72));
        for (const f of list.slice(0, options.samples)) {
            console.log(`  「${f.row.title}」`);
            console.log(`    TAG: ${f.row.tagNames.join('、') || '—'}`);
            console.log(`    命中: ${f.matchedWords.join('、')}　规则: ${f.rules.join(' ')}`);
            if (f.suggestedTitle) console.log(`    建议: 「${f.suggestedTitle}」`);
            if (f.removeTags.length) console.log(`    摘TAG: ${f.removeTags.join('、')}`);
            if (f.addTags.length) console.log(`    补TAG: ${f.addTags.join('、')}`);
            if (f.keepGroup) console.log(`    保留: ${f.keepGroup}（${f.keepSource}）`);
            if (f.blockedReason) console.log(`    转人工: ${f.blockedReason}`);
            console.log('');
        }
    };

    printSamples('✅ 可直接自动整改', autoFixable);
    printSamples('🤖 需 LLM 定性', needsLlm);
    printSamples('👤 直接转人工', toHuman);

    // ---------- 导出 ----------

    if (options.out) {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('检出结果');
        ws.columns = [
            { header: '服务器', key: 'guild', width: 16 },
            { header: '论坛', key: 'forum', width: 22 },
            { header: '标题', key: 'title', width: 55 },
            { header: 'TAG', key: 'tags', width: 26 },
            { header: '命中词', key: 'words', width: 22 },
            { header: '规则', key: 'rules', width: 12 },
            { header: '处置', key: 'disposition', width: 14 },
            { header: '建议新标题', key: 'suggested', width: 55 },
            { header: '摘除TAG', key: 'removeTags', width: 18 },
            { header: '补上TAG', key: 'addTags', width: 12 },
            { header: '保留分类', key: 'keepGroup', width: 10 },
            { header: '依据', key: 'keepSource', width: 10 },
            { header: '转人工原因', key: 'blocked', width: 40 },
            { header: '说明', key: 'messages', width: 60 },
            { header: '已归档', key: 'archived', width: 8 },
            { header: '创建时间', key: 'createdAt', width: 22 },
            { header: '链接', key: 'url', width: 62 },
        ];
        for (const f of flagged) {
            ws.addRow({
                guild: f.row.guild,
                forum: f.row.forum,
                title: f.row.title,
                tags: f.row.tagNames.join(' | '),
                words: f.matchedWords.join(' | '),
                rules: f.rules.join(' '),
                disposition: f.needsLlm ? '需LLM' : f.autoFixable ? '可自动改' : '转人工',
                suggested: f.suggestedTitle,
                removeTags: f.removeTags.join(' | '),
                addTags: f.addTags.join(' | '),
                keepGroup: f.keepGroup,
                keepSource: f.keepSource,
                blocked: f.blockedReason,
                messages: f.messages.join('；'),
                archived: f.row.archived ? '是' : '否',
                createdAt: f.row.createdAt,
                url: f.row.url,
            });
        }
        ws.getRow(1).font = { bold: true };
        ws.autoFilter = { from: 'A1', to: 'Q1' };
        await wb.xlsx.writeFile(options.out);
        console.log(`\n📤 已导出 ${flagged.length} 条到 ${options.out}`);
    }
}

void main().catch(err => {
    console.error('分析失败：', err);
    process.exit(1);
});
