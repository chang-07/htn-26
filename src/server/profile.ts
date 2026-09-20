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

const FIELDS: { key: keyof Profile & string; label: string; hint: string; long?: boolean; auto?: string }[] = [
  { key: "name", label: "What you go by", hint: "Maya", auto: "nickname" },
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
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${TICKET_FONTS}">
<style>html,body{margin:0;background:${done ? "#1f5f4f" : "#efe7d6"};}${TICKET_CSS}</style></head>
<body><div class="tk-page${done ? " is-done" : ""}"><div class="tk-wrap">${body}</div></div></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

export async function handleProfile(request: Request, url: URL, env: Env): Promise<Response> {
  const [token, rest] = url.pathname.slice("/p/".length).split("/");
  const found = token ? await people(env).byToken(token) : null;
  if (!found) {
    return page(`<div class="tk-meta">Profile</div><h1 class="tk-title">This link isn't valid</h1>
      <hr class="tk-perf"><p class="tk-lede" style="margin:0">Text the planner "profile" and it will send you a fresh one.</p>`);
  }
  const { handle, profile } = found;
  const wantsJson = url.searchParams.get("json") === "1";
  if (rest === "ship") return handleShipTo(request, url, env, handle, profile);

  // Native widget prefill: the same fields the form shows, as JSON.
  if (wantsJson && request.method === "GET") {
    return Response.json({
      name: profile.name ?? "", area: profile.area ?? "", diet: profile.diet ?? "",
      budget: profile.budget ?? "", interests: profile.interests ?? "", about: profile.about ?? "",
      links: profile.links.join("\n"), matchOptIn: profile.matchOptIn ?? false,
    }, { headers: { "cache-control": "no-store" } });
  }

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
    if (wantsJson) return Response.json({ ok: true, name: saved.name ?? "" });
    return page(`<div class="tk-meta">Saved</div><h1 class="tk-title">Got it${saved.name ? `, ${esc(saved.name)}` : ""}</h1>
      <hr class="tk-perf"><p style="margin:0">The planner uses this in every chat you're in. Open this link again to change it, or text "forget me" to delete it.</p>`, true);
  }

  const inputs = FIELDS.map((f) => {
    const value = esc(String(profile[f.key] ?? ""));
    return `<label class="tk-field"><span class="tk-meta">${f.label}</span>${
      f.long
        ? `<textarea id="${f.key}" name="${f.key}" placeholder="${esc(f.hint)}">${value}</textarea>`
        : `<input id="${f.key}" type="text" name="${f.key}" value="${value}" placeholder="${esc(f.hint)}" autocomplete="${f.auto ?? "off"}" enterkeyhint="next">`
    }</label>`;
  }).join("");

  return page(`<div class="tk-meta">Your profile</div>
    <h1 class="tk-title">So the plans fit you</h1>
    <p class="tk-lede">Read before anything is suggested, in every group chat you're in. Fill in what you like and skip the rest.</p>
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

const SHIP_FIELDS = [
  { key: "name", label: "Full name", hint: "As it should appear on the parcel", auto: "name", type: "text" },
  { key: "email", label: "Email", hint: "The store sends the receipt here", auto: "email", type: "email" },
  { key: "line1", label: "Address", hint: "Street and number", auto: "address-line1", type: "text" },
  { key: "line2", label: "Apartment, unit", hint: "Optional", auto: "address-line2", type: "text" },
  { key: "city", label: "City", hint: "", auto: "address-level2", type: "text" },
  { key: "region", label: "State or province", hint: "Two letters: ON, CA, NY", auto: "address-level1", type: "text", caps: true },
  { key: "postal", label: "Postal or ZIP code", hint: "", auto: "postal-code", type: "text", caps: true },
  { key: "country", label: "Country", hint: "Two letters: CA or US", auto: "country", type: "text", caps: true },
] as const;

/**
 * /p/<token>/ship — where this person's orders go. Its own page, not part of
 * the profile: it is asked for only when they first offer to pay for something,
 * and it never reaches the model. Saving it resumes the payment that asked.
 */
async function handleShipTo(request: Request, url: URL, env: Env, handle: string, profile: Profile): Promise<Response> {
  const chat = url.searchParams.get("chat");
  const agent = chat ? await getAgentByName<Env, PlanAgent>(env.PlanAgent, chat) : null;
  // An event's orders share one address, kept by the chat. It arrives filled in
  // for this person to check; "?own=1" is them sending this order home instead.
  const delivery = agent ? await agent.deliveryFor(handle).catch(() => null) : null;
  const own = url.searchParams.get("own") === "1";
  const toEvent = !!delivery && !own;

  let filled: Record<string, string | undefined> = toEvent
    ? { ...delivery.address, name: (profile.shipTo ?? profile.contact)?.name, email: (profile.shipTo ?? profile.contact)?.email }
    : { ...profile.shipTo };
  const wantsJson = url.searchParams.get("json") === "1";
  if (wantsJson && request.method === "GET") {
    return Response.json({ shipTo: toEvent ? filled : (profile.shipTo ?? null) }, { headers: { "cache-control": "no-store" } });
  }
  let problem = "";
  if (request.method === "POST") {
    const form = await request.formData();
    const v = (k: string, max: number) => String(form.get(k) ?? "").trim().slice(0, max);
    const shipTo = { name: v("name", 60), email: v("email", 120), line1: v("line1", 120), line2: v("line2", 60) || undefined, city: v("city", 60), region: v("region", 3).toUpperCase(), postal: v("postal", 12).toUpperCase(), country: v("country", 2).toUpperCase() };
    if (!shipTo.name || !shipTo.line1 || !shipTo.city || !shipTo.postal) problem = "Name, address, city and postal code are all needed.";
    else if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(shipTo.email)) problem = "That email doesn't look right.";
    else if (!/^[A-Z]{2}$/.test(shipTo.country) || !/^[A-Z]{2,3}$/.test(shipTo.region)) problem = "Use two-letter codes for the country and the state or province.";
    else {
      if (toEvent) {
        // The address is the event's, so it is saved to the chat; only who they are stays with them.
        const { name, email, ...address } = shipTo;
        await people(env).save(handle, { contact: { name, email } });
        await agent!.deliverySaved(handle, address);
      } else {
        await people(env).save(handle, { shipTo });
        if (delivery) await agent!.deliveryDeclined(handle);
      }
      log("info", "people", "ship_to.saved", { who: mask(handle), country: shipTo.country, event: toEvent });
      // Only resumes if that chat really is waiting on this person: the agent checks.
      if (agent) await agent.payResume(handle).catch((err) => log("warn", "people", "pay.resume_failed", { error: String(err).slice(0, 200) }));
      if (wantsJson) return Response.json({ ok: true });
      return page(`<div class="tk-meta">Saved</div><h1 class="tk-title">That's where it ships</h1>
        <hr class="tk-perf"><p style="margin:0">${
          toEvent
            ? "Back to the chat: the planner carries on from here. Anyone else who pays for this event gets the same address to check."
            : 'Back to the chat: the planner carries on from here. Open this link again to change the address, or text "forget me" to delete it.'
        }</p>`, true);
    }
    if (wantsJson) return Response.json({ ok: false, problem });
    filled = shipTo;
  }
  const inputs = SHIP_FIELDS.map(
    // The event's address must survive the keyboard's autofill, which would swap in their own.
    (f) => `<label class="tk-field"><span class="tk-meta">${f.label}</span><input id="${f.key}" type="${f.type}" name="${f.key}" autocomplete="${toEvent && f.key !== "name" && f.key !== "email" ? "off" : f.auto}" enterkeyhint="next"${"caps" in f && f.caps ? ' autocapitalize="characters"' : ""}${f.type === "email" ? ' inputmode="email" autocapitalize="off"' : ""} value="${esc(String(filled[f.key] ?? ""))}" placeholder="${esc(f.hint)}"></label>`,
  ).join("");
  const at = delivery?.label ? esc(delivery.label) : "the event";
  const ownUrl = `${url.pathname}?chat=${encodeURIComponent(chat ?? "")}&own=1`;
  return page(`<div class="tk-meta">Delivery</div>
    <h1 class="tk-title">${toEvent ? (delivery.confirmed || delivery.address ? `Ship it to ${at}?` : "Where is the event?") : "Where should it ship?"}</h1>
    <p class="tk-lede">${
      toEvent
        ? delivery.confirmed
          ? "Everything for this event goes to one place. Check it, fix anything that's off, and save."
          : delivery.address
            ? "Filled in from what the venue's own page says, so check every line before you save. Tell the venue to expect a parcel."
            : "Everything for this event goes to one place. Type it once and everyone else who pays gets it filled in."
        : "Asked once. Used only to fill in a store's checkout when you offer to pay for something."
    }</p>
    <hr class="tk-perf">
    <form class="tk-form" method="post" onsubmit="var b=this.querySelector('button');b.disabled=true;b.textContent='Saving';">
      ${inputs}
      ${problem ? `<p class="tk-error" style="margin:0">${esc(problem)}</p>` : ""}
      <button class="tk-action" type="submit">${toEvent ? "Ship here" : "Save"}</button>
      ${toEvent ? `<p class="tk-small" style="margin:0"><a href="${esc(ownUrl)}">Send this order to my own address instead</a></p>` : ""}
      <p class="tk-small" style="margin:0">No card details here, ever: those stay in your wallet. Only you have this link.</p>
    </form>`);
}
