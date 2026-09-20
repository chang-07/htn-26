import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// lanes.ts reaches into tools/ for the schema names and the known stores, so it is bundled like tools.test.mjs.
const bundle = await build({ entryPoints: ["src/server/lanes.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { LANES, LANE_NAMES, laneToolNames, systemFor, laneCatalogue } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const toolsBundle = await build({ entryPoints: ["src/server/tools/index.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { toolSchemas, openAiTools } = await import(`data:text/javascript;base64,${Buffer.from(toolsBundle.outputFiles[0].text).toString("base64")}`);

const ALL = LANE_NAMES;
const covered = new Set(ALL.flatMap((l) => LANES[l].tools));

test("every tool the agent can run belongs to at least one lane, so none can vanish from the model's view", () => {
  const missing = Object.keys(toolSchemas).filter((t) => !covered.has(t));
  assert.deepEqual(missing, []);
});

test("every lane names only real tools", () => {
  for (const lane of ALL) for (const t of LANES[lane].tools) assert.ok(t in toolSchemas, `${lane}: ${t}`);
});

test("core is always on: a turn scoped to one lane can still speak, remember and read the tally", () => {
  const names = laneToolNames(["shop"]);
  for (const t of ["send_message", "remember_fact", "remember_area", "get_votes", "propose_plan"]) assert.ok(names.includes(t), t);
  assert.ok(names.includes("shop_search"));
  assert.ok(!names.includes("search_flights"));
  assert.ok(!names.includes("research"));
});

test("every lane together is every tool, in the registry's order", () => {
  assert.deepEqual(laneToolNames(ALL), Object.keys(toolSchemas));
});

test("the lane set is a set: order and repeats do not change the tools or the prompt", () => {
  assert.deepEqual(laneToolNames(["trip", "shop", "trip"]), laneToolNames(["shop", "trip"]));
  assert.equal(systemFor(["trip", "shop"]), systemFor(["shop", "trip", "core"]));
});

test("the prompt for a lane set carries that lane's rules and not another's", () => {
  const markers = {
    venues: "book_option drives a real browser",
    trip: "work in segments and open one ballot at a time",
    shop: "An event usually shops at several stores",
    money: "The Invoice below is who paid what",
    people: "Pairing people up",
    fun: "call make_game straight away",
  };
  const everything = systemFor(ALL);
  const coreOnly = systemFor(["core"]);
  for (const [lane, marker] of Object.entries(markers)) {
    assert.ok(everything.includes(marker), `all: ${lane}`);
    assert.ok(!coreOnly.includes(marker), `core must not carry ${lane}`);
    assert.ok(systemFor([lane]).includes(marker), `${lane} alone`);
  }
  // The voice and the NOOP rule are in every prompt.
  for (const p of [coreOnly, systemFor(["money"]), everything]) {
    assert.ok(p.startsWith("You are Whim"));
    assert.ok(p.includes("reply with\n  exactly NOOP") || p.includes("exactly NOOP"));
    assert.ok(p.includes("Write like a friend texting"));
  }
});

test("the full prompt still tells the model about the known stores", () => {
  assert.match(systemFor(ALL), /Stores known to work:\n\s+\S+\.\w+ \(/);
});

test("the catalogue the triage agent reads describes every lane but core", () => {
  const cat = laneCatalogue();
  assert.deepEqual(Object.keys(cat).sort(), ALL.filter((l) => l !== "core").sort());
  for (const line of Object.values(cat)) assert.ok(line.length > 20 && line.length < 240, line);
});

test("openAiTools takes a subset and memoises it per lane set", () => {
  const all = openAiTools();
  const trip = openAiTools(laneToolNames(["trip"]));
  assert.equal(openAiTools(laneToolNames(["trip"])), trip);
  assert.ok(trip.length < all.length);
  assert.deepEqual(trip.map((t) => t.function.name), laneToolNames(["trip"]));
  assert.equal(openAiTools(Object.keys(toolSchemas)), all, "the full list is the same array as the no-argument call");
});
