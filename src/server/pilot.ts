import type { Frame, Page } from "@cloudflare/puppeteer";
import { z } from "zod";
import { askJson } from "./llm";
import { errorFields, log } from "./log";

/**
 * A browser pilot: the model drives a real page one action at a time.
 *
 *   observe  list what a person could interact with, across every frame
 *   decide   the model picks ONE action, given the goal and what happened so far
 *   act      click / type / select / scroll, then look again
 *
 * It exists because booking sites cannot be scripted in advance — the group
 * picks the venue, and every venue uses a different widget, usually inside an
 * iframe. What keeps a model-driven browser safe is not the prompt but the
 * rails around it, all enforced in code here:
 *
 *   - payment fields are never typed into; reaching one ends the run with a
 *     hand-off link for a human, exactly like a Shopify checkout
 *   - the final submit is a distinct action, so a dry run can stop one click
 *     short of it, and a read-only run can refuse it outright
 *   - a step cap, so a confused model costs a bounded number of calls
 */

export type PilotMode = "book" | "availability";

export type PilotGoal = {
  mode: PilotMode;
  /** Plain-language task, including party size, date/time and contact details. */
  task: string;
  startUrl: string;
  /** Stop before the final submit instead of clicking it. */
  dryRun: boolean;
  maxSteps?: number;
};

export type PilotStatus =
  | "submitted" // the final submit was clicked and the model read a confirmation
  | "ready" // dry run: everything filled in, stopped before the final submit
  | "needs_payment" // reached a payment form; a human must finish at handoffUrl
  | "found" // availability mode: slots were read
  | "gave_up"
  | "step_limit";

export type PilotResult = {
  status: PilotStatus;
  summary: string;
  confirmation?: string;
  slots?: string[];
  /** Where a human can pick up from: the page the pilot ended on. */
  handoffUrl: string;
  steps: string[];
  tokens: number;
};

type Observed = {
  url: string;
  title: string;
  text: string;
  elements: string[];
  hasPayment: boolean;
};

const Action = z.object({
  thought: z.string().describe("One sentence: what you see and why this action"),
  action: z.enum(["click", "type", "select", "scroll", "wait", "submit", "done", "give_up"]),
  id: z.string().optional().describe("Element id exactly as listed, e.g. '0.14'"),
  text: z.string().optional().describe("Text to type, or the visible option text to select"),
  confirmation: z.string().optional().describe("done: the confirmation number or wording shown"),
  slots: z.array(z.string()).optional().describe("done (availability): available times as shown, e.g. '7:30 PM'"),
  summary: z.string().optional().describe("done / give_up: one line for the group"),
});
type Action = z.infer<typeof Action>;

