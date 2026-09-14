import path from 'path';
import Database from 'better-sqlite3';

import { DATA_DIR } from '../../../core/utils/database';
import { appendRuntimeFileRecord } from '../../../core/utils/runtimeFileLog';
import type {
    CleanupJob,
    CleanupJobStatus,
    CleanupScanMode,
    CleanupSettings,
    CreateCleanupJobInput,
    GuildMessageIndex,
    GuildMessageIndexStatus,
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
        entire_guild             INTEGER NOT NULL DEFAULT 0,
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

    -- 完整核验按频道独立保存游标，允许多个频道并行且可在重启后准确续跑。
    CREATE TABLE IF NOT EXISTS mc_job_scan_channel (
        job_id       INTEGER NOT NULL,
        channel_id   TEXT NOT NULL,
        position     INTEGER NOT NULL,
        cursor_id    TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        failure_count INTEGER NOT NULL DEFAULT 0,
        scanned_page_count INTEGER NOT NULL DEFAULT 0,
        scanned_message_count INTEGER NOT NULL DEFAULT 0,
        last_scanned_at INTEGER,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (job_id, channel_id)
    );

    CREATE INDEX IF NOT EXISTS idx_mc_job_scan_channel_status
        ON mc_job_scan_channel(job_id, status, position);

    -- 服务器级消息元数据索引：不保存内容，只保存后续按作者定位消息所需字段。
    CREATE TABLE IF NOT EXISTS mc_guild_message_index (
        guild_id              TEXT PRIMARY KEY,
        status                TEXT NOT NULL DEFAULT 'queued',
        priority_channel_ids  TEXT NOT NULL DEFAULT '[]',
        scope_channel_ids     TEXT NOT NULL DEFAULT '[]',
        scope_count           INTEGER NOT NULL DEFAULT 0,
        completed_count       INTEGER NOT NULL DEFAULT 0,
        indexed_message_count INTEGER NOT NULL DEFAULT 0,
        cutoff_at             INTEGER NOT NULL,
        warning_text          TEXT,
        error                 TEXT,
        created_by            TEXT NOT NULL,
        created_at            INTEGER NOT NULL,
        started_at            INTEGER,
        finished_at           INTEGER,
        updated_at            INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mc_guild_index_channel (
        guild_id      TEXT NOT NULL,
        channel_id    TEXT NOT NULL,
        position      INTEGER NOT NULL,
        priority_group INTEGER NOT NULL DEFAULT 1,
        cursor_id     TEXT,
        status        TEXT NOT NULL DEFAULT 'pending',
        failure_count INTEGER NOT NULL DEFAULT 0,
        scanned_page_count INTEGER NOT NULL DEFAULT 0,
        scanned_message_count INTEGER NOT NULL DEFAULT 0,
        last_scanned_at INTEGER,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (guild_id, channel_id)
    );

    CREATE INDEX IF NOT EXISTS idx_mc_guild_index_channel_status
        ON mc_guild_index_channel(guild_id, status, updated_at, position);

    CREATE TABLE IF NOT EXISTS mc_message_cache (
        guild_id    TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        message_id  TEXT NOT NULL,
        author_id   TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        indexed_at  INTEGER NOT NULL,
        PRIMARY KEY (guild_id, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_mc_message_cache_author
        ON mc_message_cache(guild_id, author_id, created_at);

    -- covered_until 表示该频道所有早于此时刻的历史均已写入索引，可按频道增量补扫。
    CREATE TABLE IF NOT EXISTS mc_index_coverage (
        guild_id      TEXT NOT NULL,
        channel_id    TEXT NOT NULL,
        covered_until INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (guild_id, channel_id)
    );

    CREATE TABLE IF NOT EXISTS mc_index_opened_thread (
        guild_id    TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        opened_at   INTEGER NOT NULL,
        PRIMARY KEY (guild_id, channel_id)
    );

    -- 供本地通用控制台显示服务器、主频道与子区路径，不保存任何消息内容。
    CREATE TABLE IF NOT EXISTS mc_guild_snapshot (
        guild_id    TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mc_channel_snapshot (
        guild_id    TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        parent_id   TEXT,
        name        TEXT NOT NULL,
        channel_type INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (guild_id, channel_id)
    );

    CREATE INDEX IF NOT EXISTS idx_mc_channel_snapshot_guild_name
        ON mc_channel_snapshot(guild_id, name);

    -- 面板清空请求只在执行器安全退出前短暂存在，完成后整行移除。
    CREATE TABLE IF NOT EXISTS mc_list_clear (
        guild_id        TEXT PRIMARY KEY,
        requested_by    TEXT NOT NULL,
        requested_at    INTEGER NOT NULL
    );
`);

function ensureColumn(table: string, column: string, definition: string): void {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some(item => item.name === column)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// 兼容已经存在的任务数据库，启动时原地补齐生产者/消费者所需状态。
ensureColumn('mc_job', 'scan_completed_at', 'INTEGER');
ensureColumn('mc_job', 'entire_guild', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('mc_job_message', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('mc_job_message', 'next_attempt_at', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('mc_job_message', 'last_error', 'TEXT');
ensureColumn('mc_job_scan_channel', 'failure_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('mc_job_scan_channel', 'scanned_page_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('mc_job_scan_channel', 'scanned_message_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('mc_job_scan_channel', 'last_scanned_at', 'INTEGER');
ensureColumn('mc_guild_message_index', 'priority_channel_ids', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('mc_guild_index_channel', 'priority_group', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('mc_guild_index_channel', 'scanned_page_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('mc_guild_index_channel', 'scanned_message_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('mc_guild_index_channel', 'last_scanned_at', 'INTEGER');
db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mc_job_message_pending
        ON mc_job_message(job_id, outcome, next_attempt_at, channel_id);

    -- 兼容上一版已经完整建好的索引，把其频道完成状态迁移为可复用的覆盖水位。
    INSERT INTO mc_index_coverage (guild_id, channel_id, covered_until, updated_at)
    SELECT c.guild_id, c.channel_id, i.cutoff_at, i.updated_at
    FROM mc_guild_index_channel c
    JOIN mc_guild_message_index i ON i.guild_id = c.guild_id
    WHERE c.status = 'completed' AND i.status = 'completed'
    ON CONFLICT(guild_id, channel_id) DO UPDATE SET
        covered_until = MAX(mc_index_coverage.covered_until, excluded.covered_until),
        updated_at = MAX(mc_index_coverage.updated_at, excluded.updated_at);
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
    entire_guild: number;
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

interface GuildIndexRow {
    guild_id: string;
    status: GuildMessageIndexStatus;
    priority_channel_ids: string;
    scope_channel_ids: string;
    scope_count: number;
    completed_count: number;
    indexed_message_count: number;
    cutoff_at: number;
    warning_text: string | null;
    error: string | null;
    created_by: string;
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
        entireGuild: Boolean(row.entire_guild),
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

function mapGuildIndex(row: GuildIndexRow): GuildMessageIndex {
    return {
        guildId: row.guild_id,
        status: row.status,
        priorityChannelIds: parseIds(row.priority_channel_ids),
        scopeChannelIds: parseIds(row.scope_channel_ids),
        scopeCount: row.scope_count,
        completedCount: row.completed_count,
        indexedMessageCount: row.indexed_message_count,
        cutoffAt: row.cutoff_at,
        warningText: row.warning_text,
        error: row.error,
        createdBy: row.created_by,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        updatedAt: row.updated_at,
    };
}

export interface GuildSnapshot {
    guildId: string;
    name: string;
    updatedAt: number;
}

export interface ChannelSnapshotInput {
    channelId: string;
    parentId: string | null;
    name: string;
    channelType: number;
}

export interface ChannelSnapshot extends ChannelSnapshotInput {
    guildId: string;
    parentName: string | null;
    updatedAt: number;
}

export function saveGuildSnapshot(
    guildId: string,
    guildName: string,
    channels: ChannelSnapshotInput[],
): void {
    const now = Date.now();
    const upsertChannel = db.prepare(`
        INSERT INTO mc_channel_snapshot (
            guild_id, channel_id, parent_id, name, channel_type, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, channel_id) DO UPDATE SET
            parent_id = excluded.parent_id,
            name = excluded.name,
            channel_type = excluded.channel_type,
            updated_at = excluded.updated_at
    `);
    db.transaction(() => {
        db.prepare(`
            INSERT INTO mc_guild_snapshot (guild_id, name, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(guild_id) DO UPDATE SET
                name = excluded.name, updated_at = excluded.updated_at
        `).run(guildId, guildName, now);
        for (const channel of channels) {
            upsertChannel.run(
                guildId,
                channel.channelId,
                channel.parentId,
                channel.name.slice(0, 200),
                channel.channelType,
                now,
            );
        }
    })();
}

export function listGuildSnapshots(): GuildSnapshot[] {
    const rows = db.prepare(`
        SELECT guild_id, name, updated_at FROM mc_guild_snapshot ORDER BY name, guild_id
    `).all() as { guild_id: string; name: string; updated_at: number }[];
    return rows.map(row => ({ guildId: row.guild_id, name: row.name, updatedAt: row.updated_at }));
}

export function listChannelSnapshots(guildId: string): ChannelSnapshot[] {
    const rows = db.prepare(`
        SELECT c.guild_id, c.channel_id, c.parent_id, c.name, c.channel_type, c.updated_at,
               p.name AS parent_name
        FROM mc_channel_snapshot c
        LEFT JOIN mc_channel_snapshot p
          ON p.guild_id = c.guild_id AND p.channel_id = c.parent_id
        WHERE c.guild_id = ?
        ORDER BY COALESCE(p.name, ''), c.name, c.channel_id
    `).all(guildId) as {
        guild_id: string;
        channel_id: string;
        parent_id: string | null;
        name: string;
        channel_type: number;
        updated_at: number;
        parent_name: string | null;
    }[];
    return rows.map(row => ({
        guildId: row.guild_id,
        channelId: row.channel_id,
        parentId: row.parent_id,
        parentName: row.parent_name,
        name: row.name,
        channelType: row.channel_type,
        updatedAt: row.updated_at,
    }));
}

export interface ChannelScanProgress {
    channelId: string;
    status: string;
    scannedPageCount: number;
    scannedMessageCount: number;
    lastScannedAt: number | null;
}

export interface ScanProgressSummary {
    scannedPageCount: number;
    scannedMessageCount: number;
    activeChannels: ChannelScanProgress[];
}

function scanProgressSummary(
    table: 'mc_job_scan_channel' | 'mc_guild_index_channel',
    keyColumn: 'job_id' | 'guild_id',
    key: number | string,
): ScanProgressSummary {
    const total = db.prepare(`
        SELECT
            COALESCE(SUM(scanned_page_count), 0) AS pages,
            COALESCE(SUM(scanned_message_count), 0) AS messages
        FROM ${table} WHERE ${keyColumn} = ?
    `).get(key) as { pages: number; messages: number };
    const active = db.prepare(`
        SELECT channel_id, status, scanned_page_count, scanned_message_count, last_scanned_at
        FROM ${table}
        WHERE ${keyColumn} = ? AND status = 'running'
        ORDER BY updated_at ASC
        LIMIT 16
    `).all(key) as {
        channel_id: string;
        status: string;
        scanned_page_count: number;
        scanned_message_count: number;
        last_scanned_at: number | null;
    }[];
    return {
        scannedPageCount: total.pages,
        scannedMessageCount: total.messages,
        activeChannels: active.map(row => ({
            channelId: row.channel_id,
            status: row.status,
            scannedPageCount: row.scanned_page_count,
            scannedMessageCount: row.scanned_message_count,
            lastScannedAt: row.last_scanned_at,
        })),
    };
}

export function getJobScanProgress(jobId: number): ScanProgressSummary {
    return scanProgressSummary('mc_job_scan_channel', 'job_id', jobId);
}

export function getGuildIndexScanProgress(guildId: string): ScanProgressSummary {
    return scanProgressSummary('mc_guild_index_channel', 'guild_id', guildId);
}

function taskLogDetails(job: CleanupJob): Record<string, unknown> {
    return {
        task_id: job.id,
        guild_id: job.guildId,
        actor_id: job.actorId,
        target_user_id: job.targetUserId,
        selected_channel_ids: job.selectedChannelIds,
        entire_guild: job.entireGuild,
        excluded_channel_ids: job.excludedChannelIds,
        include_threads: job.includeThreads,
        cutoff_at: job.cutoffAt,
        cutoff_label: job.cutoffLabel,
        status: job.status,
        scan_mode: job.scanMode,
        scan_completed_at: job.scanCompletedAt,
        scope_channel_ids: job.scopeChannelIds,
        found_count: job.foundCount,
        pending_count: job.pendingCount,
        deleted_count: job.deletedCount,
        skipped_count: job.skippedCount,
        failed_count: job.failedCount,
        warning: job.warningText,
        error: job.error,
        created_at: job.createdAt,
        started_at: job.startedAt,
        finished_at: job.finishedAt,
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

export interface CreateCleanupJobResult {
    job: CleanupJob | null;
    created: boolean;
    clearing: boolean;
}

const createJobTransaction = db.transaction((input: CreateCleanupJobInput): CreateCleanupJobResult => {
    if (isJobListClearing(input.guildId)) return { job: null, created: false, clearing: true };
    const active = findActiveJob(input.guildId);
    if (active) return { job: active, created: false, clearing: false };

    const now = Date.now();
    const result = db.prepare(`
        INSERT INTO mc_job (
            guild_id, actor_id, target_user_id, selected_channel_ids,
            entire_guild, excluded_channel_ids, include_threads, cutoff_at, cutoff_label,
            status, scan_mode, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'search', ?, ?)
    `).run(
        input.guildId,
        input.actorId,
        input.targetUserId,
        JSON.stringify([...new Set(input.selectedChannelIds)]),
        input.entireGuild ? 1 : 0,
        JSON.stringify([...new Set(input.excludedChannelIds)]),
        input.includeThreads ? 1 : 0,
        input.cutoffAt,
        input.cutoffLabel,
        now,
        now,
    );
    return { job: getJob(Number(result.lastInsertRowid))!, created: true, clearing: false };
});

export function createJob(input: CreateCleanupJobInput): CreateCleanupJobResult {
    const result = createJobTransaction(input);
    if (result.created && result.job) {
        appendRuntimeFileRecord('maintenance.task_created', taskLogDetails(result.job));
        ensureGuildMessageIndexForCleanup(
            input.guildId,
            input.actorId,
            input.entireGuild ? [] : input.selectedChannelIds,
        );
    }
    return result;
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
    const now = Date.now();
    return db.transaction(() => {
        db.prepare(`
            UPDATE mc_job_scan_channel SET status = 'pending', updated_at = ?
            WHERE status = 'running'
        `).run(now);
        return db.prepare(`
            UPDATE mc_job SET status = 'queued', updated_at = ? WHERE status = 'running'
        `).run(now).changes;
    })();
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

export interface CleanupScanChannel {
    channelId: string;
    cursorId: string | null;
    failureCount: number;
}

/**
 * 新任务直接建立逐频道扫描账；旧任务首次升级时把原来的单游标进度迁入账中。
 */
export function ensureJobScanChannels(job: CleanupJob, acceptIndexedBase = false): void {
    const existing = db.prepare('SELECT COUNT(*) AS count FROM mc_job_scan_channel WHERE job_id = ?')
        .get(job.id) as { count: number };
    if (existing.count > 0) return;

    const insert = db.prepare(`
        INSERT OR IGNORE INTO mc_job_scan_channel (
            job_id, channel_id, position, cursor_id, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    const coverage = indexedCoverageMap(job.guildId);
    db.transaction(() => {
        job.scopeChannelIds.forEach((channelId, position) => {
            const coveredUntil = coverage.get(channelId) ?? 0;
            const completed = coveredUntil >= job.cutoffAt
                || (acceptIndexedBase && coveredUntil > 0)
                || position < job.cursorBatch;
            const cursorId = position === job.cursorBatch ? job.cursorId : null;
            insert.run(job.id, channelId, position, cursorId, completed ? 'completed' : 'pending', now);
        });
        db.prepare(`
            UPDATE mc_job SET
                cursor_batch = (
                    SELECT COUNT(*) FROM mc_job_scan_channel
                    WHERE job_id = ? AND status = 'completed'
                ),
                cursor_id = NULL,
                updated_at = ?
            WHERE id = ?
        `).run(job.id, now, job.id);
    })();
}

const claimScanChannelTransaction = db.transaction((jobId: number): CleanupScanChannel | null => {
    const row = db.prepare(`
        SELECT channel_id, cursor_id, failure_count
        FROM mc_job_scan_channel
        WHERE job_id = ? AND status = 'pending'
        ORDER BY updated_at ASC, position ASC
        LIMIT 1
    `).get(jobId) as { channel_id: string; cursor_id: string | null; failure_count: number } | undefined;
    if (!row) return null;
    const changed = db.prepare(`
        UPDATE mc_job_scan_channel SET status = 'running', updated_at = ?
        WHERE job_id = ? AND channel_id = ? AND status = 'pending'
    `).run(Date.now(), jobId, row.channel_id).changes;
    return changed > 0
        ? { channelId: row.channel_id, cursorId: row.cursor_id, failureCount: row.failure_count }
        : null;
});

export function claimScanChannel(jobId: number): CleanupScanChannel | null {
    return claimScanChannelTransaction(jobId);
}

export function updateScanChannelCursor(
    jobId: number,
    channelId: string,
    cursorId: string,
    scannedMessages: number,
): void {
    const now = Date.now();
    db.prepare(`
        UPDATE mc_job_scan_channel SET
            cursor_id = ?, failure_count = 0,
            scanned_page_count = scanned_page_count + 1,
            scanned_message_count = scanned_message_count + ?,
            last_scanned_at = ?, updated_at = ?
        WHERE job_id = ? AND channel_id = ? AND status = 'running'
    `).run(cursorId, scannedMessages, now, now, jobId, channelId);
}

export function releaseScanChannel(jobId: number, channelId: string, failed = false): void {
    db.prepare(`
        UPDATE mc_job_scan_channel SET
            status = 'pending',
            failure_count = failure_count + ?,
            updated_at = ?
        WHERE job_id = ? AND channel_id = ? AND status = 'running'
    `).run(failed ? 1 : 0, Date.now(), jobId, channelId);
}

export function completeScanChannel(jobId: number, channelId: string): void {
    const now = Date.now();
    db.transaction(() => {
        db.prepare(`
            UPDATE mc_job_scan_channel
            SET status = 'completed', cursor_id = NULL, updated_at = ?
            WHERE job_id = ? AND channel_id = ? AND status = 'running'
        `).run(now, jobId, channelId);
        db.prepare(`
            UPDATE mc_job SET
                cursor_batch = (
                    SELECT COUNT(*) FROM mc_job_scan_channel
                    WHERE job_id = ? AND status = 'completed'
                ),
                cursor_id = NULL,
                updated_at = ?
            WHERE id = ?
        `).run(jobId, now, jobId);
    })();
}

export interface IndexedMessageRef {
    channelId: string;
    messageId: string;
    authorId: string;
    createdAt: number;
}

export interface GuildIndexChannel {
    channelId: string;
    cursorId: string | null;
    failureCount: number;
}

export function getGuildMessageIndex(guildId: string): GuildMessageIndex | null {
    const row = db.prepare('SELECT * FROM mc_guild_message_index WHERE guild_id = ?')
        .get(guildId) as GuildIndexRow | undefined;
    return row ? mapGuildIndex(row) : null;
}

export function getGuildIndexPriorityProgress(guildId: string): { completed: number; total: number } {
    const row = db.prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
        FROM mc_guild_index_channel
        WHERE guild_id = ? AND priority_group = 0
    `).get(guildId) as { total: number; completed: number | null };
    return { completed: row.completed ?? 0, total: row.total };
}

export function updateGuildIndexPriorities(
    guildId: string,
    selectedChannelIds: string[],
    resolvedPriorityChannelIds: string[],
): void {
    const selected = [...new Set(selectedChannelIds)];
    const resolved = new Set(resolvedPriorityChannelIds);
    const now = Date.now();
    db.transaction(() => {
        db.prepare(`
            UPDATE mc_guild_message_index SET priority_channel_ids = ?, updated_at = ?
            WHERE guild_id = ?
        `).run(JSON.stringify(selected), now, guildId);
        db.prepare(`
            UPDATE mc_guild_index_channel SET priority_group = 1 WHERE guild_id = ?
        `).run(guildId);
        const prioritize = db.prepare(`
            UPDATE mc_guild_index_channel SET priority_group = 0, updated_at = ?
            WHERE guild_id = ? AND channel_id = ?
        `);
        for (const channelId of resolved) prioritize.run(now, guildId, channelId);
    })();
}

export interface RequestGuildIndexResult {
    index: GuildMessageIndex;
    created: boolean;
}

export function requestGuildMessageIndex(
    guildId: string,
    actorId: string,
    priorityChannelIds: string[] = [],
): RequestGuildIndexResult {
    const existing = getGuildMessageIndex(guildId);
    if (existing && ['queued', 'running', 'paused'].includes(existing.status)) {
        return { index: existing, created: false };
    }

    const now = Date.now();
    const priority = [...new Set(priorityChannelIds)];
    db.transaction(() => {
        db.prepare('DELETE FROM mc_guild_index_channel WHERE guild_id = ?').run(guildId);
        db.prepare(`
            INSERT INTO mc_guild_message_index (
                guild_id, status, priority_channel_ids, scope_channel_ids, scope_count, completed_count,
                indexed_message_count, cutoff_at, warning_text, error,
                created_by, created_at, started_at, finished_at, updated_at
            ) VALUES (
                ?, 'queued', ?, '[]', 0, 0,
                (SELECT COUNT(*) FROM mc_message_cache WHERE guild_id = ?),
                ?, NULL, NULL, ?, ?, NULL, NULL, ?
            )
            ON CONFLICT(guild_id) DO UPDATE SET
                status = 'queued', priority_channel_ids = excluded.priority_channel_ids,
                scope_channel_ids = '[]', scope_count = 0,
                completed_count = 0, indexed_message_count = excluded.indexed_message_count,
                cutoff_at = excluded.cutoff_at, warning_text = NULL, error = NULL,
                created_by = excluded.created_by, created_at = excluded.created_at,
                started_at = NULL, finished_at = NULL, updated_at = excluded.updated_at
        `).run(guildId, JSON.stringify(priority), guildId, now, actorId, now, now);
    })();
    const index = getGuildMessageIndex(guildId)!;
    appendRuntimeFileRecord('maintenance.guild_index_requested', {
        guild_id: guildId,
        action_by: actorId,
        cutoff_at: now,
        priority_channel_ids: priority,
    });
    return { index, created: true };
}

/** 第一次冲水时自动建立可续跑的索引任务；已有索引时绝不覆盖用户的暂停/取消决定。 */
export function ensureGuildMessageIndexForCleanup(
    guildId: string,
    actorId: string,
    priorityChannelIds: string[] = [],
): GuildMessageIndex {
    const existing = getGuildMessageIndex(guildId);
    if (existing) return existing;

    const now = Date.now();
    const priority = [...new Set(priorityChannelIds)];
    db.prepare(`
        INSERT OR IGNORE INTO mc_guild_message_index (
            guild_id, status, priority_channel_ids, scope_channel_ids,
            scope_count, completed_count, indexed_message_count, cutoff_at,
            warning_text, error, created_by, created_at, started_at, finished_at, updated_at
        ) VALUES (?, 'queued', ?, '[]', 0, 0, 0, ?, NULL, NULL, ?, ?, NULL, NULL, ?)
    `).run(guildId, JSON.stringify(priority), now, actorId, now, now);
    const index = getGuildMessageIndex(guildId)!;
    appendRuntimeFileRecord('maintenance.guild_index_auto_created', {
        guild_id: guildId,
        action_by: actorId,
        cleanup_priority_channel_ids: priority,
        cutoff_at: now,
    });
    return index;
}

export function listRunnableGuildIndexes(): GuildMessageIndex[] {
    const rows = db.prepare(`
        SELECT * FROM mc_guild_message_index WHERE status = 'queued' ORDER BY created_at ASC
    `).all() as GuildIndexRow[];
    return rows.map(mapGuildIndex);
}

export function claimGuildMessageIndex(guildId: string): GuildMessageIndex | null {
    const now = Date.now();
    const changed = db.prepare(`
        UPDATE mc_guild_message_index SET
            status = 'running', started_at = COALESCE(started_at, ?), error = NULL, updated_at = ?
        WHERE guild_id = ? AND status = 'queued'
    `).run(now, now, guildId).changes;
    return changed > 0 ? getGuildMessageIndex(guildId) : null;
}

export function recoverInterruptedGuildIndexes(): number {
    const now = Date.now();
    return db.transaction(() => {
        db.prepare(`
            UPDATE mc_guild_index_channel SET status = 'pending', updated_at = ? WHERE status = 'running'
        `).run(now);
        return db.prepare(`
            UPDATE mc_guild_message_index SET status = 'queued', updated_at = ? WHERE status = 'running'
        `).run(now).changes;
    })();
}

export function getIndexedCoverage(guildId: string, channelId: string): number | null {
    const row = db.prepare(`
        SELECT covered_until FROM mc_index_coverage WHERE guild_id = ? AND channel_id = ?
    `).get(guildId, channelId) as { covered_until: number } | undefined;
    return row?.covered_until ?? null;
}

function indexedCoverageMap(guildId: string): Map<string, number> {
    const rows = db.prepare(`
        SELECT channel_id, covered_until FROM mc_index_coverage WHERE guild_id = ?
    `).all(guildId) as { channel_id: string; covered_until: number }[];
    return new Map(rows.map(row => [row.channel_id, row.covered_until]));
}

export function markIndexedCoverage(guildId: string, channelId: string, coveredUntil: number): void {
    const now = Date.now();
    db.prepare(`
        INSERT INTO mc_index_coverage (guild_id, channel_id, covered_until, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, channel_id) DO UPDATE SET
            covered_until = MAX(mc_index_coverage.covered_until, excluded.covered_until),
            updated_at = excluded.updated_at
    `).run(guildId, channelId, coveredUntil, now);
}

export function areChannelsIndexedThrough(
    guildId: string,
    channelIds: string[],
    cutoffAt: number,
): boolean {
    if (channelIds.length === 0) return false;
    const coverage = indexedCoverageMap(guildId);
    return channelIds.every(channelId => (coverage.get(channelId) ?? 0) >= cutoffAt);
}

export function doChannelsHaveIndexedBase(guildId: string, channelIds: string[]): boolean {
    if (channelIds.length === 0) return false;
    const coverage = indexedCoverageMap(guildId);
    return channelIds.every(channelId => (coverage.get(channelId) ?? 0) > 0);
}

export function setGuildIndexScope(
    guildId: string,
    channelIds: string[],
    priorityChannelIds: string[],
    warnings: string[],
): void {
    const normalized = [...new Set(channelIds)];
    const priority = new Set(priorityChannelIds);
    const index = getGuildMessageIndex(guildId);
    if (!index) return;
    const coverage = indexedCoverageMap(guildId);
    const now = Date.now();
    const insert = db.prepare(`
        INSERT INTO mc_guild_index_channel (
            guild_id, channel_id, position, priority_group, cursor_id, status, failure_count, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, 0, ?)
    `);
    db.transaction(() => {
        db.prepare('DELETE FROM mc_guild_index_channel WHERE guild_id = ?').run(guildId);
        let completedCount = 0;
        normalized.forEach((channelId, position) => {
            const completed = (coverage.get(channelId) ?? 0) >= index.cutoffAt;
            if (completed) completedCount += 1;
            insert.run(
                guildId,
                channelId,
                position,
                priority.has(channelId) ? 0 : 1,
                completed ? 'completed' : 'pending',
                now,
            );
        });
        db.prepare(`
            UPDATE mc_guild_message_index SET
                scope_channel_ids = ?, scope_count = ?, completed_count = ?,
                warning_text = ?, updated_at = ?
            WHERE guild_id = ?
        `).run(
            JSON.stringify(normalized),
            normalized.length,
            completedCount,
            warnings.length ? warnings.join('\n').slice(0, 4000) : null,
            now,
            guildId,
        );
    })();
}

const claimGuildIndexChannelTransaction = db.transaction((guildId: string): GuildIndexChannel | null => {
    const row = db.prepare(`
        SELECT channel_id, cursor_id, failure_count
        FROM mc_guild_index_channel
        WHERE guild_id = ? AND status = 'pending'
        ORDER BY priority_group ASC, updated_at ASC, position ASC
        LIMIT 1
    `).get(guildId) as { channel_id: string; cursor_id: string | null; failure_count: number } | undefined;
    if (!row) return null;
    const changed = db.prepare(`
        UPDATE mc_guild_index_channel SET status = 'running', updated_at = ?
        WHERE guild_id = ? AND channel_id = ? AND status = 'pending'
    `).run(Date.now(), guildId, row.channel_id).changes;
    return changed > 0
        ? { channelId: row.channel_id, cursorId: row.cursor_id, failureCount: row.failure_count }
        : null;
});

export function claimGuildIndexChannel(guildId: string): GuildIndexChannel | null {
    return claimGuildIndexChannelTransaction(guildId);
}

export function updateGuildIndexChannelCursor(
    guildId: string,
    channelId: string,
    cursorId: string,
    scannedMessages: number,
): void {
    const now = Date.now();
    db.prepare(`
        UPDATE mc_guild_index_channel SET
            cursor_id = ?, failure_count = 0,
            scanned_page_count = scanned_page_count + 1,
            scanned_message_count = scanned_message_count + ?,
            last_scanned_at = ?, updated_at = ?
        WHERE guild_id = ? AND channel_id = ? AND status = 'running'
    `).run(cursorId, scannedMessages, now, now, guildId, channelId);
}

export function releaseGuildIndexChannel(guildId: string, channelId: string, failed = false): void {
    db.prepare(`
        UPDATE mc_guild_index_channel SET
            status = 'pending', failure_count = failure_count + ?, updated_at = ?
        WHERE guild_id = ? AND channel_id = ? AND status = 'running'
    `).run(failed ? 1 : 0, Date.now(), guildId, channelId);
}

export function completeGuildIndexChannel(guildId: string, channelId: string): void {
    const index = getGuildMessageIndex(guildId);
    const now = Date.now();
    db.transaction(() => {
        db.prepare(`
            UPDATE mc_guild_index_channel SET status = 'completed', cursor_id = NULL, updated_at = ?
            WHERE guild_id = ? AND channel_id = ? AND status = 'running'
        `).run(now, guildId, channelId);
        db.prepare(`
            UPDATE mc_guild_message_index SET
                completed_count = (
                    SELECT COUNT(*) FROM mc_guild_index_channel
                    WHERE guild_id = ? AND status = 'completed'
                ),
                updated_at = ?
            WHERE guild_id = ?
        `).run(guildId, now, guildId);
        if (index) markIndexedCoverage(guildId, channelId, index.cutoffAt);
    })();
}

export function failGuildIndexChannel(guildId: string, channelId: string): void {
    const now = Date.now();
    db.transaction(() => {
        db.prepare(`
            UPDATE mc_guild_index_channel SET status = 'failed', updated_at = ?
            WHERE guild_id = ? AND channel_id = ? AND status = 'running'
        `).run(now, guildId, channelId);
        db.prepare(`
            UPDATE mc_guild_message_index SET
                completed_count = (
                    SELECT COUNT(*) FROM mc_guild_index_channel
                    WHERE guild_id = ? AND status IN ('completed', 'failed')
                ),
                updated_at = ?
            WHERE guild_id = ?
        `).run(guildId, now, guildId);
    })();
}

export function hasGuildIndexChannelFailures(guildId: string): boolean {
    return Boolean(db.prepare(`
        SELECT 1 FROM mc_guild_index_channel
        WHERE guild_id = ? AND status = 'failed' LIMIT 1
    `).get(guildId));
}

export function recordIndexedMessages(guildId: string, messages: IndexedMessageRef[]): number {
    if (messages.length === 0) return 0;
    const insert = db.prepare(`
        INSERT OR IGNORE INTO mc_message_cache (
            guild_id, channel_id, message_id, author_id, created_at, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    let added = 0;
    db.transaction(() => {
        for (const message of messages) {
            added += insert.run(
                guildId,
                message.channelId,
                message.messageId,
                message.authorId,
                message.createdAt,
                now,
            ).changes;
        }
        if (added > 0) {
            db.prepare(`
                UPDATE mc_guild_message_index
                SET indexed_message_count = indexed_message_count + ?, updated_at = ?
                WHERE guild_id = ?
            `).run(added, now, guildId);
        }
    })();
    return added;
}

export function recordLiveIndexedMessage(message: IndexedMessageRef & { guildId: string }): void {
    const index = getGuildMessageIndex(message.guildId);
    if (!index || !['queued', 'running', 'paused', 'completed'].includes(index.status)) return;
    recordIndexedMessages(message.guildId, [message]);
}

export function removeIndexedMessages(messageIds: string[]): void {
    if (messageIds.length === 0) return;
    const find = db.prepare('SELECT guild_id FROM mc_message_cache WHERE message_id = ?');
    const remove = db.prepare('DELETE FROM mc_message_cache WHERE message_id = ?');
    db.transaction(() => {
        const removedByGuild = new Map<string, number>();
        for (const messageId of messageIds) {
            const row = find.get(messageId) as { guild_id: string } | undefined;
            if (!row || remove.run(messageId).changes === 0) continue;
            removedByGuild.set(row.guild_id, (removedByGuild.get(row.guild_id) ?? 0) + 1);
        }
        const now = Date.now();
        const decrement = db.prepare(`
            UPDATE mc_guild_message_index
            SET indexed_message_count = MAX(0, indexed_message_count - ?), updated_at = ?
            WHERE guild_id = ?
        `);
        for (const [guildId, count] of removedByGuild) decrement.run(count, now, guildId);
    })();
}

export function listIndexedCandidates(
    guildId: string,
    targetUserId: string,
    allowedChannelIds: string[],
    cutoffAt: number,
): { channelId: string; messageId: string }[] {
    const allowed = new Set(allowedChannelIds);
    const rows = db.prepare(`
        SELECT channel_id, message_id
        FROM mc_message_cache
        WHERE guild_id = ? AND author_id = ? AND created_at < ?
        ORDER BY created_at DESC
    `).all(guildId, targetUserId, cutoffAt) as { channel_id: string; message_id: string }[];
    return rows
        .filter(row => allowed.has(row.channel_id))
        .map(row => ({ channelId: row.channel_id, messageId: row.message_id }));
}

export function appendGuildIndexWarning(guildId: string, warning: string): void {
    const index = getGuildMessageIndex(guildId);
    const lines = new Set((index?.warningText ?? '').split('\n').filter(Boolean));
    lines.add(warning);
    db.prepare(`
        UPDATE mc_guild_message_index SET warning_text = ?, updated_at = ? WHERE guild_id = ?
    `).run([...lines].join('\n').slice(0, 4000), Date.now(), guildId);
}

export function setGuildMessageIndexStatus(
    guildId: string,
    status: GuildMessageIndexStatus,
    error: string | null = null,
): void {
    const terminal = ['cancelled', 'completed', 'failed'].includes(status);
    const now = Date.now();
    db.prepare(`
        UPDATE mc_guild_message_index SET
            status = ?, error = ?,
            finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
            updated_at = ?
        WHERE guild_id = ?
    `).run(status, error, terminal ? 1 : 0, now, now, guildId);
    if (terminal) {
        const index = getGuildMessageIndex(guildId);
        if (index) appendRuntimeFileRecord(`maintenance.guild_index_${status}`, { ...index });
    }
}

export function pauseGuildMessageIndex(guildId: string): boolean {
    return db.prepare(`
        UPDATE mc_guild_message_index SET status = 'paused', updated_at = ?
        WHERE guild_id = ? AND status IN ('queued', 'running')
    `).run(Date.now(), guildId).changes > 0;
}

/** 紧急清理到来时让正在运行的索引安全退回队列，清理结束后调度器会自动续跑。 */
export function yieldGuildMessageIndex(guildId: string): boolean {
    return db.prepare(`
        UPDATE mc_guild_message_index SET status = 'queued', updated_at = ?
        WHERE guild_id = ? AND status = 'running'
    `).run(Date.now(), guildId).changes > 0;
}

export function resumeGuildMessageIndex(guildId: string): boolean {
    return db.prepare(`
        UPDATE mc_guild_message_index SET status = 'queued', updated_at = ?
        WHERE guild_id = ? AND status = 'paused'
    `).run(Date.now(), guildId).changes > 0;
}

export function cancelGuildMessageIndex(guildId: string): boolean {
    const now = Date.now();
    return db.prepare(`
        UPDATE mc_guild_message_index SET status = 'cancelled', finished_at = ?, updated_at = ?
        WHERE guild_id = ? AND status IN ('queued', 'running', 'paused')
    `).run(now, now, guildId).changes > 0;
}

export function markIndexThreadOpened(guildId: string, channelId: string): void {
    db.prepare(`
        INSERT INTO mc_index_opened_thread (guild_id, channel_id, opened_at)
        VALUES (?, ?, ?) ON CONFLICT(guild_id, channel_id) DO NOTHING
    `).run(guildId, channelId, Date.now());
}

export function unmarkIndexThreadOpened(guildId: string, channelId: string): void {
    db.prepare('DELETE FROM mc_index_opened_thread WHERE guild_id = ? AND channel_id = ?')
        .run(guildId, channelId);
}

export function isIndexThreadMarkedOpened(guildId: string, channelId: string): boolean {
    return Boolean(db.prepare(`
        SELECT 1 FROM mc_index_opened_thread WHERE guild_id = ? AND channel_id = ?
    `).get(guildId, channelId));
}

export function listRestorableIndexThreads(): { guildId: string; channelId: string }[] {
    const rows = db.prepare(`
        SELECT t.guild_id, t.channel_id
        FROM mc_index_opened_thread t
        LEFT JOIN mc_guild_message_index i ON i.guild_id = t.guild_id
        WHERE i.status IS NULL OR i.status <> 'running'
        ORDER BY t.opened_at ASC
    `).all() as { guild_id: string; channel_id: string }[];
    return rows.map(row => ({ guildId: row.guild_id, channelId: row.channel_id }));
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
    const changed = db.prepare(`
        UPDATE mc_job SET scan_completed_at = COALESCE(scan_completed_at, ?), updated_at = ?
        WHERE id = ? AND scan_completed_at IS NULL
    `).run(now, now, jobId).changes > 0;
    const job = changed ? getJob(jobId) : null;
    if (job) appendRuntimeFileRecord('maintenance.scan_completed', taskLogDetails(job));
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
    removeIndexedMessages(
        results
            .filter(result => result.outcome === 'deleted' || result.outcome === 'skipped')
            .map(result => result.messageId),
    );
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

export interface JobListClearRequest {
    guildId: string;
    requestedBy: string;
    requestedAt: number;
}

export interface RequestJobListClearResult {
    accepted: boolean;
    jobCount: number;
}

export function isJobListClearing(guildId: string): boolean {
    return Boolean(db.prepare('SELECT 1 FROM mc_list_clear WHERE guild_id = ?').get(guildId));
}

export function requestJobListClear(guildId: string, actorId: string): RequestJobListClearResult {
    const rows = db.prepare('SELECT * FROM mc_job WHERE guild_id = ? ORDER BY created_at ASC')
        .all(guildId) as JobRow[];
    const jobs = rows.map(mapJob);
    if (jobs.length === 0) return { accepted: true, jobCount: 0 };
    if (isJobListClearing(guildId)) return { accepted: true, jobCount: jobs.length };

    // 在改变任务状态前先落一份完整快照；写盘失败时保留数据库记录，不静默丢失留档。
    const recorded = appendRuntimeFileRecord('maintenance.list_clear_requested', {
        guild_id: guildId,
        action_by: actorId,
        tasks: jobs.map(taskLogDetails),
    });
    if (!recorded) return { accepted: false, jobCount: jobs.length };

    const now = Date.now();
    db.transaction(() => {
        db.prepare(`
            INSERT INTO mc_list_clear (guild_id, requested_by, requested_at)
            VALUES (?, ?, ?)
            ON CONFLICT(guild_id) DO NOTHING
        `).run(guildId, actorId, now);
        db.prepare(`
            UPDATE mc_job SET status = 'cancelled', finished_at = ?, updated_at = ?
            WHERE guild_id = ? AND status IN ('queued', 'running', 'paused')
        `).run(now, now, guildId);
    })();
    return { accepted: true, jobCount: jobs.length };
}

export function listJobListClearRequests(): JobListClearRequest[] {
    const rows = db.prepare(`
        SELECT guild_id, requested_by, requested_at FROM mc_list_clear ORDER BY requested_at ASC
    `).all() as { guild_id: string; requested_by: string; requested_at: number }[];
    return rows.map(row => ({
        guildId: row.guild_id,
        requestedBy: row.requested_by,
        requestedAt: row.requested_at,
    }));
}

export function hasOpenedThreadsForGuild(guildId: string): boolean {
    return Boolean(db.prepare(`
        SELECT 1
        FROM mc_opened_thread t
        JOIN mc_job j ON j.id = t.job_id
        WHERE j.guild_id = ?
        LIMIT 1
    `).get(guildId));
}

export function completeJobListClear(request: JobListClearRequest, allowUnrestoredThreads = false): boolean {
    const openedRows = db.prepare(`
        SELECT t.channel_id
        FROM mc_opened_thread t
        JOIN mc_job j ON j.id = t.job_id
        WHERE j.guild_id = ?
        ORDER BY t.opened_at ASC
    `).all(request.guildId) as { channel_id: string }[];
    if (openedRows.length > 0 && !allowUnrestoredThreads) return false;
    const rows = db.prepare('SELECT * FROM mc_job WHERE guild_id = ? ORDER BY created_at ASC')
        .all(request.guildId) as JobRow[];
    const jobs = rows.map(mapJob);
    const recorded = appendRuntimeFileRecord('maintenance.list_cleared', {
        guild_id: request.guildId,
        action_by: request.requestedBy,
        requested_at: request.requestedAt,
        unrestored_thread_ids: openedRows.map(row => row.channel_id),
        tasks: jobs.map(taskLogDetails),
    });
    // 请求建立时已经写过完整快照；强制收尾阶段不能因第二份完成记录写入失败而永久锁住任务系统。
    if (!recorded && !allowUnrestoredThreads) return false;

    db.transaction(() => {
        db.prepare(`
            DELETE FROM mc_job_message
            WHERE job_id IN (SELECT id FROM mc_job WHERE guild_id = ?)
        `).run(request.guildId);
        db.prepare(`
            DELETE FROM mc_job_scan_channel
            WHERE job_id IN (SELECT id FROM mc_job WHERE guild_id = ?)
        `).run(request.guildId);
        db.prepare(`
            DELETE FROM mc_opened_thread
            WHERE job_id IN (SELECT id FROM mc_job WHERE guild_id = ?)
        `).run(request.guildId);
        db.prepare('DELETE FROM mc_job WHERE guild_id = ?').run(request.guildId);
        db.prepare('DELETE FROM mc_list_clear WHERE guild_id = ?').run(request.guildId);
        const remaining = db.prepare('SELECT COUNT(*) AS count FROM mc_job').get() as { count: number };
        if (remaining.count === 0) db.prepare("DELETE FROM sqlite_sequence WHERE name = 'mc_job'").run();
    })();
    return true;
}

export function setJobStatus(jobId: number, status: CleanupJobStatus, error: string | null = null): void {
    const before = getJob(jobId);
    const terminal = status === 'completed' || status === 'cancelled' || status === 'failed';
    const changed = db.prepare(`
        UPDATE mc_job SET
            status = ?, error = ?,
            finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
            updated_at = ?
        WHERE id = ?
    `).run(status, error, terminal ? 1 : 0, Date.now(), Date.now(), jobId).changes > 0;
    if (changed && before?.status !== status) {
        const job = getJob(jobId);
        if (job) appendRuntimeFileRecord(`maintenance.task_${status}`, taskLogDetails(job));
    }
}

export function pauseJob(jobId: number, actorId?: string): boolean {
    const changed = db.prepare(`
        UPDATE mc_job SET status = 'paused', updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
    `).run(Date.now(), jobId).changes > 0;
    const job = changed ? getJob(jobId) : null;
    if (job) appendRuntimeFileRecord('maintenance.task_paused', { ...taskLogDetails(job), action_by: actorId ?? null });
    return changed;
}

export function resumeJob(jobId: number, actorId?: string): boolean {
    const changed = db.prepare(`
        UPDATE mc_job SET status = 'queued', updated_at = ?
        WHERE id = ? AND status = 'paused'
    `).run(Date.now(), jobId).changes > 0;
    const job = changed ? getJob(jobId) : null;
    if (job) appendRuntimeFileRecord('maintenance.task_resumed', { ...taskLogDetails(job), action_by: actorId ?? null });
    return changed;
}

export function cancelJob(jobId: number, actorId?: string): boolean {
    const changed = db.prepare(`
        UPDATE mc_job SET status = 'cancelled', finished_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running', 'paused')
    `).run(Date.now(), Date.now(), jobId).changes > 0;
    const job = changed ? getJob(jobId) : null;
    if (job) appendRuntimeFileRecord('maintenance.task_cancelled', { ...taskLogDetails(job), action_by: actorId ?? null });
    return changed;
}
