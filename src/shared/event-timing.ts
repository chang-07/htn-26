export function eventTimings<T extends { ts: number }>(events: T[], started: number) {
  return events.map((event, index) => ({
    ...event,
    gapMs: Math.max(0, event.ts - (events[index - 1]?.ts ?? started)),
    totalMs: Math.max(0, event.ts - started),
    firstEvent: index === 0,
  }));
}

export function elapsedLabel(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 1000) return `${Math.round(safe)}ms`;
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`;
  const seconds = Math.floor(safe / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`;
}
