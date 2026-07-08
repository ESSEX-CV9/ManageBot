// src/modules/election/services/nameResolver.ts
//
// 统一的"昵称 + mention"显示工具。
// Discord 偶尔会把 <@id> 渲染成裸 id 而不是昵称，所以凡是展示用户处都用
// 「昵称 <@id>」的格式：昵称是纯文本，兜底可见；mention 便于点击。

import type { Guild } from 'discord.js';

/**
 * 批量解析一组用户的显示名。优先用缓存，缺失的走一次批量成员拉取。
 * 拉不到的（如已退群 / 测试用的假 id）不放进结果，展示时回退为纯 mention。
 */
export async function resolveNames(guild: Guild, ids: Iterable<string>): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    const names = new Map<string, string>();
    const missing: string[] = [];

    for (const id of unique) {
        const m = guild.members.cache.get(id);
        if (m) { names.set(id, m.displayName); continue; }
        const u = guild.client.users.cache.get(id);
        if (u) { names.set(id, u.username); continue; }
        missing.push(id);
    }

    if (missing.length) {
        try {
            const fetched = await guild.members.fetch({ user: missing });
            for (const [id, m] of fetched) names.set(id, m.displayName);
        } catch { /* 拉取失败就用兜底 */ }
    }
    return names;
}

/** 生成「昵称 <@id>」；解析不到昵称时回退为纯 mention。 */
export function nameTag(names: Map<string, string>, id: string): string {
    const n = names.get(id);
    return n ? `${n} <@${id}>` : `<@${id}>`;
}

/** 纯文本用（如附件文件）：「昵称(id)」。 */
export function namePlain(names: Map<string, string>, id: string): string {
    const n = names.get(id);
    return n ? `${n}(${id})` : id;
}
