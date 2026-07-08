// src/core/utils/database.ts
//
// 通用核心存储层（JSON 文件）。
// 只保留“核心/共享”功能所需的通用数据读写：
//   - 检查报告频道设置（/调试-设置检查报告频道）
//   - 一个通用的按服务器命名空间的 KV 设置存储，方便新模块快速落地配置
//
// 各业务模块请在自己的目录内维护独立的数据文件（可参考 src/modules/template/services/templateDatabase.ts）。

import fs from 'fs';
import path from 'path';

// 确保数据目录存在
export const DATA_DIR = path.join(__dirname, '../../../data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const CHECK_SETTINGS_FILE = path.join(DATA_DIR, 'checkSettings.json');
const CORE_SETTINGS_FILE = path.join(DATA_DIR, 'coreSettings.json');

/**
 * 安全读取一个 JSON 文件；文件不存在或损坏时返回 fallback。
 */
export function readJson<T>(file: string, fallback: T): T {
    try {
        if (!fs.existsSync(file)) return fallback;
        const raw = fs.readFileSync(file, 'utf8');
        if (!raw.trim()) return fallback;
        return JSON.parse(raw) as T;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[core/database] 读取 ${path.basename(file)} 失败，返回默认值：`, msg);
        return fallback;
    }
}

/**
 * 原子写入一个 JSON 文件（先写临时文件再重命名，避免写一半损坏）。
 */
export function writeJson(file: string, data: unknown): void {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

// --- 检查报告频道设置 ---

export interface CheckChannelSettings {
    guildId?: string;
    checkChannelId: string;
    enabled: boolean;
    setupBy?: string;
    timestamp?: string;
}

/**
 * 获取指定服务器的检查报告频道设置。
 */
export async function getCheckChannelSettings(guildId: string): Promise<CheckChannelSettings | null> {
    const all = readJson<Record<string, CheckChannelSettings>>(CHECK_SETTINGS_FILE, {});
    return all[guildId] || null;
}

/**
 * 保存指定服务器的检查报告频道设置。
 */
export async function saveCheckChannelSettings(
    guildId: string,
    settings: CheckChannelSettings,
): Promise<CheckChannelSettings> {
    const all = readJson<Record<string, CheckChannelSettings>>(CHECK_SETTINGS_FILE, {});
    all[guildId] = settings;
    writeJson(CHECK_SETTINGS_FILE, all);
    return settings;
}

// --- 通用按服务器 KV 设置存储 ---
// 结构：{ [guildId]: { [namespace]: value } }
// 新模块若只需要少量配置，可直接复用它，无需再建独立文件。

/**
 * 读取某服务器某命名空间下的设置。
 * @param namespace 建议用模块名，如 'template'
 */
export async function getGuildSetting<T = unknown>(guildId: string, namespace: string): Promise<T | null> {
    const all = readJson<Record<string, Record<string, T>>>(CORE_SETTINGS_FILE, {});
    return all?.[guildId]?.[namespace] ?? null;
}

/**
 * 写入某服务器某命名空间下的设置。
 */
export async function saveGuildSetting<T>(guildId: string, namespace: string, value: T): Promise<T> {
    const all = readJson<Record<string, Record<string, T>>>(CORE_SETTINGS_FILE, {});
    if (!all[guildId]) all[guildId] = {};
    all[guildId][namespace] = value;
    writeJson(CORE_SETTINGS_FILE, all);
    return value;
}
