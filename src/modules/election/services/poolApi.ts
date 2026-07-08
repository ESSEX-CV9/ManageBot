// src/modules/election/services/poolApi.ts
//
// 通过旧募选 bot 提供的 HTTP API 拉取「常态通过名单」，比解析频道 embed 可靠。
//   GET {base}/v1/continuous/approved?guild_id=...&config_id=...&field_name=...&limit=...
//   Authorization: Bearer <token>
// 建议以 user_id 为准；display_name/username 仅为申请时快照，未必是最新昵称。
//
// 用 undici 的 fetch：若 .env 配了代理（core/proxy.ts 会 setGlobalDispatcher），
// 请求会自然复用该代理；未配置则直连。

import { fetch } from 'undici';
import type { ParsedPoolEntry } from './electionDatabase';

export interface ApiConfig {
    baseUrl: string;
    token: string;
    guildId: string;
    configId?: string | null;
    fieldName?: string | null;
    limit?: number;
}

export interface ApiFetchResult {
    entries: ParsedPoolEntry[];
    count: number;
}

interface ApiItem {
    user_id?: string;
    display_name?: string | null;
    username?: string | null;
    approved_at?: string | null;
    field_name?: string | null;
}
interface ApiResponse {
    ok?: boolean;
    count?: number;
    items?: ApiItem[];
    error?: string;
    message?: string;
}

const TIMEOUT_MS = 15000;

/**
 * 拉取通过名单并规整为候选人列表。失败时抛出带可读原因的 Error。
 */
export async function fetchApprovedPool(cfg: ApiConfig): Promise<ApiFetchResult> {
    const base = cfg.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}/v1/continuous/approved`);
    url.searchParams.set('guild_id', cfg.guildId);
    if (cfg.configId) url.searchParams.set('config_id', cfg.configId);
    if (cfg.fieldName) url.searchParams.set('field_name', cfg.fieldName);
    url.searchParams.set('limit', String(cfg.limit ?? 100));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
        res = await fetch(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
            signal: controller.signal,
        });
    } catch (err) {
        throw new Error(`请求失败（网络/超时/被墙？）：${err instanceof Error ? err.message : String(err)}`);
    } finally {
        clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
        throw new Error(`鉴权失败（HTTP ${res.status}）：请检查 API Token 是否正确。`);
    }
    if (!res.ok) {
        throw new Error(`接口返回 HTTP ${res.status}。`);
    }

    let data: ApiResponse;
    try {
        data = (await res.json()) as ApiResponse;
    } catch {
        throw new Error('接口返回的不是有效 JSON。');
    }
    if (data.ok === false) {
        throw new Error(`接口返回 ok=false：${data.error ?? data.message ?? '未知错误'}`);
    }

    const entries: ParsedPoolEntry[] = [];
    const seen = new Set<string>();
    for (const it of data.items ?? []) {
        if (!it.user_id || seen.has(it.user_id)) continue;
        seen.add(it.user_id);
        const ts = it.approved_at ? Date.parse(it.approved_at) : NaN;
        entries.push({
            userId: it.user_id,
            displayName: it.display_name ?? it.username ?? null,
            passedAt: Number.isFinite(ts) ? ts : null,
        });
    }
    return { entries, count: entries.length };
}
