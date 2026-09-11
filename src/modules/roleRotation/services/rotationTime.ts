export interface ZonedDateParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
}

export function isValidTimeZone(timeZone: string): boolean {
    try {
        new Intl.DateTimeFormat('zh-CN', { timeZone }).format(new Date());
        return true;
    } catch {
        return false;
    }
}

export function isValidClockTime(value: string): boolean {
    return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function getZonedParts(timestamp: number, timeZone: string): ZonedDateParts {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date(timestamp));
    const value = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find(part => part.type === type)?.value ?? 0);
    return {
        year: value('year'),
        month: value('month'),
        day: value('day'),
        hour: value('hour'),
        minute: value('minute'),
    };
}

/** 将指定时区里的墙上时间换算为 UTC 时间戳。 */
export function zonedLocalToUtc(parts: ZonedDateParts, timeZone: string): number {
    const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
    let guess = desired;
    // Intl 没有直接的反向转换；迭代修正时区偏移，可覆盖整点和半点时区及常见 DST。
    for (let i = 0; i < 4; i++) {
        const actual = getZonedParts(guess, timeZone);
        const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
        const correction = desired - represented;
        guess += correction;
        if (correction === 0) break;
    }
    return guess;
}

/** 返回严格晚于 afterTimestamp 的下一次月度执行时间。日期限制 1-28，保证每月存在。 */
export function computeNextMonthlyRun(
    scheduleDay: number,
    scheduleTime: string,
    timeZone: string,
    afterTimestamp = Date.now(),
): number {
    if (!Number.isInteger(scheduleDay) || scheduleDay < 1 || scheduleDay > 28) {
        throw new Error('每月问询日必须是 1-28。');
    }
    if (!isValidClockTime(scheduleTime)) throw new Error('问询时间必须是 HH:mm 格式。');
    if (!isValidTimeZone(timeZone)) throw new Error('无效的 IANA 时区。');

    const [hour, minute] = scheduleTime.split(':').map(Number);
    const localNow = getZonedParts(afterTimestamp, timeZone);
    let year = localNow.year;
    let month = localNow.month;
    let candidate = zonedLocalToUtc({ year, month, day: scheduleDay, hour, minute }, timeZone);

    if (candidate <= afterTimestamp) {
        month += 1;
        if (month > 12) {
            month = 1;
            year += 1;
        }
        candidate = zonedLocalToUtc({ year, month, day: scheduleDay, hour, minute }, timeZone);
    }
    return candidate;
}

export function cycleKeyFor(timestamp: number, timeZone: string): string {
    const parts = getZonedParts(timestamp, timeZone);
    return `${parts.year}-${String(parts.month).padStart(2, '0')}`;
}

