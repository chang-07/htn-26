import { liveAgent } from "./live-agent";
import { fillCheckout, hasCardForm, payCheckout, type ShipTo } from "./checkout";
import { cancelPayment, paymentCard, paymentSucceeded, requestPayment } from "./linq";
import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import type { PlanAgent } from "./agent";
import { openBrowser, pooled, TABS } from "./browser";
import { errorFields, log } from "./log";
import { runPilot, type PilotStatus } from "./pilot";

export type BookingParams = {
  title: string;
  url: string;
  partySize: number;
  isoTime: string;
  /** Who the reservation goes under. The pilot cannot book without these. */
  contact: { name: string; email: string; phone?: string };
};

/** A read-only look at what times are free, for up to three options, one after another. */
export type AvailabilityParams = {
  mode: "availability";
  partySize: number;
  isoTime: string;
  checks: { optionId: string; title: string; url: string }[];
};

/** One person paying for one store's cart, through that store's own checkout page. */
export type PayParams = {
  pay: true;
  chat: string;
  shop: string;
  checkoutUrl: string;
  payer: string;
  shipTo: ShipTo;
  /** Refuse anything above this, whatever the page says. */
  capCents: number;
  /** One per attempt: what stops a retry from minting a second card. */
  key: string;
};

export type PayResult = {
  shop: string;
  payer: string;
  status: "paid" | "dry_run" | "over_cap" | "needs_connection" | "not_approved" | "no_card_form" | "failed";
  total?: string;
  confirmation?: string;
  detail?: string;
  /** Pay was pressed but the store never confirmed: it may or may not have charged. */
  unsure?: boolean;
  shotId?: string;
};

export type AvailabilityResult = { optionId: string; title: string; ok: boolean; slots: string[]; summary: string };

export type BookingResult = {
  /** True only when a reservation was actually confirmed. */
  ok: boolean;
  status: PilotStatus | "no_link" | "error";
  confirmation?: string;
  /** One line for the group, in plain words. */
  detail: string;
  /** The venue's own booking page: where a person picks up if the pilot stopped short. */
  handoffUrl?: string;
  /** Browserbase replay of the whole run. */
  replayUrl?: string;
  /** Id of the final screenshot, stored on the agent and served at /shot/<chat>/<id>.jpg. */
  shotId?: string;
  steps?: number;
  tokens?: number;
};

/**
 * A durable booking run. Workflows fit because a reservation is a multi-minute
 * job that must survive a restart — and must not run twice. The pilot step
 * therefore has NO retries: a retry after a half-finished attempt could submit
 * the same reservation again, or stack a second hold on the venue's inventory.
 * Only the report back to the agent, which is idempotent, is retried.
 */
export class BookingWorkflow extends AgentWorkflow<PlanAgent, BookingParams | AvailabilityParams | PayParams> {
  private _live?: DurableObjectStub<PlanAgent>;
  /** The chat's agent, looked up afresh on every call so a deploy mid-run cannot strand the result. */
  private get live() {
    return (this._live ??= liveAgent(this.env, this.agent));
  }

  async run(event: AgentWorkflowEvent<BookingParams | AvailabilityParams | PayParams>, step: AgentWorkflowStep) {
    if ("pay" in event.payload) {
      const pay = event.payload;
      // One step, no retries: a retry could pay twice. The card lives and dies
      // inside it, because whatever a step returns is written to storage.
      const result = await step.do("pay", { retries: { limit: 0, delay: "1 second" }, timeout: "10 minutes" }, () => this.pay(pay));
      log(result.status === "paid" ? "info" : "warn", "pay", "workflow.result", { shop: result.shop, status: result.status, total: result.total });
      await step.do("report", () => this.live.payFinished(result));
      return result;
    }
    if ("mode" in event.payload) {
      const checks = event.payload;
      // One browser, a tab per venue: the free Browserbase plan allows one
      // session at a time, but the checks have nothing to do with each other.
      const results = await step.do("availability", { retries: { limit: 0, delay: "1 second" }, timeout: "12 minutes" }, () =>
        this.checkAll(checks),
      );
      await step.do("report", () => this.live.availabilityFinished(results));
      return results;
    }
    const params = event.payload;
    const dryRun = this.env.BOOKING_DRY_RUN !== "false";
    log("info", "book", "workflow.start", { title: params.title, dryRun });

    const result = await step.do("pilot", { retries: { limit: 0, delay: "1 second" }, timeout: "9 minutes" }, () =>
      this.reserve(params, dryRun),
    );

    log(result.ok ? "info" : "warn", "book", "workflow.result", { status: result.status, steps: result.steps, tokens: result.tokens });
    await step.do("report", () => this.live.bookingFinished(result));
    return result;
  }

