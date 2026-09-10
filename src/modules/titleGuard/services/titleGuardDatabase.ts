// src/modules/titleGuard/services/titleGuardDatabase.ts
//
// 标题规范模块的独立数据层（SQLite / better-sqlite3）。
//
// 设计要点：
//   - 词典、互斥集合、TAG 映射**不内置任何默认值**，全部由管理组通过 /标题规范 线上维护。
//   - 词典和互斥集合是**服务器级**共用一份（社区共识层面的东西），
//     论坛级只配「启不启用」和「本论坛哪个 TAG 对应哪个分类组」。
//   - 每次改动都写 tt_actions 流水，留原值，管理组可一键还原。

import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { DATA_DIR } from '../../../core/utils/database';
import { normalize, shouldForceAsciiBoundary } from './normalizer';
import type {
    DictEntry,
    DictKind,
    DictScope,
    GuardConfig,
    GroupId,
    CrossExclusion,
    ExclusiveDimension,
    SegmenterWord,
    Violation,
} from './types';

const DB_FILE = path.join(DATA_DIR, 'title-guard.sqlite');
const db = new Database(DB_FILE);

db.pragma('journal_mode = WAL');

db.exec(`
    -- 服务器级配置
    CREATE TABLE IF NOT EXISTS tt_settings (
        guild_id                TEXT PRIMARY KEY,
        enabled                 INTEGER NOT NULL DEFAULT 0,
        alert_role_ids          TEXT    NOT NULL DEFAULT '',
        alert_channel_id        TEXT,
        grace_new_hours         INTEGER NOT NULL DEFAULT 24,
        grace_old_hours         INTEGER NOT NULL DEFAULT 168,
        old_post_days           INTEGER NOT NULL DEFAULT 60,
        auto_fix_enabled        INTEGER NOT NULL DEFAULT 0,
        llm_enabled             INTEGER NOT NULL DEFAULT 1,
        llm_needs_confirm       INTEGER NOT NULL DEFAULT 1,
        queue_interval_minutes  INTEGER NOT NULL DEFAULT 20,
        queue_paused            INTEGER NOT NULL DEFAULT 0,
        multi_route_group       TEXT    NOT NULL DEFAULT '',
        updated_at              INTEGER NOT NULL
    );

    -- 论坛级配置
    CREATE TABLE IF NOT EXISTS tt_forums (
        guild_id          TEXT NOT NULL,
        forum_id          TEXT NOT NULL,
        enabled           INTEGER NOT NULL DEFAULT 1,
        send_body_to_llm  INTEGER NOT NULL DEFAULT 0,
        added_at          INTEGER NOT NULL,
        PRIMARY KEY (guild_id, forum_id)
    );

    -- 分类组
    CREATE TABLE IF NOT EXISTS tt_groups (
        guild_id  TEXT NOT NULL,
        group_id  TEXT NOT NULL,
        canonical TEXT NOT NULL,
        -- 数值大的优先保留。社区既定规则：NTR > NTL > 纯爱
        priority  INTEGER NOT NULL DEFAULT 0,
        note      TEXT,
        PRIMARY KEY (guild_id, group_id)
    );

    -- 互斥集合（同一 dimension + set_name 下的分类组互斥）
    -- dimension: 'tag' = TAG 之间互斥，'word' = 标题关键字之间互斥。
    -- 这两个维度是分开配的：同一对分类可以 TAG 互斥而关键字不互斥，反之亦然。
    CREATE TABLE IF NOT EXISTS tt_exclusive (
        guild_id  TEXT NOT NULL,
        dimension TEXT NOT NULL,
        set_name  TEXT NOT NULL,
        group_id  TEXT NOT NULL,
        PRIMARY KEY (guild_id, dimension, set_name, group_id)
    );

    -- 词典
    CREATE TABLE IF NOT EXISTS tt_dict (
        guild_id       TEXT NOT NULL,
        word           TEXT NOT NULL,
        raw_word       TEXT NOT NULL,
        kind           TEXT NOT NULL,
        group_id       TEXT,
        scope          TEXT NOT NULL DEFAULT '全标题',
        replace_to     TEXT,
        ascii_boundary INTEGER NOT NULL DEFAULT 0,
        enabled        INTEGER NOT NULL DEFAULT 1,
        note           TEXT,
        updated_at     INTEGER NOT NULL,
        PRIMARY KEY (guild_id, word)
    );

    -- 论坛 TAG → 分类组
    CREATE TABLE IF NOT EXISTS tt_tag_map (
        guild_id TEXT NOT NULL,
        forum_id TEXT NOT NULL,
        tag_id   TEXT NOT NULL,
        tag_name TEXT NOT NULL,
        group_id TEXT,
        PRIMARY KEY (guild_id, forum_id, tag_id)
    );

    -- 分词词库：纠正中文分词器的切分。
    -- action: '补词' = 分词器不认识这个词，加给它；'拆词' = 分词器粘得太狠，拆开
    CREATE TABLE IF NOT EXISTS tt_segmenter (
        guild_id TEXT NOT NULL,
        word     TEXT NOT NULL,
        action   TEXT NOT NULL,
        note     TEXT,
        PRIMARY KEY (guild_id, word)
    );

    -- 交叉互斥：挂了 tag_group 的 TAG → 标题里不许出现 word_group 的关键字。
    -- 有方向：要双向禁就存两行。
    CREATE TABLE IF NOT EXISTS tt_cross (
        guild_id   TEXT NOT NULL,
        tag_group  TEXT NOT NULL,
        word_group TEXT NOT NULL,
        note       TEXT,
        PRIMARY KEY (guild_id, tag_group, word_group)
    );

    -- 案件
    CREATE TABLE IF NOT EXISTS tt_cases (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id          TEXT NOT NULL,
        forum_id          TEXT NOT NULL,
        thread_id         TEXT NOT NULL,
        author_id         TEXT,
        state             TEXT NOT NULL,
        original_title    TEXT NOT NULL,
        original_tag_ids  TEXT NOT NULL,
        violations_json   TEXT NOT NULL,
        plan_json         TEXT,
        notice_channel_id TEXT,
        notice_message_id TEXT,
        deadline          INTEGER,
        is_old_post       INTEGER NOT NULL DEFAULT 0,
        was_archived      INTEGER NOT NULL DEFAULT 0,
        llm_reason        TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        closed_at         INTEGER
    );
    -- 一个帖子同时只能有一个未结案件
    CREATE UNIQUE INDEX IF NOT EXISTS tt_cases_open_thread
        ON tt_cases (thread_id) WHERE closed_at IS NULL;
    CREATE INDEX IF NOT EXISTS tt_cases_due
        ON tt_cases (state, deadline) WHERE closed_at IS NULL;

    -- 操作流水（可还原）
    CREATE TABLE IF NOT EXISTS tt_actions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id        INTEGER,
        guild_id       TEXT NOT NULL,
        thread_id      TEXT NOT NULL,
        action         TEXT NOT NULL,
        before_title   TEXT,
        after_title    TEXT,
        before_tag_ids TEXT,
        after_tag_ids  TEXT,
        actor          TEXT NOT NULL,
        reverted       INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tt_actions_thread ON tt_actions (thread_id, created_at DESC);

    -- 豁免（绑定「帖子 + 当时的标题」，作者再改标题即失效）
    CREATE TABLE IF NOT EXISTS tt_exempt (
        guild_id   TEXT NOT NULL,
        thread_id  TEXT NOT NULL,
        title_hash TEXT NOT NULL,
        by_user_id TEXT NOT NULL,
        note       TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, thread_id, title_hash)
    );

    -- 老帖慢速整改队列
    CREATE TABLE IF NOT EXISTS tt_queue (
        guild_id     TEXT NOT NULL,
        forum_id     TEXT NOT NULL,
        thread_id    TEXT NOT NULL,
        state        TEXT NOT NULL DEFAULT 'pending',
        attempts     INTEGER NOT NULL DEFAULT 0,
        last_error   TEXT,
        enqueued_at  INTEGER NOT NULL,
        processed_at INTEGER,
        PRIMARY KEY (guild_id, thread_id)
    );
    CREATE INDEX IF NOT EXISTS tt_queue_pending ON tt_queue (state, enqueued_at);

    -- LLM 判定缓存
    CREATE TABLE IF NOT EXISTS tt_llm_cache (
        cache_key   TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        created_at  INTEGER NOT NULL
    );
`);

