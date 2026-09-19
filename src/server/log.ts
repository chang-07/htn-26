/**
 * One log shape everywhere: `scope event {fields}`.
 *
 *   linq   webhook.received {type:"message.received", chat:"62c58f3a"}
 *   agent  turn.end         {chat:"62c58f3a", outcome:"silent", ms:4210, tokens:1873}
 *
 * The event name is a stable, greppable identifier; everything variable goes
 * in fields. Locally this reads well in the terminal; deployed, Workers Logs
 * indexes the fields object, so `wrangler tail` and the dashboard can filter
 * on it.
 *
 * Privacy: phone numbers go through `mask()`, and message bodies are logged as
 * lengths, never content.
 */
export type Level = "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

export const mask = (handle?: string | null) => (handle ? `…${handle.slice(-4)}` : "?");
export const short = (id?: string | null) => (id ? id.slice(0, 8) : "?");

export function errorFields(err: unknown): Fields {
  if (err instanceof Error) {
    // Keep the top of the stack: enough to locate the throw, not a wall of text.
    return { error: err.message, stack: err.stack?.split("\n").slice(1, 4).join(" | ") };
  }
  return { error: String(err) };
}

export function log(level: Level, scope: string, event: string, fields: Fields = {}) {
  // One line per event: console's object pretty-printing spreads fields over
  // several lines, which defeats grep.
  const line = `${scope.padEnd(6)} ${event.padEnd(22)} ${JSON.stringify(fields)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Times an async step and logs `<event>` with ms, or `<event>.failed` with the error. */
export async function timed<T>(
  scope: string,
  event: string,
  fields: Fields,
  run: () => Promise<T>,
  sink: (level: Level, event: string, fields: Fields) => void = (l, e, f) => log(l, scope, e, f),
): Promise<T> {
  const started = Date.now();
  try {
    const result = await run();
    sink("info", event, { ...fields, ms: Date.now() - started });
    return result;
  } catch (err) {
    sink("error", `${event}.failed`, { ...fields, ms: Date.now() - started, ...errorFields(err) });
    throw err;
  }
}
