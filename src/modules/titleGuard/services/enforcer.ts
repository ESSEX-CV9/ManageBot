// src/modules/titleGuard/services/enforcer.ts
//
// 处置流程的执行层：检测一个帖子 → 建案 → 通知作者 → 到期整改 → 记账/还原。
//
// 状态机（设计文档 §7.1）：
//   detected ──通知──> notified ──倒计时──> 到期
//                         │                   │
//           作者自助修改 ──┤                   ├──> 自动整改 ──> resolved
//           管理组覆盖  ──┤                   └──> pending_admin（定不了/校验没过）
//           点了「判错了」┴──> pending_admin（倒计时暂停）
//
// 几条硬规矩：
//   - 每次动手前都存原值，管理组一条命令能还原。
//   - 改标题遵守 Discord 限流：同一帖子 2 次 / 10 分钟。
//   - 归档帖要先解归档才能改；改完恢复原来的归档状态。

import {
    ChannelType,
    SnowflakeUtil,
    type Client,
    type ForumChannel,
    type Guild,
    type ThreadChannel,
} from 'discord.js';

import { compileConfig, detect, judgeHitsOf, type CompiledConfig } from './ruleEngine';
import {
    pendingHits, planProgramStage, previewTagPlan, type RewritePlan,
} from './rewriter';
import { planWithModel } from './planner';
import {
    buildJudgeHits, buildJudgeRules, judge, type Judgement, type JudgementCache,
} from './llmJudge';
import type { AppliedTag, DetectResult, ForumTag, GroupId, Violation } from './types';
import * as db from './titleGuardDatabase';

// ============================================================
// 配置缓存（词典改动后要失效）
// ============================================================

const configCache = new Map<string, { compiled: CompiledConfig; stamp: number }>();
let configVersion = 0;

/** 词典/互斥组/禁令有任何改动后调用，让缓存失效 */
export function invalidateConfigCache(): void {
    configVersion++;
    configCache.clear();
}

export function getCompiledConfig(guildId: string): CompiledConfig {
    const cached = configCache.get(guildId);
    if (cached && cached.stamp === configVersion) return cached.compiled;

    const compiled = compileConfig(db.buildGuardConfig(guildId));
    configCache.set(guildId, { compiled, stamp: configVersion });
    return compiled;
}

/** LLM 判定缓存走模块自己的 SQLite 表 */
const llmCache: JudgementCache = {
    get: key => db.getLlmCache<Judgement>(key),
    set: (key, value) => db.setLlmCache(key, value),
};

// ============================================================
// 帖子读取
// ============================================================

export function isForumThread(channel: unknown): channel is ThreadChannel {
    const c = channel as ThreadChannel | null;
    return Boolean(c && c.type === ChannelType.PublicThread && c.parent?.type === ChannelType.GuildForum);
}

/** 论坛可用的全部 TAG 及其分类组映射。补「多路线」TAG 时要从这里找 */
export function readForumTags(thread: ThreadChannel): ForumTag[] {
    const forum = thread.parent as ForumChannel | null;
    if (!forum) return [];

    const mapping = new Map(
        db.listTagMap(thread.guild.id, forum.id).map(m => [m.tagId, m.group]),
    );
    return forum.availableTags.map(t => ({
        tagId: t.id,
        tagName: t.name,
        group: mapping.get(t.id) ?? null,
    }));
}

/** 把帖子当前挂的 TAG 映射成分类组 */
export function readAppliedTags(thread: ThreadChannel): AppliedTag[] {
    const forum = thread.parent as ForumChannel | null;
    if (!forum) return [];

    const mapping = new Map(
        db.listTagMap(thread.guild.id, forum.id).map(m => [m.tagId, m.group]),
    );
    const names = new Map(forum.availableTags.map(t => [t.id, t.name]));

    return thread.appliedTags.map(tagId => ({
        tagId,
        tagName: names.get(tagId) ?? tagId,
        group: mapping.get(tagId) ?? null,
    }));
}

/**
 * 帖子最后一次有动静是什么时候。
 *
 * 用 lastMessageId 直接算——它是雪花，自带时间戳，不用再拉一次消息列表。
 * 一条消息都没有的帖子（只有首楼被删之类）退回建帖时间。
 */
