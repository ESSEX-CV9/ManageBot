// src/modules/titleGuard/services/noticeContent.ts
//
// 生成发给作者的整改通知**文案**。纯逻辑：不碰 discord.js、不碰数据库。
//
// 抽出来单独一个文件，是为了让调试台能显示**和 Discord 上一字不差**的通知内容，
// 方便管理组在上线前核对措辞。
//
// 文案规范：
//   1. 这是管理通知，用书面语，不用口语（「将」不用「会」、「逾期」不用「到期还没」）
//   2. **处理方式和处理期限必须最醒目**——作者最需要知道的是「机器人要做什么」「什么时候做」，
//      规范依据放最后，简短带过即可
//   3. 不出现内部术语：不写规则编号（W/G/X/B）、不写「标记段」「互斥集合」「本体词」这类词
//   4. 展示给作者的词一律用**标题原文的写法**，不能是引擎内部归一化后的小写形式

import { toSourceRange } from './normalizer';
import type { GroupId, Match, NormalizedTitle, Violation } from './types';
import type { KeepSource } from './rewriter';

export interface NoticeField {
    name: string;
    value: string;
}

export interface NoticeButton {
    label: string;
    style: 'primary' | 'secondary' | 'danger';
    /** 谁能点 */
    who: string;
    /** 调试台也要如实展示 Discord 上的禁用状态 */
    disabled?: boolean;
}

export interface NoticeContent {
    /** 帖内 @ 谁 */
    mention: string | null;
    title: string;
    description: string;
    fields: NoticeField[];
    footer: string;
    buttons: NoticeButton[];
}

export interface NoticeInput {
    authorId: string | null;
    originalTitle: string;
    newTitle: string;
    titleChanged: boolean;
    violations: Violation[];
    removeTagNames: string[];
    addTagNames: string[];
    keepGroup: GroupId | null;
    keepSource: KeepSource;
    autoFixable: boolean;
    blockedReason: string | null;
    /** 截止时间戳（毫秒）。null = 倒计时已暂停 */
    deadline: number | null;
    isOldPost: boolean;
    /**
     * 归一化结果。给了它，通知里就能显示标题**原文的写法**
     * （否则只能拿到引擎内部的小写形式，作者看着莫名其妙）。
     */
    normalized?: NormalizedTitle;
    /**
     * AI 的说法，会用小字挂在通知最下面。
     * 分两条：建案时的定性理由，和作者申诉后的复核结论。
     */
    llmReason?: string | null;
    review?: {
        /** true = 维持原判，false = 申诉成立 */
        upheld: boolean;
        reason: string;
    } | null;
    /** 额外一次 AI 复核名额是否已经使用（包括正在处理但尚无结论的状态） */
    aiReviewUsed?: boolean;
    /** 申诉已升到人工，等管理组处理 */
    awaitingHuman?: boolean;
    /**
     * 案子已经有结果了。给了它，整条通知就改口——
     * 不能一边写着「申诉成立、不作整改」，一边还挂着「请按下列说明处理」和处理期限。
     */
    resolution?: {
        /** released = 判定被推翻/被放行，帖子不动；resolved = 已整改或已合规 */
        kind: 'released' | 'resolved';
        /** 一句话说明为什么结束 */
        note: string;
    } | null;
}

/** AI 理由的显示上限。再长就淹没正文了，完整内容管理组能在案件详情里看 */
const REASON_LIMIT = 300;

/**
 * Discord 的小字语法。整段每一行都要带前缀，否则换行后就变回正常字号了。
 * 顺手把可能的 @ 提及打断——这些文字里混着模型复述的作者原话。
 */
function subtext(text: string): string {
    const safe = text.replace(/@(everyone|here)/g, '@\u200b$1').replace(/<@[!&]?(\d+)>/g, '@$1');
    const clipped = safe.length > REASON_LIMIT ? safe.slice(0, REASON_LIMIT) + '…' : safe;
    return clipped.split(/\r?\n/).map(line => '-# ' + line).join('\n');
}

