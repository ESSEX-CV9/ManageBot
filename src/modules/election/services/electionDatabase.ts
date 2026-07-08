// src/modules/election/services/electionDatabase.ts
//
// 募选模块的独立数据层（SQLite / better-sqlite3）。
// 阶段①范围：服务器配置（election_settings）+ 候选池快照（election_pool）。
// 后续阶段（募选/自荐/投票）会在本文件继续追加表与访问器。

import path from 'path';
import Database from 'better-sqlite3';
import { DATA_DIR } from '../../../core/utils/database';

const DB_FILE = path.join(DATA_DIR, 'election.sqlite');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

// --- 建表 ---
// 配置项较多且含频道/身份组列表，整体以 JSON 存进单列 data，读写时合并默认值。
db.exec(`
    CREATE TABLE IF NOT EXISTS election_settings (
        guild_id   TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS election_pool (
        guild_id     TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        display_name TEXT,
        passed_at    INTEGER,          -- 通过时间（Discord 时间戳里的 Unix 秒 × 1000）
        in_pool      INTEGER NOT NULL DEFAULT 1,  -- 1=在池 0=已离池（保留历史）
        synced_at    INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS election_round (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id           TEXT NOT NULL,
        title              TEXT NOT NULL,
        status             TEXT NOT NULL,   -- nominating / voting / pending_confirm / closed / cancelled
        created_by         TEXT NOT NULL,
        created_at         INTEGER NOT NULL,
        nominate_deadline  INTEGER NOT NULL,
        vote_deadline      INTEGER NOT NULL,
        enable_public      INTEGER NOT NULL,
        enable_admin       INTEGER NOT NULL,
        weight_public      REAL NOT NULL,
        weight_admin       REAL NOT NULL,
        vacancy_count      INTEGER NOT NULL,
        tie_break          TEXT NOT NULL,
        require_confirm    INTEGER NOT NULL,
        entry_channel_id   TEXT,
        entry_message_id   TEXT,
        public_channel_id  TEXT,
        public_message_id  TEXT,
        result_channel_id  TEXT,
        result_message_id  TEXT,
        nominate_notify_message_id TEXT,    -- 自荐开放通知消息（入口频道），阶段结束时改文案
        vote_notify_message_id     TEXT,    -- 投票开始通知消息（大众投票频道）
        winner_user_ids    TEXT             -- JSON 数组，结算后写入
    );
    CREATE INDEX IF NOT EXISTS idx_round_guild_status ON election_round(guild_id, status);

    CREATE TABLE IF NOT EXISTS election_nomination (
        round_id    INTEGER NOT NULL,
        user_id     TEXT NOT NULL,
        statement   TEXT,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (round_id, user_id)
    );

    -- 投票记录：大众/管理同表，kind 区分；多选=多行；一人一票靠改票时先删后插。
    CREATE TABLE IF NOT EXISTS election_vote (
        round_id     INTEGER NOT NULL,
        kind         TEXT NOT NULL,     -- 'public' | 'admin'
        voter_id     TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        PRIMARY KEY (round_id, kind, voter_id, candidate_id)
    );

    -- 管理内投在各管理频道自动创建的 thread。
    CREATE TABLE IF NOT EXISTS election_admin_thread (
        round_id    INTEGER NOT NULL,
        channel_id  TEXT NOT NULL,
        thread_id   TEXT NOT NULL,
        message_id  TEXT,
        PRIMARY KEY (round_id, channel_id)
    );
`);

// --- 迁移：给旧库补新列（列已存在时 ALTER 会抛错，忽略即可） ---
for (const col of ['nominate_notify_message_id', 'vote_notify_message_id']) {
    try { db.exec(`ALTER TABLE election_round ADD COLUMN ${col} TEXT`); } catch { /* 列已存在 */ }
}

// ============================ 配置 ============================

export type TieBreak = 'public' | 'admin';

