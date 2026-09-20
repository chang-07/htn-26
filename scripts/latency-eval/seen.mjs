// How many of a 3-text burst had arrived when the FIRST turn read the transcript.
const [port, label] = process.argv.slice(2); const B = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (body) => fetch(B + "/api/dev/message", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
for (const gap of [300, 700, 1200]) {
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const chat = `seen-${label}-${gap}-${i}-${Date.now() % 1e6}`;
    for (const text of ["dinner friday?", "actually saturday", "somewhere downtown"]) { await post({ chat, from: "+15550100001", text }); await sleep(gap); }
    await sleep(4500);
    const log = await (await fetch(`${B}/api/dev/logs?chat=${chat}`)).text();
    const m = log.split("\n").find((l) => /\sturn\.start\s/.test(l))?.match(/"history":(\d+)/);
    seen.push(Number(m?.[1] ?? -1));
  }
  console.log(`${label} gap=${gap}ms  texts visible to first turn (of 3): ${seen.join(",")}`);
}
