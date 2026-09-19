import test from "node:test";
import assert from "node:assert/strict";
import { searchSources, scoreSources, selectSources, fetchSource } from "../src/server/research-sources.ts";

const env = { BROWSERBASE_API_KEY: "test-browserbase", AI_GATEWAY_API_KEY: "test-gateway" };
const hit = (url, relevance = 3, confidence = 0.9) => ({ url, title: "Toronto dinner", snippet: "", relevance, confidence });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

test("Search → Jev → Fetch retrieves only relevant, confident results", async (t) => {
  const fetched = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(init.signal instanceof AbortSignal);
    if (url.endsWith("/search")) {
      assert.equal(init.headers["X-BB-API-Key"], env.BROWSERBASE_API_KEY);
      assert.equal(body.query, "Toronto dinner for six");
      return json({ results: [
        { url: "https://venue.test/menu", title: "Toronto dinner" },
        { url: "https://other.test/", title: "Paris dinner" },
        { url: "https://uncertain.test/", title: "Restaurants" },
        { url: "https://venue.test/menu#top", title: "Duplicate" },
        { url: "javascript:alert(1)", title: "Invalid" },
      ] });
    }
    if (url.endsWith("/systemone")) {
      assert.equal(url, "https://ai-gateway.vercel.sh/typesafe/v1/systemone");
      assert.equal(init.headers.authorization, `Bearer ${env.AI_GATEWAY_API_KEY}`);
      assert.equal(body.model, "typesafe-ai/jev");
      assert.equal(Object.keys(body.questions).length, 3);
      assert.match(body.questions.hit_1.instructions, /result 1/);
      assert.equal(JSON.parse(body.state).results[0].snippet, "");
      return json({ answers: {
        hit_0: { type: "score", score: 2.8, confidence: 0.8 },
        hit_1: { type: "score", score: 0.1, confidence: 0.99 },
        hit_2: { type: "score", score: 2.9, confidence: 0.2 },
      }, usage: { input_tokens: 200, output_tokens: 10 } });
    }
    assert.equal(url, "https://api.browserbase.com/v1/fetch");
    assert.equal(body.format, "markdown");
    assert.equal(body.allowRedirects, true);
    fetched.push(body.url);
    return json({ statusCode: 200, content: "Dinner menu [Book](https://venue.test/book)" });
  });
  const found = await searchSources(env, "Toronto dinner for six");
  assert.equal(found.length, 3);
  const scored = await scoreSources(env, "Dinner for six in Toronto", found);
  assert.equal(scored.tokens, 210);
  const selected = selectSources(env, scored.hits, 3);
  const pages = await Promise.all(selected.map((h) => fetchSource(env, h, 1000)));
  assert.deepEqual(fetched, ["https://venue.test/menu"]);
  assert.match(pages[0].text, /https:\/\/venue.test\/book/);
});

test("a full rejection stays empty, including confidently bad results", () => {
  assert.deepEqual(selectSources(env, [
    hit("https://bad.test", 0, 1), hit("https://unclear.test", 3, 0.1),
  ], 8), []);
});

test("selection ranks relevance first, deduplicates, and limits each host", () => {
  const result = selectSources(env, [
    hit("https://a.test/1", 2.5), hit("https://a.test/1#x", 2.5),
    hit("https://www.a.test/2", 2.4), hit("https://a.test/3", 2.3),
    hit("https://b.test/", 3, 0.6), hit("https://c.test/", 2.1),
  ], 3);
  assert.deepEqual(result.map((h) => h.url), ["https://b.test/", "https://a.test/1", "https://www.a.test/2"]);
  assert.equal(selectSources(env, result, 0).length, 0);
});

test("threshold overrides are validated instead of silently disabling the gate", () => {
  assert.throws(() => selectSources({ RESEARCH_MIN_CONFIDENCE: "NaN" }, [], 3), /Invalid research threshold/);
  assert.throws(() => selectSources({ RESEARCH_MIN_RELEVANCE: "4" }, [], 3), /Invalid research threshold/);
  assert.equal(selectSources({ RESEARCH_MIN_CONFIDENCE: "0.95" }, [hit("https://a.test/")], 3).length, 0);
});

test("missing or invalid Jev judgments fail rather than admitting unscored URLs", async (t) => {
  let response = { answers: {} };
  t.mock.method(globalThis, "fetch", async () => json(response));
  await assert.rejects(scoreSources(env, "dinner", [hit("https://a.test/")]), /omitted/);
  response = { answers: { hit_0: { type: "score", score: 3, confidence: 2 } } };
  await assert.rejects(scoreSources(env, "dinner", [hit("https://a.test/")]));
});

test("provider errors propagate without echoing credentials or falling back to unscored hits", async (t) => {
  t.mock.method(globalThis, "fetch", async () => json({ error: "private request contents" }, 429));
  await assert.rejects(scoreSources(env, "dinner", [hit("https://a.test/")]), (err) => {
    assert.match(err.message, /HTTP 429/);
    assert.doesNotMatch(err.message, /private|test-gateway/);
    return true;
  });
});

test("Fetch checks the target status, requires content, and bounds evidence length", async (t) => {
  let response = { statusCode: 403, content: "Forbidden" };
  t.mock.method(globalThis, "fetch", async () => json(response));
  await assert.rejects(fetchSource(env, hit("https://a.test/"), 10), /HTTP 403/);
  response = { statusCode: 200, content: " " };
  await assert.rejects(fetchSource(env, hit("https://a.test/"), 10), /empty content/);
  response = { statusCode: 200, content: "a".repeat(100) };
  assert.equal((await fetchSource(env, hit("https://a.test/"), 10)).text.length, 10);
});