const SYSTEM = `You operate a web browser to complete a task on a booking website, one action at a time.

Each turn you see the page's interactive elements, each with an id. Reply with ONE action:
- click   {id}           press a button, link, tab, date cell or time slot
- type    {id, text}     replace the contents of an input
- select  {id, text}     choose the option with that visible text in a <select>
- scroll                 reveal more of the page
- wait                   the page is still loading
- submit  {id}           the FINAL button that commits the booking (Confirm / Complete reservation / Book now on the last step). Use "click" for every earlier Next/Continue button.
- done    {summary, confirmation?, slots?}   the task is complete
- give_up {summary}      the task cannot be completed here; say why

Rules:
- Use only ids from the current list. They change after every action.
- Never enter payment card details. If the site demands payment to continue, use give_up and say so.
- Never invent personal details. Type only the name, email and phone given in the task. If a required field needs something you were not given (a phone number, a postal code, a date of birth), use give_up and name the missing field so a person can supply it.
- Do not create accounts or log in. If that is required, give_up.
- Decline optional extras, newsletters and upsells. Accept cookie banners only to clear them.
- If the requested time is unavailable, pick the closest available time and say so in your summary.
- Be decisive: do not repeat an action that already failed; try something else or give_up.`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs inside the page. Tags each usable element so it can be addressed afterwards. */
function collectInFrame(frameIndex: number, limit: number) {
  const SELECTOR =
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="option"], [role="tab"], [role="gridcell"], [role="menuitem"], [onclick]';
  const PAYMENT = /card.?number|cardnumber|cc-?num|cvv|cvc|security.?code|expir|card.?holder/i;
  const clean = (s: string | null | undefined, n = 60) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

  document.querySelectorAll("[data-pilot]").forEach((el) => el.removeAttribute("data-pilot"));
  const lines: string[] = [];
  let hasPayment = false;
  let n = 0;

  for (const original of Array.from(document.querySelectorAll<HTMLElement>(SELECTOR))) {
    let el = original;
    let rect = el.getBoundingClientRect();
    let style = getComputedStyle(el);
    let boxState = "";
    const invisible = () => rect.width < 4 || rect.height < 4 || style.visibility === "hidden" || style.display === "none" || style.opacity === "0";

    // Styled checkboxes hide the real <input> and draw their own box. The thing
    // a person clicks is the label, so that is what gets offered instead.
    const box = original as HTMLInputElement;
    if (original.tagName === "INPUT" && (box.type === "checkbox" || box.type === "radio") && invisible()) {
      const label = (box.id && document.querySelector<HTMLElement>(`label[for="${CSS.escape(box.id)}"]`)) || box.closest<HTMLElement>("label") || box.parentElement;
      if (!label || label.hasAttribute("data-pilot")) continue;
      el = label;
      rect = el.getBoundingClientRect();
      style = getComputedStyle(el);
      boxState = box.checked ? "checked" : "unchecked";
    }
    if (invisible()) continue;
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") continue;

    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    const hint = [input.name, el.id, input.placeholder, el.getAttribute("autocomplete"), el.getAttribute("aria-label")].join(" ");
    if ((tag === "input" || tag === "select") && (PAYMENT.test(hint) || (el.getAttribute("autocomplete") ?? "").startsWith("cc-"))) {
      hasPayment = true;
      continue; // never offered to the model
    }
    if (tag === "input" && ["hidden", "password", "file"].includes(input.type)) continue;

    const id = `${frameIndex}.${++n}`;
    el.setAttribute("data-pilot", id);

    let line: string;
    if (boxState) {
      line = `[${id}] ${box.type} "${clean(el.innerText, 90)}" = ${boxState} (click to toggle)`;
    } else if (tag === "select") {
      const select = el as unknown as HTMLSelectElement;
      const options = Array.from(select.options).slice(0, 14).map((o) => clean(o.text, 24));
      line = `[${id}] select "${clean(el.getAttribute("aria-label") || input.name || el.id, 40)}" = "${clean(select.selectedOptions[0]?.text, 24)}" options: ${options.join(" | ")}`;
    } else if (tag === "input" || tag === "textarea") {
      const kind = tag === "textarea" ? "textarea" : `input:${input.type || "text"}`;
      const label = clean(el.getAttribute("aria-label") || input.placeholder || input.name || el.id, 40);
      const state = input.type === "checkbox" || input.type === "radio" ? (input.checked ? "checked" : "unchecked") : `"${clean(input.value, 30)}"`;
      line = `[${id}] ${kind} "${label}" = ${state}`;
    } else {
      let label = clean(el.innerText || el.getAttribute("aria-label") || el.getAttribute("title"), 70);
      if (!label) {
        // Icon-only controls: a quantity stepper's + and − have no text at all.
        // Name them by their icon class and say what they sit next to.
        const icon = clean(`${el.className} ${(el.firstElementChild as HTMLElement | null)?.className ?? ""}`.replace(/\b(btn|button|icon|fa|fas|far|glyphicon|material-icons)\b/g, ""), 40);
        const near = clean(el.parentElement?.innerText || el.parentElement?.parentElement?.innerText, 40);
        label = icon || near ? `icon:${icon || "?"}${near ? ` (next to "${near}")` : ""}` : clean((el as HTMLAnchorElement).href, 70);
      }
      if (!label) {
        el.removeAttribute("data-pilot");
        n--;
        continue;
      }
      const selected = el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-pressed") === "true" ? " (selected)" : "";
      line = `[${id}] ${tag === "a" ? "link" : "button"} "${label}"${selected}`;
    }
    lines.push(line);
    if (n >= limit) break;
  }

  // Calendars and slot pickers are often plain <td>/<div> cells with a JS click
  // handler: no role, no onclick attribute, nothing a selector can find. What
  // they do have is a pointer cursor. Take the innermost such element with a
  // short label, so a date grid becomes "12", "13", … rather than one big blob.
  if (n < limit) {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("a, td, li, div, span, label, p"))) {
      if (n >= limit) break;
      if (el.closest("[data-pilot]") || el.querySelector("[data-pilot]")) continue;
      if (getComputedStyle(el).cursor !== "pointer") continue;
      if ((el.innerText ?? "").trim().length > 40) continue;
      let label = clean(el.innerText, 40);
      if (!label) {
        // A stepper's − and + are often <a> tags with no href, holding only an <i class="icon-plus">.
        const icon = clean(`${(el.firstElementChild as HTMLElement | null)?.className ?? ""} ${el.className}`, 40);
        if (!/plus|minus|add|remove|increment|decrement|next|prev|close|arrow|chevron/i.test(icon)) continue;
        label = `icon:${icon} (next to "${clean(el.parentElement?.parentElement?.innerText, 30)}")`;
      }
      if (Array.from(el.children).some((c) => getComputedStyle(c).cursor === "pointer" && clean((c as HTMLElement).innerText, 40) === label)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;

      const id = `${frameIndex}.${++n}`;
      el.setAttribute("data-pilot", id);
      const off = /disabled|unavailable|sold.?out|past|inactive|blocked/i.test(el.className) ? " (looks unavailable)" : "";
      const on = /selected|active|current|chosen/i.test(el.className) ? " (selected)" : "";
      lines.push(`[${id}] clickable "${label}"${on}${off}`);
    }
  }

  // Hosted payment forms live in third-party iframes the pilot cannot (and must not) reach.
  if (document.querySelector('iframe[src*="stripe"], iframe[src*="squareup"], iframe[src*="braintree"], iframe[src*="adyen"], iframe[name*="card"]')) {
    hasPayment = true;
  }
  return { lines, hasPayment, text: clean(document.body?.innerText, 1600) };
}