export function lastActivityAt(thread: ThreadChannel): number {
    if (thread.lastMessageId) {
        return Number(SnowflakeUtil.timestampFrom(thread.lastMessageId));
    }
    return thread.archiveTimestamp ?? thread.createdTimestamp ?? Date.now();
}

/**
 * 这个帖子该按「老帖」处理吗。
 *
 * 看的是**最近活跃时间**，不是发帖时间：
 *   - 还没归档的，不管发了多久，都是活帖 → 24 小时整改通知
 *   - 已归档但最近还有动静（默认 72 小时内）→ 同样按活帖处理
 *   - 已归档且沉寂超过门槛 → 老帖，走长处理期限
 *
 * 为什么这么分：给老帖发通知**一定会顶帖**。一个沉了半年的帖子被顶上来，
 * 对论坛首页是打扰，所以要给足时间、并走慢速队列摊平。
 * 而一个还在被回复的帖子，顶不顶都在那儿，24 小时完全够用。
 */
export function isOldPost(thread: ThreadChannel, inactiveHours: number): boolean {
    if (!thread.archived) return false;
    return Date.now() - lastActivityAt(thread) > inactiveHours * 60 * 60 * 1000;
}

// ============================================================
// 检测
// ============================================================

export interface InspectResult {
    thread: ThreadChannel;
    detectResult: DetectResult;
    tags: AppliedTag[];
    availableTags: ForumTag[];
    plan: RewritePlan | null;
    judgement: Judgement | null;
    /** 模型把每一处命中都判成了误判——整条标题都不用动 */
    llmCleared: boolean;
    /**
     * 这次调模型是**兜底**触发的：规则本身判得清清楚楚，
     * 但改写方案出不来或没过校验，与其直接转人工，不如先问模型要个方案。
     */
    llmFallback: boolean;
    /** 本论坛是否要求所有问题（包括程序本可直接判的）都先经模型 */
    llmForced: boolean;
    /**
     * 存在需要 LLM 定性的违规，但还没拿到判定结论
     * （dryRun、LLM 没配、调用失败）。这种状态**不该给作者发通知**——
     * 方案还没定，通知里只能写「不知道怎么办」，等于骚扰。
     */
    llmPending: boolean;
    /** 跳过的原因（已豁免、论坛没启用等） */
    skipped: string | null;
}

/**
 * 检测一个帖子。dryRun=true 时不调用 LLM（批量静默扫描用，省钱也快）。
 */