// ------------------------------------------------------------
// 轻量迁移：CREATE TABLE IF NOT EXISTS 不会给已存在的表补新列，
// 所以后续版本新增的列必须在这里显式补一次。
// ------------------------------------------------------------

function ensureColumn(table: string, column: string, definition: string): void {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some(c => c.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[TitleGuard] 数据库迁移：${table} 新增列 ${column}`);
}

/**
 * tt_exclusive 从「一个维度」变成「TAG / 关键字两个维度」。
 * 老表没有 dimension 列，主键也不含它，ALTER 补不出正确的主键，
 * 只能整表重建：老数据里的互斥集合当年是两个维度共用的，所以两边各抄一份。
 */
function migrateExclusiveDimension(): void {
    const cols = db.prepare('PRAGMA table_info(tt_exclusive)').all() as { name: string }[];
    if (cols.length === 0 || cols.some(c => c.name === 'dimension')) return;

    const rows = db.prepare('SELECT guild_id, set_name, group_id FROM tt_exclusive').all() as
        { guild_id: string; set_name: string; group_id: string }[];

    db.exec(`
        ALTER TABLE tt_exclusive RENAME TO tt_exclusive_old;
        CREATE TABLE tt_exclusive (
            guild_id  TEXT NOT NULL,
            dimension TEXT NOT NULL,
            set_name  TEXT NOT NULL,
            group_id  TEXT NOT NULL,
            PRIMARY KEY (guild_id, dimension, set_name, group_id)
        );
    `);
    const insert = db.prepare(
        'INSERT OR IGNORE INTO tt_exclusive (guild_id, dimension, set_name, group_id) VALUES (?, ?, ?, ?)',
    );
    for (const r of rows) {
        for (const dim of ['tag', 'word']) insert.run(r.guild_id, dim, r.set_name, r.group_id);
    }
    db.exec('DROP TABLE tt_exclusive_old');
    console.log(`[TitleGuard] 数据库迁移：tt_exclusive 拆成 TAG / 关键字两个维度，搬了 ${rows.length} 行`);
}

/** tt_tag_ban 是交叉互斥的旧名字，方向也是反着记的（当年只想着禁 TAG） */
function migrateTagBanToCross(): void {
    const cols = db.prepare('PRAGMA table_info(tt_tag_ban)').all() as { name: string }[];
    if (cols.length === 0) return;

    const rows = db.prepare('SELECT guild_id, title_group, banned_group, note FROM tt_tag_ban').all() as
        { guild_id: string; title_group: string; banned_group: string; note: string | null }[];
    const insert = db.prepare(
        'INSERT OR IGNORE INTO tt_cross (guild_id, tag_group, word_group, note) VALUES (?, ?, ?, ?)',
    );
    // 旧的「标题含 title_group → 禁挂 banned_group TAG」就是
    // 「挂了 banned_group 的 TAG → 标题里不许出现 title_group」
    for (const r of rows) insert.run(r.guild_id, r.banned_group, r.title_group, r.note);
    db.exec('DROP TABLE tt_tag_ban');
    console.log(`[TitleGuard] 数据库迁移：tt_tag_ban 并入 tt_cross，搬了 ${rows.length} 行`);
}

migrateExclusiveDimension();
migrateTagBanToCross();

ensureColumn('tt_settings', 'multi_route_group', "TEXT NOT NULL DEFAULT ''");
ensureColumn('tt_groups', 'priority', 'INTEGER NOT NULL DEFAULT 0');

// ============================================================
// 服务器配置
// ============================================================

export interface GuardSettings {
    guildId: string;
    enabled: boolean;
    /** 「呼叫管理组」按钮 @ 的身份组。与管理权限判定无关——权限一律走 permissionManager */
    alertRoleIds: string[];
    /** 没有接警身份组时，通知发到这个频道 */
    alertChannelId: string | null;
    graceNewHours: number;
    graceOldHours: number;
    /** 发帖超过多少天算「老帖」 */
    oldPostDays: number;
    /** 总闸：关掉就只检测不动手 */
    autoFixEnabled: boolean;
    llmEnabled: boolean;
    /** LLM 判出的违规是否需要管理组点确认才执行 */
    llmNeedsConfirm: boolean;
    queueIntervalMinutes: number;
    queuePaused: boolean;
    /** 「多路线」这个中性 TAG 对应的分类组名。空 = 不自动补多路线 TAG */
    multiRouteGroup: string;
}

const DEFAULT_SETTINGS: Omit<GuardSettings, 'guildId'> = {
    enabled: false,
    alertRoleIds: [],
    alertChannelId: null,
    graceNewHours: 24,
    graceOldHours: 168,
    oldPostDays: 60,
    autoFixEnabled: false,
    llmEnabled: true,
    llmNeedsConfirm: true,
    queueIntervalMinutes: 20,
    queuePaused: false,
    multiRouteGroup: '多路线',
};

interface SettingsRow {
    guild_id: string;
    enabled: number;
    alert_role_ids: string;
    alert_channel_id: string | null;
    grace_new_hours: number;
    grace_old_hours: number;
    old_post_days: number;
    auto_fix_enabled: number;
    llm_enabled: number;
    llm_needs_confirm: number;
    queue_interval_minutes: number;
    queue_paused: number;
    multi_route_group: string;
}

const getSettingsStmt = db.prepare('SELECT * FROM tt_settings WHERE guild_id = ?');

export function getSettings(guildId: string): GuardSettings {
    const row = getSettingsStmt.get(guildId) as SettingsRow | undefined;
    if (!row) return { guildId, ...DEFAULT_SETTINGS };
    return {
        guildId,
        enabled: Boolean(row.enabled),
        alertRoleIds: row.alert_role_ids ? row.alert_role_ids.split(',').filter(Boolean) : [],
        alertChannelId: row.alert_channel_id,
        graceNewHours: row.grace_new_hours,
        graceOldHours: row.grace_old_hours,
        oldPostDays: row.old_post_days,
        autoFixEnabled: Boolean(row.auto_fix_enabled),
        llmEnabled: Boolean(row.llm_enabled),
        llmNeedsConfirm: Boolean(row.llm_needs_confirm),
        queueIntervalMinutes: row.queue_interval_minutes,
        queuePaused: Boolean(row.queue_paused),
        multiRouteGroup: row.multi_route_group || DEFAULT_SETTINGS.multiRouteGroup,
    };
}

const upsertSettingsStmt = db.prepare(`
    INSERT INTO tt_settings (
        guild_id, enabled, alert_role_ids, alert_channel_id,
        grace_new_hours, grace_old_hours, old_post_days,
        auto_fix_enabled, llm_enabled, llm_needs_confirm,
        queue_interval_minutes, queue_paused, multi_route_group, updated_at
    ) VALUES (
        @guild_id, @enabled, @alert_role_ids, @alert_channel_id,
        @grace_new_hours, @grace_old_hours, @old_post_days,
        @auto_fix_enabled, @llm_enabled, @llm_needs_confirm,
        @queue_interval_minutes, @queue_paused, @multi_route_group, @updated_at
    )
    ON CONFLICT(guild_id) DO UPDATE SET
        enabled = excluded.enabled,
        alert_role_ids = excluded.alert_role_ids,
        alert_channel_id = excluded.alert_channel_id,
        grace_new_hours = excluded.grace_new_hours,
        grace_old_hours = excluded.grace_old_hours,
        old_post_days = excluded.old_post_days,
        auto_fix_enabled = excluded.auto_fix_enabled,
        llm_enabled = excluded.llm_enabled,
        llm_needs_confirm = excluded.llm_needs_confirm,
        queue_interval_minutes = excluded.queue_interval_minutes,
        queue_paused = excluded.queue_paused,
        multi_route_group = excluded.multi_route_group,
        updated_at = excluded.updated_at
`);

export function saveSettings(patch: Partial<GuardSettings> & { guildId: string }): GuardSettings {
    const merged = { ...getSettings(patch.guildId), ...patch };
    upsertSettingsStmt.run({
        guild_id: merged.guildId,
        enabled: merged.enabled ? 1 : 0,
        alert_role_ids: merged.alertRoleIds.join(','),
        alert_channel_id: merged.alertChannelId,
        grace_new_hours: merged.graceNewHours,
        grace_old_hours: merged.graceOldHours,
        old_post_days: merged.oldPostDays,
        auto_fix_enabled: merged.autoFixEnabled ? 1 : 0,
        llm_enabled: merged.llmEnabled ? 1 : 0,
        llm_needs_confirm: merged.llmNeedsConfirm ? 1 : 0,
        queue_interval_minutes: merged.queueIntervalMinutes,
        queue_paused: merged.queuePaused ? 1 : 0,
        multi_route_group: merged.multiRouteGroup,
        updated_at: Date.now(),
    });
    return merged;
}

// ============================================================
// 论坛
// ============================================================

export interface ForumConfig {
    guildId: string;
    forumId: string;
    enabled: boolean;
    /** 是否允许把首楼摘录发给 LLM。露骨内容多的论坛建议关掉，免得被内容审核拦截 */
    sendBodyToLlm: boolean;
}

const listForumsStmt = db.prepare('SELECT * FROM tt_forums WHERE guild_id = ? ORDER BY added_at');
const getForumStmt = db.prepare('SELECT * FROM tt_forums WHERE guild_id = ? AND forum_id = ?');
const addForumStmt = db.prepare(`
    INSERT INTO tt_forums (guild_id, forum_id, enabled, send_body_to_llm, added_at)
    VALUES (?, ?, 1, 0, ?)
    ON CONFLICT(guild_id, forum_id) DO NOTHING
`);
const removeForumStmt = db.prepare('DELETE FROM tt_forums WHERE guild_id = ? AND forum_id = ?');
const updateForumStmt = db.prepare(`
    UPDATE tt_forums SET enabled = ?, send_body_to_llm = ? WHERE guild_id = ? AND forum_id = ?
`);

interface ForumRow {
    guild_id: string;
    forum_id: string;
    enabled: number;
    send_body_to_llm: number;
}

function toForum(row: ForumRow): ForumConfig {
    return {
        guildId: row.guild_id,
        forumId: row.forum_id,
        enabled: Boolean(row.enabled),
        sendBodyToLlm: Boolean(row.send_body_to_llm),
    };
}

export function listForums(guildId: string): ForumConfig[] {
    return (listForumsStmt.all(guildId) as ForumRow[]).map(toForum);
}

export function getForum(guildId: string, forumId: string): ForumConfig | null {
    const row = getForumStmt.get(guildId, forumId) as ForumRow | undefined;
    return row ? toForum(row) : null;
}

export function addForum(guildId: string, forumId: string): void {
    addForumStmt.run(guildId, forumId, Date.now());
}

export function removeForum(guildId: string, forumId: string): void {
    removeForumStmt.run(guildId, forumId);
}

export function updateForum(guildId: string, forumId: string, patch: Partial<ForumConfig>): void {
    const current = getForum(guildId, forumId);
    if (!current) return;
    const merged = { ...current, ...patch };
    updateForumStmt.run(merged.enabled ? 1 : 0, merged.sendBodyToLlm ? 1 : 0, guildId, forumId);
}

// ============================================================
// 分类组 / 互斥集合 / TAG 禁令
// ============================================================

export interface GroupDef {
    groupId: GroupId;
    /** 改写标题时用的规范写法 */
    canonical: string;
    /** 数值大的优先保留。社区既定规则：NTR > NTL > 纯爱 */
    priority: number;
    note: string | null;
}

const listGroupsStmt = db.prepare('SELECT * FROM tt_groups WHERE guild_id = ? ORDER BY group_id');
const upsertGroupStmt = db.prepare(`
    INSERT INTO tt_groups (guild_id, group_id, canonical, priority, note) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, group_id) DO UPDATE SET
        canonical = excluded.canonical,
        priority = excluded.priority,
        note = excluded.note
`);
const ensureGroupStmt = db.prepare(`
    INSERT INTO tt_groups (guild_id, group_id, canonical, priority, note) VALUES (?, ?, ?, 0, NULL)
    ON CONFLICT(guild_id, group_id) DO NOTHING
`);
const deleteGroupStmt = db.prepare('DELETE FROM tt_groups WHERE guild_id = ? AND group_id = ?');

export function listGroups(guildId: string): GroupDef[] {
    const rows = listGroupsStmt.all(guildId) as {
        group_id: string; canonical: string; priority: number; note: string | null;
    }[];
    return rows.map(r => ({
        groupId: r.group_id, canonical: r.canonical, priority: r.priority, note: r.note,
    }));
}

export function upsertGroup(
    guildId: string, groupId: string, canonical: string, priority = 0, note?: string,
): void {
    upsertGroupStmt.run(guildId, groupId, canonical, priority, note ?? null);
}

/**
 * 只保证这个分类组存在，已经有的一个字都不动。
 *
 * 别拿 upsertGroup 干这件事：它的 priority 默认是 0，
 * 「把 NTR 加进某个互斥集合」会顺手把 NTR 已经配好的优先级 40 清成 0。
 */
export function ensureGroup(guildId: string, groupId: string): void {
    ensureGroupStmt.run(guildId, groupId, groupId);
}

export function deleteGroup(guildId: string, groupId: string): void {
    deleteGroupStmt.run(guildId, groupId);
}

const listExclusiveStmt = db.prepare(
    'SELECT dimension, set_name, group_id FROM tt_exclusive WHERE guild_id = ?',
);
const addExclusiveStmt = db.prepare(`
    INSERT INTO tt_exclusive (guild_id, dimension, set_name, group_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, dimension, set_name, group_id) DO NOTHING
`);
const removeExclusiveMemberStmt = db.prepare(
    'DELETE FROM tt_exclusive WHERE guild_id = ? AND dimension = ? AND set_name = ? AND group_id = ?',
);
const removeExclusiveSetStmt = db.prepare(
    'DELETE FROM tt_exclusive WHERE guild_id = ? AND dimension = ? AND set_name = ?',
);

export function listExclusiveSets(
    guildId: string,
): { dimension: ExclusiveDimension; name: string; groups: GroupId[] }[] {
    const rows = listExclusiveStmt.all(guildId) as
        { dimension: string; set_name: string; group_id: string }[];
    const map = new Map<string, GroupId[]>();
    for (const r of rows) {
        const key = `${r.dimension}\u0000${r.set_name}`;
        const list = map.get(key);
        if (list) list.push(r.group_id);
        else map.set(key, [r.group_id]);
    }
    return [...map.entries()].map(([key, groups]) => {
        const [dimension, name] = key.split('\u0000');
        return { dimension: dimension as ExclusiveDimension, name, groups };
    });
}

export function addToExclusiveSet(
    guildId: string, dimension: ExclusiveDimension, setName: string, groupId: string,
): void {
    addExclusiveStmt.run(guildId, dimension, setName, groupId);
}

export function removeFromExclusiveSet(
    guildId: string, dimension: ExclusiveDimension, setName: string, groupId: string,
): void {
    removeExclusiveMemberStmt.run(guildId, dimension, setName, groupId);
}

export function deleteExclusiveSet(
    guildId: string, dimension: ExclusiveDimension, setName: string,
): void {
    removeExclusiveSetStmt.run(guildId, dimension, setName);
}

const listCrossStmt = db.prepare('SELECT * FROM tt_cross WHERE guild_id = ?');
const addCrossStmt = db.prepare(`
    INSERT INTO tt_cross (guild_id, tag_group, word_group, note) VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, tag_group, word_group) DO UPDATE SET note = excluded.note
