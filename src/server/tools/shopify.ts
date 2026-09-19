/**
 * Shopify via the Universal Commerce Protocol. Every Shopify store exposes an
 * MCP endpoint (declared in /.well-known/ucp) that speaks JSON-RPC over plain
 * HTTP POST — no SDK, no API key.
 *
 * The one requirement: every call carries `meta["ucp-agent"].profile`, and
 * Shopify *fetches that URL* to validate the agent. So these tools only work
 * once this Worker is reachable on the public internet (deployed, or tunnelled)
 * and PUBLIC_BASE_URL points at it. See /.well-known/ucp-agent.json in index.ts.
 */

/**
 * The store is not on Shopify's agent API, so no retry will ever work. The
 * wording is for the model: it once tried the same dead domain in four turns
 * running while telling the person it would "keep trying".
 */
export class NotShoppable extends Error {
  constructor(host: string) {
    super(
      `${host} cannot be shopped through this tool, and never will be: do not try it again. Use one of the known stores listed in your instructions, or tell the person this item is not something you can order and suggest they buy it themselves.`,
    );
  }
}

type UcpManifest = {
  ucp: {
    services?: Record<string, { transport: string; endpoint?: string }[]>;
  };
};

export const UCP_VERSION = "2026-08-25";

/**
 * A store only exposes the tools for capabilities that both sides declare, so
 * an empty list here means "Tool not found" for everything. No checkout
 * capability on purpose: the agent builds carts, a human pays.
 */
export const UCP_CAPABILITIES = Object.fromEntries(
  ["dev.ucp.shopping.cart", "dev.ucp.shopping.catalog.search", "dev.ucp.shopping.catalog.lookup"].map((name) => [
    name,
    [{ version: UCP_VERSION }],
  ]),
);

export function agentProfileUrl(env: Env) {
  // Shopify caches the profile for its max-age; bump v when capabilities change.
  return `${env.PUBLIC_BASE_URL}/.well-known/ucp-agent.json?v=2`;
}

const USER_AGENT = "htn-planner/1.0";

async function endpointFor(shop: string): Promise<string> {
  const host = shop.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  // Some storefronts 403 a request with no User-Agent, which is what a Worker sends.
  const res = await fetch(`https://${host}/.well-known/ucp`, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) throw new NotShoppable(host);
  const manifest = (await res.json()) as UcpManifest;
  const mcp = manifest.ucp.services?.["dev.ucp.shopping"]?.find(
    (s) => s.transport === "mcp" && s.endpoint,
  );
  if (!mcp?.endpoint) throw new NotShoppable(host);
  return mcp.endpoint;
}

async function callUcp(
  env: Env,
  shop: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<any> {
  const endpoint = await endpointFor(shop);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: tool,
        arguments: {
          meta: { "ucp-agent": { profile: agentProfileUrl(env) } },
          ...args,
        },
      },
    }),
  });
  const body = (await res.json()) as any;
  if (body.error) {
    throw new Error(`${tool} failed: ${body.error.message} ${JSON.stringify(body.error.data ?? {})}`);
  }
  // MCP tool results carry typed data in structuredContent, with a text mirror.
  return body.result?.structuredContent ?? body.result;
}

/**
 * Stores checked to publish a UCP manifest, so the model has somewhere to start
 * instead of guessing a domain. Any other Shopify store works too — endpointFor
 * says so plainly when a domain is not one.
 */
export const KNOWN_SHOPS: { shop: string; sells: string }[] = [
  { shop: "partycity.com", sells: "balloons, decorations, party supplies" },
  { shop: "milkbarstore.com", sells: "birthday cakes, cookies" },
  { shop: "levainbakery.com", sells: "cookie boxes" },
  { shop: "urbanstems.com", sells: "flower delivery" },
  { shop: "thesill.com", sells: "houseplants" },
  { shop: "drinkolipop.com", sells: "soda" },
  { shop: "explodingkittens.com", sells: "card games" },
  { shop: "whatdoyoumeme.com", sells: "party games" },
  // Gifts. Each was checked with a real search, not just for a manifest.
  { shop: "cuyana.com", sells: "leather handbags, purses, wallets" },
  { shop: "dagnedover.com", sells: "tote bags, backpacks" },
  { shop: "herschel.com", sells: "backpacks, bags" },
  { shop: "burga.com", sells: "phone cases, including current iPhones" },
  { shop: "wildflowercases.com", sells: "patterned and cute phone cases" },
  { shop: "velvetcaviar.com", sells: "phone cases" },
  { shop: "pelacase.com", sells: "plain phone cases" },
  { shop: "glossier.com", sells: "skincare, makeup" },
  { shop: "brooklinen.com", sells: "candles, robes, bedding" },
];

