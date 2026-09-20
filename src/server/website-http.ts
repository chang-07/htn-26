import { z } from "zod";
import { dashboardSchema } from "../shared/workspace.ts";
import type { WebsiteStore } from "./website-store.ts";

// Dependency injection keeps authentication and authorization testable without sending texts.
export type WebsiteBackend = {
  challenge: WebsiteStore["challenge"]; cancelChallenge: (id: string) => unknown;
  verify: WebsiteStore["verify"]; account: WebsiteStore["account"]; logout: (session: string) => unknown;
  events: (session: string) => Promise<unknown>;
  event: (session: string, id: string) => Promise<unknown>;
  workspace: (session: string) => Promise<unknown>;
  saveWorkspace: (session: string, data: unknown, revision: number) => Promise<unknown>;
};
const json = (body: unknown, status = 200, headers: Record<string,string> = {}) => Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const cookieName = (url: URL) => url.protocol === "https:" ? "__Host-whim_session" : "whim_session";
function sessionCookie(url: URL, value: string, maxAge: number) {
  return `${cookieName(url)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${url.protocol === "https:" ? "; Secure" : ""}`;
}
async function body(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("Expected JSON");
  const reader = request.body?.getReader(); if (!reader) throw new Error("Missing body");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 200_000) { await reader.cancel(); throw new Error("Request too large"); } chunks.push(part.value); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function websiteRequest(request: Request, db: WebsiteBackend, sendCode: (phone: string, code: string) => Promise<void>) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  const session = request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(cookieName(url) + "="))?.slice(cookieName(url).length + 1) ?? "";
  if (!["GET", "HEAD"].includes(method) && (request.headers.get("origin") !== url.origin || request.headers.get("sec-fetch-site") === "cross-site")) return json({ error: "Request origin does not match." }, 403);
  try {
    if (path === "/api/account/code" && method === "POST") {
      const input = z.object({ phone: z.string().max(32) }).parse(await body(request));
      const challenge = await db.challenge(input.phone, request.headers.get("cf-connecting-ip") || "local");
      if ("error" in challenge) return json({ error: challenge.error }, 429);
      try { await sendCode(challenge.phone, challenge.code); }
      catch { await db.cancelChallenge(challenge.id); return json({ error: "Couldn’t send your code. Please try again shortly." }, 503); }
      return json({ id: challenge.id });
    }
    if (path === "/api/account/verify" && method === "POST") {
      const input = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), code: z.string().regex(/^\d{6}$/) }).parse(await body(request));
      const verified = await db.verify(input.id, input.code);
      if (!verified) return json({ error: "That code is incorrect or expired. Request a new one if needed." }, 401);
      if (session) await db.logout(session);
      return json({ account: verified.account }, 200, { "set-cookie": sessionCookie(url, verified.session, 30 * 86400) });
    }
    if (path === "/api/account/logout" && method === "POST") { await db.logout(session); return json({ ok: true }, 200, { "set-cookie": sessionCookie(url, "", 0) }); }
    const account = await db.account(session);
    if (!account) return json({ error: "Sign in to continue." }, 401);
    if (path === "/api/account/session" && method === "GET") return json({ account });
    if (path === "/api/account/workspace" && method === "GET") return json(await db.workspace(session));
    if (path === "/api/account/workspace" && method === "PUT") {
      const input = z.object({ accountId: z.string(), data: dashboardSchema, revision: z.number().int().nonnegative() }).parse(await body(request));
      if (input.accountId !== account.id) return json({ error: "The signed-in account changed. Reload before saving." }, 409);
      const result = await db.saveWorkspace(session, input.data, input.revision);
      if (!result) return json({ error: "Sign in to continue." }, 401);
      if ("conflict" in (result as object)) return json({ error: "This workspace changed in another tab. Reload before saving again." }, 409);
      return json(result);
    }
    if (path === "/api/events" && method === "GET") { const events = await db.events(session); return events ? json({ events }) : json({ error: "Sign in to continue." }, 401); }
    const match = path.match(/^\/api\/events\/([^/]+)$/);
    if (match && method === "GET") { const event = await db.event(session, decodeURIComponent(match[1])); return event ? json({ event }) : json({ error: "Event not found." }, 404); }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError || (error instanceof Error && ["Expected JSON", "Missing body", "Request too large"].includes(error.message))) return json({ error: "Check the submitted details and try again." }, 400);
    return json({ error: "Couldn’t complete that request. Try again shortly." }, 503);
  }
}
