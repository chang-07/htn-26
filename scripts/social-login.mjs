#!/usr/bin/env node
/**
 * Log one of the bot's own social accounts in, once, by hand.
 *
 *   node scripts/social-login.mjs            Instagram
 *   node scripts/social-login.mjs x          X / Twitter
 *
 * Opens a Browserbase session bound to a persistent context, goes to the site's
 * login page, and prints a live-view link. You type the username and password
 * into that remote browser yourself. The script only watches for the login
 * cookie to appear; when it does, it closes the session, which saves the
 * cookies into the context. Later sessions opened with the same context are
 * already logged in. Cookies are kept per domain, so one context holds every
 * site's login and logging into one leaves the others alone.
 *
 * The password never touches this repo, a secret store, or a model prompt — and
 * it must stay that way: do not "simplify" this into a script that types it.
 *
 * Use a throwaway account made for the bot. Automation is against these sites'
 * terms and an account can be challenged or banned at any time; everything
 * that depends on it has to degrade gracefully when that happens.
 */
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const KEY = env.BROWSERBASE_API_KEY;
const CONTEXT = env.BROWSERBASE_CONTEXT_ID;
if (!KEY || !CONTEXT) throw new Error("BROWSERBASE_API_KEY and BROWSERBASE_CONTEXT_ID must be set in .env");

const API = "https://api.browserbase.com/v1";
const headers = { "X-BB-API-Key": KEY, "content-type": "application/json" };
const project = env.BROWSERBASE_PROJECT_ID ? { projectId: env.BROWSERBASE_PROJECT_ID } : {};
const WAIT_MINUTES = 9;

/** Where to log in, and the cookie whose presence means it worked. A new site is one line here plus a reader in social.ts. */
const SITES = {
  instagram: { name: "Instagram", login: "https://www.instagram.com/accounts/login/", domain: "instagram.com", cookie: "sessionid" },
  x: { name: "X", login: "https://x.com/i/flow/login", domain: "x.com", cookie: "auth_token" },
};
const site = SITES[(process.argv[2] ?? "instagram").toLowerCase().replace(/^twitter$/, "x")];
if (!site) throw new Error(`unknown site "${process.argv[2]}"; one of: ${Object.keys(SITES).join(", ")}`);

const session = await (
  await fetch(`${API}/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...project,
      timeout: (WAIT_MINUTES + 1) * 60,
      browserSettings: { context: { id: CONTEXT, persist: true }, solveCaptchas: true },
    }),
  })
).json();
if (!session.id) throw new Error(`could not open a session: ${JSON.stringify(session).slice(0, 300)}`);

// Raw CDP over the runtime's own WebSocket: enough to open a tab and read cookies.
const ws = new WebSocket(session.connectUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve);
  ws.addEventListener("error", () => reject(new Error("CDP socket failed to open")));
});
let nextId = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const cdp = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

const release = async () => {
  ws.close();
  await fetch(`${API}/sessions/${session.id}`, { method: "POST", headers, body: JSON.stringify({ ...project, status: "REQUEST_RELEASE" }) });
};

const loggedIn = async () => {
  const res = await cdp("Storage.getCookies");
  return (res.result?.cookies ?? []).some((c) => c.name === site.cookie && c.domain.includes(site.domain) && c.value);
};

try {
  if (await loggedIn()) {
    console.log(`ALREADY_LOGGED_IN: this context already holds a session for ${site.name}.`);
    await release();
    process.exit(0);
  }

  await cdp("Target.createTarget", { url: site.login });
  await new Promise((r) => setTimeout(r, 4000));

  const debug = await (await fetch(`${API}/sessions/${session.id}/debug`, { headers })).json();
  const page = (debug.pages ?? []).find((p) => (p.url ?? "").includes(site.domain));
  console.log(`LIVE_VIEW: ${page?.debuggerFullscreenUrl ?? debug.debuggerFullscreenUrl}`);
  console.log(`Log in there. Waiting up to ${WAIT_MINUTES} minutes…`);

  const deadline = Date.now() + WAIT_MINUTES * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await loggedIn()) {
      // Let the site finish its post-login redirects before the cookies are saved.
      await new Promise((r) => setTimeout(r, 8000));
      await release();
      console.log(`LOGGED_IN: ${site.name} session saved to the context.`);
      process.exit(0);
    }
  }
  await release();
  console.log("TIMED_OUT: no login detected. Run it again.");
  process.exit(1);
} catch (err) {
  await release().catch(() => {});
  console.log(`FAILED: ${err.message}`);
  process.exit(1);
}
