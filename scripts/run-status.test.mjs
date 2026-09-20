import test from 'node:test';
import assert from 'node:assert/strict';
import { runStatus } from '../src/shared/run-status.ts';

test('telemetry distinguishes active work, failed outcomes and replies containing errors', () => {
 assert.equal(runStatus({ ended: null, outcome: null, level: 'info' }).key, 'active');
 for (const outcome of ['timed_out', 'llm_failed', 'max_steps']) {
  assert.equal(runStatus({ ended: 100, outcome, level: 'info' }).key, 'attention');
 }
 assert.equal(runStatus({ ended: 100, outcome: 'replied', level: 'error' }).label, 'Replied with errors');
 assert.equal(runStatus({ ended: 100, outcome: 'silent', level: 'info' }).label, 'Finished · no reply');
 const replied = runStatus({ ended: 100, outcome: 'replied', level: 'info' });
 assert.equal(replied.label, 'Reply sent');
 assert.match(replied.description, /does not.*confirm a booking or payment/);
});

test('summary shows unfinished operations only for active runs and exposes the error action', async () => {
 const { build } = await import('esbuild');
 const { createElement } = await import('react');
 const { renderToStaticMarkup } = await import('react-dom/server');
 const bundle = await build({ entryPoints: ['src/client/RunOverview.tsx'], bundle: true, write: false, format: 'esm', platform: 'node', packages: 'external' });
 // Use a temporary module within the project so React resolves to the same copy.
 const fs = await import('node:fs/promises');
 const file = new URL(`../node_modules/.whim-run-overview-${process.pid}.mjs`, import.meta.url);
 await fs.writeFile(file, bundle.outputFiles[0].text);
 try {
  const { RunOverview } = await import(file.href);
  const run = { runId: 'test', started: 100, ended: null, outcome: null, level: 'error', tools: ['shop_search'], events: 2 };
  const events = [
   { seq: 1, ts: 110, event: 'trace.start', level: 'info', fields: { traceId: 'a', spanId: 'b', op: 'http.client', operation: 'shop_search' } },
   { seq: 2, ts: 120, event: 'trace.end', level: 'error', fields: { traceId: 'a', spanId: 'c', status: 'error', operation: 'provider.request' } },
  ];
  const render = value => renderToStaticMarkup(createElement(RunOverview, { run: value, events, onPick() {} }));
  assert.match(render(run), /Started; no completion recorded yet/);
  assert.match(render(run), /Inspect error/);
  const finished = render({ ...run, ended: 150, outcome: 'timed_out' });
  assert.match(finished, /Timed out/);
  assert.doesNotMatch(finished, /Started; no completion recorded yet/);
 } finally { await fs.unlink(file); }
});
