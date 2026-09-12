import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCleanupCutoff, snowflakeAt, timestampFromSnowflake } from './cleanupTime';

test('parseCleanupCutoff parses Shanghai date and datetime', () => {
    const now = Date.parse('2026-09-13T00:00:00+08:00');
    assert.equal(
        parseCleanupCutoff('2026-09-12 18:30', now),
        Date.parse('2026-09-12T18:30:00+08:00'),
    );
    assert.equal(
        parseCleanupCutoff('2026-09-12', now),
        Date.parse('2026-09-12T00:00:00+08:00'),
    );
});

test('parseCleanupCutoff rejects malformed and future values', () => {
    const now = Date.parse('2026-09-12T12:00:00+08:00');
    assert.equal(parseCleanupCutoff('明天', now), null);
    assert.equal(parseCleanupCutoff('2026-02-31', now), null);
    assert.equal(parseCleanupCutoff('2026-09-13 12:00', now), null);
});

test('snowflakeAt keeps the requested millisecond timestamp', () => {
    const timestamp = Date.parse('2026-09-12T18:30:00+08:00');
    assert.equal(timestampFromSnowflake(snowflakeAt(timestamp)), timestamp);
});
