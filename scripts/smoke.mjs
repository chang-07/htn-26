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
// Trace spans repeat the fields of the event they wrap, so they are left out:
// counting a needle would otherwise see every event three times.
const logs = async (c) =>
  (await (await get(`/api/dev/logs?chat=${c}&limit=400`)).text())
    .split("\n")
    .filter((line) => !/^\S+\s+\S+\s+trace\.(start|end)\s/.test(line))
    .join("\n");
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

console.log("\ngame widget HTTP pipeline");
await check("blackjack can create, play, and reveal locally", async () => {
  const c = chat("blackjack");
  const voter = "local-player";
  const made = await (await post("/api/dev/seedgame", {
    chat: c,
    voter,
    name: "Luka",
    spec: { version: 1, kind: "blackjack", title: "Local blackjack", topic: "Smoke table", rounds: 3, startingChips: 500 },
  })).json();
  expect(made.id, "game was not created");

  const action = (sub) => post(`/api/widget/${encodeURIComponent(c)}/game/${made.id}/${sub}`, { voter });
  await action("advance");
  let view = await (await get(`/api/widget/${encodeURIComponent(c)}/game/${made.id}?voter=${encodeURIComponent(voter)}`)).json();
  expect(view.kind === "blackjack" && view.phase === "round", `unexpected round: ${JSON.stringify(view)}`);
  expect(view.bj?.dealer?.[1] === "??", "dealer hole card leaked during the round");

  view = await (await action("stand")).json();
  expect(view.phase === "reveal", `stand did not reveal: ${view.phase}`);
  expect(view.bj?.dealer?.every((card) => card !== "??"), "dealer hole card stayed hidden after reveal");
  expect(Array.isArray(view.bj?.outcomes) && view.bj.outcomes.length === 1, "round outcome missing");
});

