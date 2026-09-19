import { useEffect, useState } from "react";
import { PALETTE, TICKET_CSS, TICKET_FONTS } from "../theme";

/**
 * The front page: what a judge sees when they open the Worker's URL. The
 * planner has no app — it lives in the group chat — so the page shows the one
 * object it does have, the ticket, and lets it play the story once: options
 * print, tapbacks land, the ground flips green when it is booked.
 *
 * Everything else on the page is a sequence or a list the ticket's own rows can
 * carry. One link, to the run viewer, is the only thing that looks pressable.
 */

const OPTIONS = ["Death Valley's Little Brother", "Graffiti Market", "Beertown Public House"];
const EMOJI = ["❤️", "👍", "😂"];

/** The script: what the ticket shows at each moment after the page opens. */
type Frame = { rows: number; votes: [number, number, number]; booked: boolean };
const SCRIPT: [number, Frame][] = [
  [0, { rows: 0, votes: [0, 0, 0], booked: false }],
  [500, { rows: 1, votes: [0, 0, 0], booked: false }],
  [800, { rows: 2, votes: [0, 0, 0], booked: false }],
  [1100, { rows: 3, votes: [0, 0, 0], booked: false }],
  [1900, { rows: 3, votes: [1, 0, 0], booked: false }],
  [2400, { rows: 3, votes: [1, 1, 0], booked: false }],
  [2950, { rows: 3, votes: [2, 1, 0], booked: false }],
  [4000, { rows: 3, votes: [2, 1, 0], booked: true }],
];
const STILL: Frame = { rows: 3, votes: [2, 1, 0], booked: false };

function useScript(play: number) {
  const [frame, setFrame] = useState<Frame>(STILL);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setFrame(STILL);
      return;
    }
    const timers = SCRIPT.map(([at, f]) => window.setTimeout(() => setFrame(f), at));
    return () => timers.forEach(clearTimeout);
  }, [play]);
  return frame;
}