/** 顿号连接的「A」「B」「C」 */
function quoteList(items: string[]): string {
    return items.map(x => `「${x}」`).join('、');
}

/** 把命中还原成标题里的原文写法 */
function sourceWords(hits: Match[], normalized?: NormalizedTitle): string[] {
    const words = hits.map(h => {
        if (!normalized) return h.entry.word;
        const range = toSourceRange(normalized, h.start, h.end);
        return normalized.original.slice(range.start, range.end) || h.entry.word;
    });
    return [...new Set(words)];
}

/**
 * 把违规翻译成作者看得懂的书面表述。
 * 不提规则编号——那是给管理组排查用的。
 */
function describeViolations(input: NoticeInput): string[] {
    const lines: string[] = [];
    const seen = new Set<string>();

    const add = (text: string) => {
        if (seen.has(text)) return;
        seen.add(text);
        lines.push(text);
    };

    /** 命中词与分类名不同时才补一句「标题中的写法」，否则是废话 */
    const withWording = (base: string, hits: Match[], groups: string[]): string => {
        const words = sourceWords(hits, input.normalized);
        const sameAsGroups = words.length === groups.length
            && words.every(w => groups.some(g => g.toLowerCase() === w.toLowerCase()));
        return sameAsGroups ? base : `${base}（标题中的写法：${words.join('、')}）`;
    };

    for (const v of input.violations) {
        switch (v.rule) {
            case 'B':
                for (const h of v.hits) {
                    const word = sourceWords([h], input.normalized)[0];
                    add(h.entry.replaceTo
                        ? `标题含禁用写法「${word}」，应改为「${h.entry.replaceTo}」`
                        : `标题含禁用写法「${word}」，应予删除`);
                }
                break;

            case 'W':
                add(withWording(
                    `标题中同时出现互斥分类 ${quoteList(v.groups)}`,
                    v.hits, v.groups,
                ));
                break;

            case 'X':
                // groups 固定是 [关键字侧, TAG 侧]
                add(withWording(
                    `标题所示分类「${v.groups[0]}」与所挂 TAG「${v.groups[1]}」不得并存`,
                    v.hits, [v.groups[0]],
                ));
                break;

            case 'G':
                add(`帖子同时挂载互斥 TAG ${quoteList(v.groups)}`);
                break;
        }
    }

    return lines;
}

const KEEP_BASIS: Record<KeepSource, string> = {
    author: '由作者指定',
    tag: '依据帖子所挂 TAG',
    priority: '依据社区分类优先顺序',
    rule: '依据分类规则之既定方向',
    llm: '依据标题语义判定',
    none: '',
};

/**
 * 这条案子有没有经过 AI 判定。
 *
 * **只说「经过了」，绝不把 AI 的原话摆在公开消息里。**
 * 那些话里带着它读到的规则、它的推理路数、甚至提示词里的措辞，
 * 谁都能看的话，等于把提示词的轮廓一点点喂给想做注入的人。
 * 完整理由走通知上那颗按钮，只有管理组点得开。
 */
function aiTouched(input: NoticeInput): boolean {
    return Boolean(input.llmReason || input.review);
}

/** 告诉作者「这次经过了 AI 判定」，以及去哪儿看依据 */
function aiFooterLine(input: NoticeInput): string {
    if (!aiTouched(input)) return '';
    return input.review
        ? '本帖的整改方案经过 AI 语义判定，并已复核过一次。'
        : '本帖的整改方案经过 AI 语义判定。';
}

type AiReviewState = 'available' | 'running' | 'complete';

/** 兼容调试台未显式传 aiReviewUsed 的旧输入：已有复核结论就视为已使用。 */
function aiReviewState(input: NoticeInput): AiReviewState {
    const used = input.aiReviewUsed ?? Boolean(input.review);
    if (!used) return 'available';
    return input.review ? 'complete' : 'running';
}

function canRequestAiReview(input: NoticeInput): boolean {
    return !input.awaitingHuman && aiReviewState(input) === 'available';
}

/**
 * 已结案的通知长什么样。
 *
 * 关键是**不留任何要求整改的措辞**：不列违规、不写处理方式、不写期限。
 * 案子都结了还挂着这些，作者只会更糊涂。
 */
