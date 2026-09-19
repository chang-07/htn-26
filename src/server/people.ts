import { DurableObject } from "cloudflare:workers";
import { upsertProfile } from "./tools/match";

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
  { key: "matchOptIn", ask: "whether they want to be introduced to people here with similar interests (yes or no)" },
] as const;

export type OnboardingKey = (typeof ONBOARDING)[number]["key"];

export function missingFields(p: Profile | undefined): (typeof ONBOARDING)[number][] {
  return ONBOARDING.filter(({ key }) => {
    if (p?.skipped?.includes(key)) return false;
    const value = p?.[key];
    return value === undefined || value === "";
  });
}

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

/**
 * Same profile, same consent: opting in is what puts someone in the match pool.
 * Returns false when the pool could not be reached, which must not lose the save.
 */
export async function syncMatchPool(env: Env, handle: string, p: Profile): Promise<boolean> {
  if (!p.matchOptIn || !matchBlurb(p)) return true;
  try {
    await upsertProfile(env, { id: handle, name: p.name ?? "", blurb: matchBlurb(p) });
    return true;
  } catch {
    return false;
  }
}

/** The blurb the match pool embeds, from the same profile. */
export function matchBlurb(p: Profile): string {
  return [p.interests, p.about, p.area && `Based in ${p.area}`].filter(Boolean).join(". ");
}