export function Landing() {
  const [play, setPlay] = useState(0);
  const frame = useScript(play);
  const votes = frame.votes.reduce((a, b) => a + b, 0);

  useEffect(() => {
    document.title = "Plan";
    document.documentElement.style.colorScheme = "light";
    document.body.style.background = PALETTE.paper;
  }, []);

  return (
    <div className="tk-page ld">
      <link rel="stylesheet" href={TICKET_FONTS} />
      <style>{TICKET_CSS}</style>
      <style>{LANDING_CSS}</style>

      <main className="ld-wrap">
        <header>
          <p className="tk-meta">Plan, an agent in your iMessage group chat</p>
          <h1 className="ld-title">The group chat books the table.</h1>
          <p className="tk-lede">
            Add one number to the thread. It reads along, finds real places, posts a ticket to vote on, counts the tapbacks, books the winner and builds the carts for whatever else the night needs.
          </p>
        </header>

        {/* The ticket. Its ground is its state: cream until booked, green after. */}
        <figure className={`ld-tk${frame.booked ? " is-ok" : ""}`} aria-label="A plan ticket, as it appears in the group chat: three options to vote on, then booked.">
          <div className="ld-tk-in">
            <div className="ld-tk-main">
              <div className="ld-tk-top">
                <span>{frame.booked ? "Confirmed" : "React to vote"}</span>
                <span>{frame.booked ? "See you there" : "3 options"}</span>
              </div>
              <div className="ld-tk-ttl">{frame.booked ? OPTIONS[0] : "Friday dinner"}</div>
              <div className="ld-tk-fill" />
              <div className="ld-tk-rows">
                {frame.booked ? (
                  <>
                    <div className="ld-tk-row"><s>Fri Sept 25, 8:00 PM</s></div>
                    <div className="ld-tk-row"><s>Table for 6, conf #R7K2</s></div>
                  </>
                ) : (
                  OPTIONS.map((o, i) => (
                    <div key={o} className={`ld-tk-row${i < frame.rows ? " is-in" : ""}`} aria-hidden={i >= frame.rows}>
                      <i>{EMOJI[i]}</i>
                      <s>{o}</s>
                      <u>{frame.votes[i] ? `x${frame.votes[i]}` : ""}</u>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="ld-tk-perf" />
            <div className="ld-tk-stub">
              <b>{frame.booked ? "GO" : votes}</b>
              <span>{frame.booked ? "Booked" : votes === 1 ? "Vote" : "Votes"}</span>
            </div>
          </div>
          <figcaption className="tk-small">
            The card in the thread is this ticket, drawn as a photo. ❤️ 👍 😂 on it are the ballot.{" "}
            <button className="ld-again" onClick={() => setPlay((p) => p + 1)}>Play it again</button>
          </figcaption>
        </figure>

        <hr className="tk-perf" />

        <section>
          <h2 className="ld-h2">How a night goes</h2>
          <ol className="ld-steps">
            <li><span><b>Someone texts the group.</b> “dinner friday? ramen downtown”. It wakes only when it is addressed, so the chatter costs nothing.</span></li>
            <li><span><b>It asks where you are, once,</b> then researches in a real browser. Every place it proposes came off a page it read.</span></li>
            <li><span><b>A ticket lands in the thread.</b> Tapbacks are votes. The card redraws in place as the tally moves.</span></li>
            <li><span><b>It checks the venue's own booking page</b> for real times, and books the winner with your name and email, never invented ones.</span></li>
            <li><span><b>Cake, balloons, a card game:</b> carts at real stores, sized to the headcount. One 👍 on a cart means that person covers it.</span></li>
          </ol>
        </section>

        <hr className="tk-perf" />

        <section>
          <h2 className="ld-h2">What it runs on</h2>
          <ul className="tk-rows ld-stack">
            <li className="tk-row"><span className="tk-grow">Cloudflare Workers</span><span className="tk-num">webhooks, cards, these pages</span></li>
            <li className="tk-row"><span className="tk-grow">Durable Objects</span><span className="tk-num">one agent per chat, with memory</span></li>
            <li className="tk-row"><span className="tk-grow">Workflows</span><span className="tk-num">research and booking, never twice</span></li>
            <li className="tk-row"><span className="tk-grow">Browser Rendering, Browserbase</span><span className="tk-num">the browser it drives</span></li>
            <li className="tk-row"><span className="tk-grow">Vectorize, Workers AI</span><span className="tk-num">who you should meet</span></li>
            <li className="tk-row"><span className="tk-grow">D1</span><span className="tk-num">every run, step by step</span></li>
            <li className="tk-row"><span className="tk-grow">Linq</span><span className="tk-num">the iMessage number</span></li>
            <li className="tk-row"><span className="tk-grow">Shopify UCP</span><span className="tk-num">carts at any store, no key</span></li>
          </ul>
        </section>

        <a className="tk-action" href="/runs">Watch it work, turn by turn</a>
        <p className="tk-small ld-foot">
          Built at Hack the North 2026. The pages behind each card — voting, your profile, where to ship — open from the chat and only from the chat.
        </p>
      </main>
    </div>
  );
}

const LANDING_CSS = `
.ld{ padding:44px 22px 80px; }
.ld-wrap{ max-width:600px; margin:0 auto; }
.ld-title{ font-family:"Archivo",system-ui,sans-serif; font-weight:800; font-size:clamp(40px, 9vw, 60px); line-height:.98; letter-spacing:-.03em; margin:12px 0 0; text-wrap:balance; }
.ld-h2{ font-family:"Archivo",system-ui,sans-serif; font-weight:800; font-size:24px; line-height:1.05; letter-spacing:-.02em; margin:0 0 16px; }
.ld .tk-lede{ font-size:15.5px; }

/* A numbered sequence, because it is one. The numeral is the row's lead. */
.ld-steps{ margin:0; padding:0; list-style:none; counter-reset:step; display:flex; flex-direction:column; gap:14px; }
.ld-steps li{ counter-increment:step; display:grid; grid-template-columns:28px 1fr; gap:10px; font-size:14.5px; line-height:1.5; }
.ld-steps li::before{ content:counter(step); font-family:"Archivo",system-ui,sans-serif; font-weight:800; font-size:20px; line-height:1.1; }
.ld-steps b{ font-weight:500; }
.ld-stack .tk-row{ font-size:15px; padding:7px 0; }
.ld-stack .tk-num{ font-size:12.5px; text-align:right; }
@media (max-width:520px){ .ld-stack .tk-row{ flex-wrap:wrap; row-gap:0; } .ld-stack .tk-grow{ flex-basis:100%; } .ld-stack .tk-num{ text-align:left; } }
.ld .tk-action{ margin-top:32px; }
.ld-foot{ margin:18px 0 0; max-width:44em; }
.ld-again{ margin:0; padding:0; background:none; border:0; color:inherit; font:inherit; text-decoration:underline; text-underline-offset:3px; cursor:pointer; }

/* ---- the ticket: 360x240 design, scaled by its own width ---- */
.ld-tk{ --u:calc(100cqw / 360); container-type:inline-size; width:100%; max-width:520px; margin:36px 0 0; }
.ld-tk-in{ aspect-ratio:3/2; position:relative; display:flex; overflow:hidden; background:${PALETTE.paper}; color:${PALETTE.ink};
  font-family:"IBM Plex Mono",ui-monospace,monospace; font-weight:500;
  box-shadow:0 0 0 1.5px rgba(36,31,23,.34); transition:background-color .55s ease, color .55s ease, box-shadow .55s ease; }
.ld-tk.is-ok .ld-tk-in{ background:${PALETTE.green}; color:${PALETTE.greenInk}; box-shadow:0 0 0 1.5px ${PALETTE.green}; }
.ld-tk-main{ flex:1; min-width:0; display:flex; flex-direction:column; padding:calc(15 * var(--u)) calc(12 * var(--u)) calc(16 * var(--u)) calc(16 * var(--u)); }
.ld-tk-top{ display:flex; justify-content:space-between; gap:calc(8 * var(--u)); font-size:calc(9.3 * var(--u)); letter-spacing:.13em; text-transform:uppercase; opacity:.62; white-space:nowrap; }
.ld-tk-ttl{ font-family:"Archivo",system-ui,sans-serif; font-weight:800; font-size:calc(23 * var(--u)); line-height:1; letter-spacing:-.02em; margin-top:calc(5 * var(--u)); }
.ld-tk-fill{ flex:1; }
.ld-tk-rows{ display:flex; flex-direction:column; gap:calc(4 * var(--u)); }
.ld-tk-row{ display:flex; align-items:baseline; gap:calc(7 * var(--u)); font-size:calc(11.2 * var(--u)); white-space:nowrap; opacity:1; }
.ld-tk-row i{ font-style:normal; width:calc(16 * var(--u)); flex:none; text-align:center; }
.ld-tk-row s{ text-decoration:none; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
.ld-tk-row u{ text-decoration:none; opacity:.62; flex:none; min-width:calc(14 * var(--u)); text-align:right; }
.ld-tk:not(.is-ok) .ld-tk-row:not(.is-in){ opacity:0; }
.ld-tk-perf{ width:calc(2 * var(--u)); flex:none; opacity:.32;
  background-image:radial-gradient(circle,currentColor calc(1.1 * var(--u)),transparent calc(1.2 * var(--u)));
  background-size:calc(2 * var(--u)) calc(9 * var(--u)); }
.ld-tk-stub{ width:calc(58 * var(--u)); flex:none; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:calc(5 * var(--u)); text-align:center; }
.ld-tk-stub b{ font-family:"Archivo",system-ui,sans-serif; font-weight:800; font-size:calc(20 * var(--u)); line-height:1; font-variant-numeric:tabular-nums; }
.ld-tk-stub span{ font-size:calc(8.3 * var(--u)); letter-spacing:.1em; text-transform:uppercase; opacity:.6; line-height:1.25; }
.ld-tk figcaption{ margin-top:12px; max-width:44em; }
@media (prefers-reduced-motion: reduce){ .ld-tk-in{ transition:none; } .ld-again{ display:none; } }
`;