export async function inspectThread(
    thread: ThreadChannel,
    options: { dryRun?: boolean; authorChoice?: GroupId | null } = {},
): Promise<InspectResult> {
    const guildId = thread.guild.id;
    const forum = thread.parent as ForumChannel | null;

    const base: Omit<InspectResult, 'skipped'> = {
        thread,
        detectResult: null as unknown as DetectResult,
        tags: [],
        availableTags: [],
        plan: null,
        judgement: null,
        llmCleared: false,
        llmFallback: false,
        llmForced: false,
        llmPending: false,
    };

    if (!forum) return { ...base, skipped: '不是论坛帖子' };

    const forumConfig = db.getForum(guildId, forum.id);
    if (!forumConfig?.enabled) return { ...base, skipped: '该论坛未纳入管理' };

    if (db.isExempt(guildId, thread.id, thread.name)) {
        return { ...base, skipped: '已被管理组豁免' };
    }

    const compiled = getCompiledConfig(guildId);
    const tags = readAppliedTags(thread);
    const availableTags = readForumTags(thread);
    const detectResult = detect({ title: thread.name, tags, config: compiled.raw }, compiled);

    if (detectResult.violations.length === 0) {
        return { ...base, detectResult, tags, availableTags, skipped: null };
    }

    let llmError: string | null = null;
    let judgement: Judgement | null = null;
    let llmCleared = false;
    let llmFallback = false;

    const settings = db.getSettings(guildId);
    const llmForced = forumConfig.forceLlmReview;

    // 程序那一段先跑出来：它决定了「还剩哪几处要问模型」，
    // 也决定了「整改后 TAG 长什么样」。两件事都得在提问之前算好。
    const stage = planProgramStage({ detectResult, tags, forumTags: availableTags, compiled });
    const pending = llmForced ? judgeHitsOf(detectResult) : pendingHits(detectResult, stage);

    /** 真调一次模型。retryFeedback 非空时是「打回重写」那一轮 */
    const callModel = async (retryFeedback?: string): Promise<Judgement | null> => {
        // 定性这一步主要靠首楼：光看标题分不出「这是纯爱作品」还是「作者在描述人设」，
        // 「纯爱牛娘」被分词切成「纯爱牛」这种误伤更是非看首楼不可。
        //
        // 但**默认是关的**，而且要一个论坛一个论坛地开
        //（/标题规范 论坛 添加 … 正文给llm:true，或配置台的论坛页）。
        // 这是有意的：开了就等于把首楼开头发给第三方模型，那是管理组该点头的事，
        // 不该由代码替他们决定。关着的时候模型只能靠标题判，判错的概率明显更高。
        const bodyExcerpt = forumConfig.sendBodyToLlm
            ? await readFirstPostExcerpt(thread) : undefined;

        const outcome = await judge(
            {
                title: thread.name,
                forumName: forum.name,
                segments: detectResult.segments.map(seg => ({
                    kind: seg.kind === 'marker' && seg.confident
                        ? '标签区' as const : '正文' as const,
                    text: seg.text,
                })),
                hits: buildJudgeHits(detectResult, pending, compiled.raw),
                tags: tags.map(t => ({ name: t.tagName, group: t.group })),
                // 程序那一段判出来的冲突直接摊给它
                violations: detectResult.violations.map(v => v.message),
                // 以及整改后 TAG 会变成什么样——它得按这个判，而且有权推翻
                tagPlan: previewTagPlan({
                    detectResult, tags, forumTags: availableTags, compiled,
                }),
                // 把社区既定的互斥关系、保留顺序、本体词清单一起给它。
                // 少给一样它就会自己脑补，而现行规则里恰恰有「TAG 互斥但关键字兼容」
                // 这种不脑补就想不到的配法
                rules: buildJudgeRules(compiled.raw),
                retryFeedback,
            },
            { bodyExcerpt, enabled: settings.llmEnabled, cache: llmCache },
        );

        if (outcome.ok) return outcome.judgement;

        // LLM 不可用：需要它定性的违规全部挂起，规则类违规不受影响照常跑
        llmError = `${outcome.kind}: ${outcome.error}`;
        console.warn(`[TitleGuard] LLM 判定失败（${outcome.kind}）：${outcome.error}`);
        return null;
    };

    /** 问一次模型。已经问过就不再问——同样的输入只会拿回同样的答案 */
    const askModel = async (): Promise<void> => {
        if (judgement !== null) return;
        const result = await callModel();
        if (result) judgement = result;
    };

    const planBase = () => ({
        detectResult,
        tags,
        forumTags: availableTags,
        compiled,
        authorChoice: options.authorChoice,
        judgement,
        modelHandlesAll: llmForced && !options.dryRun,
    });

    // 触发点一：规则本身要求模型定性，或本论坛明确要求所有问题都先经模型。
    if ((detectResult.needsLlm || llmForced) && !options.dryRun) await askModel();

    // 模型给的标题不合规时，把「哪儿还不合规」告诉它，让它重写一次再出方案
    const canRewrite = !options.dryRun && settings.llmEnabled;
    const rewrite = async (feedback: string): Promise<Judgement | null> => {
        if (!canRewrite) return null;
        const result = await callModel(feedback);
        if (result) judgement = result;
        return result;
    };

    let { plan } = await planWithModel(planBase(), rewrite);

    // 触发点二：规则判得清清楚楚，可是方案出不来（比如涉事分类没配保留顺序）。
    //
    // 别急着转人工——模型至少能指一个该留的分类。
    // 转人工应该是**最后一档**，不是某个分支的默认出口。
    if (!plan.autoFixable && judgement === null && canRewrite) {
        await askModel();
        if (judgement !== null) {
            llmFallback = true;
            plan = (await planWithModel(planBase(), rewrite)).plan;
        }
    }

    // 模型看过之后结论是「这帖子不用动」。绿帽癖那种就落在这儿：
    // 正文里的关联词判成描述，标题一个字不改，TAG 也不动。
    llmCleared = judgement !== null
        && plan.autoFixable
        && plan.newTitle === plan.originalTitle
        && plan.removeTagIds.length === 0
        && plan.addTagIds.length === 0;

    const llmPending = (detectResult.needsLlm || llmForced) && judgement === null;
    if (llmPending && llmError) {
        console.warn(`[TitleGuard] 帖子 ${thread.id} 需要 LLM 定性但未取得结论：${llmError}`);
    }

    return {
        ...base,
        detectResult, tags, availableTags, plan, judgement, llmCleared, llmFallback, llmForced, llmPending,
        skipped: null,
    };
}

