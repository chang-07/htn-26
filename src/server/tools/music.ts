import type { Track } from "../../types";

type AppleSearchHit = {
  trackName?: string;
  artistName?: string;
  artworkUrl100?: string;
  previewUrl?: string;
  trackViewUrl?: string;
};

function normalized(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function titleMatchScore(query: string, title: string): number {
  const q = normalized(query);
  const t = normalized(title);
  if (!q || !t) return 0;
  if (q === t) return 100;
  if (q.length > 4 && (t.includes(q) || q.includes(t))) return 70;

  const queryWords = new Set(q.split(" "));
  const titleWords = new Set(t.split(" "));
  const overlap = [...queryWords].filter((word) => titleWords.has(word)).length;
  return overlap / Math.max(queryWords.size, titleWords.size) >= 0.7 ? 45 : 0;
}

function artistMatchScore(query: string | undefined, artist: string): number {
  if (!query?.trim()) return 0;
  const q = normalized(query);
  const a = normalized(artist);
  if (q === a) return 30;
  if (q.length > 2 && (a.includes(q) || q.includes(a))) return 18;
  return 0;
}

/** Find the closest named track and attach its Apple Music catalog page. */
export async function searchTrack(title: string, artist?: string): Promise<Track | null> {
  const term = encodeURIComponent([title, artist].filter(Boolean).join(" "));
  const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&country=ca&limit=10`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`itunes search answered ${res.status}`);
  const body = (await res.json()) as { results?: AppleSearchHit[] };
  const hit = (body.results ?? [])
    .filter((candidate): candidate is AppleSearchHit & { trackName: string } => Boolean(candidate.trackName))
    .map((candidate) => ({
      candidate,
      titleScore: titleMatchScore(title, candidate.trackName),
      artistScore: artistMatchScore(artist, candidate.artistName ?? ""),
    }))
    .filter((entry) => entry.titleScore >= 45 && (!artist?.trim() || entry.artistScore > 0))
    .sort((a, b) => b.titleScore + b.artistScore - (a.titleScore + a.artistScore))[0]?.candidate;
  if (!hit?.trackName) return null;
  return {
    title: hit.trackName,
    artist: hit.artistName ?? "",
    artUrl: hit.artworkUrl100,
    previewUrl: hit.previewUrl,
    appleMusicUrl: hit.trackViewUrl,
  };
}
