import { DurableObject } from "cloudflare:workers";

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
  updated: number;
};

const EMPTY: Profile = { links: [], facts: [], updated: 0 };
const MAX_FACTS = 12;

export class People extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS profiles (handle TEXT PRIMARY KEY, json TEXT NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, handle TEXT UNIQUE NOT NULL)`);
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

  /** Deletes the profile and retires the link. */
  async forget(handle: string) {
    this.ctx.storage.sql.exec(`DELETE FROM profiles WHERE handle = ?`, handle);
    this.ctx.storage.sql.exec(`DELETE FROM tokens WHERE handle = ?`, handle);
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
    p.facts.length && `mentioned: ${p.facts.join("; ")}`,
  ].filter(Boolean);
  return parts.join(" · ").slice(0, 420);
}

/** The blurb the match pool embeds, from the same profile. */
export function matchBlurb(p: Profile): string {
  return [p.interests, p.about, p.area && `Based in ${p.area}`].filter(Boolean).join(". ");
}
