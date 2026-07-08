// src/modules/template/services/templateDatabase.ts
//
// 模版模块的独立数据层（SQLite / better-sqlite3）。
// 说明：每个模块自己维护数据文件与表结构，不要写回核心 database.ts。
// 这里用一个「按服务器+用户计数」的最小示例演示推荐写法。

import path from 'path';
import Database from 'better-sqlite3';
import { DATA_DIR } from '../../../core/utils/database';

const DB_FILE = path.join(DATA_DIR, 'template.sqlite');
const db = new Database(DB_FILE);

// 初始化表结构（模块加载即执行一次）
db.exec(`
    CREATE TABLE IF NOT EXISTS template_counters (
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        count      INTEGER NOT NULL DEFAULT 0,
        note       TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
    );
`);

/** template_counters 表的一行 */
interface CounterRow {
    guild_id: string;
    user_id: string;
    count: number;
    note: string | null;
    updated_at: number;
}

/** 对外返回的计数记录（驼峰命名） */
export interface CounterRecord {
    guildId: string;
    userId: string;
    count: number;
    note: string | null;
    updatedAt: number;
}

const incrementStmt = db.prepare(`
    INSERT INTO template_counters (guild_id, user_id, count, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
        count = count + 1,
        updated_at = excluded.updated_at
`);

const setNoteStmt = db.prepare(`
    INSERT INTO template_counters (guild_id, user_id, count, note, updated_at)
    VALUES (?, ?, 0, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
        note = excluded.note,
        updated_at = excluded.updated_at
`);

const getStmt = db.prepare(`
    SELECT guild_id, user_id, count, note, updated_at
    FROM template_counters
    WHERE guild_id = ? AND user_id = ?
`);

const countActiveStmt = db.prepare(`
    SELECT COUNT(*) AS c FROM template_counters WHERE guild_id = ?
`);

/**
 * 给某用户的计数 +1，返回最新计数。
 */
export function incrementCounter(guildId: string, userId: string): number {
    incrementStmt.run(guildId, userId, Date.now());
    const row = getStmt.get(guildId, userId) as CounterRow;
    return row.count;
}

/**
 * 设置某用户的备注。
 */
export function setNote(guildId: string, userId: string, note: string): void {
    setNoteStmt.run(guildId, userId, note, Date.now());
}

/**
 * 读取某用户的计数记录。
 */
export function getCounter(guildId: string, userId: string): CounterRecord | null {
    const row = getStmt.get(guildId, userId) as CounterRow | undefined;
    if (!row) return null;
    return {
        guildId: row.guild_id,
        userId: row.user_id,
        count: row.count,
        note: row.note || null,
        updatedAt: row.updated_at,
    };
}

/**
 * 统计某服务器有多少条计数记录（供调度器演示使用）。
 */
export function countRecords(guildId: string): number {
    const row = countActiveStmt.get(guildId) as { c: number };
    return row.c;
}
