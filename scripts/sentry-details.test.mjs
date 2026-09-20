import test from 'node:test';
import assert from 'node:assert/strict';
import { sentryDetails } from '../src/shared/sentry-details.ts';

const event = (seq, fields = {}, level = 'error') => ({ seq, ts: seq * 100, event: 'trace.end', level, fields });
test('Sentry entries group repeated captures while retaining the useful error and trace ID', () => {
 const rows = sentryDetails([
  event(1, { sentryEventId: 'abc', traceId: 'trace-a', error: 'Provider timed out' }),
  event(2, { sentryEventId: 'abc' }),
  event(3, { sentryEventId: 'def', error: 'Invalid result' }),
 ]);
 assert.equal(rows.length, 2);
 assert.equal(rows[0].eventId, 'def');
 assert.equal(rows[1].occurrences, 2);
 assert.equal(rows[1].event.fields.error, 'Provider timed out');
 assert.equal(rows[1].traceId, 'trace-a');
});
test('local errors stay visible without inventing Sentry capture or merging unrelated failures', () => {
 const rows = sentryDetails([
  event(1, { error: 'Failed' }), event(2, { error: 'Failed' }),
  event(3, { status: 'error' }, 'info'), event(4, { traceId: 'trace-only' }, 'info'),
 ]);
 assert.equal(rows.length, 3);
 assert.ok(rows.every(row => row.eventId === undefined));
 assert.deepEqual(sentryDetails([event(1, {}, 'info')]), []);
});
