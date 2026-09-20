import type { EventDocument } from "../shared/events.ts";

export interface SqlDriver { exec(query: string, ...bindings: (string | number | null)[]): { toArray(): unknown[] } }
export const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
export const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), n => n.toString(16).padStart(2, "0")).join("");
export const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, "0")).join("");
export function phone(value: string) { const p = value.replace(/[ ()-]/g, ""); return /^\+[1-9]\d{7,14}$/.test(p) ? p : null; }
export type WebsiteAccount = { id: string; phone: string };
export class WebsiteStore {
  private sql: SqlDriver;
  constructor(sql: SqlDriver) {
    this.sql = sql;
    for (const query of [
      `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, phone TEXT UNIQUE NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, phone TEXT NOT NULL, hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)`,
      `CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS event_documents (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, json TEXT NOT NULL, revision INTEGER NOT NULL, updated INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS event_documents_group ON event_documents(group_id)`,
      `CREATE TABLE IF NOT EXISTS memberships (group_id TEXT NOT NULL, phone TEXT NOT NULL, PRIMARY KEY (group_id, phone))`,
      `CREATE TABLE IF NOT EXISTS group_rosters (group_id TEXT PRIMARY KEY, version INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS memberships_phone ON memberships(phone)`,
      `CREATE TABLE IF NOT EXISTS workspaces (account_id TEXT PRIMARY KEY, json TEXT NOT NULL, revision INTEGER NOT NULL)`,
    ]) sql.exec(query);
  }
  private rows<T>(q: string, ...args: (string | number | null)[]) { return this.sql.exec(q, ...args).toArray() as T[]; }
  private limit(key: string, count: number, now: number) {
    this.sql.exec(`DELETE FROM limits WHERE expires <= ?`, now);
    const row = this.rows<{ count: number }>(`SELECT count FROM limits WHERE key = ?`, key)[0];
    if ((row?.count ?? 0) >= count) return false;
    this.sql.exec(`INSERT INTO limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1`, key, now + 900_000);
    return true;
  }
  async challenge(rawPhone: string, ip: string, now = Date.now()) {
    const handle = phone(rawPhone); if (!handle) return { error: "Use your phone number with its country code." };
    const id = token();
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
    const code = n.toString().padStart(6, "0");
    const digest = await hash(`${id}:${code}`);
    const ipKey = await hash(ip);
    if (!this.limit(`phone:${handle}`, 3, now) || !this.limit(`ip:${ipKey}`, 10, now)) return { error: "Too many requests. Try again in 15 minutes." };
    this.sql.exec(`DELETE FROM challenges WHERE expires <= ? OR phone = ?`, now, handle);
    this.sql.exec(`DELETE FROM sessions WHERE expires <= ?`, now);
    this.sql.exec(`INSERT INTO challenges (id,phone,hash,expires) VALUES (?,?,?,?)`, id, handle, digest, now + 600_000);
    return { id, code, phone: handle };
  }
  cancelChallenge(id: string) { this.sql.exec(`DELETE FROM challenges WHERE id = ?`, id); }
  async verify(id: string, code: string, now = Date.now()) {
    const session = token();
    const [digest, sessionHash] = await Promise.all([hash(`${id}:${code}`), hash(session)]);
    // No await between read, attempt update and deletion: concurrent replay cannot succeed.
    const c = this.rows<{ phone: string; hash: string; expires: number; attempts: number }>(`SELECT * FROM challenges WHERE id = ?`, id)[0];
    if (!c || c.expires <= now || c.attempts >= 5) return null;
    this.sql.exec(`UPDATE challenges SET attempts=attempts+1 WHERE id = ?`, id);
    if (digest !== c.hash) return null;
    this.sql.exec(`DELETE FROM challenges WHERE id = ?`, id);
    const newId = crypto.randomUUID();
    this.sql.exec(`INSERT OR IGNORE INTO accounts (id,phone) VALUES (?,?)`, newId, c.phone);
    const account = this.rows<WebsiteAccount>(`SELECT id,phone FROM accounts WHERE phone = ?`, c.phone)[0];
    this.sql.exec(`INSERT INTO sessions VALUES (?,?,?)`, sessionHash, account.id, now + SESSION_TTL);
    return { account, session, isNewAccount: account.id === newId };
  }
  async account(session: string, now = Date.now()) {
    if (!/^[a-f0-9]{64}$/.test(session)) return null;
    return this.rows<WebsiteAccount>(`SELECT a.id,a.phone FROM sessions s JOIN accounts a ON a.id=s.account_id WHERE s.hash=? AND s.expires>?`, await hash(session), now)[0] ?? null;
  }
  async logout(session: string) { this.sql.exec(`DELETE FROM sessions WHERE hash=?`, await hash(session)); }
  syncEvent(event: EventDocument, handles: string[], rosterVersion: number) {
    if (!Number.isSafeInteger(rosterVersion) || rosterVersion < 1) throw new Error("Invalid roster version");
    const current = this.rows<{ revision: number }>(`SELECT MAX(revision) AS revision FROM event_documents WHERE group_id=?`, event.groupId)[0];
    const roster = this.rows<{ version: number }>(`SELECT version FROM group_rosters WHERE group_id=?`, event.groupId)[0];
    // Delayed deliveries must not restore revoked access or publish new data
    // against an older roster. The Durable Object wraps these writes atomically.
    if ((current?.revision ?? -1) > event.revision || (roster?.version ?? 0) > rosterVersion) return;
    this.sql.exec(`INSERT INTO group_rosters VALUES (?,?) ON CONFLICT(group_id) DO UPDATE SET version=excluded.version`, event.groupId, rosterVersion);
    this.sql.exec(`DELETE FROM memberships WHERE group_id=?`, event.groupId);
    // Revision is the agent's persisted state version, not arrival time.
    this.sql.exec(`INSERT INTO event_documents VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,revision=excluded.revision,updated=excluded.updated WHERE excluded.revision >= event_documents.revision`, event.id, event.groupId, JSON.stringify(event), event.revision, event.updatedAt);
    for (const handle of handles) {
      const normalized = phone(handle);
      if (normalized) this.sql.exec(`INSERT OR IGNORE INTO memberships VALUES (?,?)`, event.groupId, normalized);
    }
  }
  events(account: WebsiteAccount) {
    return this.rows<{ json: string }>(`SELECT e.json FROM event_documents e JOIN memberships m ON m.group_id=e.group_id WHERE m.phone=? ORDER BY e.updated DESC LIMIT 200`, account.phone).map(row => JSON.parse(row.json) as EventDocument);
  }
  event(account: WebsiteAccount, id: string) {
    const row = this.rows<{ json: string }>(`SELECT e.json FROM event_documents e JOIN memberships m ON m.group_id=e.group_id WHERE m.phone=? AND e.id=?`, account.phone, id)[0];
    return row ? JSON.parse(row.json) as EventDocument : null;
  }
  workspace(account: WebsiteAccount) {
    const row = this.rows<{ json: string; revision: number }>(`SELECT json,revision FROM workspaces WHERE account_id=?`, account.id)[0];
    return row ? { data: JSON.parse(row.json), revision: row.revision } : { data: null, revision: 0 };
  }
  saveWorkspace(account: WebsiteAccount, data: unknown, revision: number) {
    if (this.workspace(account).revision !== revision) return { conflict: true as const };
    this.sql.exec(`INSERT INTO workspaces VALUES (?,?,?) ON CONFLICT(account_id) DO UPDATE SET json=excluded.json,revision=excluded.revision`, account.id, JSON.stringify(data), revision + 1);
    return { revision: revision + 1 };
  }
}
