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
  close: () => Promise<void>;
};

export async function openBrowser(env: Env, opts: { timeoutSeconds?: number } = {}): Promise<BrowserSession> {
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
      browserSettings: { solveCaptchas: true, blockAds: true },
    }),
  });
  if (!res.ok) throw new Error(`Browserbase session create failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const session = (await res.json()) as { id: string; connectUrl: string };

  const browser = await puppeteer.connect({ transport: await nativeSocket(session.connectUrl) });
  log("info", "browse", "session.open", { provider: "browserbase", session: short(session.id) });

  return {
    browser,
    provider: "browserbase",
    sessionId: session.id,
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

export type PageText = { url: string; title: string; text: string; links: { text: string; href: string }[] };

/**
 * Loads a page and returns what a model needs to read it: visible text and the
 * outbound links, not HTML. Images, fonts and media are never fetched — they
 * are most of a page's weight and none of its meaning.
 */
export async function readPage(browser: Browser, url: string, maxChars = 6000): Promise<PageText> {
  const page = await browser.newPage();
  try {
    await lightweight(page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    // Give client-rendered pages a moment; don't wait for network idle, which
    // ad-heavy listing sites never reach.
    await new Promise((r) => setTimeout(r, 1200));
    const out = await page.evaluate(() => {
      document.querySelectorAll("script,style,noscript,svg,nav,footer,iframe").forEach((el) => el.remove());
      const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
        .map((a) => ({ text: (a.innerText || "").trim().slice(0, 80), href: a.href }))
        .filter((l) => l.text && l.href.startsWith("http"));
      return { title: document.title, text: (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n"), links };
    });
    return { url: page.url(), title: out.title, text: out.text.slice(0, maxChars), links: out.links.slice(0, 60) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function lightweight(page: Page) {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (["image", "media", "font"].includes(req.resourceType())) req.abort().catch(() => {});
    else req.continue().catch(() => {});
  });
}
