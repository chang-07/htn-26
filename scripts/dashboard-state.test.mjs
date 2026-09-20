import test from 'node:test';
import assert from 'node:assert/strict';
import { initialDashboard, readDashboard } from '../src/client/dashboard-state.ts';

test('new and invalid workspaces contain no demo content', () => {
  for (const value of [null, 'invalid', '{}']) {
    const data = readDashboard(value);
    assert.deepEqual(data.widgets, []);
    assert.deepEqual(data.plans, []);
    assert.deepEqual(data.friends, []);
  }
});

test('loading an existing workspace removes samples and preserves personal content', () => {
  const widget = { id: 'mine', title: 'Dinner', question: 'Where?', options: ['Pizza', 'Ramen'], kind: 'Poll', sample: false };
  const editedSample = { ...widget, id: 'sample-memory', title: 'My edited game' };
  const workspace = {
    ...initialDashboard,
    account: { ...initialDashboard.account, name: 'Jack' },
    friends: [{ id: 'friend', name: 'Alex', food: '', budget: 'Flexible' }],
    plans: [{ id: 'plan', agent: 'group' }],
    widgets: [widget, editedSample, ...['sample-game', 'sample-poll', 'sample-memory'].map(id => ({ ...widget, id, sample: true }))],
  };
  assert.deepEqual(readDashboard(JSON.stringify(workspace)), { ...workspace, widgets: [widget, editedSample] });
});
