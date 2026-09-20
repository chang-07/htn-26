// Latency + batching eval for the agent harness. No model, no Linq: dry transport
// and the stub LLM. Usage: node run.mjs <port> <label> [n]
const [port, label, nArg] = process.argv.slice(2);
const N = Number(nArg ?? 8), B = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body) => fetch(B + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const tod = (s) => { const [h, m, r] = s.split(":"); return (Number(h) * 3600 + Number(m) * 60) * 1000 + Math.round(Number(r) * 1000); };
async function events(chat) {
  const text = await (await fetch(`${B}/api/dev/logs?chat=${chat}`)).text();
  return text.split("\n").map((l) => l.match(/^(\d\d:\d\d:\d\d\.\d+)\s+\w+\s+(\S+)/)).filter(Boolean).map((m) => ({ t: tod(m[1]), e: m[2] }));
}
// Done when a turn has ended and nothing new has been logged for `quiet` ms.
async function settle(chat, quiet = 2600, max = 25000) {
  const t0 = Date.now(); let last = 0, lastChange = Date.now(), ev = [];
  while (Date.now() - t0 < max) {
    ev = await events(chat);
    if (ev.length !== last) { last = ev.length; lastChange = Date.now(); }
    if (ev.some((x) => x.e === "turn.end") && Date.now() - lastChange > quiet) break;
    await sleep(120);
  }
  return ev;
}
const first = (ev, e) => ev.find((x) => x.e === e)?.t, count = (ev, e) => ev.filter((x) => x.e === e).length;
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { p50: q(0.5), p90: q(0.9), min: s[0], max: s[s.length - 1] }; };

async function single(kind) {
  const rows = [];
  for (let i = 0; i < N; i++) {
    const chat = `ev-${label}-${kind}-${i}-${Date.now() % 1e6}`;
    const sent = Date.now();
    await post("/api/dev/message", { chat, from: "+15550100001", text: "dinner friday?", group: kind === "group", mention: kind === "group" });
    const ev = await settle(chat);
    const tin = first(ev, "message.in"), ts = first(ev, "turn.start"), tout = first(ev, "message.out"), tend = first(ev, "turn.end");
    rows.push({ wait: ts - tin, think: tout - ts, reply: tout - tin, turn: tend - tin, replies: count(ev, "message.out"), wall: null, sent });
  }
  return { scenario: `${kind}_single`, n: N, in_to_turn_start: stats(rows.map((r) => r.wait)), turn_start_to_reply: stats(rows.map((r) => r.think)), in_to_first_reply: stats(rows.map((r) => r.reply)), in_to_turn_end: stats(rows.map((r) => r.turn)), replies_per_chat: stats(rows.map((r) => r.replies)) };
}
async function burst(kind, gap, texts = ["dinner friday?", "actually saturday", "somewhere downtown"]) {
  const rows = [];
  for (let i = 0; i < Math.max(4, Math.floor(N / 2)); i++) {
    const chat = `ev-${label}-${kind}-b${gap}-${i}-${Date.now() % 1e6}`;
    for (const text of texts) { await post("/api/dev/message", { chat, from: "+15550100001", text, group: kind === "group", mention: kind === "group" }); await sleep(gap); }
    const ev = await settle(chat, 3200);
    const ins = ev.filter((x) => x.e === "message.in").map((x) => x.t), tout = first(ev, "message.out");
    rows.push({ turns: count(ev, "turn.start"), replies: count(ev, "message.out"), lastInToReply: tout - ins[ins.length - 1], firstInToReply: tout - ins[0] });
  }
  return { scenario: `${kind}_burst_${texts.length}x_gap${gap}ms`, n: rows.length, turns: stats(rows.map((r) => r.turns)), replies: stats(rows.map((r) => r.replies)), first_in_to_first_reply: stats(rows.map((r) => r.firstInToReply)), replies_each: rows.map((r) => r.replies).join(","), turns_each: rows.map((r) => r.turns).join(",") };
}
const calls0 = Number(await (await fetch("http://127.0.0.1:18080/calls")).text());
const out = [await single("dm"), await single("group"), await burst("dm", 300), await burst("dm", 1500), await burst("group", 1500), await burst("dm", 800, Array.from({ length: 10 }, (_, i) => `thought ${i + 1}`))];
const calls1 = Number(await (await fetch("http://127.0.0.1:18080/calls")).text());
console.log(JSON.stringify({ label, modelCalls: calls1 - calls0, results: out }, null, 1));
