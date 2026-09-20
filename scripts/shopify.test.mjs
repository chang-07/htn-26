import test from "node:test";
import assert from "node:assert/strict";
import { searchCatalog, setCart, NotShoppable } from "../src/server/tools/shopify.ts";

const env = { PUBLIC_BASE_URL: "https://whim.test" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const manifest = (shop) => ({ ucp: { services: { "dev.ucp.shopping": [{ transport: "mcp", endpoint: `https://${shop}/api/mcp` }] } } });
const product = { products: [{ title: "Balloon", price_range: { min: { amount: 1200, currency: "USD" }, max: { amount: 1200, currency: "USD" } }, variants: [{ id: "gid://1", title: "Default Title" }] }] };
const cart = { cart: { id: "c1", continue_url: "https://x/checkout", currency: "USD", totals: [{ type: "total", amount: 1200 }], line_items: [{ item: { id: "gid://1", title: "Balloon", price: 1200 }, quantity: 1 }] } };

/** Counts manifest reads per store; UCP calls answer with whatever `rpc` says. */
function mockStore(t, rpc = () => json({ result: { structuredContent: product } })) {
  const manifests = {};
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = new URL(url);
    if (u.pathname === "/.well-known/ucp") {
      manifests[u.hostname] = (manifests[u.hostname] ?? 0) + 1;
      return u.hostname.startsWith("dead.") ? new Response("nope", { status: 404 }) : json(manifest(u.hostname));
    }
    return rpc(u);
  });
  return manifests;
}

test("a store's manifest is read once, not before every call", async (t) => {
  const manifests = mockStore(t);
  const shop = `cache-${Date.now()}.test`;
  await searchCatalog(env, shop, "balloons");
  await searchCatalog(env, shop, "banners");
  assert.equal(manifests[shop], 1);
});

test("stores asked for at the same time share one manifest read each", async (t) => {
  const manifests = mockStore(t);
  const a = `a-${Date.now()}.test`;
  const b = `b-${Date.now()}.test`;
  await Promise.all([searchCatalog(env, a, "x"), searchCatalog(env, a, "y"), searchCatalog(env, b, "z")]);
  assert.equal(manifests[a], 1);
  assert.equal(manifests[b], 1);
});

test("a store that is not on the agent API is not remembered as one", async (t) => {
  const manifests = mockStore(t);
  const shop = `dead.${Date.now()}.test`;
  await assert.rejects(searchCatalog(env, shop, "x"), NotShoppable);
  await assert.rejects(searchCatalog(env, shop, "x"), NotShoppable);
  assert.equal(manifests[shop], 2); // nothing cached from a refusal
});

test("a call that fails to reach the cached endpoint forgets it, so the next call looks again", async (t) => {
  let fail = true;
  const manifests = mockStore(t, () => {
    if (fail) throw new TypeError("fetch failed");
    return json({ result: { structuredContent: cart } });
  });
  const shop = `flaky-${Date.now()}.test`;
  await assert.rejects(setCart(env, shop, [{ variantId: "gid://1", quantity: 1 }]), /fetch failed/);
  fail = false;
  const c = await setCart(env, shop, [{ variantId: "gid://1", quantity: 1 }]);
  assert.equal(c.total, "$12.00");
  assert.equal(manifests[shop], 2);
});
