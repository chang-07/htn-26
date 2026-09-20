import type { DiagnosticEvent } from './run-diagnostics';

const words = (value: string) => value.replace(/[._]/g, ' ').replace(/^./, char => char.toUpperCase());
const text = (value: unknown) => typeof value === 'string' ? value : '';
const tools: Record<string, string> = {
  make_game: 'Create a game', send_message: 'Send a reply', research: 'Research options',
  propose_plan: 'Present plan options', book_option: 'Attempt a reservation',
  shop_search: 'Search for products', shop_build_cart: 'Build a shopping cart',
  search_flights: 'Search for flights', search_stays: 'Search for hotels',
  save_event: 'Save the event', update_event_item: 'Update an event item',
};
export const toolLabel = (name: string) => tools[name] ?? words(name);

/**
 * These tools only enqueue a durable workflow. Their `agent.tool` span ends
 * when that hand-off succeeds, not when the user-facing work is complete.
 * Calling the span "finished" made a healthy research run look as though it
 * had ended before the later research events (and follow-up turn) arrived.
 */
const backgroundToolEnd: Record<string, { title: string; sub: string }> = {
  research: {
    title: 'Research started in background',
    sub: 'The search is still running; its findings will trigger a follow-up turn.',
  },
  check_availability: {
    title: 'Availability check started in background',
    sub: 'The check is still running; its result will trigger a follow-up turn.',
  },
  book_option: {
    title: 'Reservation attempt started in background',
    sub: 'The booking workflow is still running; its result will trigger a follow-up turn.',
  },
};

/** Describe the recorded operation, without treating an HTTP success as task success. */
export function traceLabel(event: Pick<DiagnosticEvent, 'event' | 'fields' | 'level'>): { title: string; sub: string } | undefined {
  const f = event.fields;
  const model = text(f.model);
  const provider = text(f.provider) === 'api.openai.com' ? 'OpenAI' : text(f.provider) || 'External service';
  if (event.event === 'provider.response') {
    const code = typeof f.statusCode === 'number' ? f.statusCode : null;
    return { title: code === null ? `${provider} responded` : code >= 200 && code < 300 ? `${provider} responded successfully` : `${provider} returned HTTP ${code}`, sub: code === null ? 'A response was received from the service.' : `HTTP ${code} · service response, not the final task result` };
  }
  if (event.event === 'trace.start' || event.event === 'trace.end') {
    const started = event.event === 'trace.start';
    const failed = f.status === 'error' || event.level === 'error';
    const operation = text(f.operation);
    const titles: Record<string, [string, string]> = {
      'provider.request': ['Contacting an external service', 'API request completed'],
      'agent.model': ['Model is choosing what to do next', 'Model finished choosing its next action'],
      'llm.json': ['Model is generating structured data', 'Model returned structured data'],
      'agent.tool': ['Action started', 'Action finished'],
      'agent.turn': ['Whim started working on this turn', 'Whim finished this turn'],
    };
    const pair = titles[operation];
    const action = operation === 'agent.tool' && typeof f.tool === 'string' ? toolLabel(f.tool) : undefined;
    const background = !started && !failed && operation === 'agent.tool' && typeof f.tool === 'string' ? backgroundToolEnd[f.tool] : undefined;
    if (background) return background;
    const title = failed ? `${action ?? words(operation || 'Operation')} failed` : action ? `${action} · ${started ? 'started' : 'finished'}` : pair?.[started ? 0 : 1] ?? `${words(operation || 'Operation')} · ${started ? 'started' : 'finished'}`;
    const explanation = failed ? text(f.error) || text(f.errorType) || 'Open this event to inspect the failure.'
      : operation === 'agent.model' ? 'The next decision event shows which action it selected.'
      : operation === 'llm.json' ? started ? 'Generating data for the requested task.' : 'Response received; validation happens next.'
      : operation === 'provider.request' ? `${provider} · one network request`
      : operation === 'agent.tool' ? started ? 'The selected action is executing.' : 'Execution ended; inspect the action result for its outcome.' : '';
    return { title, sub: [model, explanation].filter(Boolean).join(' · ') };
  }
  if (event.event === 'turn.step') {
    const calls = Array.isArray(f.calls) ? f.calls.filter((call): call is string => typeof call === 'string') : [];
    return { title: calls.length ? `Next action: ${calls.map(toolLabel).join(', ')}` : 'No further action selected', sub: `Decision ${f.step ?? '?'} · ${calls.length ? 'The model selected this action; it has not finished yet.' : 'The model returned no tool calls.'}` };
  }
  if (event.event === 'tool') return { title: toolLabel(text(f.tool) || 'tool'), sub: 'Action execution recorded · open for inputs and results' };
  if (event.event === 'llm.usage') return { title: 'Model usage recorded', sub: [model, 'Tokens consumed by this model response'].filter(Boolean).join(' · ') };
  if (event.event === 'llm.validation_failed') return { title: 'Model output did not match the required format', sub: f.retry === true ? 'Requesting a corrected response.' : 'No more validation retries remain.' };
  if (event.event === 'game.created') return { title: 'Game created', sub: [text(f.title), text(f.kind) ? words(text(f.kind)) : '', typeof f.rounds === 'number' ? `${f.rounds} rounds` : ''].filter(Boolean).join(' · ') };
  return undefined;
}
