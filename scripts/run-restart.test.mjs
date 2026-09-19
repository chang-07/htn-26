import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// The real recorder, with the hub replaced by a list of what it was sent.
const sent = [];
globalThis.__hub = { ingest: async (msg) => void sent.push(msg) };
const bundle = await build({ entryPoints: ["src/server/runs.ts"], bundle: true, write: false, format: "esm", platform: "node", plugins: [{
  name: "agent-runtime", setup(b) {
    b.onResolve({ filter: /^agents$/ }, () => ({ path: "agents", namespace: "mock" }));
    b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export class Agent {} export const getAgentByName = async () => globalThis.__hub;", loader: "js" }));
  },
}] });
const { RunRecorder } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("a turn retried after a restart stays in the run its message opened", async (t) => {
  // The unclaimed-event timer is not under test, and would hold the process open.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let kept;
  const memory = { load: () => kept, save: (json) => { kept = json; } };
  const pending = [];
  const recorder = () => new RunRecorder({}, "chat", (p) => pending.push(p), memory);

  const first = recorder();
  first.record("info", "turn.start", {});
  first.record("info", "turn.end", { outcome: "replied" });
  first.record("info", "message.in", { text: "yes" });
  first.record("info", "turn.start", {});

  // The object is restarted mid-turn; the turn runs again from the top.
  const second = recorder();
  second.record("info", "turn.start", {});
  second.record("info", "message.out", {});
  second.record("info", "turn.end", { outcome: "replied" });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

  const opens = sent.filter((m) => m.kind === "open").map((m) => m.run.runId);
  assert.equal(opens.length, 2);
  const closes = sent.filter((m) => m.kind === "close").map((m) => m.run.runId);
  assert.deepEqual(closes, opens, "the interrupted run is the one that closes");
  const seqs = sent.filter((m) => m.kind === "events").flatMap((m) => m.events).filter((e) => e.runId === opens[1]).map((e) => e.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [...seqs.keys()], "no sequence number is reused");
});
