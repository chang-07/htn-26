import test from 'node:test';
import assert from 'node:assert/strict';
import { groupIntoSessions, sessionSummary, sessionEvents, SESSION_GAP } from '../src/shared/run-sessions.ts';

const run = (runId, started, extra = {}) => ({ runId, chat: 'chat-a', started, ended: started + 100, outcome: 'replied', level: 'info', trigger: 'message.in', ms: 100, tokens: 10, steps: 1, events: 2, tools: ['send_message'], ...extra });

test('turns and background callbacks form one conversation entry, even with duplicate summaries', () => {
 const first = run('first', 100, { said: 'Plan dinner' });
 const callback = run('callback', 200, { outcome: 'background' });
 const next = run('next', 300, { said: 'Book it', ended: null });
 const sessions = groupIntoSessions([next, first, callback, first]);
 assert.equal(sessions.length, 1); assert.equal(sessions[0].runs.length, 3);
 const summary = sessionSummary(sessions[0]);
 assert.equal(summary.ended, null); assert.equal(summary.said, 'Plan dinner');
 assert.equal(summary.tokens, 30); assert.equal(summary.events, 6);
 assert.deepEqual(summary.tools, ['send_message']);
 assert.equal(groupIntoSessions([next, callback, first])[0].id, sessions[0].id);
});

test('separate chats and long idle gaps remain separate conversations', () => {
 const sessions = groupIntoSessions([run('a', 100), run('b', 200, { chat: 'chat-b' }), run('c', SESSION_GAP + 1000)]);
 assert.equal(sessions.length, 3);
 // A long operation bridges the gap: use its end, not only its start.
 assert.equal(groupIntoSessions([run('a', 100, { ended: SESSION_GAP + 100 }), run('c', SESSION_GAP + 200)]).length, 1);
});

test('one trace deduplicates replayed events without dropping same-sequence events from other turns', () => {
 const session = groupIntoSessions([run('first', 100), run('second', 200)])[0];
 const event = (seq, ts) => ({ seq, ts, event: 'message.out', level: 'info', fields: { text: 'hello' } });
 const combined = sessionEvents(session, { first: [event(1, 110), event(1, 110)], second: [event(1, 210)] });
 assert.equal(combined.length, 2);
 assert.deepEqual(combined.map(e => [e.sourceRunId, e.sourceSeq]), [['first', 1], ['second', 1]]);
});

test('background completions do not hide a failed conversation or replace its reply outcome', () => {
 const session = groupIntoSessions([run('a', 100, { level: 'error' }), run('b', 200, { outcome: 'background' })])[0];
 assert.equal(sessionSummary(session).level, 'error');
 assert.equal(sessionSummary(session).outcome, 'replied');
});
