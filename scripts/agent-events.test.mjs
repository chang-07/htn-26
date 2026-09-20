import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { build } from 'esbuild';
import { eventFromPlan, eventInputSchema, eventItemSchema } from '../src/shared/events.ts';
import { EMPTY_PLAN } from '../src/types.ts';

// Exercise the real agent methods without booting Cloudflare or sending texts.
// Only storage, provider calls and background work are replaced at the boundary.
const source = ts.createSourceFile('agent.ts', fs.readFileSync(new URL('../src/server/agent.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const agent = source.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'PlanAgent');
const names = ['publish', 'runTool', 'syncWebsiteEvent', 'websiteRoster'];
const methods = agent.members.filter(node => names.includes(node.name?.getText(source))).map(node => node.getText(source)).join('\n');
const code = ts.transpileModule(`class Harness { ${methods} }; globalThis.Harness = Harness;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const bundle = await build({ entryPoints: ['src/server/tools/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { parseToolArgs, toolSchemas } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function fixture() {
 const meta = {}, synced = [];
 let roster = [{ handle: '+14165550456', is_me: false }], failure = false;
 const context = { eventFromPlan, eventInputSchema, eventItemSchema, parseToolArgs, toolSchemas, crypto,
  linqClient: () => ({ chats: { retrieve: async () => { if (failure) throw new Error('Linq unavailable'); return { handles: roster }; } } }),
  website: () => ({ syncEvent: async (...args) => synced.push(args) }),
 };
 vm.createContext(context); vm.runInContext(code, context);
 const h = new context.Harness();
 Object.assign(h, { name: '11111111-1111-1111-1111-111111111111', state: { ...EMPTY_PLAN, title: 'Dinner', version: 1 },
  sql: () => [], participants: () => [{ handle: '+14165550123' }], splitNames: () => [],
  getMeta: key => meta[key], setMeta: (key, value) => { meta[key] = value; },
  setState(state) { this.state = state; }, queuePlanMedia() {}, queueWebsiteSync() {},
 });
 const save = item => h.runTool('save_event', JSON.stringify({ event: { title: 'Concert', items: [{ id: 'ride', kind: 'ride', title: 'Taxi', ...item }] } }));
 const update = fields => h.runTool('update_event_item', JSON.stringify({ id: 'ride', fields }));
 return { h, meta, synced, save, update, fail: () => { failure = true; }, roster: value => { roster = value; } };
}

test('publishing a new plan title updates the dashboard without a separate model call', () => {
 const { h } = fixture(); h.publish({}); const id = h.state.event.id;
 h.publish({ title: 'Concert' });
 assert.equal(h.state.event.title, 'Concert'); assert.equal(h.state.event.id, id);
});

test('custom item saves supersede old overrides and preserve valid rescheduled dates', async () => {
 const { h, meta, save, update } = fixture();
 await save({ location: 'Station' }); await update({ location: 'Hotel', startsAt: '2026-10-02T10:00:00Z' });
 h.publish({}); assert.equal(h.state.event.items[0].location, 'Hotel');
 // Simulate overrides persisted by the old implementation.
 meta.event_item_overrides = JSON.stringify({ ride: { location: 'Hotel', startsAt: '2026-10-02T10:00:00Z' } });
 await save({ location: 'Airport', startsAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T11:00:00Z' });
 assert.equal(h.state.event.items[0].location, 'Airport');
 assert.equal(h.state.event.items[0].startsAt, '2026-10-01T10:00:00Z');
 assert.ok(eventInputSchema.safeParse(h.state.event).success);
 assert.deepEqual(JSON.parse(meta.event_item_overrides), {});
 const before = JSON.stringify(h.state);
 await assert.rejects(update({ startsAt: '2026-10-03T10:00:00Z' }));
 assert.equal(JSON.stringify(h.state), before);
});

test('generated item edits survive publish; invalid final documents leave state and overrides untouched', async () => {
 const { h, meta } = fixture();
 h.publish({ itinerary: [{ id: 'ride', kind: 'ride', title: 'Taxi', status: 'confirmed' }] });
 await h.runTool('update_event_item', JSON.stringify({ id: 'itinerary:ride', fields: { location: 'Hotel', startsAt: '2026-10-02T10:00:00Z' } }));
 h.publish({}); assert.equal(h.state.event.items[0].location, 'Hotel');
 const state = JSON.stringify(h.state), overrides = meta.event_item_overrides;
 assert.throws(() => h.publish({}, { 'itinerary:ride': { startsAt: '2026-10-03T10:00:00Z', endsAt: '2026-10-01T10:00:00Z' } }));
 assert.equal(JSON.stringify(h.state), state); assert.equal(meta.event_item_overrides, overrides);
 // Genuine duplicate IDs in the submitted event still fail atomically.
 await assert.rejects(h.runTool('save_event', JSON.stringify({ event: { title: 'Trip', items: [
  { id: 'itinerary:ride', kind: 'ride', title: 'Taxi' },
  { id: 'itinerary:ride', kind: 'ride', title: 'Duplicate' },
 ] } })));
 assert.equal(JSON.stringify(h.state), state);
});

test('save_event can cancel existing options with and without booking links', async () => {
 const { h } = fixture();
 h.publish({ options: [
  { id: 'e765ca88', title: 'Fleetway Fun', bookingUrl: 'https://fleetwayfun.com/groups/booking' },
  { id: '7428feff', title: 'Palasad North', bookingUrl: 'https://example.com/palasad-north' },
  { id: '58c7b0b3', title: 'Palasad South' },
  { id: '7b2b89e8', title: 'Fairmont Lanes' },
 ] });
 const event = { ...h.state.event, title: 'Monday birthday', status: 'cancelled',
  items: h.state.event.items.map(item => ({ ...item, status: 'cancelled' })),
 };
 await h.runTool('save_event', JSON.stringify({ event }));
 h.publish({});
 assert.equal(h.state.event.status, 'cancelled');
 assert.equal(h.state.event.items.length, 4);
 assert.equal(new Set(h.state.event.items.map(item => item.id)).size, 4);
 assert.ok(h.state.event.items.every(item => item.status === 'cancelled'));
 assert.ok(eventInputSchema.safeParse(h.state.event).success);
});

test('saved itinerary and cart items override generated copies by ID even when links change', async () => {
 const { h, meta } = fixture();
 h.publish({
  itinerary: [{ id: 'ride', kind: 'ride', title: 'Taxi', status: 'confirmed' }],
  carts: [{ shop: 'pizza.test', total: '$40', checkoutUrl: 'https://pizza.test/checkout', lines: [] }],
 });
 await h.runTool('update_event_item', JSON.stringify({ id: 'itinerary:ride', fields: { location: 'Old pickup' } }));
 await h.runTool('save_event', JSON.stringify({ event: { title: 'Updated plan', items:
  h.state.event.items.map(item => ({ ...item, status: 'cancelled', location: 'New pickup', links: [] })),
 } }));
 h.publish({});
 assert.equal(h.state.event.items.length, 2);
 assert.ok(h.state.event.items.every(item => item.status === 'cancelled' && item.location === 'New pickup' && item.links.length === 0));
 assert.deepEqual(JSON.parse(meta.event_item_overrides), {});
});

test('sync uses current roster, excludes former participants and fails closed during provider outages', async () => {
 const { h, synced, roster, fail } = fixture();
 h.publish({}); await h.syncWebsiteEvent();
 assert.deepEqual(Array.from(synced[0][1]), ['+14165550456']);
 roster([{ handle: '+14165550456', left_at: 'today' }, { handle: '+14165550999', is_me: true }]);
 h.publish({ title: 'New plan' }); await h.syncWebsiteEvent();
 assert.equal(synced[1][1].length, 0); assert.ok(synced[1][2] > synced[0][2]);
 fail(); h.publish({ title: 'Private update' });
 await assert.rejects(h.syncWebsiteEvent(), /Linq unavailable/);
 assert.equal(synced.length, 2);
});

test('local demo agents do not block backfill or call the roster provider', async () => {
 const { h, synced, fail } = fixture(); h.name = 'local-demo'; h.publish({}); fail();
 await h.syncWebsiteEvent(); assert.equal(synced.length, 0);
});
