import test from "node:test";
import assert from "node:assert/strict";
import { proxiedFetch, SourceError, pageTitle } from "../src/server/sources/fetch.ts";

const env = { BROWSERBASE_API_KEY: "bb-test" };

test("proxiedFetch posts to Browserbase Fetch with proxies and the key", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.browserbase.com/v1/fetch");
    assert.equal(init.headers["X-BB-API-Key"], "bb-test");
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    assert.deepEqual(body, { url: "https://www.example.com/x", proxies: true, headers: { Accept: "text/html" } });
    return new Response(JSON.stringify({ statusCode: 200, content: "<title>Hi</title>" }), { headers: { "content-type": "application/json" } });
  });
  const out = await proxiedFetch(env, "https://www.example.com/x", { headers: { Accept: "text/html" } });
  assert.deepEqual(out, { status: 200, content: "<title>Hi</title>" });
});

test("proxiedFetch without proxies is a plain fetch", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.luma.com/x");
    assert.equal(init.method ?? "GET", "GET");
    return new Response("{}", { status: 200 });
  });
  const out = await proxiedFetch({}, "https://api.luma.com/x", { proxies: false });
  assert.deepEqual(out, { status: 200, content: "{}" });
});

test("proxiedFetch refuses a proxied fetch without a Browserbase key", async () => {
  await assert.rejects(() => proxiedFetch({}, "https://www.example.com"), (err) => err instanceof SourceError && err.code === "no_browserbase");
});

test("proxiedFetch turns a Browserbase error into SourceError(http)", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 402 }));
  await assert.rejects(() => proxiedFetch(env, "https://www.example.com"), (err) => err instanceof SourceError && err.code === "http" && /402/.test(err.message));
});

test("pageTitle reads the title or falls back", () => {
  assert.equal(pageTitle("<html><head><title>Toronto to Vancouver | Google Flights</title></head></html>"), "Toronto to Vancouver | Google Flights");
  assert.equal(pageTitle("<html></html>"), "(no title)");
});
