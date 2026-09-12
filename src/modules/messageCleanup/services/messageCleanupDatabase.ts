import path from 'path';
import Database from 'better-sqlite3';

import { DATA_DIR } from '../../../core/utils/database';
import type {
    CleanupJob,
    CleanupJobStatus,
    CleanupScanMode,
    CleanupSettings,
    CreateCleanupJobInput,
} from './types';

const DB_FILE = path.join(DATA_DIR, 'messageCleanup.sqlite');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
    CREATE TABLE IF NOT EXISTS mc_settings (
        guild_id        TEXT PRIMARY KEY,
        manage_role_ids TEXT NOT NULL DEFAULT '[]',
        updated_by      TEXT,
        updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mc_job (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id                 TEXT NOT NULL,
        actor_id                 TEXT NOT NULL,
        target_user_id           TEXT NOT NULL,
        selected_channel_ids     TEXT NOT NULL,
        excluded_channel_ids     TEXT NOT NULL DEFAULT '[]',
        include_threads          INTEGER NOT NULL DEFAULT 1,
        cutoff_at                INTEGER NOT NULL,
        cutoff_label             TEXT NOT NULL,
        status                   TEXT NOT NULL DEFAULT 'queued',
        scan_mode                TEXT NOT NULL DEFAULT 'search',
        scan_completed_at        INTEGER,
        scope_channel_ids        TEXT NOT NULL DEFAULT '[]',
        scope_count              INTEGER NOT NULL DEFAULT 0,
        cursor_batch             INTEGER NOT NULL DEFAULT 0,
        cursor_id                TEXT,
        found_count              INTEGER NOT NULL DEFAULT 0,
        deleted_count            INTEGER NOT NULL DEFAULT 0,
        skipped_count            INTEGER NOT NULL DEFAULT 0,
        failed_count             INTEGER NOT NULL DEFAULT 0,
        warning_text             TEXT,
        error                    TEXT,
        created_at               INTEGER NOT NULL,
        started_at               INTEGER,
        finished_at              INTEGER,
        updated_at               INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mc_job_guild_created
        ON mc_job(guild_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_mc_job_status
        ON mc_job(status, created_at);

    -- 记录由任务临时解归档、但尚未确认恢复的子区。进程异常退出后也能补关。
    CREATE TABLE IF NOT EXISTS mc_opened_thread (
        job_id       INTEGER NOT NULL,
        channel_id   TEXT NOT NULL,
        opened_at    INTEGER NOT NULL,
        PRIMARY KEY (job_id, channel_id)
    );

    -- 两阶段扫描（快速搜索 + 完整历史核验）共用这本去重账，保证“找到”是唯一消息数。
    CREATE TABLE IF NOT EXISTS mc_job_message (
        job_id       INTEGER NOT NULL,
        channel_id   TEXT NOT NULL,
        message_id   TEXT NOT NULL,
        outcome      TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error   TEXT,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (job_id, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_mc_job_message_outcome
        ON mc_job_message(job_id, outcome);
`);

function ensureColumn(table: string, column: string, definition: string): void {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some(item => item.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// 兼容已经存在的任务数据库，启动时原地补齐生产者/消费者所需状态。
ensureColumn('mc_job', 'scan_completed_at', 'INTEGER');
ensureColumn('mc_job_message', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('mc_job_message', 'next_attempt_at', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('mc_job_message', 'last_error', 'TEXT');
db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mc_job_message_pending
        ON mc_job_message(job_id, outcome, next_attempt_at, channel_id);
`);

interface SettingsRow {
    guild_id: string;
    manage_role_ids: string;
    updated_by: string | null;
    updated_at: number;
}

interface JobRow {
    id: number;
    guild_id: string;
    actor_id: string;
    target_user_id: string;
    selected_channel_ids: string;
    excluded_channel_ids: string;
    include_threads: number;
    cutoff_at: number;
    cutoff_label: string;
    status: CleanupJobStatus;
    scan_mode: CleanupScanMode;
    scan_completed_at: number | null;
    scope_channel_ids: string;
    scope_count: number;
    cursor_batch: number;
    cursor_id: string | null;
    found_count: number;
    deleted_count: number;
    skipped_count: number;
    failed_count: number;
    warning_text: string | null;
    error: string | null;
    created_at: number;
    started_at: number | null;
    finished_at: number | null;
    updated_at: number;
}

function parseIds(raw: string | null | undefined): string[] {
    try {
        const value = JSON.parse(raw || '[]');
        if (!Array.isArray(value)) return [];
        return [...new Set(value.map(String).filter(id => /^\d{17,20}$/.test(id)))];
    } catch {
        return [];
    }
}

function mapSettings(row: SettingsRow | undefined, guildId: string): CleanupSettings {
    return {
        guildId,
        manageRoleIds: parseIds(row?.manage_role_ids),
        updatedBy: row?.updated_by ?? null,
        updatedAt: row?.updated_at ?? 0,
    };
}

function mapJob(row: JobRow): CleanupJob {
    return {
        id: row.id,
        guildId: row.guild_id,
        actorId: row.actor_id,
        targetUserId: row.target_user_id,
        selectedChannelIds: parseIds(row.selected_channel_ids),
        excludedChannelIds: parseIds(row.excluded_channel_ids),
        includeThreads: Boolean(row.include_threads),
        cutoffAt: row.cutoff_at,
        cutoffLabel: row.cutoff_label,
        status: row.status,
        scanMode: row.scan_mode,
        scanCompletedAt: row.scan_completed_at,
        scopeChannelIds: parseIds(row.scope_channel_ids),
        scopeCount: row.scope_count,
        cursorBatch: row.cursor_batch,
        cursorId: row.cursor_id,
        foundCount: row.found_count,
        pendingCount: Math.max(0, row.found_count - row.deleted_count - row.skipped_count - row.failed_count),
        deletedCount: row.deleted_count,
        skippedCount: row.skipped_count,
        failedCount: row.failed_count,
        warningText: row.warning_text,
        error: row.error,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        updatedAt: row.updated_at,
    };
}

export function getSettings(guildId: string): CleanupSettings {
    const row = db.prepare('SELECT * FROM mc_settings WHERE guild_id = ?').get(guildId) as SettingsRow | undefined;
    return mapSettings(row, guildId);
}

export function setManageRoleIds(guildId: string, roleIds: string[], actorId: string): CleanupSettings {
    const now = Date.now();
    const normalized = [...new Set(roleIds.filter(id => /^\d{17,20}$/.test(id)))];
    db.prepare(`
        INSERT INTO mc_settings (guild_id, manage_role_ids, updated_by, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            manage_role_ids = excluded.manage_role_ids,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at
    `).run(guildId, JSON.stringify(normalized), actorId, now);
    return getSettings(guildId);
}

const getJobStmt = db.prepare('SELECT * FROM mc_job WHERE id = ?');

export function getJob(jobId: number): CleanupJob | null {
    const row = getJobStmt.get(jobId) as JobRow | undefined;
    return row ? mapJob(row) : null;
}

export function findActiveJob(guildId: string): CleanupJob | null {
    const row = db.prepare(`
        SELECT * FROM mc_job
        WHERE guild_id = ? AND status IN ('queued', 'running', 'paused')
        ORDER BY created_at ASC LIMIT 1
    `).get(guildId) as JobRow | undefined;
    return row ? mapJob(row) : null;
}

export function listJobs(guildId: string, limit = 10): CleanupJob[] {
    const safeLimit = Math.max(1, Math.min(25, Math.floor(limit)));
    const rows = db.prepare(`
        SELECT * FROM mc_job WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(guildId, safeLimit) as JobRow[];
    return rows.map(mapJob);
}

const createJobTransaction = db.transaction((input: CreateCleanupJobInput): { job: CleanupJob; created: boolean } => {
    const active = findActiveJob(input.guildId);
    if (active) return { job: active, created: false };

    const now = Date.now();
    const result = db.prepare(`
        INSERT INTO mc_job (
            guild_id, actor_id, target_user_id, selected_channel_ids,
            excluded_channel_ids, include_threads, cutoff_at, cutoff_label,
            status, scan_mode, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'search', ?, ?)
    `).run(
        input.guildId,
        input.actorId,
        input.targetUserId,
        JSON.stringify([...new Set(input.selectedChannelIds)]),
        JSON.stringify([...new Set(input.excludedChannelIds)]),
        input.includeThreads ? 1 : 0,
        input.cutoffAt,
        input.cutoffLabel,
        now,
        now,
    );
    return { job: getJob(Number(result.lastInsertRowid))!, created: true };
});

export function createJob(input: CreateCleanupJobInput): { job: CleanupJob; created: boolean } {
    return createJobTransaction(input);
}

export function claimJob(jobId: number): CleanupJob | null {
    const now = Date.now();
    const result = db.prepare(`
        UPDATE mc_job SET
            status = 'running',
            started_at = COALESCE(started_at, ?),
            error = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'queued'
    `).run(now, now, jobId);
    return result.changes > 0 ? getJob(jobId) : null;
}

export function listRunnableJobs(): CleanupJob[] {
    const rows = db.prepare(`
        SELECT * FROM mc_job WHERE status = 'queued' ORDER BY created_at ASC
    `).all() as JobRow[];
    return rows.map(mapJob);
}

export function recoverInterruptedJobs(): number {
    return db.prepare(`
        UPDATE mc_job SET status = 'queued', updated_at = ? WHERE status = 'running'
    `).run(Date.now()).changes;
}

export function setResolvedScope(jobId: number, channelIds: string[], warnings: string[]): void {
    db.prepare(`
        UPDATE mc_job SET
            scope_channel_ids = ?, scope_count = ?, warning_text = ?, updated_at = ?
        WHERE id = ?
    `).run(
        JSON.stringify([...new Set(channelIds)]),
        new Set(channelIds).size,
        warnings.length ? warnings.join('\n').slice(0, 4000) : null,
        Date.now(),
        jobId,
    );
}

export function setScanMode(jobId: number, mode: CleanupScanMode, resetCursor = false): void {
    db.prepare(`
        UPDATE mc_job SET
            scan_mode = ?,
            cursor_batch = CASE WHEN ? THEN 0 ELSE cursor_batch END,
            cursor_id = CASE WHEN ? THEN NULL ELSE cursor_id END,
            updated_at = ?
        WHERE id = ?
    `).run(mode, resetCursor ? 1 : 0, resetCursor ? 1 : 0, Date.now(), jobId);
}

export function updateCursor(jobId: number, batch: number, cursorId: string | null): void {
    db.prepare(`
        UPDATE mc_job SET cursor_batch = ?, cursor_id = ?, updated_at = ? WHERE id = ?
    `).run(batch, cursorId, Date.now(), jobId);
}

export function markScanCompleted(jobId: number): void {
    const now = Date.now();
    db.prepare(`
        UPDATE mc_job SET scan_completed_at = COALESCE(scan_completed_at, ?), updated_at = ?
        WHERE id = ?
    `).run(now, now, jobId);
}

export type CleanupMessageOutcome = 'pending' | 'deleted' | 'skipped' | 'failed';

export interface CleanupMessageRef {
    channelId: string;
    messageId: string;
}

export interface PendingCleanupMessage extends CleanupMessageRef {
    attemptCount: number;
}

export interface CleanupMessageResult extends CleanupMessageRef {
    outcome: CleanupMessageOutcome;
    retryAt?: number;
    error?: string | null;
}

const refreshMessageCountsStmt = db.prepare(`
    UPDATE mc_job SET
        found_count = (SELECT COUNT(*) FROM mc_job_message WHERE job_id = ?),
        deleted_count = (SELECT COUNT(*) FROM mc_job_message WHERE job_id = ? AND outcome = 'deleted'),
        skipped_count = (SELECT COUNT(*) FROM mc_job_message WHERE job_id = ? AND outcome = 'skipped'),
        failed_count = (SELECT COUNT(*) FROM mc_job_message WHERE job_id = ? AND outcome = 'failed'),
        updated_at = ?
    WHERE id = ?
`);

function refreshMessageCounts(jobId: number): void {
    refreshMessageCountsStmt.run(jobId, jobId, jobId, jobId, Date.now(), jobId);
}

const recordCandidatesTransaction = db.transaction((jobId: number, messages: CleanupMessageRef[]): void => {
    const stmt = db.prepare(`
        INSERT INTO mc_job_message (job_id, channel_id, message_id, outcome, updated_at)
        VALUES (?, ?, ?, 'pending', ?)
        ON CONFLICT(job_id, message_id) DO NOTHING
    `);
    const now = Date.now();
    for (const message of messages) stmt.run(jobId, message.channelId, message.messageId, now);
    refreshMessageCounts(jobId);
});

/** 在发起删除前登记候选，快速搜索和完整核验重复命中同一 ID 时只计算一次。 */
export function recordMessageCandidates(jobId: number, messages: CleanupMessageRef[]): void {
    if (messages.length === 0) return;
    recordCandidatesTransaction(jobId, messages);
}

const recordResultsTransaction = db.transaction((jobId: number, results: CleanupMessageResult[]): void => {
    const stmt = db.prepare(`
        UPDATE mc_job_message SET
            channel_id = ?, outcome = ?, attempt_count = attempt_count + 1,
            next_attempt_at = ?, last_error = ?, updated_at = ?
        WHERE job_id = ? AND message_id = ?
    `);
    const now = Date.now();
    for (const result of results) {
        stmt.run(
            result.channelId,
            result.outcome,
            result.outcome === 'pending' ? Math.max(result.retryAt ?? now + 1_000, now) : 0,
            result.error?.slice(0, 1000) ?? null,
            now,
            jobId,
            result.messageId,
        );
    }
    refreshMessageCounts(jobId);
});

export function recordMessageResults(jobId: number, results: CleanupMessageResult[]): void {
    if (results.length === 0) return;
    recordResultsTransaction(jobId, results);
}

interface PendingMessageRow {
    channel_id: string;
    message_id: string;
    attempt_count: number;
}

/** 每次只取一个频道，便于使用 Discord 的批量删除接口并控制归档帖状态。 */
export function listPendingMessages(jobId: number, limit = 100): PendingCleanupMessage[] {
    const now = Date.now();
    const channel = db.prepare(`
        SELECT channel_id
        FROM mc_job_message
        WHERE job_id = ? AND outcome = 'pending' AND next_attempt_at <= ?
        ORDER BY updated_at ASC
        LIMIT 1
    `).get(jobId, now) as { channel_id: string } | undefined;
    if (!channel) return [];

    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = db.prepare(`
        SELECT channel_id, message_id, attempt_count
        FROM mc_job_message
        WHERE job_id = ? AND channel_id = ? AND outcome = 'pending' AND next_attempt_at <= ?
        ORDER BY message_id DESC
        LIMIT ?
    `).all(jobId, channel.channel_id, now, safeLimit) as PendingMessageRow[];
    return rows.map(row => ({
        channelId: row.channel_id,
        messageId: row.message_id,
        attemptCount: row.attempt_count,
    }));
}

export interface DeletionQueueState {
    pendingCount: number;
    nextAttemptAt: number | null;
}

export function getDeletionQueueState(jobId: number): DeletionQueueState {
    const row = db.prepare(`
        SELECT COUNT(*) AS pending_count, MIN(next_attempt_at) AS next_attempt_at
        FROM mc_job_message
        WHERE job_id = ? AND outcome = 'pending'
    `).get(jobId) as { pending_count: number; next_attempt_at: number | null };
    return {
        pendingCount: row.pending_count,
        nextAttemptAt: row.next_attempt_at,
    };
}

export function appendWarning(jobId: number, warning: string): void {
    const job = getJob(jobId);
    const lines = new Set((job?.warningText ?? '').split('\n').filter(Boolean));
    lines.add(warning);
    const combined = [...lines].join('\n').slice(0, 4000);
    db.prepare('UPDATE mc_job SET warning_text = ?, updated_at = ? WHERE id = ?')
        .run(combined || null, Date.now(), jobId);
}

export interface OpenedThreadRecord {
    jobId: number;
    guildId: string;
    channelId: string;
}

export function markThreadOpened(jobId: number, channelId: string): void {
    db.prepare(`
        INSERT INTO mc_opened_thread (job_id, channel_id, opened_at)
        VALUES (?, ?, ?)
        ON CONFLICT(job_id, channel_id) DO NOTHING
    `).run(jobId, channelId, Date.now());
}

export function unmarkThreadOpened(jobId: number, channelId: string): void {
    db.prepare('DELETE FROM mc_opened_thread WHERE job_id = ? AND channel_id = ?')
        .run(jobId, channelId);
}

export function isThreadMarkedOpened(jobId: number, channelId: string): boolean {
    return Boolean(db.prepare(`
        SELECT 1 FROM mc_opened_thread WHERE job_id = ? AND channel_id = ?
    `).get(jobId, channelId));
}

/** 仅返回当前没有执行器工作的任务，避免后台恢复与正在删除的任务抢状态。 */
export function listRestorableOpenedThreads(): OpenedThreadRecord[] {
    const rows = db.prepare(`
        SELECT t.job_id, j.guild_id, t.channel_id
        FROM mc_opened_thread t
        JOIN mc_job j ON j.id = t.job_id
        WHERE j.status <> 'running'
        ORDER BY t.opened_at ASC
    `).all() as { job_id: number; guild_id: string; channel_id: string }[];
    return rows.map(row => ({ jobId: row.job_id, guildId: row.guild_id, channelId: row.channel_id }));
}

export function setJobStatus(jobId: number, status: CleanupJobStatus, error: string | null = null): void {
    const terminal = status === 'completed' || status === 'cancelled' || status === 'failed';
    db.prepare(`
        UPDATE mc_job SET
            status = ?, error = ?,
            finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
            updated_at = ?
        WHERE id = ?
    `).run(status, error, terminal ? 1 : 0, Date.now(), Date.now(), jobId);
}

export function pauseJob(jobId: number): boolean {
    return db.prepare(`
        UPDATE mc_job SET status = 'paused', updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
    `).run(Date.now(), jobId).changes > 0;
}

export function resumeJob(jobId: number): boolean {
    return db.prepare(`
        UPDATE mc_job SET status = 'queued', updated_at = ?
        WHERE id = ? AND status = 'paused'
    `).run(Date.now(), jobId).changes > 0;
}

export function cancelJob(jobId: number): boolean {
    return db.prepare(`
        UPDATE mc_job SET status = 'cancelled', finished_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running', 'paused')
    `).run(Date.now(), Date.now(), jobId).changes > 0;
}
