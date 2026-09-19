import type { Frame, Page } from "@cloudflare/puppeteer";

/**
 * Driving a Shopify checkout page, by rote rather than by model.
 *
 * Every Shopify store serves the same checkout, with the same field names, so
 * this is a script and not a job for the browser pilot: it is faster, costs no
 * tokens, and — the reason that matters — a card number typed here never
 * passes through a prompt. The pilot, by design, cannot see payment fields.
 *
 * Two halves, because the amount to charge is only known in the middle:
 *   fillCheckout  contact + shipping → the store prices shipping and tax → total
 *   payCheckout   card into Shopify's card iframes → Pay now → confirmation
 * Between them the caller mints a virtual card for exactly that total.
 */

export type ShipTo = {
  name: string;
  email: string;
  line1: string;
  line2?: string;
  city: string;
  /** State or province, as its two-letter code ("ON", "CA"). */
  region: string;
  postal: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
};

/** Held in memory for the length of one checkout. Never logged, stored or shown to a model. */
export type CardDetails = { number: string; expMonth: string; expYear: string; cvc: string };

export type Priced = { totalCents: number; currency: string; line: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Replaces a field's contents the way a person would, so the page's own handlers run. */
async function typeInto(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const el = await page.$(selector);
    if (!el) continue;
    await el.click({ clickCount: 3 }).catch(() => {});
    await page.keyboard.press("Backspace");
    await el.type(value, { delay: 15 });
    return true;
  }
  return false;
}

async function choose(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    if (!(await page.$(selector))) continue;
    // Stores list regions by code ("ON"); fall back to matching the visible name.
    const picked = await page.evaluate(
      (sel, want) => {
        const select = document.querySelector(sel) as unknown as { value: string; options: ArrayLike<{ value: string; text: string }>; dispatchEvent(e: Event): boolean } | null;
        if (!select) return false;
        const option = Array.from(select.options).find((o) => o.value.toLowerCase() === want.toLowerCase() || o.text.trim().toLowerCase() === want.toLowerCase());
        if (!option) return false;
        if (select.value === option.value) return true;
        select.value = option.value;
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
      selector,
      value,
    );
    if (picked) return true;
  }
  return false;
}

/** The order total as the page states it, once shipping has been priced. */
async function readTotal(page: Page): Promise<Priced | { pending: string }> {
  const text = await page.evaluate(() => document.body?.innerText ?? "");
  if (/enter (your )?shipping address|calculating/i.test(text.split(/\bTotal\b/).slice(-2, -1)[0]?.slice(-160) ?? "")) return { pending: "shipping not priced yet" };
  // "Total\nUSD\n$41.57" — take the last "Total", which is the grand total.
  const matches = [...text.matchAll(/\bTotal\b[^\d$€£]{0,40}?(?:([A-Z]{3})\s*)?([$€£])\s?([\d,]+\.\d{2})/g)];
  const m = matches[matches.length - 1];
  if (!m) return { pending: "no total on the page" };
  const currency = m[1] ?? (m[2] === "€" ? "EUR" : m[2] === "£" ? "GBP" : "USD");
  return { totalCents: Math.round(parseFloat(m[3].replace(/,/g, "")) * 100), currency, line: `${currency} ${m[2]}${m[3]}` };
}

/** What the page is complaining about, if anything — shown to the person, so kept short. */
async function pageErrors(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="alert"], [id^="error-for-"], .field__message--error, [class*="error" i] p'))
      .map((el) => el.innerText.replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 3 && t.length < 160)
      .filter((t, i, all) => all.indexOf(t) === i)
      .slice(0, 3)
      .join(" / "),
  );
}

/**
 * Opens the checkout and fills in who is buying and where it ships. Returns the
 * total the store then asks for. Throws with a plain-words reason otherwise.
 */