/** 一个服务器的募选配置。列表项为 ID 字符串数组。 */
export interface ElectionSettings {
    /** 入口频道：发布空位需求 + 自荐入口 */
    entryChannelId: string | null;
    /** 大众投票频道 */
    publicVoteChannelId: string | null;
    /** 结果公示频道 */
    resultChannelId: string | null;
    /** 管理内投频道列表（每场全开，各处建 thread） */
    adminVoteChannelIds: string[];
    /** 大众投票资格身份组 */
    activeRoleIds: string[];
    /** 管理投票资格身份组 */
    adminVoteRoleIds: string[];
    /** 可发起/管理募选的身份组 */
    manageRoleIds: string[];
    /** 自荐开放通知身份组：发起时在入口频道 @ 他们 */
    nominateNotifyRoleIds: string[];
    /** 投票开始通知身份组：大众投票开始时在投票频道 @ 他们 */
    voteNotifyRoleIds: string[];
    /** 旧募选 bot 的用户 ID（embed 回退方案校验来源用） */
    oldBotId: string | null;
    /** 常态配置 id（config_id）：API 与旧命令共用 */
    poolConfigId: string | null;
    /** 候选池 API 基址（默认官方地址） */
    apiBaseUrl: string | null;
    /** 候选池 API Bearer Token */
    apiToken: string | null;
    /** API 查询用 guild_id（留空则用当前服务器 id） */
    apiGuildId: string | null;
    /** 岗位名过滤 field_name（可选，精确匹配，如「管理组」） */
    apiFieldName: string | null;
    /** 是否开启候选池定时自动拉取（默认关） */
    pollEnabled: boolean;
    /** 定时自动拉取间隔（分钟，默认 60，下限 10，无上限） */
    pollIntervalMinutes: number;
    /** 大众权重，默认 0.6 */
    weightPublic: number;
    /** 管理权重，默认 0.4 */
    weightAdmin: number;
    /** 是否启用大众投票 */
    enablePublic: boolean;
    /** 是否启用管理投票 */
    enableAdmin: boolean;
    /** 结算是否需管理员二次确认再公示，默认 false */
    requireConfirm: boolean;
    /** 并列规则，默认 public（大众得票率高者优先） */
    tieBreak: TieBreak;
}

export const DEFAULT_SETTINGS: ElectionSettings = {
    entryChannelId: null,
    publicVoteChannelId: null,
    resultChannelId: null,
    adminVoteChannelIds: [],
    activeRoleIds: [],
    adminVoteRoleIds: [],
    manageRoleIds: [],
    nominateNotifyRoleIds: [],
    voteNotifyRoleIds: [],
    oldBotId: null,
    poolConfigId: null,
    apiBaseUrl: null,
    apiToken: null,
    apiGuildId: null,
    apiFieldName: null,
    pollEnabled: false,
    pollIntervalMinutes: 60,
    weightPublic: 0.7,
    weightAdmin: 0.3,
    enablePublic: true,
    enableAdmin: true,
    requireConfirm: false,
    tieBreak: 'public',
};

const getSettingsStmt = db.prepare(`SELECT data FROM election_settings WHERE guild_id = ?`);
const upsertSettingsStmt = db.prepare(`
    INSERT INTO election_settings (guild_id, data, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
`);