function buildClosedContent(
    input: NoticeInput, resolution: NonNullable<NoticeInput['resolution']>,
): NoticeContent {
    const released = resolution.kind === 'released';
    const line = aiFooterLine(input);

    return {
        mention: null,
        title: released ? '帖子分类规范 · 已撤销' : '帖子分类规范 · 已结束',
        description: released
            ? '本帖经复核后**不作整改**，先前的整改通知作废。'
            : '本帖分类信息已符合规范，本次检查结束。',
        fields: [{ name: '结论', value: resolution.note || '—' }],
        footer: line ? line + '\n如有疑问，请联系管理组。' : '如有疑问，请联系管理组。',
        // 结案之后仍然留一颗查依据的按钮，作者和管理组都可以回看
        buttons: aiTouched(input)
            ? [{ label: 'AI 判定依据', style: 'secondary', who: '帖主 / 有「接警」权限的身份组' }]
            : [],
    };
}

export function buildNoticeContent(input: NoticeInput): NoticeContent {
    // 有结果了就走另一套文案，下面那些「请在期限前修改」一句都不能留
    if (input.resolution) return buildClosedContent(input, input.resolution);

    const fields: NoticeField[] = [];

    // ---------- 1. 不符合规范之处 ----------
    const problems = describeViolations(input);
    fields.push({
        name: '一、不符合规范之处',
        value: problems.map((p, i) => `${i + 1}. ${p}`).join('\n') || '—',
    });

    // ---------- 2. 处理方式（最重要，必须写死写清） ----------
    const actions: string[] = [];
    if (input.titleChanged) {
        actions.push(`标题变更为：\n\`${input.newTitle}\``);
    }
    if (input.removeTagNames.length > 0) {
        actions.push(`移除 TAG：${input.removeTagNames.join('、')}`);
    }
    if (input.addTagNames.length > 0) {
        actions.push(`添加 TAG：${input.addTagNames.join('、')}`);
    }

    const basis = input.keepGroup ? KEEP_BASIS[input.keepSource] : '';
    const keepLine = input.keepGroup
        ? `保留 **${input.keepGroup}** 为主分类${basis ? `（${basis}）` : ''}`
        : null;

    if (input.autoFixable) {
        fields.push({
            name: '二、逾期后机器人的处理方式',
            value: [
                keepLine,
                ...actions.map(a => `· ${a}`),
            ].filter(Boolean).join('\n') || '—',
        });
    } else {
        fields.push({
            name: '二、处理方式',
            value: '本帖情况机器人不会自动修改，将于期限届满后**转交管理组人工处理**。'
                + (input.blockedReason ? `\n（原因：${input.blockedReason}）` : '')
                + (actions.length > 0
                    ? `\n\n建议的修改方向：\n${[keepLine, ...actions.map(a => `· ${a}`)].filter(Boolean).join('\n')}`
                    : ''),
        });
    }

    // ---------- 3. 处理期限 ----------
    if (input.deadline) {
        const ts = Math.floor(input.deadline / 1000);
        fields.push({
            name: '三、处理期限',
            value: `**<t:${ts}:f>**（<t:${ts}:R>）\n`
                + (input.autoFixable
                    ? '请在此之前自行修改。逾期未修改的，机器人将按上述方式自动执行。'
                    : '请在此之前自行修改。逾期未修改的，将转交管理组处理。'),
        });
    } else {
        fields.push({
            name: '三、处理期限',
            value: '倒计时已暂停，等待管理组复核。',
        });
    }

    // ---------- 4. 规范依据（简短） ----------
    const has = (...rules: string[]) => input.violations.some(v => rules.includes(v.rule));
    const basisLines: string[] = [];

    if (has('W', 'G')) {
        basisLines.push('同一作品不得声明互斥分类：标题内不可，TAG 内亦不可。');
        basisLines.push('作品确有多条互斥路线的，应择主要路线作为主分类，另行加挂「多路线」。');
    }
    if (has('X')) {
        basisLines.push('部分分类与特定 TAG 不得并存。二者相遇时，按社区既定顺序保留其一。');
    }
    if (has('B')) {
        basisLines.push('部分写法已有规范的替代表述，应统一使用规范写法。');
    }
    if (basisLines.length === 0) {
        basisLines.push('同一作品不得声明互斥分类：标题内不可，TAG 内不可，标题与 TAG 之间亦不可矛盾。');
    }
    fields.push({ name: '四、规范依据', value: basisLines.join('\n') });

    const description = '本帖分类信息不符合社区规范，请按下列说明处理。'
        + (input.isOldPost ? '\n本帖为旧帖，已相应延长处理期限。' : '')
        + (canRequestAiReview(input)
            ? '\n\n> 如果认为判定有误，可以点击复核按钮调用 LLM 再次复核。'
            : '');

    return {
        mention: input.authorId ? `<@${input.authorId}>` : null,
        title: '帖子分类规范 · 整改通知',
        description,
        fields,
        // AI 那行放在最后一行小字**上面**，让作者知道这次有语义判定参与
        footer: [
            aiFooterLine(input),
            input.awaitingHuman
                ? '本帖已提请人工复核，倒计时保持暂停，请等待管理组处理。'
                : aiReviewState(input) === 'running'
                    ? 'AI 复核正在处理中，倒计时已暂停，请等待复核完成。'
                    : canRequestAiReview(input)
                    ? '提交复核后，倒计时将即时暂停。'
                    : '如仍有异议，可点击下方按钮提请人工复核。',
        ].filter(Boolean).join('\n'),
        buttons: buildButtonList(input),
    };
}

