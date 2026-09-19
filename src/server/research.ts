import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import { z } from "zod";
import type { PlanAgent } from "./agent";
import { openBrowser, pooled, readPage, searchWeb, TABS, type SearchHit } from "./browser";
import { askJson } from "./llm";
import { errorFields, log } from "./log";

/**
 * Deep research for one planning question: "where should eight of us go for a
 * birthday dinner near King West on Friday, ~$60 a head".
 *
 *   plan ─▶ search ─▶ select ─▶ read + extract ─▶ synthesize ─▶ report
 *   LLM     browser    LLM       browser + LLM     LLM           agent RPC
 *
 * It is a Workflow for the same reason booking is: it runs for minutes, far
 * longer than an agent turn should block, and every `step.do` result is
 * persisted — a crash while reading page five resumes after the search, it does
 * not pay for the search again. The model never drives the browser directly;
 * it decides *what* to look for and *what it means*, and fixed code does the
 * navigation. That keeps a run bounded in time, tokens and browser minutes.
 */
export type ResearchParams = {
  brief: string;
  near: string;
  when?: string;
  partySize?: number;
  depth: keyof typeof DEPTH;
};

/** The whole cost of a run is set here. */
export const DEPTH = {
  quick: { queries: 2, pages: 3, pageChars: 4000 },
  deep: { queries: 4, pages: 8, pageChars: 6000 },
} as const;

const Candidate = z.object({
  name: z.string(),
  kind: z.string().describe("restaurant, bar, activity, venue, ..."),
  why: z.string().describe("One line: why it fits this group's brief"),
  address: z.string().optional(),
  price: z.string().optional().describe("As stated on the page, e.g. '$$', '$45 pp'"),
  bookingUrl: z.string().optional().describe("Only a URL that appears on the page"),
  caveat: z.string().optional().describe("Anything that might rule it out: closed Mondays, 19+, deposit"),
});
export type Candidate = z.infer<typeof Candidate> & { sources: string[] };

export type ResearchReport = {
  ok: boolean;
  brief: string;
  summary: string;
  candidates: Candidate[];
  stats: { queries: number; hits: number; pagesRead: number; pagesFailed: number; tokens: number; ms: number };
  /** Browserbase replays, for debugging a run that came back thin. */
  sessions: string[];
  detail?: string;
};

const STEP = { retries: { limit: 1, delay: "5 seconds" as const }, timeout: "4 minutes" as const };