export async function fillCheckout(page: Page, checkoutUrl: string, to: ShipTo, onStep: (line: string) => void = () => {}): Promise<Priced> {
  await page.setViewport({ width: 1180, height: 1400 });
  await page.goto(checkoutUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForSelector('input[name="email"], input#email, input[autocomplete~="email"]', { timeout: 30_000 }).catch(() => {
    throw new Error("the store's checkout page did not load");
  });
  await sleep(1500);
  onStep("checkout open");

  const [first, ...rest] = to.name.trim().split(/\s+/);
  const last = rest.join(" ") || first;

  await typeInto(page, ['input[name="email"]', "input#email", 'input[autocomplete~="email"]'], to.email);
  // Country first: it reshapes the rest of the form.
  await choose(page, ['select[name="countryCode"]', 'select[autocomplete~="country"]'], to.country);
  await sleep(1200);
  await typeInto(page, ['input[name="firstName"]', 'input[autocomplete~="given-name"]'], first);
  await typeInto(page, ['input[name="lastName"]', 'input[autocomplete~="family-name"]'], last);
  const gotStreet = await typeInto(page, ['input[name="address1"]', 'input[autocomplete~="address-line1"]'], to.line1);
  if (!gotStreet) throw new Error("the checkout has no address form (the store may not ship this item)");
  await sleep(700);
  await page.keyboard.press("Escape"); // dismiss the address autocomplete, which would overwrite the rest
  if (to.line2) await typeInto(page, ['input[name="address2"]', 'input[autocomplete~="address-line2"]'], to.line2);
  await typeInto(page, ['input[name="city"]', 'input[autocomplete~="address-level2"]'], to.city);
  await choose(page, ['select[name="zone"]', 'select[autocomplete~="address-level1"]'], to.region);
  await typeInto(page, ['input[name="postalCode"]', 'input[autocomplete~="postal-code"]'], to.postal);
  await page.keyboard.press("Tab");
  onStep("address entered");

  // The store now prices shipping and tax; the total settles a few seconds later.
  let last2: Priced | undefined;
  for (let i = 0; i < 14; i++) {
    await sleep(1500);
    const now = await readTotal(page);
    if ("totalCents" in now) {
      if (last2 && last2.totalCents === now.totalCents && i >= 3) return now;
      last2 = now;
    }
  }
  const complaint = await pageErrors(page);
  if (last2 && !complaint) return last2;
  throw new Error(complaint ? `the store says: ${complaint}` : "the store never priced shipping for that address");
}

function cardFrame(page: Page, field: string): Frame | undefined {
  return page.frames().find((f) => f.name().startsWith(`card-fields-${field}`) || f.url().includes(`/${field}?`) || f.url().includes(`card-fields`) && f.url().includes(field));
}

async function typeInFrame(page: Page, field: string, inputSelector: string, value: string) {
  const frame = cardFrame(page, field);
  if (!frame) throw new Error(`the checkout's card form did not load (${field})`);
  const input = await frame.waitForSelector(inputSelector, { timeout: 10_000 });
  if (!input) throw new Error(`the checkout's card form did not load (${field})`);
  await input.click();
  await input.type(value, { delay: 25 });
  // A screenshot cannot show these frames, so ask the field itself. Only a count leaves the frame.
  const kept = await frame.evaluate((sel) => (document.querySelector(sel) as unknown as { value: string } | null)?.value.replace(/[\s/]/g, "").length ?? 0, inputSelector.split(",")[0]);
  if (kept !== value.replace(/[\s/]/g, "").length) throw new Error(`the checkout's card form did not take the ${field}`);
}

/** True when the page offers Shopify's own card form (not only wallets or a redirect). */
export async function hasCardForm(page: Page): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    if (cardFrame(page, "number")) return true;
    await sleep(800);
  }
  return false;
}

/** Fills Shopify's card iframes. Presses nothing. */
export async function typeCard(page: Page, card: CardDetails, holder: string) {
  await typeInFrame(page, "number", 'input[name="number"], input#number', card.number);
  await typeInFrame(page, "expiry", 'input[name="expiry"], input#expiry', `${card.expMonth.padStart(2, "0")}${card.expYear.slice(-2)}`);
  await typeInFrame(page, "verification_value", 'input[name="verification_value"], input#verification_value', card.cvc);
  await typeInFrame(page, "name", 'input[name="name"], input#name', holder).catch(() => {}); // prefilled on some stores
}

/**
 * Types the card in, presses Pay, and waits for the store's confirmation.
 * `expectCents` is re-checked against the page first: if the total moved since
 * the card was minted, nothing is submitted.
 */
export async function payCheckout(page: Page, card: CardDetails, holder: string, expectCents: number, onSubmit: () => void | Promise<void> = () => {}): Promise<{ confirmation: string; url: string }> {
  const before = await readTotal(page);
  if (!("totalCents" in before) || before.totalCents !== expectCents) throw new Error("the total changed while waiting, so nothing was charged");

  await typeCard(page, card, holder);

  const pay = await page.$('button#checkout-pay-button, button[type="submit"][id*="pay" i]');
  if (!pay) throw new Error("the checkout has no pay button");
  await pay.click();
  await Promise.resolve(onSubmit()).catch(() => {});
  return confirmed(page).catch((err: unknown) => {
    // From here on the store may have the order, so the caller must not say "nothing was charged".
    throw Object.assign(new Error(String((err as Error).message ?? err)), { submitted: true });
  });
}

async function confirmed(page: Page): Promise<{ confirmation: string; url: string }> {
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const url = page.url();
    const text = await page.evaluate(() => document.body?.innerText.slice(0, 1500) ?? "").catch(() => "");
    if (/thank[-_ ]?you|\/orders\//i.test(url) || /thank you|order (is )?confirmed|confirmation #/i.test(text)) {
      const confirmation = text.match(/(?:confirmation|order)\s*#?\s*([A-Z0-9-]{5,})/i)?.[1] ?? "";
      return { confirmation, url };
    }
    const complaint = await pageErrors(page).catch(() => "");
    if (complaint && i > 2) throw new Error(`the store says: ${complaint}`);
  }
  throw new Error("the store never confirmed the order. check your email before trying again");
}
