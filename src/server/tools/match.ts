/**
 * Matchmaking over an opt-in pool. A profile is a short free-text blurb;
 * Workers AI embeds it and Vectorize finds the nearest neighbours. People only
 * enter the pool by asking to (texting the agent), never by being scraped.
 */
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5"; // 768 dims — must match the index

export type PoolProfile = { id: string; name: string; blurb: string };

async function embed(env: Env, text: string): Promise<number[]> {
  const out = (await env.AI.run(EMBED_MODEL, { text: [text] })) as { data: number[][] };
  return out.data[0];
}

export async function upsertProfile(env: Env, profile: PoolProfile) {
  await env.PEOPLE_INDEX.upsert([
    {
      id: profile.id,
      values: await embed(env, profile.blurb),
      metadata: { name: profile.name, blurb: profile.blurb },
    },
  ]);
}

/** Leaving the pool: "forget me", or un-ticking the box. */
export async function removeProfile(env: Env, id: string) {
  await env.PEOPLE_INDEX.deleteByIds([id]);
}

/** `exclude` is the asker plus anyone they have already been offered. */
export async function findMatches(env: Env, blurb: string, exclude: string[] = [], topK = 3) {
  const res = await env.PEOPLE_INDEX.query(await embed(env, blurb), {
    topK: Math.min(topK + exclude.length, 20),
    returnMetadata: "all",
  });
  return res.matches
    .filter((m) => !exclude.includes(m.id))
    .slice(0, topK)
    .map((m) => ({
      id: m.id,
      score: Number(m.score.toFixed(3)),
      name: String(m.metadata?.name ?? ""),
      blurb: String(m.metadata?.blurb ?? ""),
    }));
}
