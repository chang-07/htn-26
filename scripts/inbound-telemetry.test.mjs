import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Run the real ingress methods with storage and external effects stubbed.
const source = ts.createSourceFile('agent.ts', fs.readFileSync(new URL('../src/server/agent.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const agent = source.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'PlanAgent');
const methods = agent.members.filter(node => ['ingestMessage', 'wakeReason', 'body'].includes(node.name?.getText(source))).map(node => node.getText(source)).join('\n');
const code = ts.transpileModule(`class Harness { ${methods} }; globalThis.Harness = Harness;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture({ payment = false, duplicate = false, bodies = true, fail = false } = {}) {
  const context = { mask: () => 'masked', short: value => value, ANSWER_WINDOW_MAX_WAKES: 3 };
  vm.createContext(context); vm.runInContext(code, context);
  const h = new context.Harness(), events = [], calls = [], meta = {};
  Object.assign(h, {
    env: { LOG_BODIES: String(bodies) }, sql: query => query.join('').includes('SELECT 1') && duplicate ? [{}] : [],
    getMeta: key => meta[key], setMeta: (key, value) => { meta[key] = value; },
    queueWebsiteSync() {}, isOwnMessage: () => false,
    note: (level, event, fields) => { events.push({ level, event, fields }); calls.push(event); },
    resetChat: async () => { calls.push('reset'); }, say: async () => {},
    handlePayText: async () => { calls.push('payment'); if (fail) throw new Error('payment failed'); return payment; },
    typing: async () => {}, acknowledge: async () => {}, ctx: { waitUntil() {} },
    handlePaymentSetup: async () => false, schedule: async () => { calls.push('schedule'); }, clearTyping: async () => {},
  });
  const send = (text, extra = {}) => h.ingestMessage({ linqId: 'message-1', from: '+14165550123', text, isGroup: false, ...extra });
  return { events, calls, meta, send };
}

test('payment and reset commands record inbound text before their early returns', async () => {
  for (const [text, payment, handler] of [['pay', true, 'payment'], ['/reset', false, 'reset']]) {
    const f = fixture({ payment });
    await f.send(text);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].event, 'message.in');
    assert.equal(f.events[0].fields.text, text);
    assert.ok(f.calls.indexOf('message.in') < f.calls.indexOf(handler));
    assert.ok(!f.calls.includes('schedule'));
  }
});

test('receipt survives a command failure', async () => {
  const f = fixture({ fail: true });
  await assert.rejects(f.send('pay'), /payment failed/);
  assert.equal(f.events[0].fields.text, 'pay');
});

test('ordinary messages and group chatter are each recorded once with existing wake behavior', async () => {
  const direct = fixture(); await direct.send('hello');
  assert.equal(direct.events.length, 1); assert.equal(direct.events[0].event, 'message.in');
  assert.ok(direct.calls.includes('schedule'));
  const group = fixture(); await group.send('hello', { isGroup: true });
  assert.equal(group.events.length, 1); assert.equal(group.events[0].event, 'message.stored');
  assert.ok(!group.calls.includes('schedule'));
});

test('commands do not consume the group answer window; conversational replies still do', async () => {
  for (const payment of [true, false]) {
    const f = fixture({ payment });
    f.meta.awaiting_answer_until = String(Date.now() + 60_000);
    f.meta.awaiting_answer_wakes = '2';
    await f.send(payment ? 'pay' : 'yes', { isGroup: true });
    assert.equal(f.meta.awaiting_answer_wakes, payment ? '2' : '3');
    assert.equal(f.meta.awaiting_answer_until === '0', !payment);
  }
});

test('duplicate suppression and disabled body logging still apply', async () => {
  const duplicate = fixture({ duplicate: true }); await duplicate.send('pay');
  assert.equal(duplicate.events.length, 1); assert.equal(duplicate.events[0].event, 'message.duplicate');
  const privateLog = fixture({ payment: true, bodies: false }); await privateLog.send('pay');
  assert.equal(privateLog.events[0].fields.text, undefined);
  assert.equal(privateLog.events[0].fields.chars, 3);
});
