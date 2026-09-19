#!/usr/bin/env node
/**
 * Manage which endpoint Linq delivers this number's events to.
 *
 *   node scripts/linq-webhook.mjs list
 *   node scripts/linq-webhook.mjs create <base-url> --env        secret -> .env   (tunnel / local dev)
 *   node scripts/linq-webhook.mjs create <base-url> --deployed   secret -> wrangler secret (deployed Worker)
 *   node scripts/linq-webhook.mjs use <url-substring>            activate the match, deactivate the rest
 *   node scripts/linq-webhook.mjs prune                          delete inactive subscriptions
 *
 * Only ONE of our subscriptions should be active at a time: with two, every
 * message is handled by two agents and the chat gets two replies. `create`
 * therefore makes the new subscription INACTIVE; switch with `use`.
 *
 * The signing secret is shown by Linq once, at creation, and cannot be fetched
 * again. This script stores it and never prints it.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import LinqAPIV3 from "@linqapp/sdk";

const PATH = "/api/webhooks/linq";
const EVENTS = ["message.received", "reaction.added"];

const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
if (!env.LINQ_API_KEY) throw new Error("LINQ_API_KEY missing from .env");
const linq = new LinqAPIV3({ apiKey: env.LINQ_API_KEY });

/** Ours = pointing at our webhook path. Linq's own welcome subscription is left alone. */
const ours = async () => (await linq.webhookSubscriptions.list()).subscriptions.filter((s) => s.target_url.endsWith(PATH));
const show = (s) => console.log(`${s.is_active ? "ACTIVE  " : "inactive"} ${s.id.slice(0, 8)}  ${s.target_url}`);

function setEnvVar(key, value) {
  const lines = fs.readFileSync(".env", "utf8").split("\n").filter((l) => !l.startsWith(`${key}=`));
  while (lines.length && lines.at(-1) === "") lines.pop();
  fs.writeFileSync(".env", [...lines, `${key}=${value}`, ""].join("\n"));
}

const [cmd, arg, flag] = process.argv.slice(2);

if (cmd === "list") {
  (await ours()).forEach(show);
} else if (cmd === "create") {
  if (!arg?.startsWith("https://") || !["--env", "--deployed"].includes(flag)) {
    throw new Error("usage: create <https base url> --env|--deployed");
  }
  const base = arg.replace(/\/$/, "");
  const sub = await linq.webhookSubscriptions.create({ target_url: base + PATH, subscribed_events: EVENTS });
  await linq.webhookSubscriptions.update(sub.id, { is_active: false });
  if (flag === "--env") {
    setEnvVar("LINQ_WEBHOOK_SECRET", sub.signing_secret);
    setEnvVar("PUBLIC_BASE_URL", base);
    console.log("secret + PUBLIC_BASE_URL written to .env — restart `npm run dev`");
  } else {
    for (const [name, value] of [["LINQ_WEBHOOK_SECRET", sub.signing_secret], ["PUBLIC_BASE_URL", base]]) {
      execFileSync("npx", ["wrangler", "secret", "put", name], { input: value, stdio: ["pipe", "ignore", "inherit"] });
    }
    console.log("secret + PUBLIC_BASE_URL stored as Worker secrets");
  }
  console.log(`created ${sub.id.slice(0, 8)} (inactive). Switch to it with: use ${new URL(base).host}`);
} else if (cmd === "use") {
  if (!arg) throw new Error("usage: use <url-substring>");
  const subs = await ours();
  const matches = subs.filter((s) => s.target_url.includes(arg));
  if (matches.length !== 1) throw new Error(`"${arg}" matches ${matches.length} subscriptions; be more specific`);
  for (const s of subs) {
    const active = s.id === matches[0].id;
    if (s.is_active !== active) await linq.webhookSubscriptions.update(s.id, { is_active: active });
  }
  (await ours()).forEach(show);
} else if (cmd === "prune") {
  for (const s of await ours()) {
    if (!s.is_active) {
      await linq.webhookSubscriptions.delete(s.id);
      console.log(`deleted ${s.id.slice(0, 8)}  ${s.target_url}`);
    }
  }
} else {
  console.log("commands: list | create <base-url> --env|--deployed | use <url-substring> | prune");
}
