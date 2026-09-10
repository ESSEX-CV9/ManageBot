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
    type Client,
    type ForumChannel,
    type Guild,
    type ThreadChannel,
} from 'discord.js';

import { compileConfig, detect, type CompiledConfig } from './ruleEngine';
import { buildPlan, type RewritePlan } from './rewriter';
import { judge, type Judgement, type JudgementCache, buildJudgeRules } from './llmJudge';
import type { AppliedTag, DetectResult, ForumTag, GroupId } from './types';
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

/** 发帖是否已超过「老帖」门槛 */
export function isOldPost(thread: ThreadChannel, oldPostDays: number): boolean {
    const created = thread.createdTimestamp;
    if (!created) return false;
    return Date.now() - created > oldPostDays * 24 * 60 * 60 * 1000;
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
    /** LLM 判定这些词不是分类标记 */
    llmCleared: boolean;
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

    // 需要 LLM 定性的部分
    let judgement: Judgement | null = null;
    let llmCleared = false;

    if (detectResult.needsLlm && !options.dryRun) {
        const settings = db.getSettings(guildId);
        const bodyExcerpt = forumConfig.sendBodyToLlm ? await readFirstPostExcerpt(thread) : undefined;

        const outcome = await judge(
            {
                title: thread.name,
                forumName: forum.name,
                hits: detectResult.matches
                    .filter(m => m.entry.group)
                    .map(m => ({ word: m.entry.word, group: m.entry.group!, where: m.segmentKind })),
                tags: tags.map(t => ({ name: t.tagName, group: t.group })),
                // 把社区既定的互斥关系和优先级一起给它，否则遇到 TAG 冲突
                // 它只会说「无法唯一确定应保留哪一组」——而程序这边其实有确定答案
                rules: buildJudgeRules(compiled.raw),
            },
            { bodyExcerpt, enabled: settings.llmEnabled, cache: llmCache },
        );

        if (outcome.ok) {
            judgement = outcome.judgement;
            llmCleared = !outcome.judgement.isClassification;
        } else {
            // LLM 不可用：需要它定性的违规全部挂起，规则类违规不受影响照常跑
            llmError = `${outcome.kind}: ${outcome.error}`;
            console.warn(`[TitleGuard] LLM 判定失败（${outcome.kind}）：${outcome.error}`);
        }
    }

    const plan = buildPlan({
        detectResult,
        tags,
        availableTags,
        compiled,
        authorChoice: options.authorChoice,
        judgement,
        llmCleared,
    });

    const llmPending = detectResult.needsLlm && judgement === null;
    if (llmPending && llmError) {
        console.warn(`[TitleGuard] 帖子 ${thread.id} 需要 LLM 定性但未取得结论：${llmError}`);
    }

    return {
        ...base,
        detectResult, tags, availableTags, plan, judgement, llmCleared, llmPending,
        skipped: null,
    };
}

/** 读首楼开头一小段。只在论坛开了开关时才会被调用 */
async function readFirstPostExcerpt(thread: ThreadChannel): Promise<string | undefined> {
    try {
        const starter = await thread.fetchStarterMessage();
        const content = starter?.content?.trim();
        if (!content) return undefined;
        return content.slice(0, 200);
    } catch {
        return undefined;
    }
}

// ============================================================
// 建案
// ============================================================

/** 有效违规：LLM 判定不是分类标记时，需要它定性的那些作废 */
export function effectiveViolations(result: InspectResult) {
    if (!result.detectResult) return [];
    return result.llmCleared
        ? result.detectResult.violations.filter(v => !v.needsLlm)
        : result.detectResult.violations;
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

    const old = isOldPost(thread, settings.oldPostDays);
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
