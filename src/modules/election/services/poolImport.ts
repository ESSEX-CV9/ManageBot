// src/modules/election/services/poolImport.ts
//
// 解析「旧募选 bot」发出的候选池名单 embed，抽取候选人。
//
// 关键点：名单里的 @某人 是真实 mention，原始文本是 <@用户ID>；
// 通过时间是 Discord 时间戳 <t:UNIX秒:样式>。我们只认这两种标记，
// 名字里的花体字/特殊符号一律不影响。
//
// 由于 Discord 禁止机器人调用斜杠命令，流程是：
//   管理员手动运行旧 bot 命令 → 旧 bot 在频道发 embed → 我们 fetch 最近消息并解析。

import type { GuildTextBasedChannel, Message } from 'discord.js';
import type { ParsedPoolEntry } from './electionDatabase';

const MENTION_RE = /<@!?(\d+)>/;
const TIMESTAMP_RE = /<t:(\d+)(?::[tTdDfFR])?>/;

/** 名单标题里出现的特征词，用于在多条消息中辨认候选池 embed。 */
const TITLE_HINTS = ['通过名单', '候补', '常态申请'];

export interface ParseResult {
    entries: ParsedPoolEntry[];
    /** 疑似被 Discord 长度上限截断（名单可能不完整）时为 true。 */
    truncated: boolean;
}

/**
 * 从一段文本里逐行解析候选人：每行取第一个 <@id> 与第一个 <t:秒>。
 * 无 mention 的行直接跳过（标题、说明等）。
 */
export function parsePoolFromText(text: string): ParsedPoolEntry[] {
    const entries: ParsedPoolEntry[] = [];
    const seen = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
        const m = MENTION_RE.exec(line);
        if (!m) continue;
        const userId = m[1];
        if (seen.has(userId)) continue; // 同一人只取一次
        seen.add(userId);

        const t = TIMESTAMP_RE.exec(line);
        const passedAt = t ? Number(t[1]) * 1000 : null;
        entries.push({ userId, passedAt });
    }
    return entries;
}

/**
 * 把一条消息的 embed 里所有可能承载名单的文本拼起来。
 */
function collectEmbedText(message: Message): { text: string; maxDescLen: number } {
    let maxDescLen = 0;
    const parts: string[] = [];
    for (const embed of message.embeds) {
        if (embed.title) parts.push(embed.title);
        if (embed.description) {
            parts.push(embed.description);
            maxDescLen = Math.max(maxDescLen, embed.description.length);
        }
        for (const field of embed.fields ?? []) {
            parts.push(field.name);
            parts.push(field.value);
        }
        if (embed.footer?.text) parts.push(embed.footer.text);
    }
    // 兜底：有的 bot 直接把名单发在正文而非 embed 里
    if (message.content) parts.push(message.content);
    return { text: parts.join('\n'), maxDescLen };
}

/** 一条消息看起来是否像候选池名单（作者是旧 bot、含 mention）。 */
function looksLikePoolMessage(message: Message, oldBotId: string | null): boolean {
    if (oldBotId && message.author.id !== oldBotId) return false;
    if (!oldBotId && !message.author.bot) return false; // 未配置旧 bot 时至少要求来自 bot
    const { text } = collectEmbedText(message);
    if (!MENTION_RE.test(text)) return false;
    // 标题/内容命中特征词更稳，但即使没命中，只要来自指定旧 bot 且含 mention 也接受
    if (oldBotId) return true;
    return TITLE_HINTS.some(h => text.includes(h));
}

/**
 * 在频道最近若干条消息里，找出**最新**的一条候选池名单消息。
 * @param oldBotId 已配置时只认该 bot 的消息；未配置时退化为"来自任意 bot 且命中标题特征"。
 */
export async function findPoolMessage(
    channel: GuildTextBasedChannel,
    oldBotId: string | null,
    scan = 50,
): Promise<Message | null> {
    const fetched = await channel.messages.fetch({ limit: Math.min(Math.max(scan, 1), 100) });
    // fetch 返回按新→旧，find 取第一个命中的即最新
    return fetched.find(msg => looksLikePoolMessage(msg, oldBotId)) ?? null;
}

/**
 * 解析给定消息为候选人列表，并给出截断预警。
 */
export function parsePoolMessage(message: Message): ParseResult {
    const { text, maxDescLen } = collectEmbedText(message);
    const entries = parsePoolFromText(text);
    // embed.description 上限 4096；接近上限时名单可能被截断/分页
    const truncated = maxDescLen >= 4000;
    return { entries, truncated };
}