/** Frames that never hold a booking form; skipping them leaves room for the ones that do. */
const JUNK_FRAME = /doubleclick|googletagmanager|google\.com\/recaptcha|googlesyndication|facebook\.|hotjar|intercom|hubspot|analytics|about:blank|^$/i;

/** Frame handles from the latest observation, addressed by the id prefix shown to the model. */
let lastFrames = new Map<string, Frame>();

export async function observe(page: Page): Promise<Observed> {
  const elements: string[] = [];
  let hasPayment = false;
  let text = "";

  // Booking widgets are usually iframes, often a modal appended long after
  // load — so junk frames are dropped and the newest kept, rather than taking
  // the first few in document order.
  const all = page.frames();
  const chosen = [all[0], ...all.slice(1).filter((f) => !JUNK_FRAME.test(f.url())).slice(-7)];
  lastFrames = new Map();

  for (let i = 0; i < chosen.length; i++) {
    lastFrames.set(String(i), chosen[i]);
    try {
      const found = await chosen[i].evaluate(collectInFrame, i, i === 0 ? 120 : 70);
      elements.push(...found.lines);
      hasPayment ||= found.hasPayment;
      if (i === 0) text = found.text;
      else if (found.lines.length) text = `${text}\n[frame ${i}] ${found.text}`.slice(0, 2800);
    } catch {
      // Cross-origin frames mid-navigation throw; they are simply skipped this turn.
    }
  }
  return { url: page.url(), title: await page.title().catch(() => ""), text, elements: elements.slice(0, 160), hasPayment };
}

function frameFor(_page: Page, id: string): { frame: Frame; selector: string } {
  const frame = lastFrames.get(id.split(".")[0]);
  if (!frame) throw new Error(`no frame for element ${id}`);
  return { frame, selector: `[data-pilot="${id}"]` };
}

/**
 * Fingerprint of "did anything happen?", compared before and after a click.
 * It hashes the visible text and every field's value: comparing lengths is not
 * enough, because a stepper going from "$82" to "$123" keeps the page the same
 * size — and a change that goes unnoticed gets clicked a second time.
 */
const signature = (page: Page) =>
  page
    .evaluate(() => {
      const fields = Array.from(document.querySelectorAll<HTMLInputElement>("input, select, textarea"))
        .map((f) => `${f.value}${f.checked ? "✓" : ""}`)
        .join("|");
      const text = `${location.href}|${document.body?.innerText ?? ""}|${fields}|${document.querySelectorAll("iframe").length}`;
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
      return String(h);
    })
    .catch(() => "?");

async function settle(page: Page) {
  // A click may navigate, open a modal, or re-render a widget. Wait for whichever.
  await Promise.race([page.waitForNavigation({ timeout: 3500 }).catch(() => {}), sleep(1400)]);
  await sleep(500);
}