`);
const removeCrossStmt = db.prepare(
    'DELETE FROM tt_cross WHERE guild_id = ? AND tag_group = ? AND word_group = ?',
);

export function listCrossExclusions(guildId: string): CrossExclusion[] {
    const rows = listCrossStmt.all(guildId) as {
        tag_group: string; word_group: string; note: string | null;
    }[];
    return rows.map(r => ({
        tagGroup: r.tag_group,
        wordGroup: r.word_group,
        note: r.note ?? undefined,
    }));
}

export function addCrossExclusion(
    guildId: string, tagGroup: string, wordGroup: string, note?: string,
): void {
    addCrossStmt.run(guildId, tagGroup, wordGroup, note ?? null);
}

export function removeCrossExclusion(guildId: string, tagGroup: string, wordGroup: string): void {
    removeCrossStmt.run(guildId, tagGroup, wordGroup);
}

const listSegmenterStmt = db.prepare('SELECT * FROM tt_segmenter WHERE guild_id = ? ORDER BY word');
const upsertSegmenterStmt = db.prepare(`
    INSERT INTO tt_segmenter (guild_id, word, action, note) VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, word) DO UPDATE SET action = excluded.action, note = excluded.note
`);
const removeSegmenterStmt = db.prepare('DELETE FROM tt_segmenter WHERE guild_id = ? AND word = ?');

export function listSegmenterWords(guildId: string): SegmenterWord[] {
    const rows = listSegmenterStmt.all(guildId) as
        { word: string; action: string; note: string | null }[];
    return rows.map(r => ({
        word: r.word,
        action: r.action === '拆词' ? '拆词' : '补词',
        note: r.note ?? undefined,
    }));
}

export function upsertSegmenterWord(
    guildId: string, word: string, action: SegmenterWord['action'], note?: string,
): void {
    upsertSegmenterStmt.run(guildId, word, action, note ?? null);
}

export function removeSegmenterWord(guildId: string, word: string): boolean {
    return removeSegmenterStmt.run(guildId, word).changes > 0;
}

// ============================================================
// 词典
// ============================================================

export interface DictRecord extends DictEntry {
    /** 管理组录入的原始写法（展示用；word 是归一化后的匹配用形式） */
    rawWord: string;
    enabled: boolean;
}

const listDictStmt = db.prepare('SELECT * FROM tt_dict WHERE guild_id = ? ORDER BY length(word) DESC, word');
const listEnabledDictStmt = db.prepare('SELECT * FROM tt_dict WHERE guild_id = ? AND enabled = 1');
const upsertDictStmt = db.prepare(`
    INSERT INTO tt_dict (
        guild_id, word, raw_word, kind, group_id, scope,
        replace_to, ascii_boundary, enabled, note, updated_at
    ) VALUES (
        @guild_id, @word, @raw_word, @kind, @group_id, @scope,
        @replace_to, @ascii_boundary, @enabled, @note, @updated_at
    )
    ON CONFLICT(guild_id, word) DO UPDATE SET
        raw_word = excluded.raw_word,
        kind = excluded.kind,
        group_id = excluded.group_id,
        scope = excluded.scope,
        replace_to = excluded.replace_to,
        ascii_boundary = excluded.ascii_boundary,
        enabled = excluded.enabled,
        note = excluded.note,
        updated_at = excluded.updated_at
