import { DurableObject } from "cloudflare:workers";
import { INTRO_TTL_MS, type Intro, type IntroStatus } from "./intros";
import { removeProfile, upsertProfile } from "./tools/match";

/**
 * What the agent knows about a person, keyed by phone handle so it follows
 * them into every chat. A PlanAgent is one chat; this is the one place that is
 * about people rather than conversations.
 *
 * Two sources, both first-hand: the profile page a person fills in for
 * themselves (/p/<token>), and facts they state in a chat (remember_fact).
 * Nothing here is scraped or submitted by someone else, and "forget me"
 * deletes the row.
 */
export type Profile = {
  name?: string;
  area?: string;
  diet?: string;
  budget?: string;
  interests?: string;
  about?: string;
  links: string[];
  /** Things they said in a chat, newest last. */
  facts: string[];
  matchOptIn?: boolean;
  /** Onboarding questions they chose not to answer, so they are not asked twice. */
  skipped?: string[];
  /** Their one-to-one chat with the agent, so saving the form can be acknowledged there. */
  dmChat?: string;
  /**
   * Where their orders ship, and the email a store sends the receipt to. Typed
   * by them into their own form; used only to fill a checkout they asked for.
   * Never part of what the model reads.
   */
  shipTo?: { name: string; email: string; line1: string; line2?: string; city: string; region: string; postal: string; country: string };
  /**
   * The name and email half of `shipTo`, for someone who has only ever shipped
   * to an event: the address then belongs to the chat, not to them.
   */
  contact?: { name: string; email: string };
  /** Set once they have connected a wallet for purchases they approve. Never any card detail. */
  payments?: "connected";
  /** What reading the links THEY shared turned up: interests, one line, and a
   *  few observations worth having when planning for them. */
  online?: { interests: string[]; line: string; notes?: string[]; from: string[] };
  /** The links that `online` was read from, so they are re-read only when they change. */
  onlineReadOf?: string;
  updated: number;
};

/**
 * What onboarding asks for, in order, with the question's intent. The harness
 * works out what is still missing each turn; the model only words the question.
 */
export const ONBOARDING = [
  { key: "name", ask: "what they go by" },
  { key: "area", ask: "which neighbourhood or city they are based in" },
  { key: "diet", ask: "any food rules (vegetarian, halal, allergies) or none" },
  { key: "budget", ask: "what a normal night out costs them" },
  { key: "interests", ask: "a few things they are into" },
  { key: "links", ask: "any socials or links they are happy to share, such as an Instagram handle, Letterboxd or a personal site (optional)" },
  { key: "matchOptIn", ask: "whether they want to be introduced to people here with similar interests (yes or no)" },
] as const;

export type OnboardingKey = (typeof ONBOARDING)[number]["key"];

export function missingFields(p: Profile | undefined): (typeof ONBOARDING)[number][] {
  return ONBOARDING.filter(({ key }) => {
    if (p?.skipped?.includes(key)) return false;
    const value = p?.[key];
    // links is a list: an empty one means nobody has answered yet.
    return value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
  });
}

const EMPTY: Profile = { links: [], facts: [], updated: 0 };
const MAX_FACTS = 12;

