import test from 'node:test';
import assert from 'node:assert/strict';
import { eventTimings, elapsedLabel } from '../src/shared/event-timing.ts';

test('trace timing separates each event gap from cumulative elapsed time', () => {
 const times = eventTimings([{ ts: 813000 }, { ts: 814000 }, { ts: 814000 }, { ts: 853000 }], 0);
 assert.deepEqual(times.map(t => t.gapMs), [813000, 1000, 0, 39000]);
 assert.deepEqual(times.map(t => t.totalMs), [813000, 814000, 814000, 853000]);
 assert.equal(times[0].firstEvent, true); assert.equal(times[1].firstEvent, false);
 assert.equal(elapsedLabel(times[1].gapMs), '1.0s');
 assert.equal(elapsedLabel(times[1].totalMs), '13m 34s');
});
test('timing handles first events, milliseconds and long conversations', () => {
 assert.deepEqual(eventTimings([], 100), []);
 assert.equal(eventTimings([{ ts: 120 }], 100)[0].gapMs, 20);
 assert.equal(eventTimings([{ ts: 90 }], 100)[0].totalMs, 0);
 assert.equal(elapsedLabel(3605000), '1h 0m 5s');
 assert.equal(elapsedLabel(350), '350ms');
});
