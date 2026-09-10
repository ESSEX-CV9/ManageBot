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
//   3. 不出现内部术语：不写规则编号（T2/G1）、不写「标记段」「互斥集合」这类词
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
    /** 申诉已升到人工，等管理组处理 */
    awaitingHuman?: boolean;
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
            case 'T1':
                for (const h of v.hits) {
                    const word = sourceWords([h], input.normalized)[0];
                    add(h.entry.replaceTo
                        ? `标题含禁用写法「${word}」，应改为「${h.entry.replaceTo}」`
                        : `标题含禁用写法「${word}」，应予删除`);
                }
                break;

            case 'T2':
                add(withWording(
                    `标题中同时使用互斥分类 ${quoteList(v.groups)}`,
                    v.hits, v.groups,
                ));
                break;

            case 'T3':
                add(withWording(
                    `标题正文中同时提及互斥分类 ${quoteList(v.groups)}`,
                    v.hits, v.groups,
                ));
                break;

            case 'T4':
                // groups 固定是 [关键字侧, TAG 侧]
                add(withWording(
                    `标题所示分类「${v.groups[0]}」与所挂 TAG「${v.groups[1]}」不得并存`,
                    v.hits, [v.groups[0]],
                ));
                break;

            case 'G1':
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

export function buildNoticeContent(input: NoticeInput): NoticeContent {
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

    if (has('T2', 'T3', 'G1')) {
        basisLines.push('同一作品不得声明互斥分类：标题内不可，TAG 内亦不可。');
        basisLines.push('作品确有多条互斥路线的，应择主要路线作为主分类，另行加挂「多路线」。');
    }
    if (has('T4')) {
        basisLines.push('部分分类与特定 TAG 不得并存。二者相遇时，按社区既定顺序保留其一。');
    }
    if (has('T1')) {
        basisLines.push('部分写法已有规范的替代表述，应统一使用规范写法。');
    }
    if (basisLines.length === 0) {
        basisLines.push('同一作品不得声明互斥分类：标题内不可，TAG 内不可，标题与 TAG 之间亦不可矛盾。');
    }
    fields.push({ name: '四、规范依据', value: basisLines.join('\n') });

    // AI 说过的话挂在最下面，小字，不抢正文
    const notes: string[] = [];
    if (input.llmReason) notes.push(subtext('🤖 AI 判定：' + input.llmReason));
    if (input.review) {
        notes.push(subtext(
            (input.review.upheld ? '🤖 AI 复核：维持原判。' : '🤖 AI 复核：申诉成立。')
            + input.review.reason,
        ));
    }

    const description = '本帖分类信息不符合社区规范，请按下列说明处理。'
        + (input.isOldPost ? '\n本帖为旧帖，已相应延长处理期限。' : '')
        + (notes.length > 0 ? '\n\n' + notes.join('\n') : '');

    return {
        mention: input.authorId ? `<@${input.authorId}>` : null,
        title: '帖子分类规范 · 整改通知',
        description,
        fields,
        footer: input.awaitingHuman
            ? '本帖已提请人工复核，倒计时保持暂停，请等待管理组处理。'
            : input.review
                ? '如仍有异议，可点击下方按钮提请人工复核。'
                : '如对判定有异议，请点击下方按钮提请复核，倒计时将即时暂停。',
        buttons: buildButtonList(input),
    };
}

/**
 * 通知上应该有哪几个按钮。
 * 复核那颗会随案件状态变：AI 复核用掉之前是「申请复核」，用掉之后是「申请人工复核」，
 * 已经升到人工了就不再显示——重复点没有意义。
 */
function buildButtonList(input: NoticeInput): NoticeButton[] {
    const buttons: NoticeButton[] = [
        { label: '我要修改', style: 'primary', who: '帖主 / 管理组' },
    ];

    if (input.awaitingHuman) {
        buttons.push({ label: '驳回申诉', style: 'secondary', who: '有「复核」权限的身份组' });
    } else {
        buttons.push({
            label: input.review ? '申请人工复核' : '申请复核',
            style: 'secondary',
            who: '帖主 / 管理组',
        });
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
