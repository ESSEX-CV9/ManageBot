// src/modules/election/services/poolSync.ts
//
// 用候选池 API 同步某服务器候选池的统一入口。
// 手动导入命令、发起募选（关键节点）、定时轮询都调用它，逻辑只一份。
//
// 令牌/地址/guild id 的取值顺序：配置面板 > .env > 兜底。
// config_id 默认取配置里的「默认 config_id」，也可临时覆盖。

import { getSettings, syncPool, type SyncResult } from './electionDatabase';
import { fetchApprovedPool } from './poolApi';

export interface PoolSyncOutcome {
    ok: boolean;
    message: string;
    result?: SyncResult;
}

/**
 * 用 API 同步候选池。
 * @param configIdOverride 传字符串则覆盖默认 config_id；不传（undefined）用配置里的默认。
 */
export async function syncPoolViaApi(guildId: string, configIdOverride?: string): Promise<PoolSyncOutcome> {
    const settings = getSettings(guildId);
    const token = settings.apiToken || process.env.ELECTION_APPROVED_API_TOKEN || null;
    if (!token) return { ok: false, message: '未配置候选池 API Token。' };

    const baseUrl = settings.apiBaseUrl || process.env.ELECTION_APPROVED_API_BASE || null;
    if (!baseUrl) return { ok: false, message: '未配置候选池 API 地址（在 .env 的 ELECTION_APPROVED_API_BASE 或配置面板里填）。' };
    const poolGuildId = settings.apiGuildId || process.env.ELECTION_APPROVED_API_GUILD_ID || guildId;
    const configId = configIdOverride !== undefined ? configIdOverride : settings.poolConfigId;

    try {
        const { entries } = await fetchApprovedPool({
            baseUrl,
            token,
            guildId: poolGuildId,
            configId,
            fieldName: settings.apiFieldName,
        });
        // 名单为空时不覆盖（多半是 config_id/岗位名/guild id 填错），避免误清空候选池。
        if (!entries.length) {
            return { ok: false, message: 'API 返回名单为空，未改动候选池（请核对 config_id / 岗位名 / guild id）。' };
        }
        const result = syncPool(guildId, entries);
        return {
            ok: true,
            message: `在池 ${result.total} 人（新进 ${result.added}，离池 ${result.removed}，保留 ${result.kept}）`,
            result,
        };
    } catch (err) {
        return { ok: false, message: `API 拉取失败：${err instanceof Error ? err.message : String(err)}` };
    }
}
