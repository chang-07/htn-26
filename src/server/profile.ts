import { log, mask } from "./log";
import { getAgentByName } from "agents";
import type { PlanAgent } from "./agent";
import { ONBOARDING, people, syncMatchPool, type Profile } from "./people";
import { TICKET_CSS, TICKET_FONTS } from "../theme";

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

/** One shell for every state of the page; the look lives in src/theme.ts, shared with the vote page. */
function page(body: string, done = false) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light"><title>Your profile</title>
<link rel="stylesheet" href="${TICKET_FONTS}">
<style>html,body{margin:0;background:${done ? "#1f5f4f" : "#efe7d6"};}${TICKET_CSS}</style></head>
<body><div class="tk-page${done ? " is-done" : ""}"><div class="tk-wrap">${body}</div></div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export async function handleProfile(request: Request, url: URL, env: Env): Promise<Response> {
  const token = url.pathname.slice("/p/".length);
  const found = token ? await people(env).byToken(token) : null;
  if (!found) {
    return page(`<div class="tk-meta">Profile</div><h1 class="tk-title">This link isn't valid</h1>
      <hr class="tk-perf"><p style="margin:0">Text the planner "profile" and it will send you a fresh one.</p>`);
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
      // One per line. A handle ("@chang on instagram") is as good as a URL here:
      // the chat accepts them, so the form must not silently drop them.
      links: String(form.get("links") ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, 6),
      matchOptIn: form.get("matchOptIn") === "on",
      // "Fill in what you like; skip the rest" has to mean it: a field left
      // blank on the form is an answer, so the chat does not ask for it again.
      skipped: ONBOARDING.map((o) => o.key).filter((k) => k !== "matchOptIn" && !String(form.get(k) ?? "").trim()),
    });
    log("info", "people", "profile.saved", { who: mask(handle), matchOptIn: saved.matchOptIn, links: saved.links.length });

    // Same profile, same consent: ticking the box is what puts someone in the pool.
    if (!(await syncMatchPool(env, handle, saved))) log("warn", "people", "match_pool.failed", { who: mask(handle) });

    // Close the loop where they started: a line in their chat with the agent.
    if (saved.dmChat) {
      const agent = await getAgentByName<Env, PlanAgent>(env.PlanAgent, saved.dmChat);
      await agent.profileSaved(saved.name).catch((err) => log("warn", "people", "profile.ack_failed", { error: String(err).slice(0, 200) }));
    }
    return page(`<div class="tk-meta">Saved</div><h1 class="tk-title">Got it${saved.name ? `, ${esc(saved.name)}` : ""}</h1>
      <hr class="tk-perf"><p style="margin:0">The planner uses this in every chat you're in. Open this link again to change it, or text "forget me" to delete it.</p>`, true);
  }

  const inputs = FIELDS.map((f) => {
    const value = esc(String(profile[f.key] ?? ""));
    return `<label class="tk-field"><span class="tk-meta">${f.label}</span>${
      f.long
        ? `<textarea id="${f.key}" name="${f.key}" placeholder="${esc(f.hint)}">${value}</textarea>`
        : `<input id="${f.key}" type="text" name="${f.key}" value="${value}" placeholder="${esc(f.hint)}">`
    }</label>`;
  }).join("");

  return page(`<div class="tk-meta">Your profile</div>
    <h1 class="tk-title">So the plans fit you</h1>
    <p style="margin:14px 0 0">Read before anything is suggested, in every group chat you're in. Fill in what you like and skip the rest.</p>
    <hr class="tk-perf">
    <form class="tk-form" method="post" onsubmit="var b=this.querySelector('button');b.disabled=true;b.textContent='Saving';">
      ${inputs}
      <label class="tk-field"><span class="tk-meta">Links, if you want</span><textarea id="links" name="links" placeholder="@you on instagram, Letterboxd, GitHub, a site. One per line.">${esc(profile.links.join("\n"))}</textarea></label>
      <label class="tk-check"><input id="matchOptIn" type="checkbox" name="matchOptIn" ${profile.matchOptIn ? "checked" : ""}>
        <span>Count me in for matching. The planner may introduce me to someone here with similar interests.</span></label>
      <button class="tk-action" type="submit">Save</button>
      <p class="tk-small" style="margin:0">Only you have this link. Text the planner "forget me" and all of it is deleted.</p>
    </form>`);
}
