#!/usr/bin/env node
/**
 * The name and photo people see for the agent's number (iMessage Name and
 * Photo Sharing). Set once per number; the agent then offers the card to each
 * chat the first time it is woken there.
 *
 *   node scripts/linq-contact-card.mjs show
 *   node scripts/linq-contact-card.mjs set "Plan"                     photo = <PUBLIC_BASE_URL>/card/avatar.png
 *   node scripts/linq-contact-card.mjs set "Plan" --image <url>       any public image instead
 *   node scripts/linq-contact-card.mjs set "Plan" --number +1555…     when the key has more than one line
 *
 * Linq fetches the image when the card is written, so PUBLIC_BASE_URL must be
 * reachable at that moment (the tunnel up, or the Worker deployed). Writes are
 * rate-limited upstream: on a 503, wait — retrying extends the limit.
 */
import fs from "node:fs";
import LinqAPIV3 from "@linqapp/sdk";

const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
if (!env.LINQ_API_KEY) throw new Error("LINQ_API_KEY missing from .env");
const linq = new LinqAPIV3({ apiKey: env.LINQ_API_KEY });

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const show = (c) => console.log(`${c.is_active ? "ACTIVE  " : "inactive"} ${c.phone_number}  ${[c.first_name, c.last_name].filter(Boolean).join(" ")}  ${c.image_url ?? "(no photo)"}`);

const cards = async () => (await linq.contactCard.retrieve()).contact_cards;

async function ourNumber() {
  const given = flag("--number");
  if (given) return given;
  const numbers = (await linq.phoneNumbers.list()).phone_numbers.map((n) => n.phone_number);
  if (numbers.length !== 1) throw new Error(`Pick a line with --number: ${numbers.join(", ") || "none found"}`);
  return numbers[0];
}

if (cmd === "show") {
  const all = await cards();
  if (!all.length) console.log("no contact card yet — run `set`");
  all.forEach(show);
} else if (cmd === "set") {
  const [first_name, ...rest] = (args[0] && !args[0].startsWith("--") ? args[0] : "Plan").split(" ");
  const image_url = flag("--image") ?? (env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL}/card/avatar.png` : undefined);
  if (!image_url) throw new Error("No photo: set PUBLIC_BASE_URL in .env or pass --image <url>");
  const phone_number = await ourNumber();
  const body = { phone_number, first_name, image_url, ...(rest.length ? { last_name: rest.join(" ") } : {}) };
  // create refuses (409) once a card is active, so an existing card is updated.
  const exists = (await cards()).some((c) => c.phone_number === phone_number);
  show(exists ? await linq.contactCard.update(body) : await linq.contactCard.create(body));
} else {
  console.log("usage: linq-contact-card.mjs show | set [name] [--image <url>] [--number <e164>]");
  process.exit(1);
}
