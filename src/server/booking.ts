import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import type { PlanAgent } from "./agent";
import { openBrowser } from "./browser";
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
export class BookingWorkflow extends AgentWorkflow<PlanAgent, BookingParams | AvailabilityParams> {
  async run(event: AgentWorkflowEvent<BookingParams | AvailabilityParams>, step: AgentWorkflowStep) {
    if ("mode" in event.payload) {
      const checks = event.payload;
      // Sequential on purpose: the free Browserbase plan allows one browser at a time.
      const results = await step.do("availability", { retries: { limit: 0, delay: "1 second" }, timeout: "12 minutes" }, () =>
        this.checkAll(checks),
      );
      await step.do("report", () => this.agent.availabilityFinished(results));
      return results;
    }
    const params = event.payload;
    const dryRun = this.env.BOOKING_DRY_RUN !== "false";
    log("info", "book", "workflow.start", { title: params.title, dryRun });

    const result = await step.do("pilot", { retries: { limit: 0, delay: "1 second" }, timeout: "9 minutes" }, () =>
      this.reserve(params, dryRun),
    );

    log(result.ok ? "info" : "warn", "book", "workflow.result", { status: result.status, steps: result.steps, tokens: result.tokens });
    await step.do("report", () => this.agent.bookingFinished(result));
    return result;
  }

  private async checkAll(params: AvailabilityParams): Promise<AvailabilityResult[]> {
    const when = new Date(params.isoTime);
    const day = Number.isNaN(when.getTime())
      ? params.isoTime
      : when.toLocaleDateString("en-CA", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
    const around = Number.isNaN(when.getTime()) ? "" : ` around ${when.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "UTC" })}`;

    const results: AvailabilityResult[] = [];
    for (const check of params.checks) {
      let session;
      try {
        session = await openBrowser(this.env, { timeoutSeconds: 240 });
        const page = await session.browser.newPage();
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
          (n, line) => this.agent.bookingProgress("availability_step", { option: check.title.slice(0, 40), n, line: line.slice(0, 160) }),
        );
        results.push({ optionId: check.optionId, title: check.title, ok: found.status === "found", slots: found.slots ?? [], summary: found.summary });
      } catch (err) {
        log("warn", "book", "availability.failed", { option: check.title, ...errorFields(err) });
        results.push({ optionId: check.optionId, title: check.title, ok: false, slots: [], summary: "couldn't open the booking page" });
      } finally {
        await session?.close();
      }
    }
    return results;
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
      await this.agent.bookingProgress("browser", { provider: session.provider, liveUrl: session.liveUrl });

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
        (n, line) => this.agent.bookingProgress("step", { n, line: line.slice(0, 200) }),
      );

      // The last thing the pilot saw: proof of how far it got, whatever the outcome.
      const shotId = await page
        .screenshot({ type: "jpeg", quality: 60, encoding: "base64" })
        .then((b64) => this.agent.saveShot(String(b64)))
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