async function perform(page: Page, a: Action): Promise<string> {
  switch (a.action) {
    case "click":
    case "submit": {
      if (!a.id) throw new Error("click needs an id");
      const { frame, selector } = frameFor(page, a.id);
      const handle = await frame.$(selector);
      if (!handle) throw new Error(`element ${a.id} is no longer on the page`);

      // Same tab always: the pilot watches one page, so a target=_blank link
      // would otherwise carry the booking flow somewhere it cannot see.
      const href = await handle.evaluate((el) => {
        el.removeAttribute("target");
        (el as HTMLElement).scrollIntoView({ block: "center" });
        return el instanceof HTMLAnchorElement && /^https?:/.test(el.href) ? el.href : null;
      });

      const before = await signature(page);
      await handle.click({ delay: 30 }).catch(() => {});
      await settle(page);

      // A pointer click lands on whatever is on top — a sticky header, a chat
      // bubble, a cookie bar — and reports success either way. If nothing
      // changed, click the element itself, and for a plain link just go there.
      let how = "";
      if ((await signature(page)) === before) {
        await handle.evaluate((el) => (el as HTMLElement).click()).catch(() => {});
        await settle(page);
        how = " (dom click)";
        if ((await signature(page)) === before && href && a.action === "click") {
          await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30_000 });
          await sleep(1500);
          how = " (followed link)";
        }
      }
      const changed = (await signature(page)) !== before;
      return `${a.action} ${a.id}${how} → ${changed ? `now at ${page.url().slice(0, 90)}` : "NOTHING CHANGED"}`;
    }
    case "type": {
      if (!a.id || a.text === undefined) throw new Error("type needs an id and text");
      const { frame, selector } = frameFor(page, a.id);
      const handle = await frame.$(selector);
      if (!handle) throw new Error(`element ${a.id} is no longer on the page`);

      // Clear by selecting all, not by triple-click: number inputs ignore a
      // triple-click, so the old value stayed and "4" became "24" or stayed "2".
      await handle.evaluate((el) => {
        (el as HTMLInputElement).focus();
        (el as HTMLInputElement).select?.();
      });
      await page.keyboard.press("Backspace");
      await handle.type(a.text, { delay: 15 });

      // Frameworks that own the value can still snap it back. Set it the way
      // React and friends listen for, then report what the field really holds.
      const value = await handle.evaluate((el, wanted) => {
        const input = el as HTMLInputElement;
        if (input.value !== wanted) {
          const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, wanted);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
        return input.value;
      }, a.text);
      await sleep(400);
      const shown = (v: string) => v.replace(/@.*/, "@…");
      return `type ${a.id} "${shown(a.text)}" → field now holds "${shown(value)}"`;
    }
    case "select": {
      if (!a.id || a.text === undefined) throw new Error("select needs an id and text");
      const { frame, selector } = frameFor(page, a.id);
      const value = await frame.$eval(
        selector,
        (el, wanted) => {
          const options = Array.from((el as unknown as HTMLSelectElement).options);
          const want = String(wanted).toLowerCase();
          return (options.find((o) => o.text.trim().toLowerCase() === want) ?? options.find((o) => o.text.toLowerCase().includes(want)))?.value;
        },
        a.text,
      );
      if (value === undefined) throw new Error(`no option "${a.text}" in ${a.id}`);
      await frame.select(selector, value);
      await settle(page);
      return `select ${a.id} "${a.text}"`;
    }
    case "scroll":
      await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.8)));
      await sleep(600);
      return "scroll";
    case "wait":
      await sleep(2500);
      return "wait";
    default:
      return a.action;
  }
}

/**
 * One line saying what is in the basket, read from the page the pilot stopped
 * on. A hand-off is only useful if it says exactly what was set up — "Wed Oct
 * 14, 6:40 PM, 4 players, $167.24" — so the person finishing it can check it.
 */
async function basketLine(env: Env, seen: Observed, addTokens: (n: number) => void): Promise<string> {
  try {
    const res = await askJson(
      env,
      z.object({ line: z.string().describe("e.g. 'Wed Oct 14 at 6:40 PM, 4 players, $167.24 total.'") }),
      "You read a booking checkout page and state what is being booked in one short line: date, time, party size and total price, exactly as the page shows them. If a detail is not on the page, leave it out. No other words.",
      seen.text,
    );
    addTokens(res.tokens);
    return res.value.line.trim().replace(/\.?$/, ".");
  } catch {
    return "The booking is set up.";
  }
}

