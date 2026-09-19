import type { Browser } from "@cloudflare/puppeteer";
import { z } from "zod";
import { openBrowser, readPage } from "./browser";
import { askJson } from "./llm";
import { errorFields, log } from "./log";

/**
 * Reading the links a person shared about themselves, to plan things they will
 * actually like.
 *
 * The rule that makes this acceptable: a link is only ever read because its
 * owner typed it into their own profile. Nothing here takes a handle from a
 * group chat, a contact list or another person, and "their account is public"
 * is not what permits it — they asking us to look is. What was read is then
 * told to them in their own chat, so none of it happens behind their back.
 *
 * Instagram is read through the bot's own signed-in account (a persistent
 * Browserbase context, set up by hand with scripts/ig-login.mjs). That login can
 * be challenged or banned at any moment, so every path here ends in "skipped",
 * never in an error the person sees.
 */

export type LinkSource =
  | { kind: "instagram"; handle: string; label: string }
  | { kind: "web"; url: string; label: string };

export type ReadOutcome = { source: LinkSource; ok: boolean; text?: string; skipped?: "private" | "login_wall" | "not_found" | "unreadable" };

export type OnlineSummary = {
  /** Short phrases, e.g. "film photography", "bouldering". */
  interests: string[];
  /** One line in plain words, for the profile. */
  line: string;
  read: string[];
  skipped: { label: string; why: string }[];
  tokens: number;
};

const IG_HANDLE = /^[a-z0-9._]{1,30}$/i;