/**
 * 通知上应该有哪几个按钮。
 * 复核那颗会随案件状态变：AI 复核用掉之前是「申请复核」，调用期间不可点击，
 * 得到结论之后才是「申请人工复核」，
 * 已经升到人工了就不再显示——重复点没有意义。
 */
function buildButtonList(input: NoticeInput): NoticeButton[] {
    const buttons: NoticeButton[] = [
        { label: '我要修改', style: 'primary', who: '帖主 / 管理组' },
    ];

    if (input.awaitingHuman) {
        buttons.push({ label: '驳回申诉', style: 'secondary', who: '有「复核」权限的身份组' });
    } else {
        const reviewState = aiReviewState(input);
        buttons.push({
            label: reviewState === 'available'
                ? '申请复核'
                : reviewState === 'running'
                    ? 'AI 复核进行中'
                    : '申请人工复核',
            style: 'secondary',
            who: '帖主 / 管理组',
            disabled: reviewState === 'running',
        });
    }

    // AI 参与过才给这颗按钮；理由只通过仅本人可见的交互回复展示。
    if (aiTouched(input)) {
        buttons.push({ label: 'AI 判定依据', style: 'secondary', who: '帖主 / 有「接警」权限的身份组' });
    }

    buttons.push({ label: '人工覆盖', style: 'danger', who: '有「覆盖」权限的身份组' });
    return buttons;
}

/** 整改完成后在帖子里回的那条 */
export function buildDoneMessage(input: {
    titleChanged: boolean;
    newTitle: string;
    removeTagNames: string[];
    addTagNames: string[];
}): string {
    const parts: string[] = [];
    if (input.titleChanged) parts.push(`标题变更为：\`${input.newTitle}\``);
    if (input.removeTagNames.length > 0) parts.push(`移除 TAG：${input.removeTagNames.join('、')}`);
    if (input.addTagNames.length > 0) parts.push(`添加 TAG：${input.addTagNames.join('、')}`);

    return '**帖子分类规范 · 整改完成**\n'
        + '处理期限已届满，机器人已按规范完成下列整改：\n'
        + parts.map(p => `· ${p}`).join('\n')
        + '\n如对整改结果有异议，请联系管理组，可予还原。';
}

/** 复查发现已合规时回的那条 */
export function buildResolvedMessage(): string {
    return '**帖子分类规范 · 检查结束**\n本帖分类信息已符合规范，本次检查结束。';
}