  private async pay(params: PayParams): Promise<PayResult> {
    const base = { shop: params.shop, payer: params.payer };
    const live = this.env.PAYMENTS_LIVE === "true";
    let session;
    try {
      session = await openBrowser(this.env, { timeoutSeconds: 570 });
    } catch (err) {
      log("error", "pay", "browser.failed", errorFields(err));
      return { ...base, status: "failed", detail: "couldn't start a browser to check out with" };
    }
    let paymentId: string | undefined;
    let shotId: string | undefined;
    const page = await session.browser.newPage();
    const shoot = async () =>
      (shotId = await page
        .screenshot({ type: "jpeg", quality: 60, encoding: "base64" })
        .then((b64) => this.live.saveShot(String(b64)))
        .catch(() => undefined));
    try {
      await this.live.payProgress("browser", { shop: params.shop, liveUrl: session.liveUrl });
      const priced = await fillCheckout(page, params.checkoutUrl, params.shipTo, (line) => void this.live.payProgress("step", { line }));
      await this.live.payProgress("priced", { shop: params.shop, total: priced.line });

      if (priced.totalCents > params.capCents) return { ...base, status: "over_cap", total: priced.line, shotId: await shoot() };
      if (!(await hasCardForm(page))) return { ...base, status: "no_card_form", total: priced.line, shotId: await shoot() };
      if (!live) return { ...base, status: "dry_run", total: priced.line, shotId: await shoot() };

      // Mint a card for exactly this total at exactly this store. If the person
      // has to act first (add a card, approve with their passkey), tell them
      // once and keep asking Linq with the same key until they have.
      const ask = {
        handle: params.payer,
        amountCents: priced.totalCents,
        currency: priced.currency,
        description: `Order at ${params.shop}`,
        merchant: { name: params.shop, url: `https://${params.shop}` },
        key: params.key,
      };
      let told = "";
      const deadline = Date.now() + 4 * 60_000;
      for (;;) {
        const now = await requestPayment(this.env, params.chat, ask);
        if (now.status === "ready") {
          paymentId = now.id;
          break;
        }
        if (now.status === "needs_connection") return { ...base, status: "needs_connection", total: priced.line };
        if (now.status === "failed") return { ...base, status: "failed", total: priced.line, detail: `the payment was ${now.why}` };
        if (told !== now.status) {
          told = now.status;
          await this.live.payNeedsAction(params.payer, now.status, now.url, priced.line, params.shop);
        }
        if (Date.now() > deadline) return { ...base, status: "not_approved", total: priced.line };
        await new Promise((r) => setTimeout(r, 4000));
      }
      if (paymentId.startsWith("dry-")) return { ...base, status: "dry_run", total: priced.line, shotId: await shoot() };

      await this.live.payProgress("paying", { shop: params.shop });
      const done = await payCheckout(page, await paymentCard(this.env, paymentId), params.shipTo.name, priced.totalCents);
      paymentId = undefined; // spent: nothing to cancel
      return { ...base, status: "paid", total: priced.line, confirmation: done.confirmation, shotId: await shoot() };
    } catch (err) {
      log("warn", "pay", "failed", errorFields(err));
      // The store may have taken the order even though the page never said so.
      const charged = paymentId ? await paymentSucceeded(this.env, params.chat, paymentId).catch(() => false) : false;
      if (charged) return { ...base, status: "paid", detail: "the store took the payment but never showed a confirmation. check your email for the receipt", shotId: await shoot() };
      // Pay was pressed and the outcome is unknown: leave the card open, since closing it could void a real order.
      const unsure = (err as { submitted?: boolean }).submitted === true;
      if (unsure) paymentId = undefined;
      return { ...base, status: "failed", unsure, detail: String((err as Error).message ?? err).slice(0, 200), shotId: await shoot() };
    } finally {
      if (paymentId) await cancelPayment(this.env, params.chat, paymentId);
      await session.close();
    }
  }

