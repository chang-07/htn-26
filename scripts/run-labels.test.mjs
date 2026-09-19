import test from 'node:test';
import assert from 'node:assert/strict';
import { runLabel } from '../src/shared/run-labels.ts';
const run = (data = {}) => ({ said: null, tools: [], trigger: null, outcome: null, ...data });
test('short replies get recorded action context without losing their message', () => {
  assert.deepEqual(runLabel(run({ said: 'Yes', tools: ['send_message', 'check_availability', 'check_availability'] })), { title: 'Check availability', detail: '“Yes”' });
  assert.equal(runLabel(run({ said: 'Yes', outcome: 'replied' })).title, 'Reply to “Yes”');
});
test('reaction labels distinguish an ignored event from a run that sent a reply', () => {
  assert.equal(runLabel(run({ trigger: 'reaction.ignored' })).title, 'Reaction not matched to an action');
  assert.equal(runLabel(run({ trigger: 'reaction.ignored', tools: ['send_message'] })).title, 'Respond to a message reaction');
});
test('labels do not claim booking success and retain long messages with redacted email', () => {
  assert.equal(runLabel(run({ tools: ['book_option'], outcome: 'replied' })).title, 'Attempt a reservation');
  const label=runLabel(run({ said: 'Please arrange a birthday dinner and send details to test@example.com', tools: ['research'] }));
  assert.match(label.title, /Please arrange/);
  assert.doesNotMatch(label.title, /test@example/);
  assert.equal(label.detail, 'Research outing options');
});
