import test from "node:test";
import assert from "node:assert/strict";
import { CONCURRENT_TOOLS, startConcurrent } from "../src/server/tool-concurrency.ts";

const call = (id, name) => ({ id, function: { name } });

/** A runner that records the order calls were started in, and resolves only when told to. */
function recorder() {
  const started = [];
  const release = new Map();
  const run = (c) => {
    started.push(c.function.name);
    return new Promise((resolve, reject) => release.set(c.id, { resolve, reject }));
  };
  return { started, release, run };
}

test("two lookups in one step are started together, before either is awaited", () => {
  const { started, run } = recorder();
  const calls = [call("a", "search_flights"), call("b", "search_stays")];
  const early = startConcurrent(calls, run);
  assert.deepEqual(started, ["search_flights", "search_stays"]);
  assert.deepEqual([...early.keys()], ["a", "b"]);
});

test("the tools that speak, post or edit are never started early, whatever their position", () => {
  const { started, run } = recorder();
  const calls = [call("a", "search_flights"), call("b", "propose_plan"), call("c", "get_votes"), call("d", "find_events"), call("e", "send_message")];
  const early = startConcurrent(calls, run);
  assert.deepEqual(started, ["search_flights", "find_events"]);
  assert.ok(!early.has("b") && !early.has("c") && !early.has("e"));
});

test("a lone lookup is left to the ordered loop: nothing gained by starting it early", () => {
  const { started, run } = recorder();
  const early = startConcurrent([call("a", "remember_area"), call("b", "search_flights"), call("c", "send_message")], run);
  assert.deepEqual(started, []);
  assert.equal(early.size, 0);
});

test("a lookup that fails is still reported to the loop, and does not surface as unhandled if the loop never gets there", async () => {
  const { release, run } = recorder();
  const early = startConcurrent([call("a", "shop_search"), call("b", "shop_search")], run);
  let unhandled = null;
  const trap = (err) => (unhandled = err);
  process.on("unhandledRejection", trap);
  release.get("a").reject(new Error("store down"));
  release.get("b").resolve("ok");
  await new Promise((r) => setTimeout(r, 20));
  process.off("unhandledRejection", trap);
  assert.equal(unhandled, null);
  await assert.rejects(early.get("a"), /store down/); // the loop still sees it when it awaits
  assert.equal(await early.get("b"), "ok");
});

test("every concurrent tool is a pure network lookup; the set names no tool that speaks, posts or edits", () => {
  for (const name of ["send_message", "propose_plan", "get_votes", "get_rsvps", "book_option", "research", "shop_build_cart", "add_to_itinerary", "read_locations", "save_profile", "remember_fact"]) {
    assert.ok(!CONCURRENT_TOOLS.has(name), `${name} must run in order`);
  }
});