export class People extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS profiles (handle TEXT PRIMARY KEY, json TEXT NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS intros (id TEXT PRIMARY KEY, from_handle TEXT NOT NULL, to_handle TEXT NOT NULL, json TEXT NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS pairings (code TEXT PRIMARY KEY, chat TEXT NOT NULL, expires INTEGER NOT NULL)`);
  }

  private read(handle: string): Profile | null {
    const row = this.ctx.storage.sql.exec<{ json: string }>(`SELECT json FROM profiles WHERE handle = ?`, handle).toArray()[0];
    return row ? { ...EMPTY, ...(JSON.parse(row.json) as Profile) } : null;
  }

  private write(handle: string, profile: Profile) {
    this.ctx.storage.sql.exec(
      `INSERT INTO profiles (handle, json) VALUES (?, ?) ON CONFLICT(handle) DO UPDATE SET json = excluded.json`,
      handle,
      JSON.stringify({ ...profile, updated: Date.now() }),
    );
  }

  async getMany(handles: string[]): Promise<Record<string, Profile>> {
    const out: Record<string, Profile> = {};
    for (const h of handles) {
      const p = this.read(h);
      if (p) out[h] = p;
    }
    return out;
  }

  /** The token in a person's profile link. It stands in for their identity, so it is unguessable and theirs alone. */
  async tokenFor(handle: string): Promise<string> {
    const row = this.ctx.storage.sql.exec<{ token: string }>(`SELECT token FROM tokens WHERE handle = ?`, handle).toArray()[0];
    if (row) return row.token;
    const token = crypto.randomUUID().replace(/-/g, "");
    this.ctx.storage.sql.exec(`INSERT INTO tokens (token, handle) VALUES (?, ?)`, token, handle);
    return token;
  }

  async byToken(token: string): Promise<{ handle: string; profile: Profile } | null> {
    const row = this.ctx.storage.sql.exec<{ handle: string }>(`SELECT handle FROM tokens WHERE token = ?`, token).toArray()[0];
    return row ? { handle: row.handle, profile: this.read(row.handle) ?? EMPTY } : null;
  }

  async save(handle: string, patch: Partial<Profile>): Promise<Profile> {
    const next = { ...(this.read(handle) ?? EMPTY), ...patch };
    this.write(handle, next);
    return next;
  }

  async addFact(handle: string, fact: string) {
    const p = this.read(handle) ?? EMPTY;
    const clean = fact.trim().slice(0, 140);
    if (!clean || p.facts.some((f) => f.toLowerCase() === clean.toLowerCase())) return;
    this.write(handle, { ...p, facts: [...p.facts, clean].slice(-MAX_FACTS) });
  }

  /** Deletes the profile, retires the link, and takes them out of matching. */
  async forget(handle: string) {
    this.ctx.storage.sql.exec(`DELETE FROM profiles WHERE handle = ?`, handle);
    this.ctx.storage.sql.exec(`DELETE FROM tokens WHERE handle = ?`, handle);
    this.ctx.storage.sql.exec(`DELETE FROM intros WHERE from_handle = ? OR to_handle = ?`, handle, handle);
    await removeProfile(this.env, handle).catch(() => {}); // the pool is best-effort; the profile is gone either way
  }

  // ---------------------------------------------------------------- pairing
  // A short-lived code that hands the iMessage drawer its chat id without a
  // card tap ("/link" in the chat mints it; the drawer claims it once). Lives
  // here because codes must resolve before the claimer knows which chat it is.

  async pairCreate(chat: string): Promise<string> {
    // No ambiguous glyphs (0/O, 1/I/L): the code is read off one phone screen
    // and typed into another.
    const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
    this.ctx.storage.sql.exec(`DELETE FROM pairings WHERE expires < ?`, Date.now());
    this.ctx.storage.sql.exec(
      `INSERT INTO pairings (code, chat, expires) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET chat = excluded.chat, expires = excluded.expires`,
      code,
      chat,
      Date.now() + 10 * 60_000,
    );
    return code;
  }

  /** Single use: the first claim burns the code, hit or miss. */
  async pairClaim(code: string): Promise<string | null> {
    const row = this.ctx.storage.sql
      .exec<{ chat: string; expires: number }>(`SELECT chat, expires FROM pairings WHERE code = ?`, code)
      .toArray()[0];
    this.ctx.storage.sql.exec(`DELETE FROM pairings WHERE code = ?`, code);
    return row && row.expires > Date.now() ? row.chat : null;
  }

  // ----------------------------------------------------------------- intros
  // See intros.ts for the flow. One row per ask, whatever became of it, so the
  // same two people are never offered to each other twice.

  private introsWhere(where: string, ...args: string[]): Intro[] {
    return this.ctx.storage.sql
      .exec<{ json: string }>(`SELECT json FROM intros WHERE ${where}`, ...args)
      .toArray()
      .map((r) => JSON.parse(r.json) as Intro)
      .map((i) => (i.status === "pending" && Date.now() - i.created > INTRO_TTL_MS ? { ...i, status: "expired" as const } : i));
  }

  async createIntro(intro: Intro) {
    this.ctx.storage.sql.exec(`INSERT INTO intros (id, from_handle, to_handle, json) VALUES (?, ?, ?, ?)`, intro.id, intro.from, intro.to, JSON.stringify(intro));
  }

  async getIntro(id: string): Promise<Intro | null> {
    return this.introsWhere(`id = ?`, id)[0] ?? null;
  }

  async updateIntro(id: string, patch: { status?: IntroStatus; chat?: string }): Promise<Intro | null> {
    const intro = this.introsWhere(`id = ?`, id)[0];
    if (!intro) return null;
    const next = { ...intro, ...patch };
    this.ctx.storage.sql.exec(`UPDATE intros SET json = ? WHERE id = ?`, JSON.stringify(next), id);
    return next;
  }

  /**
   * The pool without Vectorize: everyone opted in, ranked by shared words. Far
   * cruder than embeddings ("climbing" will not find "bouldering"), but it needs
   * no Cloudflare login, so pairing still works on a laptop and when the index
   * is down.
   */
  async scanPool(query: string, exclude: string[], topK = 3) {
    const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{3,}/g) ?? []);
    const want = words(query);
    return this.ctx.storage.sql
      .exec<{ handle: string; json: string }>(`SELECT handle, json FROM profiles`)
      .toArray()
      .map((r) => ({ id: r.handle, profile: { ...EMPTY, ...(JSON.parse(r.json) as Profile) } }))
      .filter(({ id, profile }) => profile.matchOptIn && !exclude.includes(id) && matchBlurb(profile))
      .map(({ id, profile }) => {
        const blurb = matchBlurb(profile);
        const shared = [...words(blurb)].filter((w) => want.has(w)).length;
        return { id, name: profile.name ?? "", blurb, score: Number((shared / Math.max(want.size, 1)).toFixed(3)) };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Asks waiting on this person. They are asked about one at a time. */
  async pendingTo(handle: string): Promise<Intro[]> {
    return this.introsWhere(`to_handle = ?`, handle).filter((i) => i.status === "pending");
  }

  /** Asks this person has out that nobody has answered yet. */
  async pendingFrom(handle: string): Promise<Intro[]> {
    return this.introsWhere(`from_handle = ?`, handle).filter((i) => i.status === "pending");
  }

  /**
   * Forgets every introduction these people were part of, so they can be
   * matched again. Their profiles and pool membership are untouched. Returns
   * the direct chats of everyone involved, whose pending asks are now stale.
   */
  async clearIntros(handles: string[]): Promise<number> {
    let cleared = 0;
    for (const h of handles) {
      cleared += this.introsWhere(`from_handle = ? OR to_handle = ?`, h, h).length;
      this.ctx.storage.sql.exec(`DELETE FROM intros WHERE from_handle = ? OR to_handle = ?`, h, h);
    }
    return cleared;
  }

  /** Everyone this person has been paired with or offered, in either direction. */
  async pairedWith(handle: string): Promise<string[]> {
    return this.introsWhere(`from_handle = ? OR to_handle = ?`, handle, handle).map((i) => (i.from === handle ? i.to : i.from));
  }
}

export const people = (env: Env) => env.People.get(env.People.idFromName("global"));

/** A profile as the model reads it: a few short lines, capped so ten people don't swamp the prompt. */
export function profileLines(p: Profile): string {
  const parts = [
    p.area && `based in ${p.area}`,
    p.diet && `eats: ${p.diet}`,
    p.budget && `budget: ${p.budget}`,
    p.interests && `into: ${p.interests}`,
    p.about && `says: ${p.about}`,
    p.payments === "connected" && "has payments set up",
    p.links.length && `links: ${p.links.join(", ")}`,
    p.online?.interests.length && `their ${p.online.from.join(" + ")} shows: ${p.online.interests.join(", ")}`,
    // The notes are the part worth planning around — an interest tag says
    // "climbing", a note says they climb most weekends.
    p.online?.notes?.length && `noted from their links: ${p.online.notes.join("; ")}`,
    p.facts.length && `mentioned: ${p.facts.join("; ")}`,
  ].filter(Boolean);
  return parts.join(" · ").slice(0, 420);
}

/**
 * Same profile, same consent: opting in is what puts someone in the match pool.
 * Returns false when the pool could not be reached, which must not lose the save.
 */
export async function syncMatchPool(env: Env, handle: string, p: Profile): Promise<boolean> {
  if (!p.matchOptIn || !matchBlurb(p)) {
    // Un-ticking the box has to take them out, not just stop updating them.
    await removeProfile(env, handle).catch(() => {});
    return true;
  }
  try {
    await upsertProfile(env, { id: handle, name: p.name ?? "", blurb: matchBlurb(p) });
    return true;
  } catch {
    return false;
  }
}

/** The blurb the match pool embeds, from the same profile. */
export function matchBlurb(p: Profile): string {
  return [p.interests, p.online?.interests.join(", "), p.online?.notes?.join(". "), p.about, p.area && `Based in ${p.area}`]
    .filter(Boolean)
    .join(". ");
}