console.log("\nplan, votes, cards");
const a = chat("plan");
await check("propose_plan opens a ballot with 3 options", async () => {
  await tool(a, "propose_plan", PLAN);
  const { state } = await dump(a);
  expect(state.status === "voting" && state.options.length === 3, `status=${state.status} options=${state.options.length}`);
});
await check("the plan card is the only ballot: no ticket for it, none per vote", async () => {
  for (const r of ["love", "like", "love"]) await post("/api/dev/react", { chat: a, from: "+15550001111", reaction: r });
  await sleep(1500);
  const text = await logs(a);
  expect(count(text, "ticket.out") === 0, `ticket.out fired ${count(text, "ticket.out")} times`);
  expect(count(text, "vote.cast") === 3, `vote.cast fired ${count(text, "vote.cast")} times`);
});
await check("a voter's latest tapback replaces their earlier one", async () => {
  const { state, votes } = await dump(a);
  expect(votes.length === 1, `${votes.length} votes stored for one voter`);
  expect(Object.values(state.counts).reduce((x, y) => x + y, 0) === 1, "counts do not sum to 1");
});
await check("a tapback on the plan card counts as a vote, in that slot", async () => {
  await post("/api/dev/react", { chat: a, from: "+15550002222", reaction: "like" });
  await post("/api/dev/react", { chat: a, from: "+15550003333", reaction: "laugh" });
  const { state, votes } = await dump(a);
  const v = votes.find((x) => x.voter === "+15550003333");
  expect(v?.option_id === state.options[2].id && v.source === "reaction", `vote on the card: ${JSON.stringify(v ?? "dropped")}`);
});
await check("a tap on the card counts toward everyone having voted", async () => {
  const g = chat("tapvotes");
  for (const from of ["+15550005551", "+15550005552"]) await post("/api/dev/message", { chat: g, from, text: "hey", group: true });
  await tool(g, "propose_plan", PLAN);
  const { state } = await dump(g);
  expect(state.awaiting.length === 2, `awaiting ${state.awaiting.length} of 2 before any vote`);
  await post("/api/dev/react", { chat: g, from: "+15550005551", reaction: "love" });
  const res = await post(`/api/widget/${g}/vote`, { optionId: state.options[1].id, voter: "phone-abc" });
  expect(res.ok, `widget vote answered ${res.status}`);
  const after = (await dump(g)).state;
  expect(after.awaiting.length === 0, `still awaiting ${JSON.stringify(after.awaiting)} after a tapback and a card tap`);
});
await check("a ballot posts no photo; a booking's confirmation photo takes no votes", async () => {
  const b = chat("reballot");
  await tool(b, "propose_plan", PLAN);
  expect((await dump(b)).planPhotos.length === 0, "an open ballot posted a ticket photo beside the plan card");
  await post("/api/dev/booked", { chat: b });
  expect((await dump(b)).planPhotos.length === 0, "the confirmation photo was kept as a vote target");
  const res = await post("/api/dev/react", { chat: b, on: "photo", from: "+15550004444", reaction: "love" });
  expect(res.status === 404, `reacting on a photo that no longer exists answered ${res.status}, not 404`);
});
await check("plan card renders as a PNG", async () => expect((await get(`/card/${a}?v=1`)).headers.get("content-type") === "image/png", "not a PNG"));
await check("every ticket design renders", async () => {
  for (const kind of ["plan", "cart", "list", "venue", "rsvp", "match", "invoice", "itinerary", "icon"]) {
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

console.log("\nthe chat becomes the plan (no browser; Linq calls are dry)");
await check("a confirmed booking in a group renames the chat, sets its icon and background", async () => {
  const d = chat("dress");
  await post("/api/dev/message", { chat: d, group: true, from: "+15550001111", text: "ramen friday?" });
  await tool(d, "propose_plan", { title: "Friday dinner", emoji: "🍜", options: [{ title: "Kinton Ramen" }, { title: "Pai" }] });
  const out = await (await post("/api/dev/booked", { chat: d })).json();
  expect(out.name === "🍜 Friday dinner · Kinton Ramen", `name: ${out.name}`);
  const { state } = await dump(d);
  expect(state.status === "booked", `status=${state.status}`);
  const text = await logs(d);
  expect(/chat\.dressed .*"name":"dry".*"icon":"dry".*"background":"dry"/.test(text), "chat.dressed did not report all three calls");
  const icon = await get(`/card/${d}/icon.png?v=${state.version}`);
  expect(icon.headers.get("content-type") === "image/png", `icon: ${icon.status}`);
});
await check("a direct chat is left alone: no name or icon to set", async () => {
  const d = chat("dress-dm");
  await post("/api/dev/message", { chat: d, group: false, from: "+15550001111", text: "hi" });
  await tool(d, "propose_plan", { title: "Solo ramen", options: [{ title: "Kinton" }, { title: "Pai" }] });
  await post("/api/dev/booked", { chat: d });
  expect(!(await logs(d)).includes("chat.dressed"), "dressed a one-to-one chat");
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

console.log("\nreset");
await check("/reset wipes the plan, carts and transcript but keeps the people and the area", async () => {
  const c = chat("reset");
  await post("/api/dev/message", { chat: c, from: "+15550006661", text: "hey", group: true });
  await post("/api/dev/message", { chat: c, from: "+15550006662", text: "yo", group: true });
  await tool(c, "remember_area", { area: "Waterloo" });
  await tool(c, "propose_plan", PLAN);
  await post("/api/dev/seedcart", { chat: c, shop: "example-store.com", total: "$12.00" });
  await post("/api/dev/react", { chat: c, from: "+15550006661", reaction: "love" });
  await post("/api/dev/message", { chat: c, from: "+15550006661", text: "/reset", group: true });
  await sleep(500);
  const d = await dump(c);
  expect(d.state.status === "idle" && d.state.options.length === 0, `plan survived: ${d.state.status}, ${d.state.options.length} options`);
  expect((d.state.carts ?? []).length === 0, "a cart survived");
  expect(d.votes.length === 0, `${d.votes.length} votes survived`);
  expect(d.transcript.length <= 1, `${d.transcript.length} messages survived`);
  expect(d.participants.length === 2, `${d.participants.length} participants kept, wanted 2`);
  expect(d.area === "Waterloo", `area is ${JSON.stringify(d.area)}`);
  expect(!(await logs(c)).includes("turn.start"), "the model was woken by /reset");
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
await check("a thumbs up on the shopping list offers to pay the one unpaid cart", async () => {
  const c = chat("paylist");
  await post("/api/dev/seedcart", { chat: c, shop: "example-store.com", total: "$12.00" });
  await tool(c, "show_shopping_list", {});
  await post("/api/dev/react", { chat: c, on: "list", from: "+15550007777", reaction: "like" });
  const text = await logs(c);
  expect(count(text, "pay.asked") === 1, `pay.asked fired ${count(text, "pay.asked")} times for a thumbs up on the list`);
  expect(!text.includes("not on the plan card"), "the tapback on the list was dropped");
});
await check("with PAY_MOCK a dry run ends as a purchase: cart paid, marked as a mock in the log", async () => {
  const c = chat("paymock");
  await post("/api/dev/seedcart", { chat: c, shop: "example-store.com", total: "$12.00" });
  await post("/api/dev/payfinished", { chat: c, shop: "example-store.com", from: "+15550007777", status: "dry_run", total: "USD $14.50" });
  const cart = (await dump(c)).state.carts.find((x) => x.shop === "example-store.com");
  const text = await logs(c);
  if (text.includes("pay.mocked")) expect(!!cart?.paidBy && cart.total === "USD $14.50", `mocked but cart is ${JSON.stringify(cart)}`);
  else expect(!cart?.paidBy, "a dry run marked the cart paid with PAY_MOCK off");
});
await check("with PAY_MOCK a checkout that could not start is mocked at the cart's total; an unsure one never is", async () => {
  const c = chat("paymockfail");
  await post("/api/dev/seedcart", { chat: c, shop: "example-store.com", total: "$12.00" });
  await post("/api/dev/payfinished", { chat: c, shop: "example-store.com", from: "+15550007777", status: "failed", unsure: "1" });
  expect(!(await dump(c)).state.carts[0].paidBy, "an unsure payment was mocked as paid");
  await post("/api/dev/payfinished", { chat: c, shop: "example-store.com", from: "+15550007777", status: "failed" });
  const cart = (await dump(c)).state.carts[0];
  if ((await logs(c)).includes("pay.mocked")) expect(!!cart.paidBy && cart.total === "$12.00", `mocked but cart is ${JSON.stringify(cart)}`);
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
await check("the itinerary ticket renders in both states", async () => {
  for (const state of ["open", "done"]) {
    const res = await get(`/api/dev/card?kind=itinerary&state=${state}`);
    expect(res.headers.get("content-type") === "image/png", `itinerary ${state}: ${res.status}`);
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

console.log("\nlocation (simulated share: no phone, no model)");
await check("a location request is refused in a group", async () => {
  const c = chat("locgroup");
  await post("/api/dev/message", { chat: c, group: true, from: "+15550006001", text: "anyone around" });
  await sleep(400);
  const result = await tool(c, "request_location", {});
  expect(/group/i.test(result), `asked for location in a group: ${result}`);
  expect(!(await logs(c)).includes("location.requested"), "the request reached Linq from a group chat");
});
await check("a share they started is kept running; one the agent asked for is ended", async () => {
  const c = chat("locdm");
  const from = "+15550006002";
  // A direct chat, established without waking the model: payment removal is handled in code.
  await post("/api/dev/message", { chat: c, from, text: "remove my payments" });
  await sleep(800);
  const share = async (locality) => (await (await post("/api/dev/location", { chat: c, from, locality, region: "ON, Canada" })).json()).took;

  // Sharing unprompted is consent to be read, but the share is theirs to end.
  expect((await share("Waterloo")) === "Waterloo, ON, Canada", "ignored a share the person started themselves");
  let text = await logs(c);
  expect(text.includes('"shareEnded":false'), "ended a share the agent never asked for");
  await share("Waterloo");
  expect(count(await logs(c), "location.taken") === 1, "told them twice about the same share");

  // Asked for during onboarding: the city was all it wanted, so it ends the share.
  await tool(c, "request_location", {});
  expect((await share("Toronto")) === "Toronto, ON, Canada", "the accepted share was not taken");
  text = await logs(c);
  expect(text.includes('"shareEnded":true'), "the share it asked for was not ended");
  expect(!/coordinates|latitude|longitude|"lat"|"lon"/i.test(text), "something finer than a city reached the log");
});
await check("with nobody sharing, read_locations says so rather than inventing a place", async () => {
  const c = chat("locread");
  const result = await tool(c, "read_locations", {});
  expect(/nobody/i.test(result) && /do not claim/i.test(result), `unexpected answer: ${result.slice(0, 120)}`);
});

console.log("\nitinerary (no network; the sources are not called)");
const it = chat("it");
await check("add_to_itinerary takes the winner, posts one ticket, clears the ballot", async () => {
  await tool(it, "propose_plan", { title: "Vancouver weekend", options: [{ title: "Flair 1:55 PM → 4:05 PM, nonstop", subtitle: "CA$254 · 5 hr 10 min · Sat Oct 10", bookingUrl: "https://www.google.com/travel/flights?q=x" }, { title: "WestJet 10:30 PM → 12:44 AM +1, nonstop", subtitle: "CA$261 · 5 hr 14 min · Sat Oct 10", bookingUrl: "https://www.google.com/travel/flights?q=y" }] });
  const before = await dump(it);
  const out = await tool(it, "add_to_itinerary", { optionId: before.state.options[0].id, kind: "flight" });
  expect(/^Added i[0-9a-f]{4}\./.test(out), `unexpected reply: ${out}`);
  const { state } = await dump(it);
  expect(state.itinerary.length === 1, `${state.itinerary.length} items`);
  expect(state.itinerary[0].kind === "flight" && state.itinerary[0].status === "handoff" && state.itinerary[0].price === "CA$254", JSON.stringify(state.itinerary[0]));
  expect(state.options.length === 0 && state.status === "idle", "ballot not cleared");
  const text = await logs(it);
  expect(count(text, "itinerary.added") === 1, "itinerary.added fired " + count(text, "itinerary.added"));
  expect(/ticket\.out.*"kind":"itinerary"/.test(text), "no itinerary ticket posted");
  expect(/Finish it here: https:\/\/www\.google\.com/.test(text), "the deep link was not said");
});
if (env.BROWSERBASE_API_KEY) {
  await check("watch_flight with no itemId attaches to the lone unwatched flight item, and a bad ident reverts it", async () => {
    const before = await dump(it);
    const flightId = before.state.itinerary.find((i) => i.kind === "flight").id;
    const out = await tool(it, "watch_flight", { ident: "ZZ9999" });
    expect(/FlightAware has no ZZ9999/.test(out), `unexpected reply: ${out}`);
    const { state } = await dump(it);
    const flights = state.itinerary.filter((i) => i.kind === "flight");
    expect(flights.length === 1 && flights[0].id === flightId && flights[0].status === "handoff", JSON.stringify(flights));
    expect(!state.itinerary.some((i) => i.title === "ZZ9999"), "a ZZ9999 item was left behind");
  });
} else {
  console.log("  PASS  watch_flight bad-ident revert check  (skipped: no BROWSERBASE_API_KEY in .env)");
}
await check("confirm_item marks it booked and logs the expense", async () => {
  const { state } = await dump(it);
  const out = await tool(it, "confirm_item", { itemId: state.itinerary[0].id, note: "F8 227", price: "CA$254", paidBy: "+15550001111" });
  expect(/confirmed\./.test(out), out);
  const after = await dump(it);
  expect(after.state.itinerary[0].status === "confirmed" && after.state.itinerary[0].note === "F8 227", JSON.stringify(after.state.itinerary[0]));
  expect(after.state.expenses.length === 1 && after.state.expenses[0].amount === "CA$254", "expense not logged");
});
await check("add_to_itinerary refuses a ballot option without a kind", async () => {
  await tool(it, "propose_plan", { title: "Vancouver weekend", options: [{ title: "A" }, { title: "B" }] });
  const { state } = await dump(it);
  const out = await tool(it, "add_to_itinerary", { optionId: state.options[0].id });
  expect(/Say what kind/.test(out), out);
});
await check("book_option on a flight redirects to add_to_itinerary, never the pilot", async () => {
  const c = chat("it-flight-redirect");
  await tool(c, "propose_plan", { title: "Vancouver weekend", options: [{ title: "Flair", bookingUrl: "https://www.google.com/travel/flights?q=a" }, { title: "WestJet", bookingUrl: "https://www.google.com/travel/flights?q=b" }] });
  const { state } = await dump(c);
  const out = await tool(c, "book_option", { optionId: state.options[0].id, partySize: 4, isoTime: "2026-10-10T19:00:00" });
  expect(/^Added i[0-9a-f]{4}\./.test(out), `unexpected reply: ${out}`);
  const after = await dump(c);
  expect(after.state.itinerary.length === 1 && after.state.itinerary[0].kind === "flight" && after.state.itinerary[0].status === "handoff", JSON.stringify(after.state.itinerary));
  expect(after.state.options.length === 0 && after.state.status === "idle", "ballot not cleared");
  const text = await logs(c);
  expect(text.includes("booking.redirected"), "booking.redirected not logged");
  expect(!text.includes("booking.started"), "the pilot's booking.started fired for a flight");
});
await check("add_to_itinerary infers stay from a Google Hotels link with no kind given", async () => {
  const c = chat("it-stay-infer");
  await tool(c, "propose_plan", { title: "Where to stay", options: [{ title: "Rosewood", bookingUrl: "https://www.google.com/travel/search?q=x" }, { title: "Fairmont" }] });
  const { state } = await dump(c);
  const out = await tool(c, "add_to_itinerary", { optionId: state.options[0].id });
  expect(/^Added i[0-9a-f]{4}\./.test(out), `unexpected reply: ${out}`);
  const after = await dump(c);
  expect(after.state.itinerary.length === 1 && after.state.itinerary[0].kind === "stay", JSON.stringify(after.state.itinerary));
});
await check("book_option on a plain venue link without contact fields asks who is booking", async () => {
  const c = chat("it-venue-guard");
  await tool(c, "propose_plan", { title: "Dinner", options: [{ title: "Room A", bookingUrl: "https://example.com/book" }, { title: "Room B" }] });
  const { state } = await dump(c);
  const out = await tool(c, "book_option", { optionId: state.options[0].id, partySize: 4, isoTime: "2026-10-14T19:00:00" });
  expect(/ask who is booking/i.test(out), `unexpected reply: ${out}`);
  expect((await dump(c)).state.status === "voting", "plan left in a booking state by a refused call");
});
await check("search_flights refuses a date in the past without calling anything", async () => {
  const out = await tool(it, "search_flights", { from: "YYZ", to: "YVR", depart: "2020-01-01" });
  expect(/in the past/.test(out), out);
});
if (env.BROWSERBASE_API_KEY) {
  await check("search_flights returns real options (one proxied fetch)", async () => {
    const d = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const out = JSON.parse(await tool(it, "search_flights", { from: "YYZ", to: "YVR", depart: d }));
    expect(out.options?.length >= 1, "no flights");
    expect(/CA\$\d/.test(out.options[0].subtitle), out.options[0].subtitle);
  });
} else {
  console.log("  PASS  search_flights live check  (skipped: no BROWSERBASE_API_KEY in .env)");
}

console.log("\nwatching (snapshots injected; nothing fetched)");
const w = chat("watch");
await check("a shipped order is said once, with the tracking link, then delivered once", async () => {
  const { id } = await (await post("/api/dev/seedorder", { chat: w, shop: "partycity.com", url: "https://partycity.com/orders/abc" })).json();
  await post("/api/dev/shipped", { chat: w, itemId: id, carrier: "Canada Post", tracking: "7023210000000001", trackingUrl: "https://www.canadapost-postescanada.ca/track?x=7023210000000001", eta: "Tuesday" });
  await post("/api/dev/shipped", { chat: w, itemId: id, carrier: "Canada Post", tracking: "7023210000000001", trackingUrl: "https://www.canadapost-postescanada.ca/track?x=7023210000000001", eta: "Tuesday" });
  let text = await logs(w);
  expect(count(text, "watch.posted") === 1, `watch.posted fired ${count(text, "watch.posted")} times`);
  expect(/partycity\.com shipped: Canada Post 7023210000000001, arriving Tuesday\. https:/.test(text), "shipped line wrong");
  let { state } = await dump(w);
  expect(state.itinerary[0].status === "watching" && /^shipped/.test(state.itinerary[0].lastUpdate ?? ""), JSON.stringify(state.itinerary[0]));
  await post("/api/dev/shipped", { chat: w, itemId: id, delivered: true });
  text = await logs(w);
  expect(count(text, "watch.posted") === 2, "delivered not posted once");
  ({ state } = await dump(w));
  expect(state.itinerary[0].status === "done", "item not done after delivery");
  expect(count(text, '"kind":"itinerary"') >= 1, "no itinerary ticket after delivery");
});
await check("a flight delay and a gate change are said; a 10 minute creep is not", async () => {
  await tool(w, "add_to_itinerary", { item: { kind: "flight", title: "AC123 YYZ→YVR Oct 10", url: "https://www.google.com/travel/flights?q=z" } });
  const { state } = await dump(w);
  const item = state.itinerary.find((i) => i.kind === "flight");
  // watch_flight would fetch; seed the watch row through the same path the tool uses, with a snapshot injected instead.
  const T0 = Math.floor(Date.now() / 1000) + 3600;
  const base = { ident: "ACA123", iata: "AC123", status: "scheduled", from: "YYZ", to: "YVR", fromTz: "America/Toronto", toTz: "America/Vancouver", gateFrom: "D22", terminalFrom: "1", gateTo: "C41", scheduledDeparture: T0, estimatedDeparture: T0, scheduledArrival: T0 + 18000, estimatedArrival: T0 + 18000, delayMinutes: 0, url: "https://fa" };
  await post("/api/dev/seedflight", { chat: w, itemId: item.id, ident: "AC123" });
  await post("/api/dev/flight", { chat: w, itemId: item.id, status: base });
  await post("/api/dev/flight", { chat: w, itemId: item.id, status: { ...base, delayMinutes: 10, estimatedDeparture: T0 + 600 } });
  await post("/api/dev/flight", { chat: w, itemId: item.id, status: { ...base, delayMinutes: 30, estimatedDeparture: T0 + 1800, gateFrom: "D30" } });
  const text = await logs(w);
  const posted = text.split("\n").filter((l) => l.includes("watch.posted") && l.includes(item.id));
  expect(posted.length === 2, `${posted.length} lines posted for the flight`);
  expect(/delayed 30 min/.test(text) && /gate D30, terminal 1/.test(text), "delay or gate line missing");
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

if (flags.has("--net")) {
  console.log("\nworkflows (starts one real research run)");
  await check("a workflow can be launched at all", async () => {
    // Broke in production once: wrapping the agent class (Sentry) hid its name
    // from the SDK, and every launch failed with "Could not detect Agent binding".
    const c = chat("workflow");
    const out = await tool(c, "research", { brief: "one ramen place", near: "Waterloo, ON", depth: "quick" });
    expect(/research started/i.test(out), `unexpected reply: ${String(out).slice(0, 200)}`);
    expect(!(await logs(c)).includes("tool.failed"), "the research tool failed to launch");
  });
}

if (flags.has("--llm")) {
  console.log("\nmodel-driven turns");
  const m = chat("llm");
  await check("an @mention wakes the agent and it sends exactly one message", async () => {
    await post("/api/dev/message", { chat: m, group: true, from: "+15550001111", text: "we should get bubble tea after class" });
    await post("/api/dev/message", { chat: m, group: true, mention: true, from: "+15550001111", text: "@whim whats a good spot" });
    expect(await waitFor(m, "turn.end", 90), "no turn finished within 90s — is `npm run llm` running?");
    const out = (await dump(m)).transcript.filter((t) => t.direction === "out");
    expect(out.length === 1, `${out.length} messages sent in one turn`);
    return JSON.stringify(out[0].body).slice(0, 80);
  });
  await check("the agent asks where the group is instead of guessing a city", async () => {
    expect(!(await logs(m)).includes('"tool":"research"'), "started research without knowing the group's area");
  });
  await check("a reply to the ballot photo wakes the agent, like a reply to its card", async () => {
    const r = chat("reply");
    await tool(r, "propose_plan", PLAN);
    await post("/api/dev/message", { chat: r, group: true, from: "+15550001111", text: "can we do 8 instead?", replyTo: "photo" });
    expect((await logs(r)).includes('"wake":"reply"'), "the reply to the photo did not wake the agent");
    expect(await waitFor(r, "turn.end", 90), "no turn finished within 90s");
  });
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
