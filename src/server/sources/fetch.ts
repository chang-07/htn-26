import { traceOperation } from "../telemetry.ts";

export type SourceEnv = { BROWSERBASE_API_KEY?: string };

/** A source could not get a page. `code` is what the model-facing message keys on. */
export class SourceError extends Error {
  code: "no_browserbase" | "http";

  constructor(code: "no_browserbase" | "http", message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * One HTTP page through Browserbase Fetch with residential proxies: the sites
 * these sources read block datacenter IPs but serve a plain proxied request.
 * `proxies: false` is an ordinary fetch, for APIs that need neither.
 * Bodies are never logged; an upstream error can echo the request.
 */
export async function proxiedFetch(
  env: SourceEnv,
  url: string,
  opts: { headers?: Record<string, string>; proxies?: boolean } = {},
): Promise<{ status: number; content: string }> {
  const host = new URL(url).hostname;
  return traceOperation("provider.fetch", "http.client", { provider: host, proxies: opts.proxies !== false }, async () => {
    if (opts.proxies === false) {
      const res = await fetch(url, { headers: opts.headers, signal: AbortSignal.timeout(30_000) });
      return { status: res.status, content: await res.text() };
    }
    if (!env.BROWSERBASE_API_KEY) throw new SourceError("no_browserbase", "BROWSERBASE_API_KEY is required for a proxied fetch");
    const res = await fetch("https://api.browserbase.com/v1/fetch", {
      method: "POST",
      headers: { "X-BB-API-Key": env.BROWSERBASE_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ url, proxies: true, ...(opts.headers ? { headers: opts.headers } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new SourceError("http", `Browserbase fetch of ${host}: HTTP ${res.status}`);
    const data = (await res.json()) as { statusCode?: number; content?: string };
    return { status: data.statusCode ?? 0, content: data.content ?? "" };
  });
}

/** For `source.empty` logs: which page came back, without the page. */
export function pageTitle(html: string): string {
  return html.match(/<title>([^<]*)<\/title>/)?.[1]?.trim() || "(no title)";
}