/** 读取配置；缺省项用默认值补齐（对旧数据向前兼容）。 */
export function getSettings(guildId: string): ElectionSettings {
    const row = getSettingsStmt.get(guildId) as { data: string } | undefined;
    if (!row) return { ...DEFAULT_SETTINGS };
    try {
        const parsed = JSON.parse(row.data) as Partial<ElectionSettings>;
        return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

/** 部分更新配置（合并已有值后写回），返回更新后的完整配置。 */
export function updateSettings(guildId: string, patch: Partial<ElectionSettings>): ElectionSettings {
    const merged = { ...getSettings(guildId), ...patch };
    upsertSettingsStmt.run(guildId, JSON.stringify(merged), Date.now());
    return merged;
}

// ============================ 候选池 ============================

interface PoolRow {
    guild_id: string;
    user_id: string;
    display_name: string | null;
    passed_at: number | null;
    in_pool: number;
    synced_at: number;
}

export interface PoolMember {
    userId: string;
    displayName: string | null;
    passedAt: number | null;
    inPool: boolean;
    syncedAt: number;
}

/** 从旧 bot 名单解析出的一条候选人。 */
export interface ParsedPoolEntry {
    userId: string;
    displayName?: string | null;
    /** 通过时间（毫秒）。解析不到时为 null。 */
    passedAt?: number | null;
}

const markAllLeftStmt = db.prepare(`UPDATE election_pool SET in_pool = 0 WHERE guild_id = ?`);
const upsertPoolStmt = db.prepare(`
    INSERT INTO election_pool (guild_id, user_id, display_name, passed_at, in_pool, synced_at)
    VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
        display_name = excluded.display_name,
        passed_at    = excluded.passed_at,
        in_pool      = 1,
        synced_at    = excluded.synced_at
`);
const listPoolStmt = db.prepare(`
    SELECT guild_id, user_id, display_name, passed_at, in_pool, synced_at
    FROM election_pool WHERE guild_id = ? AND in_pool = 1
    ORDER BY passed_at ASC
`);
const isInPoolStmt = db.prepare(`
    SELECT 1 FROM election_pool WHERE guild_id = ? AND user_id = ? AND in_pool = 1
`);

export interface SyncResult {
    total: number;   // 同步后在池人数
    added: number;   // 新进池
    removed: number; // 本次离池
    kept: number;    // 依旧在池
}

/**
 * 用旧 bot 名单对候选池做**全量对账**：
 * 名单中在 → 进/留池；名单中无 → 标记离池（保留历史行）。
 * 在一个事务里完成，避免中途失败导致半同步。
 */
export function syncPool(guildId: string, entries: ParsedPoolEntry[]): SyncResult {
    const now = Date.now();
    const beforeInPool = new Set(
        (listPoolStmt.all(guildId) as PoolRow[]).map(r => r.user_id),
    );
    const nextIds = new Set(entries.map(e => e.userId));

    const run = db.transaction(() => {
        markAllLeftStmt.run(guildId);
        for (const e of entries) {
            upsertPoolStmt.run(guildId, e.userId, e.displayName ?? null, e.passedAt ?? null, now);
        }
    });
    run();

    let added = 0;
    let kept = 0;
    for (const id of nextIds) {
        if (beforeInPool.has(id)) kept++;
        else added++;
    }
    let removed = 0;
    for (const id of beforeInPool) {
        if (!nextIds.has(id)) removed++;
    }
    return { total: nextIds.size, added, removed, kept };
}

/** 列出当前在池成员。 */
export function listPool(guildId: string): PoolMember[] {
    return (listPoolStmt.all(guildId) as PoolRow[]).map(r => ({
        userId: r.user_id,
        displayName: r.display_name,
        passedAt: r.passed_at,
        inPool: r.in_pool === 1,
        syncedAt: r.synced_at,
    }));
}

/** 判断某用户当前是否在池（用于自荐资格校验）。 */
export function isInPool(guildId: string, userId: string): boolean {
    return !!isInPoolStmt.get(guildId, userId);
}

// ============================ 募选场次（round） ============================

export type RoundStatus = 'nominating' | 'voting' | 'pending_confirm' | 'closed' | 'cancelled';

export interface ElectionRound {
    id: number;
    guildId: string;
    title: string;
    status: RoundStatus;
    createdBy: string;
    createdAt: number;
    nominateDeadline: number;
    voteDeadline: number;
    enablePublic: boolean;
    enableAdmin: boolean;
    weightPublic: number;
    weightAdmin: number;
    vacancyCount: number;
    tieBreak: TieBreak;
    requireConfirm: boolean;
    entryChannelId: string | null;
    entryMessageId: string | null;
    publicChannelId: string | null;
    publicMessageId: string | null;
    resultChannelId: string | null;
    resultMessageId: string | null;
    nominateNotifyMessageId: string | null;
    voteNotifyMessageId: string | null;
    winnerUserIds: string[] | null;
}

interface RoundRow {
    id: number;
    guild_id: string;
    title: string;
    status: string;
    created_by: string;
    created_at: number;
    nominate_deadline: number;
    vote_deadline: number;
    enable_public: number;
    enable_admin: number;
    weight_public: number;
    weight_admin: number;
    vacancy_count: number;
    tie_break: string;
    require_confirm: number;
    entry_channel_id: string | null;
    entry_message_id: string | null;
    public_channel_id: string | null;
    public_message_id: string | null;
    result_channel_id: string | null;
    result_message_id: string | null;
    nominate_notify_message_id: string | null;
    vote_notify_message_id: string | null;
    winner_user_ids: string | null;
}

function rowToRound(r: RoundRow): ElectionRound {
    let winners: string[] | null = null;
    if (r.winner_user_ids) {
        try {
            winners = JSON.parse(r.winner_user_ids) as string[];
        } catch {
            winners = null;
        }
    }
    return {
        id: r.id,
        guildId: r.guild_id,
        title: r.title,
        status: r.status as RoundStatus,
        createdBy: r.created_by,
        createdAt: r.created_at,
        nominateDeadline: r.nominate_deadline,
        voteDeadline: r.vote_deadline,
        enablePublic: r.enable_public === 1,
        enableAdmin: r.enable_admin === 1,
        weightPublic: r.weight_public,
        weightAdmin: r.weight_admin,
        vacancyCount: r.vacancy_count,
        tieBreak: r.tie_break as TieBreak,
        requireConfirm: r.require_confirm === 1,
        entryChannelId: r.entry_channel_id,
        entryMessageId: r.entry_message_id,
        publicChannelId: r.public_channel_id,
        publicMessageId: r.public_message_id,
        resultChannelId: r.result_channel_id,
        resultMessageId: r.result_message_id,
        nominateNotifyMessageId: r.nominate_notify_message_id,
        voteNotifyMessageId: r.vote_notify_message_id,
        winnerUserIds: winners,
    };
}

export interface CreateRoundInput {
    guildId: string;
    title: string;
    createdBy: string;
    nominateDeadline: number;
    voteDeadline: number;
    enablePublic: boolean;
    enableAdmin: boolean;
    weightPublic: number;
    weightAdmin: number;
    vacancyCount: number;
    tieBreak: TieBreak;
    requireConfirm: boolean;
    entryChannelId: string;
}

const insertRoundStmt = db.prepare(`
    INSERT INTO election_round (
        guild_id, title, status, created_by, created_at,
        nominate_deadline, vote_deadline, enable_public, enable_admin,
        weight_public, weight_admin, vacancy_count, tie_break, require_confirm,
        entry_channel_id
    ) VALUES (
        @guild_id, @title, 'nominating', @created_by, @created_at,
        @nominate_deadline, @vote_deadline, @enable_public, @enable_admin,
        @weight_public, @weight_admin, @vacancy_count, @tie_break, @require_confirm,
        @entry_channel_id
    )
`);
const getRoundStmt = db.prepare(`SELECT * FROM election_round WHERE id = ?`);
const listRoundsByStatusStmt = db.prepare(`
    SELECT * FROM election_round WHERE guild_id = ? AND status IN (SELECT value FROM json_each(?))
    ORDER BY created_at DESC
`);

/** 新建一场募选（状态 nominating），返回 round id。 */
export function createRound(input: CreateRoundInput): number {
    const info = insertRoundStmt.run({
        guild_id: input.guildId,
        title: input.title,
        created_by: input.createdBy,
        created_at: Date.now(),
        nominate_deadline: input.nominateDeadline,
        vote_deadline: input.voteDeadline,
        enable_public: input.enablePublic ? 1 : 0,
        enable_admin: input.enableAdmin ? 1 : 0,
        weight_public: input.weightPublic,
        weight_admin: input.weightAdmin,
        vacancy_count: input.vacancyCount,
        tie_break: input.tieBreak,
        require_confirm: input.requireConfirm ? 1 : 0,
        entry_channel_id: input.entryChannelId,
    });
    return Number(info.lastInsertRowid);
}

/** 读取一场募选。 */
export function getRound(id: number): ElectionRound | null {
    const row = getRoundStmt.get(id) as RoundRow | undefined;
    return row ? rowToRound(row) : null;
}

/** 按状态列出某服务器的募选（新→旧）。 */
export function listRounds(guildId: string, statuses: RoundStatus[]): ElectionRound[] {
    const rows = listRoundsByStatusStmt.all(guildId, JSON.stringify(statuses)) as RoundRow[];
    return rows.map(rowToRound);
}

// 允许被更新的列白名单（防止拼错列名）
const ROUND_COL: Record<string, string> = {
    status: 'status',
    entryMessageId: 'entry_message_id',
    publicChannelId: 'public_channel_id',
    publicMessageId: 'public_message_id',
    resultChannelId: 'result_channel_id',
    resultMessageId: 'result_message_id',
    nominateNotifyMessageId: 'nominate_notify_message_id',
    voteNotifyMessageId: 'vote_notify_message_id',
};

/** 局部更新一场募选的部分字段（状态、各消息 id 等）。 */
export function updateRound(
    id: number,
    patch: Partial<Pick<ElectionRound,
        'status' | 'entryMessageId' | 'publicChannelId' | 'publicMessageId' | 'resultChannelId' | 'resultMessageId'
        | 'nominateNotifyMessageId' | 'voteNotifyMessageId'>>,
): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
        const col = ROUND_COL[k];
        if (!col) continue;
        sets.push(`${col} = ?`);
        vals.push(v);
    }
    if (!sets.length) return;
    vals.push(id);
    db.prepare(`UPDATE election_round SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

/** 写入结算当选者（JSON 数组）。 */
export function setRoundWinners(id: number, winnerUserIds: string[]): void {
    db.prepare(`UPDATE election_round SET winner_user_ids = ? WHERE id = ?`)
        .run(JSON.stringify(winnerUserIds), id);
}

// ============================ 自荐（nomination） ============================

export interface Nomination {
    userId: string;
    statement: string | null;
    createdAt: number;
}

interface NominationRow {
    round_id: number;
    user_id: string;
    statement: string | null;
    created_at: number;
}

const upsertNominationStmt = db.prepare(`
    INSERT INTO election_nomination (round_id, user_id, statement, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(round_id, user_id) DO UPDATE SET statement = excluded.statement
`);
const listNominationsStmt = db.prepare(`
    SELECT round_id, user_id, statement, created_at FROM election_nomination
    WHERE round_id = ? ORDER BY created_at ASC
`);
const getNominationStmt = db.prepare(`
    SELECT round_id, user_id, statement, created_at FROM election_nomination
    WHERE round_id = ? AND user_id = ?
`);
const countNominationsStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM election_nomination WHERE round_id = ?
`);

/** 新增/更新一条自荐（改自荐宣言时保留原时间）。 */
export function upsertNomination(roundId: number, userId: string, statement: string): void {
    upsertNominationStmt.run(roundId, userId, statement, Date.now());
}

/** 列出一场募选的所有自荐。 */
export function listNominations(roundId: number): Nomination[] {
    return (listNominationsStmt.all(roundId) as NominationRow[]).map(r => ({
        userId: r.user_id,
        statement: r.statement,
        createdAt: r.created_at,
    }));
}

/** 读取某人的自荐（判断是否已自荐）。 */
export function getNomination(roundId: number, userId: string): Nomination | null {
    const r = getNominationStmt.get(roundId, userId) as NominationRow | undefined;
    return r ? { userId: r.user_id, statement: r.statement, createdAt: r.created_at } : null;
}

/** 统计自荐人数。 */
export function countNominations(roundId: number): number {
    return (countNominationsStmt.get(roundId) as { c: number }).c;
}

// ============================ 投票（vote） ============================

export type VoteKind = 'public' | 'admin';

const deleteVoterStmt = db.prepare(`
    DELETE FROM election_vote WHERE round_id = ? AND kind = ? AND voter_id = ?
`);
const insertVoteStmt = db.prepare(`
    INSERT OR IGNORE INTO election_vote (round_id, kind, voter_id, candidate_id, created_at)
    VALUES (?, ?, ?, ?, ?)
`);
const getVoterSelStmt = db.prepare(`
    SELECT candidate_id FROM election_vote WHERE round_id = ? AND kind = ? AND voter_id = ?
`);
const tallyStmt = db.prepare(`
    SELECT candidate_id, COUNT(*) AS c FROM election_vote
    WHERE round_id = ? AND kind = ? GROUP BY candidate_id
`);
const totalVotesStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM election_vote WHERE round_id = ? AND kind = ?
`);
const distinctVotersStmt = db.prepare(`
    SELECT COUNT(DISTINCT voter_id) AS c FROM election_vote WHERE round_id = ? AND kind = ?
`);

/**
 * 记录/更新某人某类投票（一人一票）：先删该人本类所有选择，再插入新选择。
 * candidateIds 为空表示弃票/清空。
 */
export function replaceVotes(roundId: number, kind: VoteKind, voterId: string, candidateIds: string[]): void {
    const now = Date.now();
    const run = db.transaction(() => {
        deleteVoterStmt.run(roundId, kind, voterId);
        for (const cid of candidateIds) {
            insertVoteStmt.run(roundId, kind, voterId, cid, now);
        }
    });
    run();
}

/** 读取某人某类当前已选的候选人（用于回显）。 */
export function getVoterSelections(roundId: number, kind: VoteKind, voterId: string): string[] {
    return (getVoterSelStmt.all(roundId, kind, voterId) as { candidate_id: string }[]).map(r => r.candidate_id);
}

export interface Tally {
    /** 每个候选人的得票数（被多少票选中） */
    counts: Map<string, number>;
    /** 总投票数（所有选择次数之和，作为得票率分母） */
    totalVotes: number;
    /** 参与投票的人数（去重） */
    voters: number;
}

const votersByCandStmt = db.prepare(`
    SELECT candidate_id, voter_id FROM election_vote
    WHERE round_id = ? AND kind = ? ORDER BY created_at ASC, voter_id ASC
`);

/** 取某场某类下，每个候选人的投票者 id 列表（按投票时间先后）。用于实名公示。 */
export function getVotersByCandidate(roundId: number, kind: VoteKind): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const row of votersByCandStmt.all(roundId, kind) as { candidate_id: string; voter_id: string }[]) {
        const arr = map.get(row.candidate_id) ?? [];
        arr.push(row.voter_id);
        map.set(row.candidate_id, arr);
    }
    return map;
}

/** 统计某场某类的票。 */
export function tallyVotes(roundId: number, kind: VoteKind): Tally {
    const counts = new Map<string, number>();
    for (const row of tallyStmt.all(roundId, kind) as { candidate_id: string; c: number }[]) {
        counts.set(row.candidate_id, row.c);
    }
    const totalVotes = (totalVotesStmt.get(roundId, kind) as { c: number }).c;
    const voters = (distinctVotersStmt.get(roundId, kind) as { c: number }).c;
    return { counts, totalVotes, voters };
}

// ============================ 管理投票 thread ============================

const upsertAdminThreadStmt = db.prepare(`
    INSERT INTO election_admin_thread (round_id, channel_id, thread_id, message_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(round_id, channel_id) DO UPDATE SET
        thread_id = excluded.thread_id, message_id = excluded.message_id
`);
const listAdminThreadsStmt = db.prepare(`
    SELECT round_id, channel_id, thread_id, message_id FROM election_admin_thread WHERE round_id = ?
`);

export interface AdminThread {
    channelId: string;
    threadId: string;
    messageId: string | null;
}

/** 记录一条管理投票 thread。 */
export function saveAdminThread(roundId: number, channelId: string, threadId: string, messageId: string | null): void {
    upsertAdminThreadStmt.run(roundId, channelId, threadId, messageId);
}

/** 列出某场的管理投票 thread。 */
export function listAdminThreads(roundId: number): AdminThread[] {
    return (listAdminThreadsStmt.all(roundId) as { round_id: number; channel_id: string; thread_id: string; message_id: string | null }[])
        .map(r => ({ channelId: r.channel_id, threadId: r.thread_id, messageId: r.message_id }));
}

// ============================ 跨服务器扫描（调度器用） ============================

const listRoundsAllStmt = db.prepare(`
    SELECT * FROM election_round WHERE status IN (SELECT value FROM json_each(?))
    ORDER BY created_at ASC
`);

/** 列出所有服务器中处于给定状态的募选（供调度器扫描到点场次）。 */
export function listRoundsAll(statuses: RoundStatus[]): ElectionRound[] {
    return (listRoundsAllStmt.all(JSON.stringify(statuses)) as RoundRow[]).map(rowToRound);
}

// ============================ 测试辅助（仅测试模式用） ============================

/** 往候选池追加成员（不做全量对账，不清除现有）。 */
export function addToPool(guildId: string, entries: ParsedPoolEntry[]): void {
    const now = Date.now();
    const run = db.transaction(() => {
        for (const e of entries) {
            upsertPoolStmt.run(guildId, e.userId, e.displayName ?? null, e.passedAt ?? null, now);
        }
    });
    run();
}

/** 清空某服务器的候选池，返回删除行数。 */
export function clearPool(guildId: string): number {
    return db.prepare(`DELETE FROM election_pool WHERE guild_id = ?`).run(guildId).changes;
}

/** 清空某场募选的所有投票，返回删除行数。 */
export function clearRoundVotes(roundId: number): number {
    return db.prepare(`DELETE FROM election_vote WHERE round_id = ?`).run(roundId).changes;
}

/** 清空某场募选的所有自荐，返回删除行数。 */
export function clearRoundNominations(roundId: number): number {
    return db.prepare(`DELETE FROM election_nomination WHERE round_id = ?`).run(roundId).changes;
}
