import type { RunSummary } from '../server/runs';

export type RunFilter = 'all' | 'active' | 'attention' | 'finished';
export function runStatus(run: Pick<RunSummary, 'ended' | 'outcome' | 'level'>) {
  if (run.ended === null) return { key: 'active', label: 'In progress', description: 'Whim is still working on this run.' } as const;
  if (run.outcome === 'timed_out') return { key: 'attention', label: 'Timed out', description: 'This run stopped reporting before it finished.' } as const;
  if (run.outcome === 'llm_failed') return { key: 'attention', label: 'Model failed', description: 'The model could not complete this run. Inspect the recorded error below.' } as const;
  if (run.outcome === 'max_steps') return { key: 'attention', label: 'Step limit reached', description: 'Whim reached its step limit before finishing the turn.' } as const;
  if (run.level === 'error') return { key: 'attention', label: run.outcome === 'replied' ? 'Replied with errors' : 'Ended with errors', description: 'Errors were recorded during this run. Check them before retrying an action.' } as const;
  if (run.outcome === 'replied') return { key: 'finished', label: 'Reply sent', description: 'Whim sent a reply to the chat. This does not by itself confirm a booking or payment.' } as const;
  if (run.outcome === 'silent') return { key: 'finished', label: 'Finished · no reply', description: 'The turn ended without sending a message to the chat.' } as const;
  return { key: 'finished', label: 'Finished', description: 'This run has ended. The activity below shows what was recorded.' } as const;
}
