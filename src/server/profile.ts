import { log, mask } from "./log";
import { people, syncMatchPool, type Profile } from "./people";

/**
 * The page behind a person's profile link: GET shows the form, POST saves it.
 * The token in the path is the only credential, so it is sent to its owner in a
 * one-to-one chat and never posted to a group.
 */
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const FIELDS: { key: keyof Profile & string; label: string; hint: string; long?: boolean }[] = [
  { key: "name", label: "What you go by", hint: "Maya" },
  { key: "area", label: "Where you're based", hint: "Neighbourhood or city" },
  { key: "diet", label: "Food rules", hint: "Vegetarian, halal, no shellfish, none…" },
  { key: "budget", label: "A normal night out costs", hint: "$20, $50, whatever it takes" },
  { key: "interests", label: "What you're into", hint: "Bouldering, ramen, film cameras", long: true },
  { key: "about", label: "Anything else worth knowing", hint: "Hate loud bars. Free most Fridays.", long: true },
];

function page(body: string, done = false) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your profile</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@800&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
  *{box-sizing:border-box;}
  body{margin:0;background:#efe7d6;color:#241f17;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:15px;line-height:1.5;padding:28px 20px 60px;}
  main{max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:22px;}
  h1{font-family:"Archivo",system-ui,sans-serif;font-weight:800;font-size:34px;line-height:1;letter-spacing:-.02em;margin:0;}
  .meta{font-size:11.5px;letter-spacing:.13em;text-transform:uppercase;opacity:.62;}
  p{margin:0;}
  form{display:flex;flex-direction:column;gap:18px;}
  label{display:flex;flex-direction:column;gap:6px;font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;}
  input[type=text],textarea{width:100%;font:inherit;font-size:16px;letter-spacing:0;text-transform:none;color:inherit;background:#f8f3e6;
    border:1.5px solid #241f17;border-radius:8px;padding:11px 12px;}
  textarea{min-height:74px;resize:vertical;}
  input:focus,textarea:focus,button:focus-visible{outline:3px solid #1f5f4f;outline-offset:2px;}
  .check{flex-direction:row;align-items:flex-start;gap:10px;text-transform:none;letter-spacing:0;font-size:14px;}
  .check input{width:20px;height:20px;margin:1px 0 0;accent-color:#1f5f4f;}
  button{font-family:"Archivo",sans-serif;font-weight:800;font-size:18px;background:#241f17;color:#efe7d6;border:0;border-radius:10px;padding:15px;cursor:pointer;}
  .perf{border-top:2px dotted rgba(36,31,23,.32);}
  .done{background:#1f5f4f;color:#f0ece2;}
  small{opacity:.62;font-size:12.5px;}
</style></head><body${done ? ' class="done"' : ""}>${body}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export async function handleProfile(request: Request, url: URL, env: Env): Promise<Response> {
  const token = url.pathname.slice("/p/".length);
  const found = token ? await people(env).byToken(token) : null;
  if (!found) {
    return page(`<main><span class="meta">Profile</span><h1>This link isn't valid</h1>
      <p>Text the planner "profile" and it will send you a fresh one.</p></main>`);
  }
  const { handle, profile } = found;

  if (request.method === "POST") {
    const form = await request.formData();
    const text = (k: string, max: number) => String(form.get(k) ?? "").trim().slice(0, max) || undefined;
    const saved = await people(env).save(handle, {
      name: text("name", 40),
      area: text("area", 80),
      diet: text("diet", 120),
      budget: text("budget", 60),
      interests: text("interests", 300),
      about: text("about", 300),
      links: String(form.get("links") ?? "")
        .split(/\s+/)
        .filter((l) => /^https?:\/\/\S+\.\S+/.test(l))
        .slice(0, 6),
      matchOptIn: form.get("matchOptIn") === "on",
    });
    log("info", "people", "profile.saved", { who: mask(handle), matchOptIn: saved.matchOptIn, links: saved.links.length });

    // Same profile, same consent: ticking the box is what puts someone in the pool.
    if (!(await syncMatchPool(env, handle, saved))) log("warn", "people", "match_pool.failed", { who: mask(handle) });
    return page(`<main><span class="meta">Saved</span><h1>Got it${saved.name ? `, ${esc(saved.name)}` : ""}</h1>
      <p>The planner will use this in every chat you're in. Open this link again any time to change it, or text "forget me" to delete it.</p></main>`, true);
  }

  const inputs = FIELDS.map((f) => {
    const value = esc(String(profile[f.key] ?? ""));
    return `<label>${f.label}${
      f.long
        ? `<textarea id="${f.key}" name="${f.key}" placeholder="${esc(f.hint)}">${value}</textarea>`
        : `<input id="${f.key}" type="text" name="${f.key}" value="${value}" placeholder="${esc(f.hint)}">`
    }</label>`;
  }).join("");

  return page(`<main>
    <span class="meta">Planner · your profile</span>
    <h1>So the plans fit you</h1>
    <p>The planner reads this before it suggests anything, in every group chat you're in. Fill in what you like; skip the rest.</p>
    <div class="perf"></div>
    <form method="post">
      ${inputs}
      <label>Links, if you want<textarea id="links" name="links" placeholder="Personal site, GitHub, Letterboxd, Spotify… one per line">${esc(profile.links.join("\n"))}</textarea></label>
      <label class="check"><input id="matchOptIn" type="checkbox" name="matchOptIn" ${profile.matchOptIn ? "checked" : ""}>
        <span>Count me in for matching. The planner may introduce me to someone here with similar interests.</span></label>
      <button type="submit">Save</button>
      <small>Only you have this link. Text the planner "forget me" and all of it is deleted.</small>
    </form></main>`);
}
