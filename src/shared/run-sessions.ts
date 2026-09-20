import type { RunSummary } from '../server/runs';
import type { DiagnosticEvent } from './run-diagnostics';

export type RunSession = { id: string; chat: string; runs: RunSummary[]; from: number; to: number };
export const SESSION_GAP = 20 * 60 * 1000;

/** Group before filtering: hiding a turn must never split one conversation. */
export function groupIntoSessions(runs: RunSummary[]): RunSession[] {
  const byChat = new Map<string, RunSummary[]>();
  for (const run of new Map(runs.map(run => [run.runId, run])).values()) {
    const list = byChat.get(run.chat) ?? [];
    list.push(run); byChat.set(run.chat, list);
  }
  const sessions: RunSession[] = [];
  for (const [chat, list] of byChat) {
    let current: RunSession | undefined;
    let lastActivity = 0;
    for (const run of list.sort((a, b) => a.started - b.started || a.runId.localeCompare(b.runId))) {
      if (!current || run.started - lastActivity > SESSION_GAP) {
        current = { id: `${chat}:${run.runId}`, chat, runs: [], from: run.started, to: run.started };
        sessions.push(current);
      }
      current.runs.unshift(run);
      current.to = Math.max(current.to, run.started);
      lastActivity = Math.max(lastActivity, run.ended ?? run.started);
    }
  }
  return sessions.sort((a, b) => b.to - a.to);
}

export function sessionSummary(session: RunSession): RunSummary {
  const latest = session.runs.find(run => run.outcome !== 'background') ?? session.runs[0];
  const active = session.runs.some(run => run.ended === null);
  const ended = active ? null : Math.max(...session.runs.map(run => run.ended!));
  return {
    ...latest, runId: session.id, started: session.from, ended,
    outcome: active ? null : latest.outcome,
    level: session.runs.some(run => run.level === 'error' || ['timed_out', 'llm_failed', 'max_steps'].includes(run.outcome ?? '')) ? 'error' : latest.level,
    said: [...session.runs].reverse().find(run => run.said)?.said,
    ms: ended === null ? null : ended - session.from,
    tokens: session.runs.reduce((sum, run) => sum + (run.tokens ?? 0), 0),
    steps: session.runs.reduce((sum, run) => sum + (run.steps ?? 0), 0),
    tools: [...new Set(session.runs.flatMap(run => run.tools))],
    events: session.runs.reduce((sum, run) => sum + run.events, 0),
  };
}

/** Sequence numbers are local to a run; identical numbers in other turns are distinct. */
export function sessionEvents(session: RunSession, events: Record<string, DiagnosticEvent[]>) {
  const unique = new Map<string, DiagnosticEvent & { sourceRunId: string; sourceSeq: number }>();
  for (const run of session.runs) for (const event of events[run.runId] ?? []) {
    unique.set(`${run.runId}:${event.seq}`, { ...event, sourceRunId: run.runId, sourceSeq: event.seq });
  }
  return [...unique.values()].sort((a, b) => a.ts - b.ts || a.sourceRunId.localeCompare(b.sourceRunId) || a.sourceSeq - b.sourceSeq);
}
