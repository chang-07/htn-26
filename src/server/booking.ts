import puppeteer from "@cloudflare/puppeteer";
import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import type { PlanAgent } from "./agent";

export type BookingParams = {
  title: string;
  url: string;
  partySize: number;
  isoTime: string;
};

export type BookingResult = { ok: boolean; confirmation?: string; detail?: string };

/**
 * A durable, retried booking run. Workflows fit because a reservation is a
 * multi-minute, multi-step job that must survive a restart and must not run
 * twice — each `step.do` result is persisted, so a retry resumes after the
 * last completed step instead of re-booking the table.
 */
export class BookingWorkflow extends AgentWorkflow<PlanAgent, BookingParams> {
  async run(event: AgentWorkflowEvent<BookingParams>, step: AgentWorkflowStep) {
    const params = event.payload;

    const result = await step.do(
      "reserve",
      { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" },
      () => this.reserve(params),
    );

    await step.do("report", () => this.agent.bookingFinished(result));
    return result;
  }

  private async reserve(params: BookingParams): Promise<BookingResult> {
    if (this.env.BOOKING_DRY_RUN !== "false") {
      return { ok: true, confirmation: "dry run — nothing was booked" };
    }
    if (!params.url) return { ok: false, detail: "this option has no booking link" };

    const browser = await puppeteer.launch(this.env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.goto(params.url, { waitUntil: "networkidle0" });

      // TODO(demo): hardcode the flow for the ONE site you will book on stage.
      // You know the restaurant and the time in advance, so fixed selectors are
      // faster and more reliable than having a model drive the page. Roughly:
      //
      //   await page.select('[data-test="party-size"]', String(params.partySize));
      //   await page.click(`[data-test="slot"][data-time="${hhmm}"]`);
      //   await page.click('[data-test="reserve"]');
      //   const code = await page.$eval('[data-test="confirmation"]', (el) => el.textContent);
      //
      // Until that is written, fail loudly rather than pretend to have booked.
      return { ok: false, detail: `booking flow for ${new URL(params.url).host} is not scripted yet` };
    } finally {
      await browser.close();
    }
  }
}
