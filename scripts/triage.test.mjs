import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// triage.ts imports llm.ts (openai, telemetry); bundled for node like research's tests, with the model client never called.
const bundle = await build({ entryPoints: ["src/server/triage.ts"], bundle: true, write: false, format: "esm", platform: "node", external: ["@sentry/cloudflare", "cloudflare:*"] });
const { routeByReason, parseLanes, settleRoute, routeTurn } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const EVERY = ["venues", "trip", "shop", "money", "people", "fun"];
const input = { direct: false, transcript: "…1111: dinner friday?", plan: "none yet", hasCarts: false, hasItinerary: false, hasResearch: false };
const env = {};

test("a tally wake is routed in code: trip when the lone winner is a flight, stay or event, venues otherwise", () => {
  assert.deepEqual(routeByReason({ reason: "votes_in", winnerKind: "flight" }), ["trip"]);
  assert.deepEqual(routeByReason({ reason: "votes_in" }), ["venues"]);
});

test("an availability wake only speaks: core alone", () => {
  assert.deepEqual(routeByReason({ reason: "availability_in" }), []);
});

test("a message wake leaves the decision to triage", () => {
  assert.equal(routeByReason({ reason: "" }), undefined);
});

test("unknown lane names are dropped, core is never a choice, order is the catalogue's", () => {
  assert.deepEqual(parseLanes({ lanes: ["shop", "core", "flights", "trip", "shop"] }), ["trip", "shop"]);
});

test("an answer without a lanes array means every lane", () => {
  assert.equal(parseLanes({ lane: "shop" }), undefined);
  assert.equal(parseLanes(null), undefined);
  assert.equal(parseLanes("shop"), undefined);
  assert.deepEqual(parseLanes({ lanes: [] }), []);
});

const routed = (lanes, source = "triage") => ({ lanes, source, tokens: 0, ms: 0, silent: false });

test("a direct chat still onboarding, or with an intro waiting, always has the people lane", () => {
  assert.deepEqual(settleRoute(routed(["shop"]), { direct: true, onboarding: true, pendingIntro: false }).lanes, ["shop", "people"]);
  assert.deepEqual(settleRoute(routed([]), { direct: true, onboarding: false, pendingIntro: true }).lanes, ["people"]);
  assert.deepEqual(settleRoute(routed(["people"]), { direct: true, onboarding: true, pendingIntro: false }).lanes, ["people"]);
  // In a group there is nobody to onboard.
  assert.deepEqual(settleRoute(routed(["shop"]), { direct: false, onboarding: true, pendingIntro: false }).lanes, ["shop"]);
});

test("only a group turn that triage found nothing in goes silent; a direct chat always gets a reply", () => {
  assert.equal(settleRoute(routed([]), { direct: false, onboarding: false, pendingIntro: false }).silent, true);
  assert.equal(settleRoute(routed([]), { direct: true, onboarding: false, pendingIntro: false }).silent, false);
  assert.equal(settleRoute(routed(["shop"]), { direct: false, onboarding: false, pendingIntro: false }).silent, false);
  // A fallback or a fixed reason never goes silent, whatever the lanes.
  assert.equal(settleRoute(routed([], "reason"), { direct: false, onboarding: false, pendingIntro: false }).silent, false);
  assert.equal(settleRoute(routed([], "fallback"), { direct: false, onboarding: false, pendingIntro: false }).silent, false);
});

test("AGENT_PIPELINE=single runs every lane without asking anything", async () => {
  let asked = 0;
  const route = await routeTurn({ AGENT_PIPELINE: "single" }, { reason: "" }, input, { ask: async () => (asked++, { value: { lanes: ["shop"] }, tokens: 1 }) });
  assert.equal(asked, 0);
  assert.equal(route.source, "single");
  assert.deepEqual(route.lanes, EVERY);
});

test("a fixed wake reason is answered without a model call", async () => {
  let asked = 0;
  const route = await routeTurn(env, { reason: "votes_in", winnerKind: "stay" }, input, { ask: async () => (asked++, { value: { lanes: [] }, tokens: 1 }) });
  assert.equal(asked, 0);
  assert.deepEqual(route, { lanes: ["trip"], source: "reason", tokens: 0, ms: 0, silent: false });
});

test("the triage answer's lanes, tokens and reason are carried, and the model saw the catalogue and the transcript", async () => {
  let seen;
  const ask = async (_env, _schema, system, user) => {
    seen = { system, user: JSON.parse(user) };
    return { value: { lanes: ["trip", "shop"], why: "flights and balloons" }, tokens: 321 };
  };
  const route = await routeTurn(env, { reason: "" }, { ...input, direct: true, hasCarts: true }, { ask });
  assert.deepEqual(route.lanes, ["trip", "shop"]);
  assert.equal(route.source, "triage");
  assert.equal(route.tokens, 321);
  assert.equal(route.why, "flights and balloons");
  assert.match(seen.system, /triage step/);
  assert.equal(seen.user.transcript, input.transcript);
  assert.equal(seen.user.shoppingList, "has carts");
  assert.match(seen.user.chat, /direct/);
  assert.deepEqual(Object.keys(seen.user.lanes), EVERY);
});

test("a triage call that throws falls back to every lane and says why", async () => {
  const route = await routeTurn(env, { reason: "" }, input, { ask: async () => { throw new Error("model down"); } });
  assert.equal(route.source, "fallback");
  assert.deepEqual(route.lanes, EVERY);
  assert.match(route.why, /model down/);
});

test("a triage call that overruns its budget falls back to every lane instead of holding the turn", async () => {
  const route = await routeTurn(env, { reason: "" }, input, { ask: () => new Promise(() => {}), budgetMs: 20 });
  assert.equal(route.source, "fallback");
  assert.deepEqual(route.lanes, EVERY);
  assert.match(route.why, /over 20ms/);
});

test("a malformed triage answer falls back to every lane", async () => {
  const route = await routeTurn(env, { reason: "" }, input, { ask: async () => ({ value: { lane: "shop" }, tokens: 5 }) });
  assert.equal(route.source, "fallback");
  assert.equal(route.tokens, 5);
});
