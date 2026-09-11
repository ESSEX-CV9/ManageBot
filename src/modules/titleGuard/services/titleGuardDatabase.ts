// src/modules/titleGuard/services/titleGuardDatabase.ts
//
// 标题规范模块的独立数据层（SQLite / better-sqlite3）。
//
// 设计要点：
//   - 词典、互斥集合、TAG 映射**不内置任何默认值**，全部由管理组通过 /标题规范 线上维护。
//   - 词典和互斥集合是**服务器级**共用一份（社区共识层面的东西），
//     论坛级配置启用状态、模型策略，以及「本论坛哪个 TAG 对应哪个分类组」。
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
    WordTier,
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

    -- 身份组能力：谁能干什么。
    -- 社区管理组不是一个身份组，而是一堆（风纪委员、执行管理……），
    -- 各自负责的事情不一样，所以权限按「能力」发，不按「是不是管理员」发。
    -- 某项能力一个身份组都没配 = 回退到 permissionManager 的管理员判定（即保持原状）。
    CREATE TABLE IF NOT EXISTS tt_role_caps (
        guild_id   TEXT NOT NULL,
        role_id    TEXT NOT NULL,
        capability TEXT NOT NULL,
        granted_by TEXT,
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, role_id, capability)
    );

    -- 论坛级配置
    CREATE TABLE IF NOT EXISTS tt_forums (
        guild_id          TEXT NOT NULL,
        forum_id          TEXT NOT NULL,
        enabled           INTEGER NOT NULL DEFAULT 1,
        send_body_to_llm  INTEGER NOT NULL DEFAULT 0,
        force_llm_review  INTEGER NOT NULL DEFAULT 0,
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
        tier           TEXT NOT NULL DEFAULT '关联',
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

    -- 未结案件后台重审核队列。与作者的申诉复核完全分开，绝不占 ai_review_used。
    -- 单独落库是为了批量 LLM 重审跑到一半重启后仍能接着跑。
    CREATE TABLE IF NOT EXISTS tt_case_reaudit (
        case_id      INTEGER PRIMARY KEY,
        guild_id     TEXT NOT NULL,
        mode         TEXT NOT NULL,
        state        TEXT NOT NULL DEFAULT 'pending',
        requested_by TEXT NOT NULL,
        attempts     INTEGER NOT NULL DEFAULT 0,
        last_error   TEXT,
        enqueued_at  INTEGER NOT NULL,
        processed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS tt_case_reaudit_pending
        ON tt_case_reaudit (state, mode, enqueued_at);

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

    -- 快扫判定为合格的帖子。
    -- 这**只是个「还剩多少活要干」的标记**，不是缓存：
    -- 帖子改名改 TAG 有事件兜着，重跑全量扫描时也会无视这张表一律重判，
    -- 所以它永远不会让你漏掉东西，也就不需要做失效判断。
    CREATE TABLE IF NOT EXISTS tt_clean (
        guild_id   TEXT NOT NULL,
        forum_id   TEXT NOT NULL,
        thread_id  TEXT NOT NULL,
        checked_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, thread_id)
    );

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
 * 词条新增「词档」这一列：本体词 / 关联词。
 *
 * 这一列决定的是**词落在标题主体里时判定尺度有多严**：
 *   本体词就是大家打进搜索框的那几个字，留在标题里就一定被搜到，从严；
 *   关联词本身不是任何人会搜的词，写在句子里多半只是描述，结合上下文判。
 *
 * 新列默认「关联」，但这么一来已经在用的服务器会突然整体放宽。
 * 所以**只在这一列刚被建出来的那一次**，按社区 2026-09-11 定下的清单
 * 把六个本体词标出来，之后管理组随便改，这段代码再也不会动词表。
 * 其余任何词的档位都不在代码里写死。
 */
const CORE_WORDS_AT_MIGRATION = ['纯爱', 'ntr', 'ntl', '百合', '百破', '百合破坏'];

function seedWordTier(): void {
    const cols = db.prepare('PRAGMA table_info(tt_dict)').all() as { name: string }[];
    if (cols.length === 0) return;
    if (cols.some(c => c.name === 'tier')) return;

    db.exec("ALTER TABLE tt_dict ADD COLUMN tier TEXT NOT NULL DEFAULT '关联'");
    const mark = db.prepare("UPDATE tt_dict SET tier = '本体' WHERE word = ?");
    let n = 0;
    for (const w of CORE_WORDS_AT_MIGRATION) n += mark.run(w).changes;
    console.log(`[TitleGuard] 数据库迁移：tt_dict 新增列 tier，已标出 ${n} 个本体词`);
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
// 老帖门槛从「发帖至今多少天」改成「最近活跃至今多少小时」。
// 老的 old_post_days 列留着不删（sqlite 删列麻烦，留着也不碍事），只是不再读了。
ensureColumn('tt_settings', 'old_post_inactive_hours', 'INTEGER NOT NULL DEFAULT 72');

// 申诉复核（两级：先 AI 一次，再人工）
ensureColumn('tt_cases', 'appeal_text', 'TEXT');
ensureColumn('tt_cases', 'appeal_by', 'TEXT');
ensureColumn('tt_cases', 'appeal_at', 'INTEGER');
// AI 复核每案只有一次，用掉就置 1
ensureColumn('tt_cases', 'ai_review_used', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('tt_cases', 'ai_review_upheld', 'INTEGER');
ensureColumn('tt_cases', 'llm_review_reason', 'TEXT');
// 申诉时暂停倒计时，存下当时还剩多久；AI 维持原判后按这个恢复，
// 免得点一下按钮就白赚一整个宽限期
ensureColumn('tt_cases', 'paused_remaining_ms', 'INTEGER');
ensureColumn('tt_groups', 'priority', 'INTEGER NOT NULL DEFAULT 0');
// 队列拆成快慢两条：
//   fast —— 活跃帖 + 近期归档帖，50 个一批，批间隔 30 分钟
//   slow —— 老帖，默认 5 分钟一个，发通知前要先解归档
// 老库里的排队项一律按 slow 算（当年入队的本来就只有老帖）
ensureColumn('tt_queue', 'lane', "TEXT NOT NULL DEFAULT 'slow'");
// 词表来源：留空 = 用自己这个服的。填别的服务器 ID = 词表跟着那个服走。
// 只影响词表（词条/互斥/优先级/分词），身份组、论坛名单、案件、TAG 映射一律各归各的服。
ensureColumn('tt_settings', 'dict_source_guild_id', "TEXT NOT NULL DEFAULT ''");
// 快队列：一批最多发多少条、批与批之间隔多久。
// 一口气把上百条通知发出去，论坛首页会被这上百个帖子全顶上来，等于刷屏。
ensureColumn('tt_settings', 'fast_batch_size', 'INTEGER NOT NULL DEFAULT 50');
ensureColumn('tt_settings', 'fast_batch_pause_minutes', 'INTEGER NOT NULL DEFAULT 30');
// 论坛级开关：即使程序已经能直接判，也要先让模型完整复核一次再形成整改方案。
ensureColumn('tt_forums', 'force_llm_review', 'INTEGER NOT NULL DEFAULT 0');
seedWordTier();

// ============================================================
// 身份组能力
// ============================================================

const listCapsStmt = db.prepare(
    'SELECT role_id, capability FROM tt_role_caps WHERE guild_id = ? ORDER BY capability, role_id');
const listCapRolesStmt = db.prepare(
    'SELECT role_id FROM tt_role_caps WHERE guild_id = ? AND capability = ?');
const grantCapStmt = db.prepare(`
    INSERT INTO tt_role_caps (guild_id, role_id, capability, granted_by, granted_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, role_id, capability) DO NOTHING
`);
const revokeCapStmt = db.prepare(
    'DELETE FROM tt_role_caps WHERE guild_id = ? AND role_id = ? AND capability = ?');
const revokeAllCapsStmt = db.prepare('DELETE FROM tt_role_caps WHERE guild_id = ? AND role_id = ?');

export interface RoleCapability {
    roleId: string;
    capability: string;
}

export function listRoleCapabilities(guildId: string): RoleCapability[] {
    const rows = listCapsStmt.all(guildId) as { role_id: string; capability: string }[];
    return rows.map(r => ({ roleId: r.role_id, capability: r.capability }));
}

/** 拥有某项能力的身份组。空数组 = 没配，调用方据此回退到管理员判定 */
export function listRolesWithCapability(guildId: string, capability: string): string[] {
    const rows = listCapRolesStmt.all(guildId, capability) as { role_id: string }[];
    return rows.map(r => r.role_id);
}

export function grantCapability(
    guildId: string, roleId: string, capability: string, byUserId: string,
): boolean {
    return grantCapStmt.run(guildId, roleId, capability, byUserId, Date.now()).changes > 0;
}

export function revokeCapability(guildId: string, roleId: string, capability: string): boolean {
    return revokeCapStmt.run(guildId, roleId, capability).changes > 0;
}

export function revokeAllCapabilities(guildId: string, roleId: string): number {
    return revokeAllCapsStmt.run(guildId, roleId).changes;
}

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
    /**
     * 沉寂多少小时算「老帖」。
     *
     * 看的是**最近活跃时间**（最后一条消息），不是发帖时间：
     * 三年前发的帖只要还有人在回就是活的；上周发的帖沉了就是沉了。
     * 只有「已归档 + 沉寂超过这个小时数」才走长处理期限。
     */
    oldPostInactiveHours: number;
    /** 总闸：关掉就只检测不动手 */
    autoFixEnabled: boolean;
    llmEnabled: boolean;
    /** LLM 判出的违规是否需要管理组点确认才执行 */
    llmNeedsConfirm: boolean;
    /** 慢队列（老帖）多少分钟发一个 */
    queueIntervalMinutes: number;
    /** 快队列（活跃帖 + 近期归档帖）一批最多发多少条 */
    fastBatchSize: number;
    /** 快队列每批之间歇多少分钟 */
    fastBatchPauseMinutes: number;
    queuePaused: boolean;
    /** 「多路线」这个中性 TAG 对应的分类组名。空 = 不自动补多路线 TAG */
    multiRouteGroup: string;
    /**
     * 词表跟着哪个服务器走。空 = 用自己这个服的。
     *
     * 分类规范（词条、互斥规则、优先级、分词）是**整个社区一套**，
     * 两个服理应完全一致，维护两份迟早跑偏。
     * 而身份组、论坛名单、案件、TAG 映射是每个服自己的事，一律不共享——
     * 尤其身份组：A 服的身份组 ID 贴到 B 服的帖子里会显示成一串坏掉的编号。
     */
    dictSourceGuildId: string;
}

const DEFAULT_SETTINGS: Omit<GuardSettings, 'guildId'> = {
    enabled: false,
    alertRoleIds: [],
    alertChannelId: null,
    graceNewHours: 24,
    graceOldHours: 168,
    oldPostInactiveHours: 72,
    autoFixEnabled: false,
    llmEnabled: true,
    llmNeedsConfirm: true,
    queueIntervalMinutes: 5,
    fastBatchSize: 50,
    fastBatchPauseMinutes: 30,
    queuePaused: false,
    multiRouteGroup: '多路线',
    dictSourceGuildId: '',
};

interface SettingsRow {
    guild_id: string;
    enabled: number;
    alert_role_ids: string;
    alert_channel_id: string | null;
    grace_new_hours: number;
    grace_old_hours: number;
    old_post_inactive_hours: number;
    auto_fix_enabled: number;
    llm_enabled: number;
    llm_needs_confirm: number;
    queue_interval_minutes: number;
    fast_batch_size: number;
    fast_batch_pause_minutes: number;
    dict_source_guild_id: string | null;
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
        oldPostInactiveHours: row.old_post_inactive_hours,
        autoFixEnabled: Boolean(row.auto_fix_enabled),
        llmEnabled: Boolean(row.llm_enabled),
        llmNeedsConfirm: Boolean(row.llm_needs_confirm),
        queueIntervalMinutes: row.queue_interval_minutes,
        fastBatchSize: row.fast_batch_size,
        fastBatchPauseMinutes: row.fast_batch_pause_minutes,
        dictSourceGuildId: row.dict_source_guild_id ?? '',
        queuePaused: Boolean(row.queue_paused),
        multiRouteGroup: row.multi_route_group || DEFAULT_SETTINGS.multiRouteGroup,
    };
}

const upsertSettingsStmt = db.prepare(`
    INSERT INTO tt_settings (
        guild_id, enabled, alert_role_ids, alert_channel_id,
        grace_new_hours, grace_old_hours, old_post_inactive_hours,
        auto_fix_enabled, llm_enabled, llm_needs_confirm,
        queue_interval_minutes, fast_batch_size, fast_batch_pause_minutes,
        queue_paused, multi_route_group, dict_source_guild_id, updated_at
    ) VALUES (
        @guild_id, @enabled, @alert_role_ids, @alert_channel_id,
        @grace_new_hours, @grace_old_hours, @old_post_inactive_hours,
        @auto_fix_enabled, @llm_enabled, @llm_needs_confirm,
        @queue_interval_minutes, @fast_batch_size, @fast_batch_pause_minutes,
        @queue_paused, @multi_route_group, @dict_source_guild_id, @updated_at
    )
    ON CONFLICT(guild_id) DO UPDATE SET
        enabled = excluded.enabled,
        alert_role_ids = excluded.alert_role_ids,
        alert_channel_id = excluded.alert_channel_id,
        grace_new_hours = excluded.grace_new_hours,
        grace_old_hours = excluded.grace_old_hours,
        old_post_inactive_hours = excluded.old_post_inactive_hours,
        auto_fix_enabled = excluded.auto_fix_enabled,
        llm_enabled = excluded.llm_enabled,
        llm_needs_confirm = excluded.llm_needs_confirm,
        queue_interval_minutes = excluded.queue_interval_minutes,
        fast_batch_size = excluded.fast_batch_size,
        fast_batch_pause_minutes = excluded.fast_batch_pause_minutes,
        dict_source_guild_id = excluded.dict_source_guild_id,
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
        old_post_inactive_hours: merged.oldPostInactiveHours,
        auto_fix_enabled: merged.autoFixEnabled ? 1 : 0,
        llm_enabled: merged.llmEnabled ? 1 : 0,
        llm_needs_confirm: merged.llmNeedsConfirm ? 1 : 0,
        queue_interval_minutes: merged.queueIntervalMinutes,
        fast_batch_size: merged.fastBatchSize,
        fast_batch_pause_minutes: merged.fastBatchPauseMinutes,
        dict_source_guild_id: merged.dictSourceGuildId,
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
    /** 是否让本论坛每一个有问题的帖子都先经 LLM 判定，再形成整改方案 */
    forceLlmReview: boolean;
}

const listForumsStmt = db.prepare('SELECT * FROM tt_forums WHERE guild_id = ? ORDER BY added_at');
const getForumStmt = db.prepare('SELECT * FROM tt_forums WHERE guild_id = ? AND forum_id = ?');
const addForumStmt = db.prepare(`
    INSERT INTO tt_forums (
        guild_id, forum_id, enabled, send_body_to_llm, force_llm_review, added_at
    )
    VALUES (?, ?, 1, 0, 0, ?)
    ON CONFLICT(guild_id, forum_id) DO NOTHING
`);
const removeForumStmt = db.prepare('DELETE FROM tt_forums WHERE guild_id = ? AND forum_id = ?');
const updateForumStmt = db.prepare(`
    UPDATE tt_forums
    SET enabled = ?, send_body_to_llm = ?, force_llm_review = ?
    WHERE guild_id = ? AND forum_id = ?
`);

interface ForumRow {
    guild_id: string;
    forum_id: string;
    enabled: number;
    send_body_to_llm: number;
    force_llm_review: number;
}

function toForum(row: ForumRow): ForumConfig {
    return {
        guildId: row.guild_id,
        forumId: row.forum_id,
        enabled: Boolean(row.enabled),
        sendBodyToLlm: Boolean(row.send_body_to_llm),
        forceLlmReview: Boolean(row.force_llm_review),
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
    updateForumStmt.run(
        merged.enabled ? 1 : 0,
        merged.sendBodyToLlm ? 1 : 0,
        merged.forceLlmReview ? 1 : 0,
        guildId,
        forumId,
    );
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
        guild_id, word, raw_word, kind, group_id, tier, scope,
        replace_to, ascii_boundary, enabled, note, updated_at
    ) VALUES (
        @guild_id, @word, @raw_word, @kind, @group_id, @tier, @scope,
        @replace_to, @ascii_boundary, @enabled, @note, @updated_at
    )
    ON CONFLICT(guild_id, word) DO UPDATE SET
        raw_word = excluded.raw_word,
        kind = excluded.kind,
        group_id = excluded.group_id,
        tier = excluded.tier,
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
    tier: string | null;
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
        // 老库里这一列可能是 null，一律按「关联」算——本体词是明确列举的那几个
        tier: row.tier === '本体' ? '本体' : '关联',
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
    /** 词档。不传则沿用已有的；新词默认「关联」 */
    tier?: WordTier;
    scope?: DictScope;
    replaceTo?: string | null;
    asciiBoundary?: boolean;
    enabled?: boolean;
    note?: string | null;
}

export function upsertDict(guildId: string, input: UpsertDictInput): DictRecord {
    const word = normalize(input.rawWord).text.trim();
    if (!word) throw new Error('词条不能为空');

    // 改一条已有词条时没指定档位，就保持原样，别把管理组标好的本体词悄悄降回关联
    const existing = db.prepare('SELECT tier FROM tt_dict WHERE guild_id = ? AND word = ?')
        .get(guildId, word) as { tier: string | null } | undefined;

    const record = {
        guild_id: guildId,
        word,
        raw_word: input.rawWord.trim(),
        kind: input.kind,
        group_id: input.kind === '白名单' ? null : (input.group ?? null),
        tier: input.tier ?? (existing?.tier === '本体' ? '本体' : '关联'),
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
/**
 * 词表实际该从哪个服务器读。
 *
 * 只跳一层，不做链式解析：A→B→C 这种配法解析起来要防环，
 * 而且没人真的需要，配错了还很难看出来。B 要是自己也指向别人，就当它没指。
 */
export function dictSourceOf(guildId: string): string {
    const source = getSettings(guildId).dictSourceGuildId.trim();
    if (!source || source === guildId) return guildId;
    return source;
}

export function buildGuardConfig(guildId: string): GuardConfig {
    // 词条、互斥、优先级、分词都跟着来源服走；
    // 「多路线」用哪个 TAG 是本服自己的事（TAG ID 按服务器分），所以读本服的
    const src = dictSourceOf(guildId);

    const dict = (listEnabledDictStmt.all(src) as DictRow[]).map(toDict);
    const groupPriority: Record<string, number> = {};
    for (const g of listGroups(src)) groupPriority[g.groupId] = g.priority;

    return {
        dict,
        exclusiveSets: listExclusiveSets(src)
            .map(s => ({ dimension: s.dimension, groups: s.groups })),
        crossExclusions: listCrossExclusions(src),
        segmenterWords: listSegmenterWords(src),
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
    /** 作者提交的申诉理由（已过安检才会落这儿） */
    appealText: string | null;
    appealBy: string | null;
    appealAt: number | null;
    /** AI 复核用掉了没有。每案只有一次 */
    aiReviewUsed: boolean;
    /** AI 复核的结论：true 维持原判，false 申诉成立，null 还没复核过 */
    aiReviewUpheld: boolean | null;
    llmReviewReason: string | null;
    /** 倒计时暂停时还剩多久。恢复时按它算，不重新给一整个宽限期 */
    pausedRemainingMs: number | null;
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
    appeal_text: string | null;
    appeal_by: string | null;
    appeal_at: number | null;
    ai_review_used: number;
    ai_review_upheld: number | null;
    llm_review_reason: string | null;
    paused_remaining_ms: number | null;
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
        appealText: row.appeal_text,
        appealBy: row.appeal_by,
        appealAt: row.appeal_at,
        aiReviewUsed: Boolean(row.ai_review_used),
        aiReviewUpheld: row.ai_review_upheld === null ? null : Boolean(row.ai_review_upheld),
        llmReviewReason: row.llm_review_reason,
        pausedRemainingMs: row.paused_remaining_ms,
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
    ORDER BY created_at DESC, id DESC LIMIT ?
`);
const listCasesPageStmt = db.prepare(`
    SELECT * FROM tt_cases WHERE guild_id = ? AND closed_at IS NULL
    ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
`);
const countOpenCasesStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM tt_cases WHERE guild_id = ? AND closed_at IS NULL
`);
const listDueCasesStmt = db.prepare(`
    SELECT * FROM tt_cases
    WHERE state = 'notified' AND closed_at IS NULL AND deadline IS NOT NULL AND deadline <= ?
    ORDER BY deadline LIMIT ?
`);
const listUnnotifiedStmt = db.prepare(`
    SELECT * FROM tt_cases WHERE state = 'detected' AND closed_at IS NULL ORDER BY created_at LIMIT ?
`);
const listOpenNoticeCasesStmt = db.prepare(`
    SELECT * FROM tt_cases
    WHERE closed_at IS NULL AND notice_message_id IS NOT NULL
    ORDER BY id
`);
const listNoticeCasesForRefreshStmt = db.prepare(`
    SELECT * FROM tt_cases
    WHERE notice_message_id IS NOT NULL
      AND (closed_at IS NULL OR closed_at >= ?)
    ORDER BY id
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

/** 管理面板分页读取；排序补上 id，避免同一毫秒建案时跨页重复或漏项。 */
export function listOpenCasesPage(
    guildId: string,
    limit: number,
    offset: number,
): GuardCase[] {
    return (listCasesPageStmt.all(
        guildId,
        Math.max(1, Math.trunc(limit)),
        Math.max(0, Math.trunc(offset)),
    ) as CaseRow[]).map(toCase);
}

export function countOpenCases(guildId: string): number {
    return (countOpenCasesStmt.get(guildId) as { count: number }).count;
}

export function listDueCases(now: number, limit = 20): GuardCase[] {
    return (listDueCasesStmt.all(now, limit) as CaseRow[]).map(toCase);
}

export function listUnnotifiedCases(limit = 20): GuardCase[] {
    return (listUnnotifiedStmt.all(limit) as CaseRow[]).map(toCase);
}

/** 已经发过通知、且仍未结案的案件。用于新版上线后原地刷新旧面板文案。 */
export function listOpenNoticeCases(): GuardCase[] {
    return (listOpenNoticeCasesStmt.all() as CaseRow[]).map(toCase);
}

/**
 * 启动修复通知时，除了全部未结案件，也带上近期已结案件。
 * 这能自动修复旧版本中“作者已完成，但黄色面板没有重画”的历史通知。
 */
export function listNoticeCasesForRefresh(recentClosedSince: number): GuardCase[] {
    return (listNoticeCasesForRefreshStmt.all(recentClosedSince) as CaseRow[]).map(toCase);
}

// ============================================================
// 未结案件后台重审核队列
// ============================================================

export type CaseReauditMode = 'rules' | 'llm';

export interface CaseReauditItem {
    caseId: number;
    guildId: string;
    mode: CaseReauditMode;
    attempts: number;
}

const openCasesForReauditStmt = db.prepare(`
    SELECT id, guild_id FROM tt_cases
    WHERE closed_at IS NULL AND (? IS NULL OR guild_id = ?)
    ORDER BY id
`);
const enqueueCaseReauditStmt = db.prepare(`
    INSERT INTO tt_case_reaudit (
        case_id, guild_id, mode, state, requested_by,
        attempts, last_error, enqueued_at, processed_at
    ) VALUES (?, ?, ?, 'pending', ?, 0, NULL, ?, NULL)
    ON CONFLICT(case_id) DO UPDATE SET
        guild_id = excluded.guild_id,
        mode = CASE
            WHEN tt_case_reaudit.state IN ('pending', 'running')
                AND tt_case_reaudit.mode = 'llm'
                THEN 'llm'
            ELSE excluded.mode
        END,
        state = 'pending',
        requested_by = CASE
            WHEN tt_case_reaudit.state IN ('pending', 'running')
                AND tt_case_reaudit.mode = 'llm'
                THEN tt_case_reaudit.requested_by
            ELSE excluded.requested_by
        END,
        attempts = CASE
            WHEN tt_case_reaudit.state IN ('pending', 'running')
                THEN tt_case_reaudit.attempts
            ELSE 0
        END,
        last_error = NULL,
        enqueued_at = excluded.enqueued_at,
        processed_at = NULL
`);
const discardClosedReauditStmt = db.prepare(`
    DELETE FROM tt_case_reaudit
    WHERE NOT EXISTS (
        SELECT 1 FROM tt_cases c
        WHERE c.id = tt_case_reaudit.case_id AND c.closed_at IS NULL
    )
`);
const nextCaseReauditStmt = db.prepare(`
    SELECT q.case_id, q.guild_id, q.mode, q.attempts
    FROM tt_case_reaudit q
    JOIN tt_cases c ON c.id = q.case_id AND c.closed_at IS NULL
    WHERE q.state = 'pending'
    ORDER BY CASE q.mode WHEN 'llm' THEN 0 ELSE 1 END, q.enqueued_at, q.case_id
    LIMIT 1
`);
const claimCaseReauditStmt = db.prepare(`
    UPDATE tt_case_reaudit
    SET state = 'running', attempts = attempts + 1, last_error = NULL
    WHERE case_id = ? AND state = 'pending'
`);
const finishCaseReauditStmt = db.prepare(`
    UPDATE tt_case_reaudit
    SET state = 'done', processed_at = ?, last_error = NULL
    WHERE case_id = ? AND state = 'running'
`);
const deferCaseReauditStmt = db.prepare(`
    UPDATE tt_case_reaudit
    SET state = 'pending', attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END
    WHERE case_id = ? AND state = 'running'
`);
const discardCaseReauditStmt = db.prepare(`
    DELETE FROM tt_case_reaudit
    WHERE case_id = ? AND (? = 'llm' OR mode = 'rules')
`);
const failCaseReauditStmt = db.prepare(`
    UPDATE tt_case_reaudit
    SET state = CASE WHEN attempts < 3 THEN 'pending' ELSE 'failed' END,
        last_error = ?, processed_at = ?
    WHERE case_id = ? AND state = 'running'
`);
const recoverCaseReauditStmt = db.prepare(`
    UPDATE tt_case_reaudit SET state = 'pending'
    WHERE state = 'running'
`);
const caseReauditStatsStmt = db.prepare(`
    SELECT mode, state, COUNT(*) AS count
    FROM tt_case_reaudit
    WHERE guild_id = ?
    GROUP BY mode, state
`);

/**
 * 把当前所有未结案件排入后台重审核。相同案件只保留一项；LLM 任务不会被规则任务降级。
 */
export const enqueueOpenCaseReaudits = db.transaction((
    guildId: string | null,
    mode: CaseReauditMode,
    requestedBy: string,
): number => {
    discardClosedReauditStmt.run();
    const rows = openCasesForReauditStmt.all(guildId, guildId) as { id: number; guild_id: string }[];
    const now = Date.now();
    for (const row of rows) {
        enqueueCaseReauditStmt.run(row.id, row.guild_id, mode, requestedBy, now);
    }
    return rows.length;
});

/** 重启时把来不及收尾的任务放回队列。 */
export function recoverCaseReaudits(): void {
    discardClosedReauditStmt.run();
    recoverCaseReauditStmt.run();
}

/** 原子领取一个任务；手动 LLM 重审核优先于启动时的规则重审核。 */
export const claimNextCaseReaudit = db.transaction((): CaseReauditItem | null => {
    discardClosedReauditStmt.run();
    const row = nextCaseReauditStmt.get() as {
        case_id: number;
        guild_id: string;
        mode: string;
        attempts: number;
    } | undefined;
    if (!row || claimCaseReauditStmt.run(row.case_id).changes === 0) return null;
    return {
        caseId: row.case_id,
        guildId: row.guild_id,
        mode: row.mode === 'llm' ? 'llm' : 'rules',
        attempts: row.attempts + 1,
    };
});

export function finishCaseReaudit(caseId: number): void {
    finishCaseReauditStmt.run(Date.now(), caseId);
}

/** 单案立即重审正在执行时，后台领取到同案任务就先放回去，不计失败次数。 */
export function deferCaseReaudit(caseId: number): void {
    deferCaseReauditStmt.run(caseId);
}

/**
 * 单案立即重审后移除不再需要的后台任务。
 * 立即规则重审不能取消一项更强的 LLM 批量任务；立即 LLM 重审则两种都覆盖。
 */
export function discardCaseReaudit(caseId: number, mode: CaseReauditMode): void {
    discardCaseReauditStmt.run(caseId, mode);
}

/** 失败任务最多自动重试三次；再次手动入队会重新获得三次机会。 */
export function failCaseReaudit(caseId: number, error: string): void {
    failCaseReauditStmt.run(error.slice(0, 500), Date.now(), caseId);
}

export function caseReauditStats(guildId: string): {
    rulesPending: number;
    llmPending: number;
    running: number;
    failed: number;
} {
    discardClosedReauditStmt.run();
    const rows = caseReauditStatsStmt.all(guildId) as {
        mode: string;
        state: string;
        count: number;
    }[];
    const count = (mode: string | null, state: string) => rows
        .filter(r => (mode === null || r.mode === mode) && r.state === state)
        .reduce((sum, r) => sum + r.count, 0);
    return {
        rulesPending: count('rules', 'pending'),
        llmPending: count('llm', 'pending'),
        running: count(null, 'running'),
        failed: count(null, 'failed'),
    };
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
        appeal_text = @appeal_text,
        appeal_by = @appeal_by,
        appeal_at = @appeal_at,
        ai_review_used = @ai_review_used,
        ai_review_upheld = @ai_review_upheld,
        llm_review_reason = @llm_review_reason,
        paused_remaining_ms = @paused_remaining_ms,
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
        appeal_text: merged.appealText,
        appeal_by: merged.appealBy,
        appeal_at: merged.appealAt,
        ai_review_used: merged.aiReviewUsed ? 1 : 0,
        ai_review_upheld: merged.aiReviewUpheld === null ? null : (merged.aiReviewUpheld ? 1 : 0),
        llm_review_reason: merged.llmReviewReason,
        paused_remaining_ms: merged.pausedRemainingMs,
        updated_at: Date.now(),
        closed_at: merged.closedAt,
    });
    return getCase(id);
}

