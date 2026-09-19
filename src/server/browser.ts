import puppeteer, { type Browser, type ConnectionTransport, type Page } from "@cloudflare/puppeteer";
import { errorFields, log, short } from "./log";

/**
 * One way to get a browser, two places it can come from:
 *
 *  - Browserbase, when BROWSERBASE_API_KEY is set. Residential-looking sessions
 *    with stealth and captcha solving, and every session leaves a replay at
 *    browserbase.com/sessions/<id> — the first thing to open when a run returns
 *    nothing useful.
 *  - Cloudflare Browser Rendering (the BROWSER binding) otherwise. Free with
 *    the Worker, but datacenter IPs that search engines and review sites block.
 *
 * Both speak CDP, so callers get a plain puppeteer Browser either way.
 */
const BB_API = "https://api.browserbase.com/v1";

export type BrowserSession = {
  browser: Browser;
  provider: "browserbase" | "cloudflare";
  /** Browserbase session id, for the replay link. */
  sessionId?: string;
  /** Browserbase live view: watch the browser being driven, in real time. */
  liveUrl?: string;
  close: () => Promise<void>;
};

export async function openBrowser(
  env: Env,
  opts: {
    timeoutSeconds?: number;
    /**
     * Use the persistent context that holds the bot account's logins (see
     * scripts/social-login.mjs). Only for reading a profile its owner handed over —
     * never for research or booking, which have no business being signed in.
     */
    signedIn?: boolean;
  } = {},
): Promise<BrowserSession> {
  if (!env.BROWSERBASE_API_KEY) {
    const browser = await puppeteer.launch(env.BROWSER);
    log("info", "browse", "session.open", { provider: "cloudflare" });
    return { browser, provider: "cloudflare", close: () => browser.close() };
  }

  const headers = { "X-BB-API-Key": env.BROWSERBASE_API_KEY, "content-type": "application/json" };
  const res = await fetch(`${BB_API}/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...(env.BROWSERBASE_PROJECT_ID ? { projectId: env.BROWSERBASE_PROJECT_ID } : {}),
      // A hard ceiling: a crashed run must not leave a session billing for hours.
      timeout: opts.timeoutSeconds ?? 300,
      browserSettings: {
        solveCaptchas: true,
        blockAds: true,
        // persist: cookies refreshed during the run are written back, which keeps the login alive.
        ...(opts.signedIn && env.BROWSERBASE_CONTEXT_ID ? { context: { id: env.BROWSERBASE_CONTEXT_ID, persist: true } } : {}),
      },
    }),
  });
  if (!res.ok) throw new Error(`Browserbase session create failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const session = (await res.json()) as { id: string; connectUrl: string };

  const browser = await puppeteer.connect({ transport: await nativeSocket(session.connectUrl) });
  log("info", "browse", "session.open", { provider: "browserbase", session: short(session.id) });

  // The live view is a nicety; a session is still usable without it.
  const liveUrl = await fetch(`${BB_API}/sessions/${session.id}/debug`, { headers })
    .then((r) => (r.ok ? (r.json() as Promise<{ debuggerFullscreenUrl?: string }>) : null))
    .then((d) => d?.debuggerFullscreenUrl)
    .catch(() => undefined);

  return {
    browser,
    provider: "browserbase",
    sessionId: session.id,
    liveUrl,
    close: async () => {
      await browser.close().catch(() => {});
      // Disconnecting normally ends the session; releasing makes sure of it.
      await fetch(`${BB_API}/sessions/${session.id}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ status: "REQUEST_RELEASE", ...(env.BROWSERBASE_PROJECT_ID ? { projectId: env.BROWSERBASE_PROJECT_ID } : {}) }),
      }).catch((err) => log("warn", "browse", "session.release_failed", errorFields(err)));
    },
  };
}

/**
 * CDP over the runtime's own WebSocket. Given a URL, the Cloudflare fork of
 * puppeteer reaches for Node's `ws` package, which throws inside a Worker.
 */
function nativeSocket(url: string): Promise<ConnectionTransport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const transport: ConnectionTransport = {
      send: (message) => ws.send(message),
      close: () => ws.close(),
    };
    ws.addEventListener("open", () => resolve(transport));
    ws.addEventListener("error", () => reject(new Error("Browserbase WebSocket failed to open")));
    ws.addEventListener("message", (e) => transport.onmessage?.(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)));
    ws.addEventListener("close", () => transport.onclose?.());
  });
}

/**
 * Runs `fn` over `items` with at most `limit` in flight, results in input
 * order. For tabs sharing one browser: the free Browserbase plan allows a
 * single session, but a session holds as many pages as it has memory for.
 */
export async function pooled<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Tabs open at once in one session. Past this, pages start timing each other out. */
export const TABS = 4;

export type PageText = {
  url: string;
  title: string;
  text: string;
  links: { text: string; href: string }[];
  /** base64 JPEG of the page as loaded, when the caller asked for one. */
  shot?: string;
};

/**
 * Loads a page and returns what a model needs to read it: visible text and the
 * outbound links, not HTML.
 *
 * `capture` adds a JPEG of the page and, to make that worth looking at, lets
 * images load — so it is slower and heavier than a plain read. Ask for it when
 * someone will look at the result, not on every page in a batch.
 */
export async function readPage(browser: Browser, url: string, maxChars = 6000, capture = false): Promise<PageText> {
  const page = await browser.newPage();
  try {
    await lightweight(page, capture);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    // Give client-rendered pages a moment; don't wait for network idle, which
    // ad-heavy listing sites never reach.
    await new Promise((r) => setTimeout(r, 1200));
    // Taken before the DOM is stripped below: the capture has to show the page
    // a person would recognise, not one with its nav and footer torn out.
    const shot = capture
      ? await page
          .screenshot({ type: "jpeg", quality: 55, encoding: "base64" })
          .then((b) => String(b))
          .catch(() => undefined)
      : undefined;
    const out = await page.evaluate(() => {
      document.querySelectorAll("script,style,noscript,svg,nav,footer,iframe").forEach((el) => el.remove());
      const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
        .map((a) => ({ text: (a.innerText || "").trim().slice(0, 80), href: a.href }))
        .filter((l) => l.text && l.href.startsWith("http"));
      return { title: document.title, text: (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n"), links };
    });
    return { url: page.url(), title: out.title, text: out.text.slice(0, maxChars), links: out.links.slice(0, 60), shot };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Images, fonts and media are most of a page's weight and none of its meaning,
 * so they are dropped — unless the caller wants a screenshot, where an
 * image-less render is a picture of nothing anyone would recognise.
 */
async function lightweight(page: Page, keepImages = false) {
  await page.setRequestInterception(true);
  const drop = keepImages ? ["media", "font"] : ["image", "media", "font"];
  page.on("request", (req) => {
    if (drop.includes(req.resourceType())) req.abort().catch(() => {});
    else req.continue().catch(() => {});
  });
}

export type SearchHit = { title: string; url: string; snippet: string };

/**
 * Web search through the same browser. DuckDuckGo's HTML endpoint is used
 * because its markup is static and stable; result links are redirects that
 * carry the real destination in `uddg`.
 */
export async function searchWeb(browser: Browser, query: string, limit = 8): Promise<SearchHit[]> {
  const page = await browser.newPage();
  try {
    await lightweight(page);
    await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });
    const hits = await page.evaluate(() =>
      [...document.querySelectorAll(".result:not(.result--ad)")].map((r) => ({
        title: r.querySelector<HTMLElement>(".result__a")?.innerText.trim() ?? "",
        url: r.querySelector<HTMLAnchorElement>(".result__a")?.href ?? "",
        snippet: r.querySelector<HTMLElement>(".result__snippet")?.innerText.trim() ?? "",
      })),
    );
    return hits
      .map((h) => ({ ...h, url: unwrapRedirect(h.url) }))
      .filter((h) => h.title && h.url.startsWith("http") && !h.url.includes("duckduckgo.com/y.js"))
      .slice(0, limit);
  } finally {
    await page.close().catch(() => {});
  }
}

function unwrapRedirect(href: string): string {
  try {
    return new URL(href).searchParams.get("uddg") ?? href;
  } catch {
    return href;
  }
}