`);
const deleteDictStmt = db.prepare('DELETE FROM tt_dict WHERE guild_id = ? AND word = ?');

interface DictRow {
    word: string;
    raw_word: string;
    kind: string;
    group_id: string | null;
    scope: string;
    replace_to: string | null;
    ascii_boundary: number;
    enabled: number;
    note: string | null;
}

function toDict(row: DictRow): DictRecord {
    return {
        word: row.word,
        rawWord: row.raw_word,
        kind: row.kind as DictKind,
        group: row.group_id,
        scope: row.scope as DictScope,
        replaceTo: row.replace_to,
        asciiBoundary: Boolean(row.ascii_boundary),
        enabled: Boolean(row.enabled),
        note: row.note ?? undefined,
    };
}

export function listDict(guildId: string): DictRecord[] {
    return (listDictStmt.all(guildId) as DictRow[]).map(toDict);
}

export { shouldForceAsciiBoundary };

export interface UpsertDictInput {
    rawWord: string;
    kind: DictKind;
    group?: string | null;
    scope?: DictScope;
    replaceTo?: string | null;
    asciiBoundary?: boolean;
    enabled?: boolean;
    note?: string | null;
}

export function upsertDict(guildId: string, input: UpsertDictInput): DictRecord {
    const word = normalize(input.rawWord).text.trim();
    if (!word) throw new Error('词条不能为空');

    const record = {
        guild_id: guildId,
        word,
        raw_word: input.rawWord.trim(),
        kind: input.kind,
        group_id: input.kind === '白名单' ? null : (input.group ?? null),
        scope: input.scope ?? '全标题',
        replace_to: input.replaceTo ?? null,
        ascii_boundary: (input.asciiBoundary ?? shouldForceAsciiBoundary(word)) ? 1 : 0,
        enabled: (input.enabled ?? true) ? 1 : 0,
        note: input.note ?? null,
        updated_at: Date.now(),
    };
    upsertDictStmt.run(record);
    return toDict(record as unknown as DictRow);
}

export function deleteDict(guildId: string, rawWord: string): boolean {
    const word = normalize(rawWord).text.trim();
    return deleteDictStmt.run(guildId, word).changes > 0;
}

// ============================================================
// TAG 映射
// ============================================================

export interface TagMapping {
    forumId: string;
    tagId: string;
    tagName: string;
    group: GroupId | null;
}

const listTagMapStmt = db.prepare(
    'SELECT * FROM tt_tag_map WHERE guild_id = ? AND forum_id = ? ORDER BY tag_name',
);
const upsertTagMapStmt = db.prepare(`
    INSERT INTO tt_tag_map (guild_id, forum_id, tag_id, tag_name, group_id) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, forum_id, tag_id) DO UPDATE SET
        tag_name = excluded.tag_name,
        group_id = excluded.group_id
