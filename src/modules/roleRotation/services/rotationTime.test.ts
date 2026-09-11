import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeNextMonthlyRun,
    cycleKeyFor,
    getZonedParts,
    isValidClockTime,
    isValidTimeZone,
} from './rotationTime';

test('北京时间月度时间在当月尚未到点时落到本月', () => {
    const after = Date.UTC(2026, 8, 14, 0, 0);
    const next = computeNextMonthlyRun(15, '09:00', 'Asia/Shanghai', after);
    assert.equal(next, Date.UTC(2026, 8, 15, 1, 0));
    assert.deepEqual(getZonedParts(next, 'Asia/Shanghai'), {
        year: 2026,
        month: 9,
        day: 15,
        hour: 9,
        minute: 0,
    });
});

test('当月时间已过后滚动到下月，并正确处理跨年', () => {
    const nextMonth = computeNextMonthlyRun(15, '09:00', 'Asia/Shanghai', Date.UTC(2026, 8, 15, 2));
    assert.equal(nextMonth, Date.UTC(2026, 9, 15, 1));

    const nextYear = computeNextMonthlyRun(15, '09:00', 'Asia/Shanghai', Date.UTC(2026, 11, 20));
    assert.deepEqual(getZonedParts(nextYear, 'Asia/Shanghai'), {
        year: 2027,
        month: 1,
        day: 15,
        hour: 9,
        minute: 0,
    });
});

test('IANA 时区转换会考虑夏令时', () => {
    const next = computeNextMonthlyRun(15, '09:00', 'America/New_York', Date.UTC(2026, 1, 20));
    assert.equal(next, Date.UTC(2026, 2, 15, 13));
    assert.equal(cycleKeyFor(next, 'America/New_York'), '2026-03');
});

test('配置格式校验', () => {
    assert.equal(isValidClockTime('00:00'), true);
    assert.equal(isValidClockTime('23:59'), true);
    assert.equal(isValidClockTime('24:00'), false);
    assert.equal(isValidTimeZone('Asia/Shanghai'), true);
    assert.equal(isValidTimeZone('Mars/Olympus'), false);
    assert.throws(() => computeNextMonthlyRun(31, '09:00', 'Asia/Shanghai', 0));
});

