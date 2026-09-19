#!/usr/bin/env node
/**
 * Smoke test against the local dev server. Run it after every pull and before
 * every deploy — several sessions edit this repo at once, and these are the
 * behaviours that have already broken at least once.
 *
 *   npm run smoke            deterministic checks: no LLM calls, no network beyond localhost
 *   npm run smoke -- --net   + real Shopify stores (needs PUBLIC_BASE_URL reachable: tunnel up)
 *   npm run smoke -- --llm   + model-driven turns (spends dev-LLM usage; needs `npm run llm`)
 *
 * Everything runs in simulator chats (non-UUID ids), which always use the dry
 * Linq transport, so nothing here can text a real person.
 */
import fs from "node:fs";
import http from "node:http";

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:5173";
const flags = new Set(process.argv.slice(2));
const env = Object.fromEntries(
  (fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

let failed = 0;
const stamp = Date.now();
const chat = (name) => `smoke-${name}-${stamp}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(name, fn) {
  try {
    const note = await fn();
    console.log(`  PASS  ${name}${note ? `  (${note})` : ""}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${String(err.message ?? err).slice(0, 300)}`);
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const get = (path) => fetch(BASE + path);
const post = (path, body) =>
  fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const tool = async (c, name, args) => (await (await post("/api/dev/tool", { chat: c, tool: name, args })).json()).result;
const dump = async (c) => (await get(`/api/dev/dump?chat=${c}`)).json();
const logs = async (c) => (await get(`/api/dev/logs?chat=${c}&limit=200`)).text();
const count = (text, needle) => text.split(needle).length - 1;
async function waitFor(c, needle, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    if ((await logs(c)).includes(needle)) return true;
    await sleep(500);
  }
  return false;
}

const PLAN = { title: "Friday dinner", options: [{ title: "Kinton Ramen" }, { title: "Crafty Ramen" }, { title: "Ken Sushi" }] };

console.log(`smoke test → ${BASE}`);

console.log("\nserver");
await check("dev server is up", async () => expect((await get("/.well-known/ucp-agent.json")).status === 200, "not reachable — is `npm run dev` running?"));
await check("vote page is served", async () => expect((await get("/w/x")).headers.get("content-type")?.includes("text/html"), "SPA not served"));

console.log("\nplan, votes, cards");
const a = chat("plan");
await check("propose_plan opens a ballot with 3 options", async () => {
  await tool(a, "propose_plan", PLAN);
  const { state } = await dump(a);
  expect(state.status === "voting" && state.options.length === 3, `status=${state.status} options=${state.options.length}`);
});
await check("one ticket photo per ballot, none per vote", async () => {
  for (const r of ["love", "like", "love"]) await post("/api/dev/react", { chat: a, from: "+15550001111", reaction: r });
  await sleep(1500);
  const text = await logs(a);
  expect(count(text, "ticket.out") === 1, `ticket.out fired ${count(text, "ticket.out")} times`);
  expect(count(text, "vote.cast") === 3, `vote.cast fired ${count(text, "vote.cast")} times`);
});
await check("a voter's latest tapback replaces their earlier one", async () => {
  const { state, votes } = await dump(a);
  expect(votes.length === 1, `${votes.length} votes stored for one voter`);
  expect(Object.values(state.counts).reduce((x, y) => x + y, 0) === 1, "counts do not sum to 1");
});
await check("plan card renders as a PNG", async () => expect((await get(`/card/${a}?v=1`)).headers.get("content-type") === "image/png", "not a PNG"));
await check("every ticket design renders", async () => {
  for (const kind of ["plan", "cart", "list", "venue", "rsvp", "match", "invoice"]) {
    const res = await get(`/api/dev/card?kind=${kind}`);
    expect(res.headers.get("content-type") === "image/png", `${kind}: ${res.status}`);
  }
});

console.log("\nwake gate (no model calls expected)");
const g = chat("gate");
await check("un-addressed group chatter is stored, not answered", async () => {
  for (const text of ["dinner friday?", "im down, ramen", "lol did you see the game"]) {
    await post("/api/dev/message", { chat: g, group: true, from: "+15550001111", text });
  }
  await sleep(4500);
  const text = await logs(g);
  expect(count(text, "message.stored") === 3, `message.stored ×${count(text, "message.stored")}`);
  expect(!text.includes("turn.start"), "a turn started with nobody addressing the agent");
});

console.log("\nnudges");
await check("no nudge in a one-to-one chat", async () => {
  const c = chat("nudge");
  await tool(c, "propose_plan", PLAN);
  await post("/api/dev/fire", { chat: c, callback: "nudge" });
  expect(!(await logs(c)).includes(" nudge "), "nudged someone in a direct chat");
});

console.log("\nbooking guards (no browser is opened)");
const b = chat("book");
await check("an invented email is refused and the plan is left untouched", async () => {
  await tool(b, "propose_plan", { title: "Escape room", options: [{ title: "Room A", bookingUrl: "https://example.com/book" }, { title: "Room B" }] });
  const { state } = await dump(b);
  const out = await tool(b, "book_option", { optionId: state.options[0].id, partySize: 4, isoTime: "2026-10-14T19:00:00", contactName: "Alex Rivera", contactEmail: "alex@example.com" });
  expect(/not a real email/i.test(out), `unexpected reply: ${out}`);
  expect((await dump(b)).state.status === "voting", "plan left in a booking state by a refused call");
});
await check("an option with no booking link is refused", async () => {
  const { state } = await dump(b);
  const out = await tool(b, "book_option", { optionId: state.options[1].id, partySize: 4, isoTime: "2026-10-14T19:00:00", contactName: "Alex Rivera", contactEmail: "alex@plan-agent.test" });
  expect(/no online booking link/i.test(out), `unexpected reply: ${out}`);
});
await check("availability check refuses options with no link", async () => {
  const { state } = await dump(b);
  const out = await tool(b, "check_availability", { optionIds: [state.options[1].id], partySize: 4, isoTime: "2026-10-14T19:00:00" });
  expect(/nothing to check/i.test(out), `unexpected reply: ${out}`);
});

console.log("\npayment setup (stubbed for simulator chats; no model involved)");
await check("wrong code is refused, right code connects, the code never reaches the transcript", async () => {
  const c = chat("pay");
  const from = "+15550004242";
  const say = (text) => post("/api/dev/message", { chat: c, from, text });
  await say("set up payments");
  await say("123456");
  await say("set up payments");
  await say("000000");
  await sleep(1200);
  const text = await logs(c);
  expect(text.includes("payments.verify_failed") && text.includes("payments.connected"), "setup did not run as expected");
  expect(!text.includes("turn.start"), "the model was woken during payment setup");
  const bodies = (await dump(c)).transcript.map((t) => t.body).join(" ");
  expect(!/\b(123456|000000)\b/.test(bodies), "a verification code was left in the transcript");
});

await check("a misspelt \"remove my paymente\" is still handled in code, never by the model", async () => {
  const c = chat("payremove");
  await post("/api/dev/message", { chat: c, from: "+15550004243", text: "remove my paymente" });
  await sleep(800);
  const text = await logs(c);
  expect(text.includes("payments.revoked"), "the removal did not run");
  expect(!text.includes("turn.start"), "the model was left to answer a payment removal");
});

console.log("\npaying (guards only: no browser, no wallet, no store)");
await check("a thumbs up on a cart from someone with no wallet starts nothing", async () => {
  const c = chat("payguard");
  await post("/api/dev/seedcart", { chat: c, shop: "example-store.com", total: "$12.00" });
  await post("/api/dev/react", { chat: c, on: "cart", shop: "example-store.com", from: "+15550007777", reaction: "like" });
  await post("/api/dev/react", { chat: c, on: "cart", shop: "example-store.com", from: "+15550007777", reaction: "laugh" });
  const text = await logs(c);
  expect(text.includes("pay.needs_wallet"), "no wallet check happened");
  expect(!text.includes("pay.started"), "a payment started for someone with no wallet");
  expect(count(text, "pay.asked") === 1, "a non-pay tapback was treated as an offer to pay");
});
await check("\"i'll pay\" with no cart in the chat is ordinary conversation", async () => {
  const c = chat("paytext");
  await post("/api/dev/message", { chat: c, group: true, from: "+15550007777", text: "i'll pay" });
  await sleep(500);
  expect(!(await logs(c)).includes("pay.asked"), "treated as a payment with nothing to pay for");
});

console.log("\ninvoice (who owes whom; no model involved)");
const inv = chat("invoice");
await check("the invoice ticket renders in both states", async () => {
  for (const state of ["open", "done"]) {
    const res = await get(`/api/dev/card?kind=invoice&state=${state}`);
    expect(res.headers.get("content-type") === "image/png", `${state}: ${res.status}`);
  }
});
await check("paying the last cart posts the invoice ticket once, not before", async () => {
  // Three in the chat; two have names. Carts are seeded, not shopped, so nothing leaves the laptop.
  for (const from of ["+15550000001", "+15550000002", "+15550000003"]) await post("/api/dev/message", { chat: inv, group: true, from, text: "in" });
  await tool(inv, "remember_name", { who: "…0001", name: "Maya" });
  await tool(inv, "remember_name", { who: "…0002", name: "Sam" });
  await post("/api/dev/seedcart", { chat: inv, shop: "levainbakery.com", total: "$128.00" });
  await post("/api/dev/seedcart", { chat: inv, shop: "partycity.com", total: "$41.50" });
  await tool(inv, "mark_paid", { who: "Maya", shop: "levainbakery.com" });
  expect(!(await logs(inv)).includes('"kind":"invoice"'), "invoice posted while a cart was still unpaid");
  await tool(inv, "mark_paid", { who: "Sam", shop: "partycity.com" });
  const text = await logs(inv);
  expect(count(text, '"kind":"invoice"') === 1, `invoice ticket posted ${count(text, '"kind":"invoice"')} times`);
  expect(text.indexOf('"kind":"cart","tone":"done"') < text.indexOf('"kind":"invoice"'), "the invoice came before the PAID ticket");
});
await check("the invoice splits every cart across the chat and nets the two payers", async () => {
  const { invoice, state } = await dump(inv);
  expect(invoice?.ok && invoice.settled, `invoice: ${JSON.stringify(invoice).slice(0, 120)}`);
  const line = (n) => invoice.lines.find((l) => l.name === n);
  // 128.00/3 and 41.50/3, odd cents to the first names, in cents.
  expect(line("Maya")?.net === 7149, `Maya net ${line("Maya")?.net}`);
  expect(line("Sam")?.net === -1500, `Sam net ${line("Sam")?.net}`);
  expect(line("…0003")?.net === -5649, `…0003 net ${line("…0003")?.net}`);
  expect(invoice.transfers.length === 2 && invoice.transfers.every((t) => t.to === "Maya"), JSON.stringify(invoice.transfers));
  expect(state.going.includes("Maya") && state.going.length === 3, `state.going = ${JSON.stringify(state.going)}`);
});
await check("add_expense for one person is a transfer, and it settles that debt", async () => {
  await tool(inv, "add_expense", { who: "Sam", amount: "$15", what: "paid Maya back", for: ["Maya"] });
  const { invoice, state } = await dump(inv);
  expect(state.expenses?.length === 1, `${state.expenses?.length} expenses in state`);
  expect(invoice.lines.find((l) => l.name === "Sam").net === 0, "Sam still owes after paying Maya back");
  expect(invoice.transfers.length === 1, `${invoice.transfers.length} transfers left`);
});
await check("show_invoice posts the ticket; drop_expense takes the entry back out", async () => {
  await tool(inv, "show_invoice", {});
  expect(count(await logs(inv), '"kind":"invoice"') === 2, "show_invoice did not post a ticket");
  const id = (await dump(inv)).state.expenses[0].id;
  await tool(inv, "drop_expense", { id });
  const { invoice, state } = await dump(inv);
  expect(state.expenses.length === 0, "expense still in state");
  expect(invoice.transfers.length === 2, "the debt did not come back");
});
await check("nothing to split: no invoice for a chat of one", async () => {
  const c = chat("invoice1");
  await post("/api/dev/message", { chat: c, from: "+15550000009", text: "hi" });
  await post("/api/dev/seedcart", { chat: c, shop: "example-store.com", total: "$12.00" });
  await tool(c, "mark_paid", { who: "…0009", shop: "example-store.com" });
  expect(!(await logs(c)).includes('"kind":"invoice"'), "an invoice was posted with nobody to split with");
});

console.log("\nrun history");
await check("run history is locked for anyone arriving by a public hostname", async () => {
  if (!env.RUNS_TOKEN) return "skipped: no RUNS_TOKEN in .env";
  // Localhost is deliberately open (the dev routes are too). What must hold is
  // that the SAME server, reached through the tunnel or in production, asks for
  // the token — so the request is made under a public Host header.
  const asPublic = (path) =>
    new Promise((resolve, reject) => {
      const u = new URL(BASE + path);
      http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { host: "smoke.trycloudflare.com" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on("error", reject);
    });
  expect((await asPublic("/api/runs")) === 401, "readable without a token from a public hostname");
  expect((await asPublic(`/api/runs?token=${env.RUNS_TOKEN}`)) === 200, "rejected the right token");
});
await check("out-of-turn events become a run of their own", async () => {
  if (!env.RUNS_TOKEN) return "skipped: no RUNS_TOKEN in .env";
  await sleep(7000); // the recorder flushes unclaimed events after ~6s
  const { runs } = await (await get(`/api/runs?token=${env.RUNS_TOKEN}&chat=${g}`)).json();
  expect(runs.some((r) => r.outcome === "background"), `no background run for the sleeping group (got ${runs.length} runs)`);
});

if (flags.has("--net")) {
  console.log("\nshopify (real stores)");
  const s = chat("shop");
  await check("two stores, two carts, neither disturbs the other", async () => {
    const variant = async (shop, query) => (await tool(s, "shop_search", { shop, query })).match(/gid:[^"\\]*ProductVariant[^"\\]*/)?.[0];
    const [v1, v2] = [await variant("explodingkittens.com", "party game"), await variant("drinkolipop.com", "soda")];
    expect(v1 && v2, "search returned no variants — is the tunnel up and PUBLIC_BASE_URL current?");
    await tool(s, "shop_build_cart", { shop: "explodingkittens.com", lines: [{ variantId: v1, quantity: 1 }] });
    await tool(s, "shop_build_cart", { shop: "drinkolipop.com", lines: [{ variantId: v2, quantity: 2 }] });
    const carts = (await dump(s)).state.carts ?? [];
    expect(carts.length === 2, `${carts.length} carts in state`);
    expect(!(await logs(s)).includes("tool.failed"), "a shop tool failed");
    return carts.map((c) => `${c.shop} ${c.total}`).join(", ");
  });
}

if (flags.has("--net")) {
  await check("a single-variant product keeps its real name, never \"Default Title\"", async () => {
    // Shopify names the only variant of an option-less product "Default Title",
    // and a cart response carries that instead of the product's name.
    const c = chat("flower");
    const found = await tool(c, "shop_search", { shop: "urbanstems.com", query: "bouquet" });
    expect(!/default title/i.test(found), "the placeholder reached the model in search results");
    const variant = found.match(/gid:[^"\\]*ProductVariant[^"\\]*/)?.[0];
    expect(variant, "no variant found at urbanstems.com");
    await tool(c, "shop_build_cart", { shop: "urbanstems.com", lines: [{ variantId: variant, quantity: 1 }] });
    const title = (await dump(c)).state.carts?.[0]?.lines?.[0]?.title ?? "";
    expect(title && !/default title|^item$/i.test(title), `cart line is titled "${title}"`);
    return title;
  });
}

if (flags.has("--llm")) {
  console.log("\nmodel-driven turns");
  const m = chat("llm");
  await check("an @mention wakes the agent and it sends exactly one message", async () => {
    await post("/api/dev/message", { chat: m, group: true, from: "+15550001111", text: "we should get bubble tea after class" });
    await post("/api/dev/message", { chat: m, group: true, mention: true, from: "+15550001111", text: "@plan whats a good spot" });
    expect(await waitFor(m, "turn.end", 90), "no turn finished within 90s — is `npm run llm` running?");
    const out = (await dump(m)).transcript.filter((t) => t.direction === "out");
    expect(out.length === 1, `${out.length} messages sent in one turn`);
    return JSON.stringify(out[0].body).slice(0, 80);
  });
  await check("the agent asks where the group is instead of guessing a city", async () => {
    expect(!(await logs(m)).includes('"tool":"research"'), "started research without knowing the group's area");
  });
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
