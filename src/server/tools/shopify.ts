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

type UcpManifest = {
  ucp: {
    services?: Record<string, { transport: string; endpoint?: string }[]>;
  };
};

export function agentProfileUrl(env: Env) {
  return `${env.PUBLIC_BASE_URL}/.well-known/ucp-agent.json`;
}

async function endpointFor(shop: string): Promise<string> {
  const host = shop.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const res = await fetch(`https://${host}/.well-known/ucp`);
  if (!res.ok) throw new Error(`${host} does not publish a UCP manifest (${res.status})`);
  const manifest = (await res.json()) as UcpManifest;
  const mcp = manifest.ucp.services?.["dev.ucp.shopping"]?.find(
    (s) => s.transport === "mcp" && s.endpoint,
  );
  if (!mcp?.endpoint) throw new Error(`${host} has no UCP MCP endpoint`);
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
    headers: { "content-type": "application/json" },
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

export function searchCatalog(env: Env, shop: string, query: string, limit = 5) {
  return callUcp(env, shop, "search_catalog", {
    catalog: { query, pagination: { limit }, filters: { available: true } },
  });
}

export function createCart(
  env: Env,
  shop: string,
  lines: { variantId: string; quantity: number }[],
) {
  return callUcp(env, shop, "create_cart", {
    cart: {
      line_items: lines.map((l) => ({ item: { id: l.variantId }, quantity: l.quantity })),
    },
  });
}