`);
/** 只补名字、不动已有的分类归属——自动生成映射时用，避免覆盖管理组的人工修正 */
const touchTagMapStmt = db.prepare(`
    INSERT INTO tt_tag_map (guild_id, forum_id, tag_id, tag_name, group_id) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, forum_id, tag_id) DO UPDATE SET tag_name = excluded.tag_name
`);

export function listTagMap(guildId: string, forumId: string): TagMapping[] {
    const rows = listTagMapStmt.all(guildId, forumId) as {
        forum_id: string; tag_id: string; tag_name: string; group_id: string | null;
    }[];
    return rows.map(r => ({
        forumId: r.forum_id,
        tagId: r.tag_id,
        tagName: r.tag_name,
        group: r.group_id,
    }));
}

export function setTagMapping(
    guildId: string, forumId: string, tagId: string, tagName: string, group: string | null,
): void {
    upsertTagMapStmt.run(guildId, forumId, tagId, tagName, group);
}

export function touchTagMapping(
    guildId: string, forumId: string, tagId: string, tagName: string, guessedGroup: string | null,
): void {
    touchTagMapStmt.run(guildId, forumId, tagId, tagName, guessedGroup);
}

// ============================================================
// 组装引擎配置
// ============================================================

/**
 * 把库里的词典 + 互斥集合 + 禁令组装成引擎能吃的配置。
 * 词典和互斥集合都不内置默认值——库里是空的就等于不管任何词。
 */
export function buildGuardConfig(guildId: string): GuardConfig {
    const dict = (listEnabledDictStmt.all(guildId) as DictRow[]).map(toDict);
    const groupPriority: Record<string, number> = {};
    for (const g of listGroups(guildId)) groupPriority[g.groupId] = g.priority;

    return {
        dict,
        exclusiveSets: listExclusiveSets(guildId)
            .map(s => ({ dimension: s.dimension, groups: s.groups })),
        crossExclusions: listCrossExclusions(guildId),
        segmenterWords: listSegmenterWords(guildId),
        groupPriority,
        multiRouteGroup: getSettings(guildId).multiRouteGroup || null,
    };
}

// ============================================================
// 案件
// ============================================================

export type CaseState =
    | 'detected'       // 刚检出，还没通知
    | 'notified'       // 已通知作者，倒计时中
    | 'pending_admin'  // 挂起等管理组（申诉 / 定不了保留组 / 校验失败）
    | 'resolved'       // 已解决（作者自改、bot 改完、或复查已合规）
    | 'exempt'         // 管理组人工放行
    | 'failed';        // 执行失败

export interface GuardCase {
    id: number;
    guildId: string;
    forumId: string;
    threadId: string;
    authorId: string | null;
    state: CaseState;
    originalTitle: string;
    originalTagIds: string[];
    violations: Violation[];
    plan: unknown | null;
    noticeChannelId: string | null;
    noticeMessageId: string | null;
    deadline: number | null;
    isOldPost: boolean;
    wasArchived: boolean;
    llmReason: string | null;
    createdAt: number;
    updatedAt: number;
    closedAt: number | null;
}

interface CaseRow {
    id: number;
    guild_id: string;
    forum_id: string;
    thread_id: string;
    author_id: string | null;
    state: string;
    original_title: string;
    original_tag_ids: string;
    violations_json: string;
    plan_json: string | null;
    notice_channel_id: string | null;
    notice_message_id: string | null;
    deadline: number | null;
    is_old_post: number;
    was_archived: number;
    llm_reason: string | null;
    created_at: number;
    updated_at: number;
    closed_at: number | null;
}

function toCase(row: CaseRow): GuardCase {
    return {
        id: row.id,
        guildId: row.guild_id,
        forumId: row.forum_id,
        threadId: row.thread_id,
        authorId: row.author_id,
        state: row.state as CaseState,
        originalTitle: row.original_title,
        originalTagIds: row.original_tag_ids ? row.original_tag_ids.split(',').filter(Boolean) : [],
        violations: JSON.parse(row.violations_json) as Violation[],
        plan: row.plan_json ? JSON.parse(row.plan_json) : null,
        noticeChannelId: row.notice_channel_id,
        noticeMessageId: row.notice_message_id,
        deadline: row.deadline,
        isOldPost: Boolean(row.is_old_post),
        wasArchived: Boolean(row.was_archived),
        llmReason: row.llm_reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        closedAt: row.closed_at,
    };
}

const insertCaseStmt = db.prepare(`
    INSERT INTO tt_cases (
        guild_id, forum_id, thread_id, author_id, state,
        original_title, original_tag_ids, violations_json, plan_json,
        deadline, is_old_post, was_archived, created_at, updated_at
    ) VALUES (
        @guild_id, @forum_id, @thread_id, @author_id, @state,
        @original_title, @original_tag_ids, @violations_json, @plan_json,
        @deadline, @is_old_post, @was_archived, @created_at, @updated_at
    )
