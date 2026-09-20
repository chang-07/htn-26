# Latency eval

How long the harness takes to answer, and what a burst of texts costs, with the
model and Linq taken out: dry transport, and a stub model that always answers in
300ms. The only thing that differs between two runs is the harness.

```sh
node scripts/latency-eval/stub-llm.mjs            # terminal 1: the stub model, on :18080
# .dev.vars: DEV_LLM_BASE_URL=http://127.0.0.1:18080/v1  DEV_LLM_MODEL=stub  (and no LINQ_API_KEY)
npx vite dev --port 5183 --strictPort             # terminal 2
node scripts/latency-eval/run.mjs 5183 mylabel 8  # single texts and bursts: latency, turns, replies
node scripts/latency-eval/seen.mjs 5183 mylabel   # how much of a burst the first turn read
```

To compare two commits, run them one at a time (two dev servers fight over the
inspector port, and share a CPU). The 10-text burst outruns the dev log's
buffer, so read its turn and reply counts, not its timings.