export async function runPilot(
  env: Env,
  page: Page,
  goal: PilotGoal,
  onStep?: (n: number, line: string) => Promise<void> | void,
): Promise<PilotResult> {
  const maxSteps = goal.maxSteps ?? 16;
  const steps: string[] = [];
  let tokens = 0;
  const finish = (status: PilotStatus, summary: string, extra: Partial<PilotResult> = {}): PilotResult => ({
    status,
    summary,
    handoffUrl: page.url(),
    steps,
    tokens,
    ...extra,
  });

  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(goal.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(2500); // booking widgets render after load

  let submitted = false;
  let lastFingerprint = "";
  let repeats = 0;
  const visits = new Map<string, number>();
  let lastUrl = "";
  for (let n = 1; n <= maxSteps; n++) {
    const seen = await observe(page);

    // Enforced here, not requested in the prompt: the pilot never pays.
    if (seen.hasPayment && goal.mode === "book") {
      return finish("needs_payment", `${await basketLine(env, seen, (t) => (tokens += t))} All that's left is payment, which a person has to do.`);
    }

    const user = `TASK: ${goal.task}
${goal.mode === "availability" ? "This is a READ-ONLY check: never use submit, never enter personal details. Navigate to the date, read the available times, then use done with slots." : ""}
${submitted ? "You already pressed the final submit. If a confirmation is showing, use done and quote it; if an error is showing, fix it or give_up." : ""}

PAGE: ${seen.title} — ${seen.url}
${seen.text}

ELEMENTS:
${seen.elements.join("\n") || "(none found — try wait or scroll)"}

ACTIONS SO FAR:
${steps.join("\n") || "(none)"}`;

    let action: Action;
    try {
      const res = await askJson(env, Action, SYSTEM, user);
      action = res.value;
      tokens += res.tokens;
    } catch (err) {
      log("warn", "pilot", "decide.failed", errorFields(err));
      return finish("gave_up", "The browsing model stopped responding mid-booking.");
    }

    if (action.action === "done") {
      if (goal.mode === "availability") return finish("found", action.summary ?? "", { slots: action.slots ?? [] });
      // "done" without ever submitting means the model thinks there is nothing to submit.
      return finish(submitted ? "submitted" : "gave_up", action.summary ?? "", { confirmation: action.confirmation });
    }
    if (action.action === "give_up") return finish("gave_up", action.summary ?? action.thought);

    // A model that is stuck repeats itself, and every repeat is a paid call.
    // The same action three times running ends the run with what is known.
    const fingerprint = `${action.action}|${action.id ?? ""}|${action.text ?? ""}|${seen.url}`;
    repeats = fingerprint === lastFingerprint ? repeats + 1 : 0;
    lastFingerprint = fingerprint;
    if (repeats >= 2) return finish("gave_up", `Got stuck repeating "${action.action}" on ${new URL(seen.url).host} without progress.`);
    // Cycling between pages is the slower version of the same thing. Counted
    // per ARRIVAL, not per step: a single-page booking flow legitimately spends
    // many steps on one URL.
    if (seen.url !== lastUrl) {
      visits.set(seen.url, (visits.get(seen.url) ?? 0) + 1);
      lastUrl = seen.url;
      if ((visits.get(seen.url) ?? 0) > 3) return finish("gave_up", `Kept returning to the same page on ${new URL(seen.url).host} without progress.`);
    }

    if (action.action === "submit") {
      if (goal.mode === "availability") {
        steps.push(`${n}. refused submit (read-only check)`);
        continue;
      }
      if (goal.dryRun) {
        return finish("ready", `${await basketLine(env, seen, (t) => (tokens += t))} Filled in and ready to confirm; stopped one click short.`);
      }
      submitted = true;
    }

    let line: string;
    try {
      line = `${n}. ${await perform(page, action)} — ${action.thought.slice(0, 110)}`;
    } catch (err) {
      line = `${n}. ${action.action} ${action.id ?? ""} FAILED: ${err instanceof Error ? err.message : String(err)}`;
    }
    steps.push(line);
    await onStep?.(n, line);
  }
  return finish("step_limit", `Ran out of steps (${maxSteps}) before finishing.`);
}
