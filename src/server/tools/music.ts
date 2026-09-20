import type { Track } from "../../types";

/**
 * Song lookup via the iTunes Search API: free, no key, and every hit carries a
 * 30-second preview clip and album art. The playlist plays previews, not full
 * tracks — that is the honest scope of a bubble player with no music-service auth.
 */
export async function searchTrack(title: string, artist?: string): Promise<Track | null> {
  const term = encodeURIComponent([title, artist].filter(Boolean).join(" "));
  const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=song&limit=1`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`itunes search answered ${res.status}`);
  const body = (await res.json()) as { results?: { trackName?: string; artistName?: string; artworkUrl100?: string; previewUrl?: string }[] };
  const hit = body.results?.[0];
  if (!hit?.trackName) return null;
  return {
    title: hit.trackName,
    artist: hit.artistName ?? "",
    artUrl: hit.artworkUrl100,
    previewUrl: hit.previewUrl,
  };
}
