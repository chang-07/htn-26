import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { skills, eligibleSkills, canUseSkill, allowedSkillFetch } from "../src/server/browserbase/catalog.ts";

// Bundle the Worker module with provider boundaries replaced; no live browser, LLM or spend.
const bundle = await build({ entryPoints: ["src/server/browserbase/agent.ts"], bundle: true, write: false, format: "esm", platform: "node", plugins: [{
  name: "mock-providers", setup(b) {
    b.onResolve({ filter: /^(\.\.\/(llm|pilot|research-sources)|\.\/instructions)$/ }, (args) => ({ path: args.path, namespace: "mock" }));
    b.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ contents:
      path.endsWith("instructions") ? `export const instructions = new Proxy({}, { get: (_, id) => 'INSTRUCTIONS:' + id });`
      : path.endsWith("llm") ? `export const askJson = (...args) => globalThis.bbDeps.askJson(...args);`
      : path.endsWith("pilot") ? `export const runPilot = (...args) => globalThis.bbDeps.runPilot(...args);`
      : `export const fetchSource = (...args) => globalThis.bbDeps.fetchSource(...args);`, loader: "js" }));
  },
}] });
const { planBrowserbase, runBrowserbasePilot, readWithBrowserbase } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const env = { BROWSERBASE_API_KEY: "test" };

test("catalog includes all ten actual installed snapshots, scoped away from general agents", async () => {
  assert.equal(skills.length, 10);
  for (const skill of skills) {
    assert.match(await readFile(`src/server/browserbase/skills/${skill.id}/SKILL.md`, "utf8"), /## (Purpose|Workflow)/);
  }
  assert.equal(eligibleSkills("split our dinner bill and set up payments").length, 0);
  assert.equal(canUseSkill("link.com/create-payment-credential-0nc34a", "https://link.com/"), false);
  assert.equal(canUseSkill(skills[0].id, "https://ticketmaster.com.evil.test/"), false);
  assert.equal(canUseSkill(skills[0].id, "https://user:password@ticketmaster.com/"), false);
});

test("ordinary conversation and missing Browserbase configuration make no model calls", async () => {
  globalThis.bbDeps = { askJson: () => assert.fail("unnecessary model call") };
  assert.equal((await planBrowserbase(env, "brainstorm a birthday dinner in Toronto")).skill, null);
  assert.equal((await planBrowserbase({}, "find hiking trails")).skill, null);
});

test("specialist can decline a keyword match and cannot choose an unrelated or payment skill", async () => {
  for (const id of [null, "link.com/create-payment-credential-0nc34a", "airbnb.com/search-listings-ddgioa", "made-up"]) {
    globalThis.bbDeps = { askJson: async () => ({ value: { skill: id, reason: "test" }, tokens: 7 }) };
    assert.equal((await planBrowserbase(env, "easy hiking trails in Waterloo")).skill, null);
  }
});

test("selected specialist metadata is workflow-serializable and instructions stay private", async () => {
  globalThis.bbDeps = { askJson: async (_env, _schema, prompt, data) => {
    assert.match(prompt, /Default to null/);
    assert.doesNotMatch(data, /INSTRUCTIONS:/);
    return { value: { skill: "alltrails.com/search-trails-dsqvnx" }, tokens: 11 };
  } };
  const result = await planBrowserbase(env, "easy hiking trails in Waterloo");
  assert.equal(result.tokens, 11);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("OpenTable instructions only reach availability subagent, never authorize booking", async () => {
  globalThis.bbDeps = { runPilot: async (_env, _page, goal) => goal };
  const goal = { startUrl: "https://www.opentable.com/r/place", mode: "availability", dryRun: true, task: "four people" };
  assert.match((await runBrowserbasePilot(env, {}, goal)).skillInstructions, /INSTRUCTIONS:opentable/);
  assert.equal((await runBrowserbasePilot(env, {}, { ...goal, mode: "book" })).skillInstructions, undefined);
  assert.equal((await runBrowserbasePilot({}, {}, goal)).skillInstructions, undefined);
});

test("Luma runs bounded skill-guided public fetches without a browser", async () => {
  let decisions = 0, fetches = 0;
  globalThis.bbDeps = {
    askJson: async (_env, _schema, prompt) => {
      assert.match(prompt, /INSTRUCTIONS:luma/);
      return { value: { url: decisions++ === 0 ? "https://api.luma.com/discover/get-paginated-events?slug=toronto" : null }, tokens: 10 };
    },
    fetchSource: async (_env, hit, _limit, options) => {
      fetches++;
      assert.equal(options.proxies, false);
      assert.equal(options.format, "raw");
      return { url: hit.url, title: "Events", text: '{"entries":[]}', links: [] };
    },
  };
  const result = await readWithBrowserbase(env, undefined, { url: "https://luma.com/toronto" }, "Toronto meetups", "luma.com/discover-1zqc5a", 4000);
  assert.equal(result.tokens, 20);
  assert.equal(fetches, 1);
  assert.match(result.page.text, /entries/);
});

test("API adapters reject unrelated endpoints, SSRF targets and mutation endpoints", () => {
  for (const url of ["http://127.0.0.1/", "https://api.luma.com:8443/discover/get-paginated-events", "https://api.luma.com/register", "https://evil.test/", "https://api.luma.com/discover/get-paginated-events/../register"]) {
    assert.equal(allowedSkillFetch("luma.com/discover-1zqc5a", url), false);
  }
  assert.equal(allowedSkillFetch(skills[0].id, "https://www.ticketmaster.com/api/search/events/artist/123"), true);
  assert.equal(allowedSkillFetch(skills[0].id, "https://www.ticketmaster.com/checkout"), false);
});

test("browser failures remain failures rather than empty availability", async () => {
  globalThis.bbDeps = { runPilot: async () => ({ status: "gave_up", tokens: 5, summary: "login required" }) };
  await assert.rejects(readWithBrowserbase(env, {}, { url: "https://alltrails.com/trail/example" }, "hike", "alltrails.com/search-trails-dsqvnx", 4000), /incomplete/);
  await assert.rejects(readWithBrowserbase(env, {}, { url: "https://link.com/" }, "pay", "link.com/create-payment-credential-0nc34a", 4000), /does not match/);
});
