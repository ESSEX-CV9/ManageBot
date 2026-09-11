// 分管身份组轮替模块的数据层。所有流程状态都持久化，机器人重启后可继续处理。

import path from 'path';
import Database from 'better-sqlite3';
import { DATA_DIR } from '../../../core/utils/database';

export type RotationChannelKind = 'notification' | 'recruitment';
export type RotationRoundStatus = 'inquiry' | 'recruiting' | 'closed' | 'cancelled' | 'failed';
export type RotationResponse = 'keep' | 'leave';
export type RotationMessagePhase = 'inquiry' | 'recruitment';

export interface RoleRotationConfig {
    id: number;
    guildId: string;
    managedRoleId: string;
    capacity: number;
    scheduleDay: number;
    scheduleTime: string;
    timezone: string;
    inquiryHours: number;
    minTenureDays: number;
    enabled: boolean;
    nextRunAt: number;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
    notificationChannelIds: string[];
    recruitmentChannelIds: string[];
    conflictRoleIds: string[];
}

export interface RotationRound {
    id: number;
    configId: number;
    guildId: string;
    roleId: string;
    cycleKey: string;
    status: RotationRoundStatus;
    openedAt: number;
    inquiryDeadline: number;
    recruitmentOpenedAt: number | null;
    closedAt: number | null;
    vacanciesAtOpen: number | null;
    createdBy: string | null;
    error: string | null;
}

export interface RotationParticipant {
    roundId: number;
    userId: string;
    response: RotationResponse | null;
    respondedAt: number | null;
    roleRemovedAt: number | null;
    removeError: string | null;
}

export interface RotationMessage {
    roundId: number;
    phase: RotationMessagePhase;
    /** 实际承载消息的频道/帖子 ID。论坛目标会是新建帖子的 ID。 */
    channelId: string;
    /** 管理员配置的原始目标 ID（普通频道/帖子时与 channelId 相同）。 */
    destinationId: string;
    messageId: string;
}

export interface RotationAudit {
    id: number;
    guildId: string;
    configId: number | null;
    roundId: number | null;
    actorId: string | null;
    userId: string | null;
    event: string;
    detail: string | null;
    createdAt: number;
}

interface ConfigRow {
    id: number;
    guild_id: string;
    managed_role_id: string;
    capacity: number;
    schedule_day: number;
    schedule_time: string;
    timezone: string;
    inquiry_hours: number;
    min_tenure_days: number;
    enabled: number;
    next_run_at: number;
    created_by: string;
    created_at: number;
    updated_at: number;
}

interface RoundRow {
    id: number;
    config_id: number;
    guild_id: string;
    role_id: string;
    cycle_key: string;
    status: RotationRoundStatus;
    opened_at: number;
    inquiry_deadline: number;
    recruitment_opened_at: number | null;
    closed_at: number | null;
    vacancies_at_open: number | null;
    created_by: string | null;
    error: string | null;
}

interface ParticipantRow {
    round_id: number;
    user_id: string;
    response: RotationResponse | null;
    responded_at: number | null;
    role_removed_at: number | null;
    remove_error: string | null;
}