export class ResearchWorkflow extends AgentWorkflow<PlanAgent, ResearchParams> {
  async run(event: AgentWorkflowEvent<ResearchParams>, step: AgentWorkflowStep) {
    const p = event.payload;
    const budget = DEPTH[p.depth] ?? DEPTH.quick;
    const started = Date.now();
    const ask = `${p.brief}. Near: ${p.near}.${p.when ? ` When: ${p.when}.` : ""}${p.partySize ? ` Group of ${p.partySize}.` : ""}`;
    let tokens = 0;
    const sessions: string[] = [];
    const progress = (stage: string, fields: Record<string, unknown> = {}) =>
      // Progress is for the log only; losing a line must never fail the run.
      this.agent.researchProgress(stage, fields).catch((err) => log("warn", "research", "progress.failed", { stage, ...errorFields(err) }));

    try {
      // 1. What to search for.
      const plan = await step.do("plan", STEP, async () => {
        const r = await askJson(
          this.env,
          z.object({ queries: z.array(z.string()).min(1) }),
          `You plan web research for a group organising an outing. Write ${budget.queries} web search queries that together would surface specific, bookable places. Vary the angle: one "best of" list query, one that names the constraint that matters most (group size, budget, dietary, vibe), one local-blog or reddit style query. Always include the location.`,
          ask,
        );
        return { queries: r.value.queries.slice(0, budget.queries), tokens: r.tokens };
      });
      tokens += plan.tokens;
      await progress("planned", { queries: plan.queries });

      // 2. Run the searches in one browser session.
      const found = await step.do("search", STEP, async () => {
        const session = await openBrowser(this.env, { timeoutSeconds: 180 });
        try {
          // A tab per query. Merged in query order afterwards, so the hit
          // list does not depend on which search came back first.
          const batches = await pooled(plan.queries, TABS, (q) =>
            searchWeb(session.browser, q).catch((err) => {
              log("warn", "research", "search.failed", { q, ...errorFields(err) });
              return [] as SearchHit[];
            }),
          );
          const hits = new Map<string, SearchHit>();
          for (const h of batches.flat()) if (!hits.has(h.url)) hits.set(h.url, h);
          return { hits: [...hits.values()], session: session.sessionId };
        } finally {
          await session.close();
        }
      });
      if (found.session) sessions.push(found.session);
      await progress("searched", { hits: found.hits.length });
      if (found.hits.length === 0) throw new Error("every search came back empty");

      // 3. Which results are worth the browser time.
      const picked = await step.do("select", STEP, async () => {
        const r = await askJson(
          this.env,
          z.object({ indexes: z.array(z.number().int()) }),
          `Pick the ${budget.pages} search results most likely to name specific places that fit the brief. Prefer curated lists, local guides and the venues' own pages over aggregator landing pages with no detail. Avoid picking several results from the same site. Answer with their indexes.`,
          `Brief: ${ask}\n\n${found.hits.map((h, i) => `[${i}] ${h.title} — ${new URL(h.url).host}\n    ${h.snippet}`).join("\n")}`,
        );
        const urls = [...new Set(r.value.indexes)].map((i) => found.hits[i]?.url).filter(Boolean) as string[];
        // A model that returns nothing usable should not sink the run.
        return { urls: (urls.length ? urls : found.hits.map((h) => h.url)).slice(0, budget.pages), tokens: r.tokens };
      });
      tokens += picked.tokens;
      await progress("selected", { count: picked.urls.length, hosts: picked.urls.map((u) => new URL(u).host) });

      // 4. Read each page and pull candidates out of it. Extraction is per page
      //    so that each prompt stays small enough for a local dev model.
      const read = await step.do("read", { ...STEP, timeout: "8 minutes" }, async () => {
        const session = await openBrowser(this.env, { timeoutSeconds: 420 });
        // Watchable while it runs, the same way a booking is.
        await progress("browser", { provider: session.provider, liveUrl: session.liveUrl });
        let used = 0;
        try {
          // A tab per page, each followed straight away by its own extraction,
          // so the model is reading page one while the browser loads page two.
          const pages = await pooled(picked.urls, TABS, async (url) => {
            try {
              const page = await readPage(session.browser, url, budget.pageChars, true);
              const r = await askJson(
                this.env,
                z.object({ candidates: z.array(Candidate).max(6) }),
                `Extract specific places from this web page that could fit the brief. Use only what the page says — never invent an address, price or URL. If the page names no specific places, return an empty list.`,
                `Brief: ${ask}\n\nPage: ${page.title} (${page.url})\n\n${page.text}\n\nLinks on the page:\n${page.links.slice(0, 40).map((l) => `${l.text} -> ${l.href}`).join("\n")}`,
              );
              used += r.tokens;
              // Kept on the chat agent and served from /shot, so the run viewer
              // can show what the browser actually landed on.
              const shotId = page.shot ? await this.agent.saveShot(page.shot).catch(() => undefined) : undefined;
              await progress("read", { host: new URL(url).host, candidates: r.value.candidates.length, shotId, url: page.url });
              return { url: page.url, candidates: r.value.candidates };
            } catch (err) {
              log("warn", "research", "page.failed", { url, ...errorFields(err) });
              return null;
            }
          });
          const out = pages.filter((pg) => pg !== null);
          return { pages: out, failed: pages.length - out.length, tokens: used, session: session.sessionId };
        } finally {
          await session.close();
        }
      });
      tokens += read.tokens;
      if (read.session) sessions.push(read.session);

      const all = read.pages.flatMap((pg) => pg.candidates.map((c) => ({ ...c, source: pg.url })));
      if (all.length === 0) throw new Error(`read ${read.pages.length} pages and found no specific places`);

      // 5. Merge duplicates, rank, and say why.
      const final = await step.do("synthesize", STEP, async () => {
        const r = await askJson(
          this.env,
          z.object({
            summary: z.string().describe("Two sentences a friend would text: what you found and the standout"),
            ranked: z.array(z.object({ indexes: z.array(z.number().int()).min(1), why: z.string() })).max(5),
          }),
          `You are choosing the best options for a group. Below are candidate places extracted from several web pages; the same place may appear more than once. Return up to 5, best first. For each, list the indexes of every entry that refers to it, and one line on why it fits. Places named by several independent sources deserve more trust.`,
          `Brief: ${ask}\n\n${all.map((c, i) => `[${i}] ${c.name} (${c.kind})${c.price ? ` ${c.price}` : ""}${c.address ? ` — ${c.address}` : ""}: ${c.why}${c.caveat ? ` ⚠ ${c.caveat}` : ""} <${new URL(c.source).host}>`).join("\n")}`,
        );
        return { ...r.value, tokens: r.tokens };
      });
      tokens += final.tokens;

      // Facts come from the extracted entries, not from the ranking model's
      // retelling, so a merge cannot introduce a made-up address or link.
      const candidates: Candidate[] = final.ranked.flatMap((rank) => {
        const entries = rank.indexes.map((i) => all[i]).filter(Boolean);
        if (entries.length === 0) return [];
        const pick = <K extends keyof (typeof entries)[0]>(k: K) => entries.find((e) => e[k])?.[k];
        const { source: _s, ...first } = entries[0];
        return [{
          ...first,
          why: rank.why,
          address: pick("address"),
          price: pick("price"),
          bookingUrl: pick("bookingUrl"),
          caveat: pick("caveat"),
          sources: [...new Set(entries.map((e) => e.source))],
        }];
      });

      const report: ResearchReport = {
        ok: true,
        brief: p.brief,
        summary: final.summary,
        candidates,
        stats: { queries: plan.queries.length, hits: found.hits.length, pagesRead: read.pages.length, pagesFailed: read.failed, tokens, ms: Date.now() - started },
        sessions,
      };
      await step.do("report", () => this.agent.researchFinished(report));
      return report;
    } catch (err) {
      const report: ResearchReport = {
        ok: false,
        brief: p.brief,
        summary: "",
        candidates: [],
        stats: { queries: 0, hits: 0, pagesRead: 0, pagesFailed: 0, tokens, ms: Date.now() - started },
        sessions,
        detail: err instanceof Error ? err.message : String(err),
      };
      await step.do("report-failure", () => this.agent.researchFinished(report));
      return report;
    }
  }
}