const claimAiReviewStmt = db.prepare(`
    UPDATE tt_cases SET ai_review_used = 1, updated_at = ?
    WHERE id = ? AND ai_review_used = 0 AND closed_at IS NULL
`);
const releaseAiReviewStmt = db.prepare(
    'UPDATE tt_cases SET ai_review_used = 0, updated_at = ? WHERE id = ? AND ai_review_upheld IS NULL');

/**
 * 抢占这个案子的 AI 复核名额，抢到才准往下走。
 *
 * 必须在**调用模型之前**抢。写成「调用完成后再标记已用」的话，
 * 中间那几十秒里连点几次按钮就是几次调用，「每案一次」形同虚设。
 * 返回 false = 已经有人在跑了，或者案子已结案。
 */
export function claimAiReview(caseId: number): boolean {
    return claimAiReviewStmt.run(Date.now(), caseId).changes > 0;
}

/**
 * 把名额还回去。只在**复核没真正完成**时调用（安检没过、模型调不通、案子中途结了）。
 * 有 ai_review_upheld 就说明复核出过结论，那个名额不退。
 */
export function releaseAiReview(caseId: number): void {
    releaseAiReviewStmt.run(Date.now(), caseId);
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

/** 走哪条队列。见迁移处的说明 */
export type QueueLane = 'fast' | 'slow';

export interface QueueItem {
    guildId: string;
    forumId: string;
    threadId: string;
    lane: QueueLane;
    state: string;
    attempts: number;
    lastError: string | null;
}

const enqueueStmt = db.prepare(`
    INSERT INTO tt_queue (guild_id, forum_id, thread_id, lane, state, enqueued_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
    ON CONFLICT(guild_id, thread_id) DO UPDATE SET
        lane = excluded.lane
    WHERE tt_queue.state = 'pending'
`);
// guild_id 必须进 WHERE。少了它就是「全局取最老的一条，不是这个服的就放弃」——
// 两个服的时候，其中一个会被另一个的排队项永久挡住，而且那些项连状态都不会变，
// 表现是「待处理数字一直不动」，非常难查
const nextQueueStmt = db.prepare(`
    SELECT * FROM tt_queue
    WHERE guild_id = ? AND state = 'pending' AND lane = ?
    ORDER BY enqueued_at LIMIT 1
`);
const pendingCountStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM tt_queue WHERE guild_id = ? AND state = 'pending' AND lane = ?
`);
const finishQueueStmt = db.prepare(`
    UPDATE tt_queue SET state = ?, attempts = attempts + 1, last_error = ?, processed_at = ?
    WHERE guild_id = ? AND thread_id = ?
`);
const queueStatsStmt = db.prepare(`
    SELECT state, COUNT(*) AS c FROM tt_queue WHERE guild_id = ? GROUP BY state
`);
const clearQueueStmt = db.prepare('DELETE FROM tt_queue WHERE guild_id = ?');

export function enqueueBackfill(
    guildId: string, forumId: string, threadId: string, lane: QueueLane = 'slow',
): void {
    enqueueStmt.run(guildId, forumId, threadId, lane, Date.now());
}

export function nextBackfillItem(guildId: string, lane: QueueLane): QueueItem | null {
    const row = nextQueueStmt.get(guildId, lane) as {
        guild_id: string; forum_id: string; thread_id: string; lane: string;
        state: string; attempts: number; last_error: string | null;
    } | undefined;
    if (!row) return null;
    return {
        guildId: row.guild_id,
        forumId: row.forum_id,
        threadId: row.thread_id,
        lane: row.lane === 'fast' ? 'fast' : 'slow',
        state: row.state,
        attempts: row.attempts,
        lastError: row.last_error,
    };
}

/** 某条队列还排着多少个 */
export function pendingCount(guildId: string, lane: QueueLane): number {
    return (pendingCountStmt.get(guildId, lane) as { c: number }).c;
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
// 已核查合格
// ============================================================

const markCleanStmt = db.prepare(`
    INSERT INTO tt_clean (guild_id, forum_id, thread_id, checked_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, thread_id) DO UPDATE SET
        forum_id = excluded.forum_id,
        checked_at = excluded.checked_at
`);
const unmarkCleanStmt = db.prepare('DELETE FROM tt_clean WHERE guild_id = ? AND thread_id = ?');
const cleanCountStmt = db.prepare('SELECT COUNT(*) AS c FROM tt_clean WHERE guild_id = ?');
const clearCleanStmt = db.prepare('DELETE FROM tt_clean WHERE guild_id = ?');

/** 批量记账。一次事务，两万条也就一眨眼 */
export const markClean = db.transaction(
    (guildId: string, forumId: string, threadIds: string[]) => {
        const now = Date.now();
        for (const id of threadIds) markCleanStmt.run(guildId, forumId, id, now);
    },
);

/**
 * 帖子有变动就把「合格」撤掉。
 * 改名、改 TAG、重新建案时都要调，否则管理组看到的「还剩多少活」是错的。
 */
export function unmarkClean(guildId: string, threadId: string): void {
    unmarkCleanStmt.run(guildId, threadId);
}

export function cleanCount(guildId: string): number {
    return (cleanCountStmt.get(guildId) as { c: number }).c;
}

export function clearClean(guildId: string): void {
    clearCleanStmt.run(guildId);
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
