import { getAgentByName } from "agents";
import type { PlanAgent } from "./agent";
import { DurableObject } from "cloudflare:workers";
import { WebsiteStore } from "./website-store";
import type { EventDocument } from "../shared/events";
export class Website extends DurableObject<Env> {
  private store: WebsiteStore;
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); this.store = new WebsiteStore(ctx.storage.sql); }
  async startBackfill() {
    if (await this.ctx.storage.get("backfill_complete")) return;
    if (!await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }
  async alarm() {
    const cursor = await this.ctx.storage.get<string>("backfill_cursor") ?? "";
    const rows = await this.env.RUNS_DB.prepare("SELECT DISTINCT chat FROM runs WHERE chat > ? ORDER BY chat LIMIT 10").bind(cursor).all<{ chat: string }>();
    for (const row of rows.results) {
      const agent = await getAgentByName<Env, PlanAgent>(this.env.PlanAgent, row.chat);
      await agent.syncWebsiteEvent();
      await this.ctx.storage.put("backfill_cursor", row.chat);
    }
    if (rows.results.length === 10) await this.ctx.storage.setAlarm(Date.now() + 1000);
    else await this.ctx.storage.put("backfill_complete", true);
  }
  challenge(phone: string, ip: string) { return this.store.challenge(phone, ip); }
  cancelChallenge(id: string) { return this.store.cancelChallenge(id); }
  verify(id: string, code: string) { return this.store.verify(id, code); }
  account(session: string) { return this.store.account(session); }
  logout(session: string) { return this.store.logout(session); }
  syncEvent(document: string, handles: string[], rosterVersion: number) { return this.ctx.storage.transactionSync(() => this.store.syncEvent(JSON.parse(document) as EventDocument, handles, rosterVersion)); }
  async events(session: string): Promise<unknown> { const a = await this.store.account(session); return a ? this.store.events(a) : null; }
  async event(session: string, id: string): Promise<unknown> { const a = await this.store.account(session); return a ? this.store.event(a, id) : null; }
  async workspace(session: string) { const a = await this.store.account(session); return a ? this.store.workspace(a) : null; }
  async saveWorkspace(session: string, data: unknown, revision: number) { const a = await this.store.account(session); return a ? this.store.saveWorkspace(a, data, revision) : null; }
}
export const website = (env: Env) => env.Website.get(env.Website.idFromName("global"));
