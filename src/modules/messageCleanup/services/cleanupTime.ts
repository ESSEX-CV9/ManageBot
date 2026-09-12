const SHANGHAI_OFFSET = '+08:00';

export function formatShanghaiTime(timestamp: number): string {
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(new Date(timestamp));
}

/**
 * 支持北京时间 YYYY-MM-DD、YYYY-MM-DD HH:mm，以及秒/毫秒 Unix 时间戳。
 * 日期不带时间时按当天 00:00 处理，语义始终是“删除早于这个时间的消息”。
 */
export function parseCleanupCutoff(raw: string, now = Date.now()): number | null {
    const value = raw.trim();
    if (!value) return null;

    let parsed: number | null = null;
    if (/^\d{10}$/.test(value)) parsed = Number(value) * 1000;
    else if (/^\d{13}$/.test(value)) parsed = Number(value);
    else {
        const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(value);
        if (!match) return null;
        const [, year, month, day, hour = '00', minute = '00'] = match;
        parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:00${SHANGHAI_OFFSET}`);
        if (Number.isFinite(parsed)) {
            const shanghaiWallClock = new Date(parsed + 8 * 60 * 60_000);
            const matchesInput = shanghaiWallClock.getUTCFullYear() === Number(year)
                && shanghaiWallClock.getUTCMonth() + 1 === Number(month)
                && shanghaiWallClock.getUTCDate() === Number(day)
                && shanghaiWallClock.getUTCHours() === Number(hour)
                && shanghaiWallClock.getUTCMinutes() === Number(minute);
            if (!matchesInput) return null;
        }
    }

    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > now + 5 * 60_000) return null;
    return parsed;
}

const DISCORD_EPOCH = 1_420_070_400_000n;

/** 生成某毫秒时刻的最小 Discord snowflake，配合 before/max_id 表示严格早于。 */
export function snowflakeAt(timestamp: number): string {
    const millis = BigInt(Math.max(Number(DISCORD_EPOCH), Math.floor(timestamp)));
    return ((millis - DISCORD_EPOCH) << 22n).toString();
}

export function timestampFromSnowflake(id: string): number {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}
