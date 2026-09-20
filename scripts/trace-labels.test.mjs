import test from 'node:test';
import assert from 'node:assert/strict';
import { traceLabel } from '../src/shared/trace-labels.ts';

const label = (event, fields, level = 'info') => traceLabel({ event, fields, level });
test('game creation trace distinguishes a model decision, generation and the actual result', () => {
 const decision = label('turn.step', { step: 1, calls: ['make_game'] });
 assert.equal(decision.title, 'Next action: Create a game');
 assert.match(decision.sub, /has not finished yet/);
 const response = label('trace.end', { operation: 'llm.json', status: 'ok', model: 'test-model' });
 assert.match(response.sub, /validation happens next/);
 assert.equal(label('llm.usage', { model: 'test-model' }).title, 'Model usage recorded');
 const result = label('game.created', { title: 'Friday trivia', kind: 'trivia', rounds: 5 });
 assert.equal(result.title, 'Game created');
 assert.equal(result.sub, 'Friday trivia · Trivia · 5 rounds');
});
test('network success is distinct from task success and failures remain explicit', () => {
 const response = label('provider.response', { provider: 'api.openai.com', statusCode: 200 });
 assert.equal(response.title, 'OpenAI responded successfully');
 assert.match(response.sub, /not the final task result/);
 assert.equal(label('provider.response', { provider: 'api.openai.com', statusCode: 429 }).title, 'OpenAI returned HTTP 429');
 const failure = label('trace.end', { operation: 'agent.tool', tool: 'make_game', status: 'error', error: 'Invalid configuration' }, 'error');
 assert.equal(failure.title, 'Create a game failed');
 assert.equal(failure.sub, 'Invalid configuration');
 assert.match(label('turn.step', { step: 2, calls: [] }).sub, /no tool calls/);
 assert.equal(label('llm.validation_failed', { retry: true }).sub, 'Requesting a corrected response.');
});