const DB_FILE = path.join(DATA_DIR, 'roleRotation.sqlite');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
    CREATE TABLE IF NOT EXISTS rr_config (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id            TEXT NOT NULL,
        managed_role_id     TEXT NOT NULL,
        capacity            INTEGER NOT NULL,
        schedule_day        INTEGER NOT NULL DEFAULT 15,
        schedule_time       TEXT NOT NULL DEFAULT '09:00',
        timezone            TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        inquiry_hours       INTEGER NOT NULL DEFAULT 48,
        min_tenure_days     INTEGER NOT NULL DEFAULT 0,
        enabled             INTEGER NOT NULL DEFAULT 1,
        next_run_at         INTEGER NOT NULL,
        created_by          TEXT NOT NULL,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL,
        UNIQUE (guild_id, managed_role_id)
    );

    CREATE TABLE IF NOT EXISTS rr_channel (
        config_id   INTEGER NOT NULL REFERENCES rr_config(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK (kind IN ('notification', 'recruitment')),
        channel_id  TEXT NOT NULL,
        PRIMARY KEY (config_id, kind, channel_id)
    );

    CREATE TABLE IF NOT EXISTS rr_conflict_role (
        config_id       INTEGER NOT NULL REFERENCES rr_config(id) ON DELETE CASCADE,
        conflict_role_id TEXT NOT NULL,
        PRIMARY KEY (config_id, conflict_role_id)
    );

    CREATE TABLE IF NOT EXISTS rr_guild_settings (
        guild_id       TEXT PRIMARY KEY,
        frog_role_id   TEXT,
        updated_by     TEXT,
        updated_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rr_round (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        config_id               INTEGER NOT NULL REFERENCES rr_config(id) ON DELETE CASCADE,
        guild_id                TEXT NOT NULL,
        role_id                 TEXT NOT NULL,
        cycle_key               TEXT NOT NULL,
        status                  TEXT NOT NULL,
        opened_at               INTEGER NOT NULL,
        inquiry_deadline        INTEGER NOT NULL,
        recruitment_opened_at   INTEGER,
        closed_at               INTEGER,
        vacancies_at_open       INTEGER,
        created_by              TEXT,
        error                   TEXT,
        UNIQUE (config_id, cycle_key)
    );

    CREATE INDEX IF NOT EXISTS idx_rr_round_status
        ON rr_round(status, inquiry_deadline);

    CREATE TABLE IF NOT EXISTS rr_participant (
        round_id        INTEGER NOT NULL REFERENCES rr_round(id) ON DELETE CASCADE,
        user_id         TEXT NOT NULL,
        response        TEXT CHECK (response IN ('keep', 'leave')),
        responded_at    INTEGER,
        role_removed_at INTEGER,
        remove_error    TEXT,
        PRIMARY KEY (round_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS rr_message (
        round_id       INTEGER NOT NULL REFERENCES rr_round(id) ON DELETE CASCADE,
        phase          TEXT NOT NULL CHECK (phase IN ('inquiry', 'recruitment')),
        channel_id     TEXT NOT NULL,
        destination_id TEXT NOT NULL,
        message_id     TEXT NOT NULL,
        PRIMARY KEY (round_id, phase, channel_id)
    );

    CREATE TABLE IF NOT EXISTS rr_application (
        round_id    INTEGER NOT NULL REFERENCES rr_round(id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL,
        applied_at  INTEGER NOT NULL,
        PRIMARY KEY (round_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS rr_member (
        config_id   INTEGER NOT NULL REFERENCES rr_config(id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL,
        is_bot      INTEGER NOT NULL DEFAULT 0,
        active      INTEGER NOT NULL DEFAULT 1,
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL,
        removed_at  INTEGER,
        PRIMARY KEY (config_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS rr_audit (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id    TEXT NOT NULL,
        config_id   INTEGER,
        round_id    INTEGER,
        actor_id    TEXT,
        user_id     TEXT,
        event       TEXT NOT NULL,
        detail      TEXT,
        created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rr_audit_guild
        ON rr_audit(guild_id, created_at DESC);
`);

// 兼容已经由上一版模块创建的 rr_message：论坛目标需要同时记录“论坛 ID”和
// “实际新建的帖子 ID”，否则调度器会误以为尚未发布而重复建帖。
const messageColumns = db.pragma('table_info(rr_message)') as { name: string }[];
if (!messageColumns.some(column => column.name === 'destination_id')) {
    db.exec('ALTER TABLE rr_message ADD COLUMN destination_id TEXT');
}
db.exec(`
    UPDATE rr_message SET destination_id = channel_id WHERE destination_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rr_message_destination
        ON rr_message(round_id, phase, destination_id);
`);

function mapRound(row: RoundRow): RotationRound {
    return {
        id: row.id,
        configId: row.config_id,
        guildId: row.guild_id,
        roleId: row.role_id,
        cycleKey: row.cycle_key,
        status: row.status,
        openedAt: row.opened_at,
        inquiryDeadline: row.inquiry_deadline,
        recruitmentOpenedAt: row.recruitment_opened_at,
        closedAt: row.closed_at,
        vacanciesAtOpen: row.vacancies_at_open,
        createdBy: row.created_by,
        error: row.error,
    };
}

const channelListStmt = db.prepare('SELECT channel_id FROM rr_channel WHERE config_id = ? AND kind = ? ORDER BY channel_id');
const conflictListStmt = db.prepare('SELECT conflict_role_id FROM rr_conflict_role WHERE config_id = ? ORDER BY conflict_role_id');

function mapConfig(row: ConfigRow): RoleRotationConfig {
    const channels = (kind: RotationChannelKind) =>
        (channelListStmt.all(row.id, kind) as { channel_id: string }[]).map(item => item.channel_id);
    return {
        id: row.id,
        guildId: row.guild_id,
        managedRoleId: row.managed_role_id,
        capacity: row.capacity,
        scheduleDay: row.schedule_day,
        scheduleTime: row.schedule_time,
        timezone: row.timezone,
        inquiryHours: row.inquiry_hours,
        minTenureDays: row.min_tenure_days,
        enabled: Boolean(row.enabled),
        nextRunAt: row.next_run_at,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        notificationChannelIds: channels('notification'),
        recruitmentChannelIds: channels('recruitment'),
        conflictRoleIds: (conflictListStmt.all(row.id) as { conflict_role_id: string }[])
            .map(item => item.conflict_role_id),
    };
}

export function createConfig(input: {
    guildId: string;
    managedRoleId: string;
    capacity: number;
    nextRunAt: number;
    createdBy: string;
}): RoleRotationConfig {
    const now = Date.now();
    const result = db.prepare(`
        INSERT INTO rr_config
            (guild_id, managed_role_id, capacity, next_run_at, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.guildId, input.managedRoleId, input.capacity, input.nextRunAt, input.createdBy, now, now);
    return getConfigById(Number(result.lastInsertRowid))!;
}

export function getConfigById(id: number): RoleRotationConfig | null {
    const row = db.prepare('SELECT * FROM rr_config WHERE id = ?').get(id) as ConfigRow | undefined;
    return row ? mapConfig(row) : null;
}

export function getConfigByRole(guildId: string, roleId: string): RoleRotationConfig | null {
    const row = db.prepare('SELECT * FROM rr_config WHERE guild_id = ? AND managed_role_id = ?')
        .get(guildId, roleId) as ConfigRow | undefined;
    return row ? mapConfig(row) : null;
}

export function listConfigs(guildId?: string, enabledOnly = false): RoleRotationConfig[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (guildId) {
        clauses.push('guild_id = ?');
        args.push(guildId);
    }
    if (enabledOnly) clauses.push('enabled = 1');
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM rr_config${where} ORDER BY guild_id, id`).all(...args) as ConfigRow[];
    return rows.map(mapConfig);
}

export type ConfigUpdate = Partial<Pick<RoleRotationConfig,
    'capacity' | 'scheduleDay' | 'scheduleTime' | 'timezone' | 'inquiryHours' |
    'minTenureDays' | 'enabled' | 'nextRunAt'>>;

export function updateConfig(id: number, patch: ConfigUpdate): RoleRotationConfig | null {
    const columns: Record<keyof ConfigUpdate, string> = {
        capacity: 'capacity',
        scheduleDay: 'schedule_day',
        scheduleTime: 'schedule_time',
        timezone: 'timezone',
        inquiryHours: 'inquiry_hours',
        minTenureDays: 'min_tenure_days',
        enabled: 'enabled',
        nextRunAt: 'next_run_at',
    };
    const entries = Object.entries(patch) as [keyof ConfigUpdate, ConfigUpdate[keyof ConfigUpdate]][];
    if (!entries.length) return getConfigById(id);
    const values = entries.map(([, value]) => typeof value === 'boolean' ? Number(value) : value);
    const setters = entries.map(([key]) => `${columns[key]} = ?`);
    db.prepare(`UPDATE rr_config SET ${setters.join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...values, Date.now(), id);
    return getConfigById(id);
}

export function deleteConfig(id: number): boolean {
    return db.prepare('DELETE FROM rr_config WHERE id = ?').run(id).changes > 0;
}

export function addChannel(configId: number, kind: RotationChannelKind, channelId: string): boolean {
    return db.prepare('INSERT OR IGNORE INTO rr_channel (config_id, kind, channel_id) VALUES (?, ?, ?)')
        .run(configId, kind, channelId).changes > 0;
}

export function removeChannel(configId: number, kind: RotationChannelKind, channelId: string): boolean {
    return db.prepare('DELETE FROM rr_channel WHERE config_id = ? AND kind = ? AND channel_id = ?')
        .run(configId, kind, channelId).changes > 0;
}

export function addConflictRole(configId: number, roleId: string): boolean {
    return db.prepare('INSERT OR IGNORE INTO rr_conflict_role (config_id, conflict_role_id) VALUES (?, ?)')
        .run(configId, roleId).changes > 0;
}

export function removeConflictRole(configId: number, roleId: string): boolean {
    return db.prepare('DELETE FROM rr_conflict_role WHERE config_id = ? AND conflict_role_id = ?')
        .run(configId, roleId).changes > 0;
}

export function setFrogRole(guildId: string, roleId: string | null, updatedBy: string): void {
    db.prepare(`
        INSERT INTO rr_guild_settings (guild_id, frog_role_id, updated_by, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET
            frog_role_id = excluded.frog_role_id,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at
    `).run(guildId, roleId, updatedBy, Date.now());
}

export function getFrogRoleId(guildId: string): string | null {
    const row = db.prepare('SELECT frog_role_id FROM rr_guild_settings WHERE guild_id = ?')
        .get(guildId) as { frog_role_id: string | null } | undefined;
    return row?.frog_role_id ?? null;
}

export function createRound(input: {
    config: RoleRotationConfig;
    cycleKey: string;
    openedAt: number;
    inquiryDeadline: number;
    createdBy?: string | null;
    participantIds: string[];
}): RotationRound {
    const run = db.transaction(() => {
        const result = db.prepare(`
            INSERT INTO rr_round
                (config_id, guild_id, role_id, cycle_key, status, opened_at, inquiry_deadline, created_by)
            VALUES (?, ?, ?, ?, 'inquiry', ?, ?, ?)
        `).run(
            input.config.id,
            input.config.guildId,
            input.config.managedRoleId,
            input.cycleKey,
            input.openedAt,
            input.inquiryDeadline,
            input.createdBy ?? null,
        );
        const roundId = Number(result.lastInsertRowid);
        const participantStmt = db.prepare('INSERT INTO rr_participant (round_id, user_id) VALUES (?, ?)');
        for (const userId of [...new Set(input.participantIds)]) participantStmt.run(roundId, userId);
        return roundId;
    });
    return getRound(run())!;
}

export function getRound(id: number): RotationRound | null {
    const row = db.prepare('SELECT * FROM rr_round WHERE id = ?').get(id) as RoundRow | undefined;
    return row ? mapRound(row) : null;
}

export function getRoundByCycle(configId: number, cycleKey: string): RotationRound | null {
    const row = db.prepare('SELECT * FROM rr_round WHERE config_id = ? AND cycle_key = ?')
        .get(configId, cycleKey) as RoundRow | undefined;
    return row ? mapRound(row) : null;
}

export function getActiveRound(configId: number): RotationRound | null {
    const row = db.prepare(`
        SELECT * FROM rr_round
        WHERE config_id = ? AND status IN ('inquiry', 'recruiting')
        ORDER BY id DESC LIMIT 1
    `).get(configId) as RoundRow | undefined;
    return row ? mapRound(row) : null;
}

export function listRoundsByStatus(statuses: RotationRoundStatus[]): RotationRound[] {
    if (!statuses.length) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    return (db.prepare(`SELECT * FROM rr_round WHERE status IN (${placeholders}) ORDER BY id`).all(...statuses) as RoundRow[])
        .map(mapRound);
}

export type RoundUpdate = Partial<Pick<RotationRound,
    'status' | 'inquiryDeadline' | 'recruitmentOpenedAt' | 'closedAt' | 'vacanciesAtOpen' | 'error'>>;

export function updateRound(id: number, patch: RoundUpdate): RotationRound | null {
    const columns: Record<keyof RoundUpdate, string> = {
        status: 'status',
        inquiryDeadline: 'inquiry_deadline',
        recruitmentOpenedAt: 'recruitment_opened_at',
        closedAt: 'closed_at',
        vacanciesAtOpen: 'vacancies_at_open',
        error: 'error',
    };
    const entries = Object.entries(patch) as [keyof RoundUpdate, RoundUpdate[keyof RoundUpdate]][];
    if (!entries.length) return getRound(id);
    db.prepare(`UPDATE rr_round SET ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')} WHERE id = ?`)
        .run(...entries.map(([, value]) => value), id);
    return getRound(id);
}

export function getParticipant(roundId: number, userId: string): RotationParticipant | null {
    const row = db.prepare('SELECT * FROM rr_participant WHERE round_id = ? AND user_id = ?')
        .get(roundId, userId) as ParticipantRow | undefined;
    return row ? {
        roundId: row.round_id,
        userId: row.user_id,
        response: row.response,
        respondedAt: row.responded_at,
        roleRemovedAt: row.role_removed_at,
        removeError: row.remove_error,
    } : null;
}

export function recordResponse(roundId: number, userId: string, response: RotationResponse): boolean {
    return db.prepare(`
        UPDATE rr_participant SET response = ?, responded_at = ?
        WHERE round_id = ? AND user_id = ? AND response IS NULL
    `).run(response, Date.now(), roundId, userId).changes > 0;
}

export function listParticipants(roundId: number): RotationParticipant[] {
    return (db.prepare('SELECT * FROM rr_participant WHERE round_id = ? ORDER BY user_id').all(roundId) as ParticipantRow[])
        .map(row => ({
            roundId: row.round_id,
            userId: row.user_id,
            response: row.response,
            respondedAt: row.responded_at,
            roleRemovedAt: row.role_removed_at,
            removeError: row.remove_error,
        }));
}

export function markParticipantRemoval(roundId: number, userId: string, error?: string | null): void {
    db.prepare(`
        UPDATE rr_participant
        SET role_removed_at = ?, remove_error = ?
        WHERE round_id = ? AND user_id = ?
    `).run(error ? null : Date.now(), error ?? null, roundId, userId);
}

export function saveMessage(message: RotationMessage): void {
    db.prepare(`
        INSERT INTO rr_message (round_id, phase, channel_id, destination_id, message_id)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(round_id, phase, destination_id) DO UPDATE SET
            channel_id = excluded.channel_id,
            message_id = excluded.message_id
    `).run(message.roundId, message.phase, message.channelId, message.destinationId, message.messageId);
}

export function listMessages(roundId: number, phase?: RotationMessagePhase): RotationMessage[] {
    const rows = phase
        ? db.prepare('SELECT * FROM rr_message WHERE round_id = ? AND phase = ?').all(roundId, phase)
        : db.prepare('SELECT * FROM rr_message WHERE round_id = ?').all(roundId);
    return (rows as {
        round_id: number;
        phase: RotationMessagePhase;
        channel_id: string;
        destination_id: string | null;
        message_id: string;
    }[]).map(row => ({
        roundId: row.round_id,
        phase: row.phase,
        channelId: row.channel_id,
        destinationId: row.destination_id ?? row.channel_id,
        messageId: row.message_id,
    }));
}

export function hasApplication(roundId: number, userId: string): boolean {
    return Boolean(db.prepare('SELECT 1 FROM rr_application WHERE round_id = ? AND user_id = ?').get(roundId, userId));
}

export function recordApplication(roundId: number, userId: string): boolean {
    return db.prepare('INSERT OR IGNORE INTO rr_application (round_id, user_id, applied_at) VALUES (?, ?, ?)')
        .run(roundId, userId, Date.now()).changes > 0;
}

export function syncMembers(configId: number, members: { userId: string; isBot: boolean }[]): void {
    const now = Date.now();
    db.transaction(() => {
        db.prepare('UPDATE rr_member SET active = 0, removed_at = ?, last_seen = ? WHERE config_id = ? AND active = 1')
            .run(now, now, configId);
        const stmt = db.prepare(`
            INSERT INTO rr_member (config_id, user_id, is_bot, active, first_seen, last_seen, removed_at)
            VALUES (?, ?, ?, 1, ?, ?, NULL)
            ON CONFLICT(config_id, user_id) DO UPDATE SET
                is_bot = excluded.is_bot,
                active = 1,
                last_seen = excluded.last_seen,
                removed_at = NULL
        `);
        for (const member of members) stmt.run(configId, member.userId, Number(member.isBot), now, now);
    })();
}

export function syncMember(configId: number, userId: string, isBot: boolean, active: boolean): void {
    const now = Date.now();
    if (active) {
        db.prepare(`
            INSERT INTO rr_member (config_id, user_id, is_bot, active, first_seen, last_seen, removed_at)
            VALUES (?, ?, ?, 1, ?, ?, NULL)
            ON CONFLICT(config_id, user_id) DO UPDATE SET
                is_bot = excluded.is_bot,
                active = 1,
                last_seen = excluded.last_seen,
                removed_at = NULL
        `).run(configId, userId, Number(isBot), now, now);
    } else {
        db.prepare(`
            UPDATE rr_member SET active = 0, last_seen = ?, removed_at = ?
            WHERE config_id = ? AND user_id = ?
        `).run(now, now, configId, userId);
    }
}

export function addAudit(input: {
    guildId: string;
    event: string;
    configId?: number | null;
    roundId?: number | null;
    actorId?: string | null;
    userId?: string | null;
    detail?: string | null;
}): void {
    db.prepare(`
        INSERT INTO rr_audit (guild_id, config_id, round_id, actor_id, user_id, event, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        input.guildId,
        input.configId ?? null,
        input.roundId ?? null,
        input.actorId ?? null,
        input.userId ?? null,
        input.event,
        input.detail ?? null,
        Date.now(),
    );
}

export function listAudit(guildId: string, configId?: number, limit = 20): RotationAudit[] {
    const rows = configId
        ? db.prepare('SELECT * FROM rr_audit WHERE guild_id = ? AND config_id = ? ORDER BY id DESC LIMIT ?')
            .all(guildId, configId, limit)
        : db.prepare('SELECT * FROM rr_audit WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
            .all(guildId, limit);
    return (rows as Array<{
        id: number; guild_id: string; config_id: number | null; round_id: number | null;
        actor_id: string | null; user_id: string | null; event: string; detail: string | null; created_at: number;
    }>).map(row => ({
        id: row.id,
        guildId: row.guild_id,
        configId: row.config_id,
        roundId: row.round_id,
        actorId: row.actor_id,
        userId: row.user_id,
        event: row.event,
        detail: row.detail,
        createdAt: row.created_at,
    }));
}
