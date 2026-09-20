/**
 * Which of a step's tool calls are fetched together.
 *
 * The model often asks for several lookups in one step: flights and a hotel,
 * two stores, a place and its weather. Each is a network round trip that reads
 * nothing another tool in the step could change and changes nothing another
 * tool reads, so they are all started at once and the step costs one wait
 * instead of several. Everything else keeps its place in the loop, where order
 * is the point: a text follows the work it reports on, a card follows the plan
 * edit it draws, a tally is read after the ballot it counts.
 *
 * Kept apart from the agent so the rule can be tested without a Durable Object.
 */
export const CONCURRENT_TOOLS: ReadonlySet<string> = new Set([
  "shop_search",
  "find_matches",
  "search_flights",
  "search_stays",
  "find_events",
  "find_locations",
  "get_weather",
]);

export type ToolCall = { id: string; function: { name: string } };

/**
 * Starts every concurrent-safe call in the step, when there is more than one
 * of them, and returns the promises by call id. A lone lookup gains nothing
 * from starting early, so a step with one is left entirely to the ordered loop.
 * Each started promise carries a no-op catch: the loop may end the turn before
 * it reaches that call, and an unread rejection must not surface as unhandled.
 * The loop still awaits the same promise, so it still sees the error.
 */
export function startConcurrent<T extends ToolCall>(
  calls: readonly T[],
  run: (call: T) => Promise<string>,
  concurrent: ReadonlySet<string> = CONCURRENT_TOOLS,
): Map<string, Promise<string>> {
  const early = new Map<string, Promise<string>>();
  if (calls.filter((c) => concurrent.has(c.function.name)).length < 2) return early;
  for (const call of calls) {
    if (!concurrent.has(call.function.name)) continue;
    const started = run(call);
    started.catch(() => {});
    early.set(call.id, started);
  }
  return early;
}