`);
const getOpenCaseStmt = db.prepare('SELECT * FROM tt_cases WHERE thread_id = ? AND closed_at IS NULL');
const getCaseStmt = db.prepare('SELECT * FROM tt_cases WHERE id = ?');
const listCasesStmt = db.prepare(`
    SELECT * FROM tt_cases WHERE guild_id = ? AND closed_at IS NULL
    ORDER BY created_at DESC LIMIT ?
`);
const listDueCasesStmt = db.prepare(`
    SELECT * FROM tt_cases
    WHERE state = 'notified' AND closed_at IS NULL AND deadline IS NOT NULL AND deadline <= ?
    ORDER BY deadline LIMIT ?
`);
const listUnnotifiedStmt = db.prepare(`
    SELECT * FROM tt_cases WHERE state = 'detected' AND closed_at IS NULL ORDER BY created_at LIMIT ?
`);

export interface CreateCaseInput {
    guildId: string;
    forumId: string;
    threadId: string;
    authorId: string | null;
    originalTitle: string;
    originalTagIds: string[];
    violations: Violation[];
    plan?: unknown;
    deadline: number | null;
    isOldPost: boolean;
    wasArchived: boolean;
}

export function createCase(input: CreateCaseInput): GuardCase | null {
    const now = Date.now();
    try {
        const info = insertCaseStmt.run({
            guild_id: input.guildId,
            forum_id: input.forumId,
            thread_id: input.threadId,
            author_id: input.authorId,
            state: 'detected' satisfies CaseState,
            original_title: input.originalTitle,
            original_tag_ids: input.originalTagIds.join(','),
            violations_json: JSON.stringify(input.violations),
            plan_json: input.plan ? JSON.stringify(input.plan) : null,
            deadline: input.deadline,
            is_old_post: input.isOldPost ? 1 : 0,
            was_archived: input.wasArchived ? 1 : 0,
            created_at: now,
            updated_at: now,
        });
        return getCase(Number(info.lastInsertRowid));
    } catch (err) {
        // 唯一索引冲突 = 该帖已有未结案件，属正常情况
        if (String(err).includes('UNIQUE')) return null;
        throw err;
    }
}

export function getCase(id: number): GuardCase | null {
    const row = getCaseStmt.get(id) as CaseRow | undefined;
    return row ? toCase(row) : null;
}

export function getOpenCase(threadId: string): GuardCase | null {
    const row = getOpenCaseStmt.get(threadId) as CaseRow | undefined;
    return row ? toCase(row) : null;
}

export function listOpenCases(guildId: string, limit = 50): GuardCase[] {
    return (listCasesStmt.all(guildId, limit) as CaseRow[]).map(toCase);
}

export function listDueCases(now: number, limit = 20): GuardCase[] {
    return (listDueCasesStmt.all(now, limit) as CaseRow[]).map(toCase);
}

export function listUnnotifiedCases(limit = 20): GuardCase[] {
    return (listUnnotifiedStmt.all(limit) as CaseRow[]).map(toCase);
}

const updateCaseStmt = db.prepare(`
    UPDATE tt_cases SET
        state = @state,
        violations_json = @violations_json,
        plan_json = @plan_json,
        notice_channel_id = @notice_channel_id,
        notice_message_id = @notice_message_id,
        deadline = @deadline,
        llm_reason = @llm_reason,
        updated_at = @updated_at,
        closed_at = @closed_at
    WHERE id = @id