/** Minor units to a display string: (1800, "USD") -> "$18.00". */
export function money(amount: number, currency: string) {
  const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency });
  return fmt.format(amount / 10 ** (fmt.resolvedOptions().maximumFractionDigits ?? 2));
}

export type ProductHit = {
  title: string;
  price: string;
  url?: string;
  variants: { variantId: string; label: string; price: string }[];
};

/**
 * A raw product is ~4KB of descriptions, media and tags. The model needs a
 * title, a price and the variant ids it can put in a cart.
 */
export async function searchCatalog(env: Env, shop: string, query: string, limit = 8): Promise<ProductHit[]> {
  const found = await callUcp(env, shop, "search_catalog", {
    catalog: { query, pagination: { limit }, filters: { available: true } },
  });
  return ((found?.products ?? []) as any[]).map((p) => {
    const { min, max } = p.price_range ?? {};
    const variants = ((p.variants ?? []) as any[]).filter((v) => v.availability?.available !== false);
    return {
      title: p.title,
      price: !min ? "" : min.amount === max?.amount ? money(min.amount, min.currency) : `from ${money(min.amount, min.currency)}`,
      url: p.url,
      variants: variants.slice(0, 4).map((v) => ({
        variantId: v.id,
        // A product with no options has one variant, which Shopify names
        // "Default Title". It is a placeholder, not something to show anyone.
        label: isPlaceholder(v.title) ? "" : v.title,
        price: v.price ? money(v.price.amount, v.price.currency) : "",
      })),
    };
  });
}

/** Shopify's name for the only variant of a product that has no options. */
export const isPlaceholder = (title: unknown) => /^default title$/i.test(String(title ?? "").trim());

/** "The Sorbet", or "Exploding Kittens - English Version" when the variant says something. */
export const productName = (product: string, variantLabel?: string) =>
  variantLabel && !isPlaceholder(variantLabel) && !product.includes(variantLabel) ? `${product} - ${variantLabel}` : product;

export type Cart = {
  /** Carries the cart's secret key, so it stays server-side. */
  id: string;
  checkoutUrl: string;
  total: string;
  lines: { variantId: string; title: string; quantity: number; price: string; imageUrl?: string }[];
  /** Anything the store wants the buyer told, e.g. an item that sold out. */
  messages: string[];
};

/**
 * Sets the cart's full contents. With `cartId` the existing cart is updated —
 * update_cart replaces the whole line list — and the checkout link already in
 * the chat stays valid.
 */
export async function setCart(
  env: Env,
  shop: string,
  lines: { variantId: string; quantity: number }[],
  cartId?: string,
  /**
   * Product names by variant id, remembered from search. A cart response names
   * each line by its VARIANT, so a single-variant product comes back as
   * "Default Title" with the real name nowhere in the payload.
   */
  names: Record<string, string> = {},
): Promise<Cart> {
  const cart = { line_items: lines.map((l) => ({ item: { id: l.variantId }, quantity: l.quantity })) };
  const result = await callUcp(env, shop, cartId ? "update_cart" : "create_cart", cartId ? { id: cartId, cart } : { cart });
  const c = result?.cart ?? result;
  if (!c?.id || !c?.continue_url) throw new Error(`cart response had no checkout url: ${JSON.stringify(c).slice(0, 400)}`);

  const total = (c.totals as any[] | undefined)?.find((t) => t.type === "total")?.amount;
  return {
    id: c.id,
    checkoutUrl: c.continue_url,
    total: total === undefined ? "" : money(total, c.currency),
    lines: ((c.line_items ?? []) as any[]).map((l) => ({
      // Carried through so a cart can be re-sent with changed quantities.
      variantId: String(l.item.id),
      title: names[String(l.item.id)] ?? (isPlaceholder(l.item.title) ? "Item" : l.item.title),
      quantity: l.quantity,
      price: typeof l.item.price === "number" ? money(l.item.price, c.currency) : "",
      imageUrl: l.item.image_url,
    })),
    messages: ((c.messages ?? []) as any[]).map((m) => m.content ?? m.message ?? JSON.stringify(m)),
  };
}

/**
 * Tells the store a cart is abandoned. Best effort: the cart is already gone
 * from the group's shopping list, and an un-cancelled cart simply expires, so a
 * store that refuses must not turn "drop it" into an error.
 */
export async function cancelCart(env: Env, shop: string, cartId: string): Promise<boolean> {
  try {
    await callUcp(env, shop, "cancel_cart", { id: cartId });
    return true;
  } catch {
    return false;
  }
}