/** Turns what someone typed ("@me on insta", "letterboxd.com/me") into things that can be opened. */
export function parseLinks(links: string[]): LinkSource[] {
  const out: LinkSource[] = [];
  for (const raw of links.slice(0, 6)) {
    const text = raw.trim();
    // An Instagram handle arrives as a URL, as "@name", or as "name on insta".
    const fromUrl = text.match(/instagram\.com\/([a-z0-9._]+)/i)?.[1];
    const at = text.match(/@([a-z0-9._]{2,30})/i)?.[1];
    const saysInstagram = /\b(insta(gram)?|ig)\b/i.test(text);
    const firstWord = text.split(/[\s:,]+/).find((w) => !/^(insta(gram)?|ig|on|my|is|at)$/i.test(w))?.replace(/^@/, "");
    const handle = fromUrl ?? (saysInstagram ? (at ?? firstWord) : /^@\S+$/.test(text) ? at : undefined);
    if (handle && IG_HANDLE.test(handle) && !text.includes("/") === !fromUrl) {
      out.push({ kind: "instagram", handle: handle.toLowerCase(), label: "instagram" });
      continue;
    }
    const url = text.match(/((https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?)/i)?.[1];
    if (url) {
      const full = url.startsWith("http") ? url : `https://${url}`;
      try {
        out.push({ kind: "web", url: full, label: new URL(full).hostname.replace(/^www\./, "") });
      } catch {
        // not a URL after all
      }
    }
  }
  // The same account given twice ("@me" and the full URL) is read once.
  const seen = new Set<string>();
  return out.filter((s) => {
    const key = s.kind === "instagram" ? `ig:${s.handle}` : s.url;
    return seen.has(key) ? false : (seen.add(key), true);
  }).slice(0, 4);
}

export async function readInstagram(browser: Browser, handle: string): Promise<Omit<ReadOutcome, "source">> {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 1600 });
    await page.goto(`https://www.instagram.com/${encodeURIComponent(handle)}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 4500)); // the grid renders after load

    const seen = await page.evaluate(() => {
      const body = document.body?.innerText ?? "";
      const header = document.querySelector<HTMLElement>("header")?.innerText ?? "";
      // Instagram writes a description of each photo into its alt text, which
      // says far more about a person's interests than the captions do.
      const alts = Array.from(document.querySelectorAll<HTMLImageElement>("main img"))
        .map((img) => (img.alt ?? "").replace(/\s+/g, " ").trim())
        .filter((alt) => alt.length > 25)
        .slice(0, 14);
      return { path: location.pathname, body: body.slice(0, 1500), header: header.slice(0, 700), alts };
    });

    if (seen.path.startsWith("/accounts/login") || /log in to (see|continue)/i.test(seen.body)) return { ok: false, skipped: "login_wall" };
    if (/this account is private/i.test(seen.body)) return { ok: false, skipped: "private" };
    if (/page isn.t available|page not found/i.test(seen.body)) return { ok: false, skipped: "not_found" };
    if (!seen.header && !seen.alts.length) return { ok: false, skipped: "unreadable" };

    return { ok: true, text: `PROFILE HEADER:\n${seen.header}\n\nRECENT POSTS (image descriptions):\n${seen.alts.map((a) => `- ${a}`).join("\n")}`.slice(0, 3500) };
  } finally {
    await page.close().catch(() => {});
  }
}

const Summary = z.object({
  interests: z.array(z.string()).max(6).describe("Short phrases for things they evidently enjoy: 'film photography', 'bouldering', 'ramen'"),
  line: z.string().describe("One plain sentence a friend might say about what they are into, under 140 characters"),
});

const SYSTEM = `You read pages a person shared about themselves (their own socials and sites) and note what they enjoy, so a friend planning an outing can pick something they would like.

- Only interests and tastes that are plainly evidenced by the text: hobbies, food, music, films, sports, places, scenes.
- Never infer or mention health, religion, politics, sexuality, ethnicity, relationships, family, money, their job's details, or where they live. If that is all a page shows, return no interests.
- Do not name other people who appear. Do not quote captions. No follower counts.
- If the pages say little, return few interests or none. Never pad.`;

/** Reads each link and boils them down to a handful of interests. Never throws. */
export async function readLinks(env: Env, links: string[]): Promise<OnlineSummary> {
  const sources = parseLinks(links);
  const empty: OnlineSummary = { interests: [], line: "", read: [], skipped: [], tokens: 0 };
  if (!sources.length) return empty;

  const outcomes: ReadOutcome[] = [];
  let session;
  try {
    // Signed in only when there is an Instagram link to read; a personal site needs no login.
    session = await openBrowser(env, { timeoutSeconds: 180, signedIn: sources.some((s) => s.kind === "instagram") });
    for (const source of sources) {
      try {
        if (source.kind === "instagram") {
          outcomes.push({ source, ...(await readInstagram(session.browser, source.handle)) });
        } else {
          const page = await readPage(session.browser, source.url, 3000);
          outcomes.push(page.text.trim().length > 80 ? { source, ok: true, text: `${page.title}\n${page.text}` } : { source, ok: false, skipped: "unreadable" });
        }
      } catch (err) {
        log("warn", "social", "read.failed", { source: source.label, ...errorFields(err) });
        outcomes.push({ source, ok: false, skipped: "unreadable" });
      }
    }
  } catch (err) {
    log("warn", "social", "browser.failed", errorFields(err));
    return { ...empty, skipped: sources.map((s) => ({ label: s.label, why: "unreadable" })) };
  } finally {
    await session?.close();
  }

  const read = outcomes.filter((o) => o.ok && o.text);
  const skipped = outcomes.filter((o) => !o.ok).map((o) => ({ label: o.source.label, why: o.skipped ?? "unreadable" }));
  log("info", "social", "read.done", { read: read.map((o) => o.source.label), skipped });
  if (!read.length) return { ...empty, skipped };

  try {
    const res = await askJson(env, Summary, SYSTEM, read.map((o) => `=== ${o.source.label} ===\n${o.text}`).join("\n\n"));
    return {
      interests: res.value.interests.map((i) => i.trim().slice(0, 40)).filter(Boolean).slice(0, 6),
      line: res.value.line.trim().slice(0, 160),
      read: read.map((o) => o.source.label),
      skipped,
      tokens: res.tokens,
    };
  } catch (err) {
    log("warn", "social", "summarise.failed", errorFields(err));
    return { ...empty, read: read.map((o) => o.source.label), skipped };
  }
}