`);

export function updateCase(id: number, patch: Partial<Omit<GuardCase, 'id'>>): GuardCase | null {
    const current = getCase(id);
    if (!current) return null;
    const merged = { ...current, ...patch };
    updateCaseStmt.run({
        id,
        state: merged.state,
        violations_json: JSON.stringify(merged.violations),
        plan_json: merged.plan ? JSON.stringify(merged.plan) : null,
        notice_channel_id: merged.noticeChannelId,
        notice_message_id: merged.noticeMessageId,
        deadline: merged.deadline,
        llm_reason: merged.llmReason,
        updated_at: Date.now(),
        closed_at: merged.closedAt,
    });
    return getCase(id);
}

export function closeCase(id: number, state: CaseState): GuardCase | null {
    return updateCase(id, { state, closedAt: Date.now() });
}

// ============================================================
// 操作流水（还原用）
// ============================================================

export interface ActionRecord {
    id: number;
    caseId: number | null;
    threadId: string;
    action: string;
    beforeTitle: string | null;
    afterTitle: string | null;
    beforeTagIds: string[];
    afterTagIds: string[];
    actor: string;
    reverted: boolean;
    createdAt: number;
}

const insertActionStmt = db.prepare(`
    INSERT INTO tt_actions (
        case_id, guild_id, thread_id, action,
        before_title, after_title, before_tag_ids, after_tag_ids,
        actor, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const lastActionStmt = db.prepare(`
    SELECT * FROM tt_actions WHERE thread_id = ? AND reverted = 0 ORDER BY created_at DESC LIMIT 1
`);
const markRevertedStmt = db.prepare('UPDATE tt_actions SET reverted = 1 WHERE id = ?');

export function recordAction(input: {
    caseId: number | null;
    guildId: string;
    threadId: string;
    action: string;
    beforeTitle: string | null;
    afterTitle: string | null;
    beforeTagIds: string[];
    afterTagIds: string[];
    actor: string;
}): void {
    insertActionStmt.run(
        input.caseId, input.guildId, input.threadId, input.action,
        input.beforeTitle, input.afterTitle,
        input.beforeTagIds.join(','), input.afterTagIds.join(','),
        input.actor, Date.now(),
    );
}

export function getLastAction(threadId: string): ActionRecord | null {
    const row = lastActionStmt.get(threadId) as {
        id: number; case_id: number | null; thread_id: string; action: string;
        before_title: string | null; after_title: string | null;
        before_tag_ids: string; after_tag_ids: string;
        actor: string; reverted: number; created_at: number;
    } | undefined;
    if (!row) return null;
    return {
        id: row.id,
        caseId: row.case_id,
        threadId: row.thread_id,
        action: row.action,
        beforeTitle: row.before_title,
        afterTitle: row.after_title,
        beforeTagIds: row.before_tag_ids ? row.before_tag_ids.split(',').filter(Boolean) : [],
        afterTagIds: row.after_tag_ids ? row.after_tag_ids.split(',').filter(Boolean) : [],
        actor: row.actor,
        reverted: Boolean(row.reverted),
        createdAt: row.created_at,
    };
}

export function markActionReverted(id: number): void {
    markRevertedStmt.run(id);
}

// ============================================================
// 豁免
// ============================================================

export function titleHash(title: string): string {
    return crypto.createHash('sha1').update(normalize(title).text).digest('hex').slice(0, 16);
}

const isExemptStmt = db.prepare(
    'SELECT 1 FROM tt_exempt WHERE guild_id = ? AND thread_id = ? AND title_hash = ?',
);
const addExemptStmt = db.prepare(`
    INSERT INTO tt_exempt (guild_id, thread_id, title_hash, by_user_id, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, thread_id, title_hash) DO UPDATE SET
        by_user_id = excluded.by_user_id, note = excluded.note
`);
const removeExemptStmt = db.prepare('DELETE FROM tt_exempt WHERE guild_id = ? AND thread_id = ?');
const listExemptStmt = db.prepare(
    'SELECT * FROM tt_exempt WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?',
);

/** 豁免绑定「帖子 + 当时的标题」——作者之后再改标题，豁免自动失效 */
export function isExempt(guildId: string, threadId: string, title: string): boolean {
    return Boolean(isExemptStmt.get(guildId, threadId, titleHash(title)));
}

export function addExempt(
    guildId: string, threadId: string, title: string, byUserId: string, note?: string,
): void {
    addExemptStmt.run(guildId, threadId, titleHash(title), byUserId, note ?? null, Date.now());
}

export function removeExempt(guildId: string, threadId: string): void {
    removeExemptStmt.run(guildId, threadId);
}

export function listExempt(guildId: string, limit = 50): {
    threadId: string; byUserId: string; note: string | null; createdAt: number;
}[] {
    const rows = listExemptStmt.all(guildId, limit) as {
        thread_id: string; by_user_id: string; note: string | null; created_at: number;
    }[];
    return rows.map(r => ({
        threadId: r.thread_id,
        byUserId: r.by_user_id,
        note: r.note,
        createdAt: r.created_at,
    }));
}

// ============================================================
// 老帖队列
// ============================================================

export interface QueueItem {
    guildId: string;
    forumId: string;
    threadId: string;
    state: string;
    attempts: number;
    lastError: string | null;
}

const enqueueStmt = db.prepare(`
    INSERT INTO tt_queue (guild_id, forum_id, thread_id, state, enqueued_at)
    VALUES (?, ?, ?, 'pending', ?)
    ON CONFLICT(guild_id, thread_id) DO NOTHING
`);
const nextQueueStmt = db.prepare(`
    SELECT * FROM tt_queue WHERE state = 'pending' ORDER BY enqueued_at LIMIT 1
`);
const finishQueueStmt = db.prepare(`
    UPDATE tt_queue SET state = ?, attempts = attempts + 1, last_error = ?, processed_at = ?
    WHERE guild_id = ? AND thread_id = ?
`);
const queueStatsStmt = db.prepare(`
    SELECT state, COUNT(*) AS c FROM tt_queue WHERE guild_id = ? GROUP BY state
`);
const clearQueueStmt = db.prepare('DELETE FROM tt_queue WHERE guild_id = ?');

export function enqueueBackfill(guildId: string, forumId: string, threadId: string): void {
    enqueueStmt.run(guildId, forumId, threadId, Date.now());
}

export function nextBackfillItem(): QueueItem | null {
    const row = nextQueueStmt.get() as {
        guild_id: string; forum_id: string; thread_id: string;
        state: string; attempts: number; last_error: string | null;
    } | undefined;
    if (!row) return null;
    return {
        guildId: row.guild_id,
        forumId: row.forum_id,
        threadId: row.thread_id,
        state: row.state,
        attempts: row.attempts,
        lastError: row.last_error,
    };
}

export function finishBackfillItem(
    guildId: string, threadId: string, state: 'done' | 'failed' | 'skipped', error?: string,
): void {
    finishQueueStmt.run(state, error ?? null, Date.now(), guildId, threadId);
}

export function backfillStats(guildId: string): Record<string, number> {
    const rows = queueStatsStmt.all(guildId) as { state: string; c: number }[];
    return Object.fromEntries(rows.map(r => [r.state, r.c]));
}

export function clearBackfill(guildId: string): void {
    clearQueueStmt.run(guildId);
}

// ============================================================
// LLM 缓存
// ============================================================

const getCacheStmt = db.prepare('SELECT result_json FROM tt_llm_cache WHERE cache_key = ?');
const setCacheStmt = db.prepare(`
    INSERT INTO tt_llm_cache (cache_key, result_json, created_at) VALUES (?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET result_json = excluded.result_json, created_at = excluded.created_at
`);

export function getLlmCache<T>(key: string): T | null {
    const row = getCacheStmt.get(key) as { result_json: string } | undefined;
    if (!row) return null;
    try {
        return JSON.parse(row.result_json) as T;
    } catch {
        return null;
    }
}

export function setLlmCache(key: string, value: unknown): void {
    setCacheStmt.run(key, JSON.stringify(value), Date.now());
}

export { db as titleGuardDb };
