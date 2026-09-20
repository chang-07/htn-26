/** Generous enough for the longest booking/research workflows; never extends on progress. */
export const RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const RUN_TIMEOUT_MESSAGE = "No completion was recorded within the 30-minute limit.";

/** A delayed HTTP snapshot must not resurrect a run already closed by the live feed. */
export function mergeRunState<T extends { ended: number | null; outcome: string | null }>(current: T | undefined, incoming: T): T {
  if (!current) return incoming;
  if (current.outcome === "timed_out" && incoming.outcome !== "timed_out") return current;
  if (current.ended !== null && incoming.ended === null) return current;
  return incoming;
}