/**
 * 读首楼开头一段，给模型定性用。
 *
 * 以前只截 200 字，因为那会儿首楼只是「把握低时补一刀」的可选料。
 * 现在定性是第一步，光看标题做不了，所以给足一点。
 */
export async function readFirstPostExcerpt(thread: ThreadChannel): Promise<string | undefined> {
    try {
        const starter = await thread.fetchStarterMessage();
        const content = starter?.content?.trim();
        if (!content) return undefined;
        return content.slice(0, 600);
    } catch {
        return undefined;
    }
}

// ============================================================
// 建案
// ============================================================

/**
 * 有效违规：这个帖子到底还需不需要处理。
 *
 * 模型没看过之前，检测出什么就是什么。
 * 模型看过之后以**方案**为准——方案说「标题不用改、TAG 不用动」，
 * 那就是真的没事，不建案、不打扰作者。
 *
 * 绿帽癖那种帖子走的就是这条：正文里的关联词被判成描述人设，
 * 于是方案是空的，这里返回空数组，作者根本不会收到通知。
 */
export function effectiveViolations(result: InspectResult): Violation[] {
    if (!result.detectResult) return [];

    const plan = result.plan;
    if (!result.judgement || !plan) return result.detectResult.violations;

    const noChange = plan.newTitle === plan.originalTitle
        && plan.removeTagIds.length === 0
        && plan.addTagIds.length === 0;

    return noChange && plan.autoFixable ? [] : result.detectResult.violations;
}

/**
 * 检出违规就建案（同一帖子同时只会有一个未结案件）。
 * 返回 null 表示无需建案（没违规 / 已有未结案件）。
 */
export function openCaseFor(result: InspectResult): db.GuardCase | null {
    if (result.skipped || !result.detectResult) return null;

    const violations = effectiveViolations(result);
    if (violations.length === 0) return null;

    const thread = result.thread;
    const guildId = thread.guild.id;
    const settings = db.getSettings(guildId);

    const existing = db.getOpenCase(thread.id);
    if (existing) return existing;

    const old = isOldPost(thread, settings.oldPostInactiveHours);
    const graceHours = old ? settings.graceOldHours : settings.graceNewHours;

    return db.createCase({
        guildId,
        forumId: thread.parentId ?? '',
        threadId: thread.id,
        authorId: thread.ownerId ?? null,
        originalTitle: thread.name,
        originalTagIds: [...thread.appliedTags],
        violations,
        plan: result.plan,
        deadline: Date.now() + graceHours * 60 * 60 * 1000,
        isOldPost: old,
        wasArchived: Boolean(thread.archived),
    });
}

// ============================================================
// 实际动手改帖子
// ============================================================

/** 同帖改名限流：Discord 允许 2 次 / 10 分钟，这里留一手只用 2 次 */
const renameHistory = new Map<string, number[]>();

function canRename(threadId: string): boolean {
    const now = Date.now();
    const window = (renameHistory.get(threadId) ?? []).filter(t => now - t < 10 * 60 * 1000);
    renameHistory.set(threadId, window);
    return window.length < 2;
}

function noteRename(threadId: string): void {
    const list = renameHistory.get(threadId) ?? [];
    list.push(Date.now());
    renameHistory.set(threadId, list);
}

export interface ApplyResult {
    ok: boolean;
    error: string | null;
    titleChanged: boolean;
    tagsChanged: boolean;
}

/**
 * 把方案落到帖子上。
 * 归档帖会先解归档、改完恢复原状态——单纯解归档/重新归档不影响论坛活跃度排序。
 */
