import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

// Isolate the actual request guard from the Cloudflare-only storage runtime.
const source = ts.createSourceFile('runs.ts', fs.readFileSync(new URL('../src/server/runs.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const guard = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'requireRunsAuth');
const code = ts.transpileModule(guard.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { requireRunsAuth } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const env = { RUNS_TOKEN: 'test-operator-token' };

test('telemetry history and live connections are public with an operator token configured', () => {
 for (const path of ['/api/runs', '/api/runs/example', '/agents/run-hub/global']) {
  const url = new URL(path, 'https://whim.test');
  assert.equal(requireRunsAuth(new Request(url), url, env), null);
 }
 const url = new URL('https://whim.test/api/runs');
 assert.equal(requireRunsAuth(new Request(url, { method: 'HEAD' }), url, env), null);
});

test('removing the viewer password does not unlock cart edits or chat resets', () => {
 for (const path of ['/api/runs/cart', '/api/runs/reset/example']) {
  const url = new URL(path, 'https://whim.test');
  assert.equal(requireRunsAuth(new Request(url, { method: 'POST' }), url, env)?.status, 401);
  assert.equal(requireRunsAuth(new Request(url, { method: 'POST', headers: { authorization: 'Bearer test-operator-token' } }), url, env), null);
 }
});
