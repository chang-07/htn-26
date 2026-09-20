import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const modules = {
  "agents/workflows": "export class AgentWorkflow {}",
  "./live-agent": "export const liveAgent = () => globalThis.researchDeps.live;",
  "./llm": "export const askJson = (...a) => globalThis.researchDeps.askJson(...a);",
  "./browser": "export const TABS = 3; export const pooled = (items, n, fn) => Promise.all(items.map(fn)); export const openBrowser = () => { throw Error('unexpected browser'); }; export const readPage = () => {}; export const searchWeb = () => {};",
  "./browserbase/agent": "export const planBrowserbase = async () => ({ skill: null, tokens: 0 }); export const readWithBrowserbase = () => {};",
  "./log": "export const log = () => {}; export const errorFields = (e) => ({ error: e.message });",
  "./telemetry": "export const telemetryScope = (_, fn) => fn(); export const traceOperation = (a, b, c, fn) => fn(); export const traceWorkflowSteps = s => s;",
};
const bundle = await build({ entryPoints: ["src/server/research.ts"], bundle: true, write: false, format: "esm", platform: "node", plugins: [{
  name: "workflow-providers", setup(b) {
    b.onResolve({ filter: /.*/ }, ({ path }) => {
      const key = path.replace(/\.ts$/, "");
      if (modules[key]) return { path: key, namespace: "mock" };
    });
    b.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents: modules[path], loader: "js" }));
  },
}] });
const { ResearchWorkflow } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

async function run(t, { key = true, sourceScore = 3, candidateScore = 3 } = {}) {
  const calls = [];
  const candidate = { name: "Real venue", kind: "activity", why: "Fits", address: "Toronto", details: ["Saturday"], bookingUrl: "https://venue.test/book" };
  globalThis.researchDeps = {
    live: { researchProgress: async () => {}, researchFinished: async () => {} },
    askJson: async (_env, _schema, system) => {
      if (system.startsWith("You plan web research")) { calls.push("plan"); return { value: { queries: ["Toronto activities"] }, tokens: 1 }; }
      if (system.startsWith("Pick the")) { calls.push("llm-select"); return { value: { indexes: [0] }, tokens: 1 }; }
      if (system.startsWith("Extract specific")) { calls.push("extract"); return { value: { candidates: [candidate] }, tokens: 1 }; }
      calls.push("synthesize"); return { value: { summary: "A matching activity", ranked: [{ indexes: [0], why: "Fits" }] }, tokens: 1 };
    },
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    let response;
    if (url.endsWith("/search")) { calls.push("search"); response = { results: [{ url: "https://venue.test/", title: "Real venue", snippet: "Toronto" }] }; }
    else if (url.endsWith("/fetch")) { calls.push("fetch"); response = { statusCode: 200, content: "Real venue in Toronto on Saturday" }; }
    else {
      const extracted = body.questions.hit_0.instructions.includes("extracted candidate");
      calls.push(extracted ? "jev-candidate" : "jev-source");
      response = { answers: { hit_0: { type: "score", score: extracted ? candidateScore : sourceScore, confidence: 1 } } };
    }
    return new Response(JSON.stringify(response));
  });
  const workflow = new ResearchWorkflow();
  workflow.env = { BROWSERBASE_API_KEY: "bb-test", ...(key ? { AI_GATEWAY_API_KEY: "jev-test" } : {}) };
  const report = await workflow.run({ payload: { brief: "An outing", near: "Toronto", depth: "quick" } }, { do: async (_name, ...args) => args.at(-1)() });
  return { calls, report };
}

test("research falls back to LLM selection, never calling Jev, when it is unconfigured", async (t) => {
  const { calls, report } = await run(t, { key: false });
  assert.deepEqual(calls, ["plan", "search", "llm-select", "fetch", "extract", "synthesize"]);
  assert.equal(report.ok, true);
  assert.equal(report.candidates[0].bookingUrl, "https://venue.test/book");
});

test("rejected sources never reach Fetch or specialist extraction", async (t) => {
  const { calls, report } = await run(t, { sourceScore: 0 });
  assert.deepEqual(calls, ["plan", "search", "jev-source"]);
  assert.equal(report.ok, false);
});

test("rejected extracted options never reach synthesis or chat recommendations", async (t) => {
  const { calls, report } = await run(t, { candidateScore: 0 });
  assert.deepEqual(calls, ["plan", "search", "jev-source", "fetch", "extract", "jev-candidate"]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.candidates, []);
});

test("accepted results pass both Jev gates before synthesis with original facts intact", async (t) => {
  const { calls, report } = await run(t);
  assert.deepEqual(calls, ["plan", "search", "jev-source", "fetch", "extract", "jev-candidate", "synthesize"]);
  assert.equal(report.ok, true);
  assert.equal(report.candidates[0].bookingUrl, "https://venue.test/book");
  assert.deepEqual(report.candidates[0].sources, ["https://venue.test/"]);
});