export async function applyPlan(
    thread: ThreadChannel,
    plan: RewritePlan,
    actor: string,
    caseId: number | null,
): Promise<ApplyResult> {
    const beforeTitle = thread.name;
    const beforeTags = [...thread.appliedTags];

    // 先摘掉冲突的，再补上「多路线」
    const kept = beforeTags.filter(id => !plan.removeTagIds.includes(id));
    const afterTags = [...new Set([...kept, ...plan.addTagIds])];

    const wantTitle = plan.newTitle !== beforeTitle;
    const wantTags =
        afterTags.length !== beforeTags.length ||
        afterTags.some(id => !beforeTags.includes(id));

    if (!wantTitle && !wantTags) {
        return { ok: true, error: null, titleChanged: false, tagsChanged: false };
    }

    if (wantTitle && !canRename(thread.id)) {
        return { ok: false, error: '改名过于频繁（Discord 限制 2 次/10 分钟），稍后重试', titleChanged: false, tagsChanged: false };
    }

    const wasArchived = Boolean(thread.archived);

    try {
        if (wasArchived) {
            await thread.setArchived(false, '标题规范：整改前解归档');
        }

        if (wantTitle) {
            await thread.setName(plan.newTitle, '标题规范：自动整改');
            noteRename(thread.id);
        }
        if (wantTags) {
            // Discord 单帖 TAG 上限 5 个
            await thread.setAppliedTags(afterTags.slice(0, 5), '标题规范：整理分类 TAG');
        }

        db.recordAction({
            caseId,
            guildId: thread.guild.id,
            threadId: thread.id,
            action: wantTitle && wantTags ? 'both' : wantTitle ? 'rename' : 'retag',
            beforeTitle,
            afterTitle: wantTitle ? plan.newTitle : null,
            beforeTagIds: beforeTags,
            afterTagIds: afterTags,
            actor,
        });

        return { ok: true, error: null, titleChanged: wantTitle, tagsChanged: wantTags };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[TitleGuard] 整改帖子 ${thread.id} 失败：`, err);
        return { ok: false, error: message, titleChanged: false, tagsChanged: false };
    } finally {
        if (wasArchived) {
            await thread.setArchived(true, '标题规范：整改后恢复归档').catch(() => { /* 忽略 */ });
        }
    }
}

/** 还原 bot 对某个帖子最近一次未被还原的改动 */
export async function revertLast(thread: ThreadChannel): Promise<{ ok: boolean; message: string }> {
    const action = db.getLastAction(thread.id);
    if (!action) return { ok: false, message: '没有可还原的改动记录' };

    const wasArchived = Boolean(thread.archived);
    try {
        if (wasArchived) await thread.setArchived(false, '标题规范：还原前解归档');

        if (action.beforeTitle && action.beforeTitle !== thread.name) {
            if (!canRename(thread.id)) {
                return { ok: false, message: '改名过于频繁（Discord 限制 2 次/10 分钟），请稍后再试' };
            }
            await thread.setName(action.beforeTitle, '标题规范：管理组还原');
            noteRename(thread.id);
        }
        if (action.beforeTagIds.length > 0) {
            await thread.setAppliedTags(action.beforeTagIds, '标题规范：管理组还原');
        }

        db.markActionReverted(action.id);
        return { ok: true, message: `已还原为「${action.beforeTitle ?? thread.name}」` };
    } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
        if (wasArchived) {
            await thread.setArchived(true, '标题规范：还原后恢复归档').catch(() => { /* 忽略 */ });
        }
    }
}

// ============================================================
// 工具
// ============================================================

export async function fetchThread(client: Client, threadId: string): Promise<ThreadChannel | null> {
    try {
        const channel = await client.channels.fetch(threadId);
        return isForumThread(channel) ? channel : null;
    } catch {
        return null;
    }
}

/** 「呼叫管理组」要 @ 的身份组。权限判定不走这里——那一律用 permissionManager */
export function alertMentions(guild: Guild, settings: db.GuardSettings): string {
    const roles = settings.alertRoleIds.filter(id => guild.roles.cache.has(id));
    if (roles.length === 0) return '';
    return roles.map(id => `<@&${id}>`).join(' ');
}