  private async checkAll(params: AvailabilityParams): Promise<AvailabilityResult[]> {
    const when = new Date(params.isoTime);
    const day = Number.isNaN(when.getTime())
      ? params.isoTime
      : when.toLocaleDateString("en-CA", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
    const around = Number.isNaN(when.getTime()) ? "" : ` around ${when.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "UTC" })}`;

    const failed = (check: AvailabilityParams["checks"][number]): AvailabilityResult => ({
      optionId: check.optionId,
      title: check.title,
      ok: false,
      slots: [],
      summary: "couldn't open the booking page",
    });

    let session: Awaited<ReturnType<typeof openBrowser>>;
    try {
      session = await openBrowser(this.env, { timeoutSeconds: 420 });
    } catch (err) {
      log("warn", "book", "availability.failed", { option: "(all)", ...errorFields(err) });
      return params.checks.map(failed);
    }
    try {
      return await pooled(params.checks, TABS, async (check) => {
        let page;
        try {
          page = await session.browser.newPage();
          const found = await runPilot(
            this.env,
            page,
            {
              mode: "availability",
              dryRun: true,
              startUrl: check.url,
              maxSteps: 12,
              task: `Find which start times are available at "${check.title}" for ${params.partySize} people on ${day}${around}. Today is ${new Date().toISOString().slice(0, 10)}.`,
            },
            (n, line) => this.live.bookingProgress("availability_step", { option: check.title.slice(0, 40), n, line: line.slice(0, 160) }),
          );
          return { optionId: check.optionId, title: check.title, ok: found.status === "found", slots: found.slots ?? [], summary: found.summary };
        } catch (err) {
          log("warn", "book", "availability.failed", { option: check.title, ...errorFields(err) });
          // Into the chat's own event log too: the console is gone by the time anyone asks why.
          await this.live.bookingProgress("availability_failed", { option: check.title.slice(0, 40), ...errorFields(err) }).catch(() => {});
          return failed(check);
        } finally {
          await page?.close().catch(() => {});
        }
      });
    } finally {
      await session.close();
    }
  }

  private async reserve(params: BookingParams, dryRun: boolean): Promise<BookingResult> {
    if (!params.url) return { ok: false, status: "no_link", detail: "there's no online booking link for this place" };

    let session;
    try {
      session = await openBrowser(this.env, { timeoutSeconds: 480 });
    } catch (err) {
      log("error", "book", "browser.failed", errorFields(err));
      return { ok: false, status: "error", detail: "couldn't start a browser to book with", handoffUrl: params.url };
    }

    const replayUrl = session.sessionId ? `https://browserbase.com/sessions/${session.sessionId}` : undefined;
    try {
      // Lets the group watch the browser being driven while it happens.
      await this.live.bookingProgress("browser", { provider: session.provider, liveUrl: session.liveUrl });

      const page = await session.browser.newPage();
      const when = new Date(params.isoTime);
      const whenText = Number.isNaN(when.getTime())
        ? params.isoTime
        : `${when.toLocaleDateString("en-CA", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })} at ${when.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "UTC" })}`;
      const [first, ...rest] = params.contact.name.trim().split(/\s+/);

      const result = await runPilot(
        this.env,
        page,
        {
          mode: "book",
          dryRun,
          startUrl: params.url,
          maxSteps: 24,
          task: `Book "${params.title}" for ${params.partySize} people on ${whenText}, or the closest available time that day. Contact details — first name: ${first}, last name: ${rest.join(" ") || first}, email: ${params.contact.email}${params.contact.phone ? `, phone: ${params.contact.phone}` : " (no phone number was provided)"}. Today is ${new Date().toISOString().slice(0, 10)}.`,
        },
        (n, line) => this.live.bookingProgress("step", { n, line: line.slice(0, 200) }),
      );

      // The last thing the pilot saw: proof of how far it got, whatever the outcome.
      const shotId = await page
        .screenshot({ type: "jpeg", quality: 60, encoding: "base64" })
        .then((b64) => this.live.saveShot(String(b64)))
        .catch(() => undefined);

      const detail: Record<PilotStatus, string> = {
        submitted: result.summary || "reservation confirmed",
        ready: `${result.summary} This was a dry run, so nothing is confirmed.`,
        needs_payment: result.summary,
        found: result.summary,
        gave_up: result.summary,
        step_limit: result.summary,
      };
      return {
        ok: result.status === "submitted",
        status: result.status,
        confirmation: result.confirmation,
        detail: detail[result.status],
        handoffUrl: params.url,
        replayUrl,
        shotId,
        steps: result.steps.length,
        tokens: result.tokens,
      };
    } catch (err) {
      log("error", "book", "pilot.failed", errorFields(err));
      return { ok: false, status: "error", detail: "the browser hit an error partway through", handoffUrl: params.url, replayUrl };
    } finally {
      await session.close();
    }
  }
}
