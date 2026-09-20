import { useEffect, useState } from "react";
import TextLoop from "./motion/TextLoop";
import HalftoneReveal from "./motion/HalftoneReveal";
import TearTicket from "./motion/TearTicket";
import "./Landing.css";
import { MessagesDemo } from "./MessagesDemo";

const ART = "/images/rooftop-friends.png";
const MODES = ["Plan a weekend", "Play a game", "Make your own"] as const;
const PROMPTS = ["whim, plan a weekend in montréal for us", "make a who’s most likely to game for our group", "make us a game where we rank our hot takes"];

export function Landing() {
  const [mode, setMode] = useState(0);
  const [vote, setVote] = useState<string | null>(null);
  const [torn, setTorn] = useState(false);
  const [motion, setMotion] = useState(false);
  useEffect(() => {
    if (!torn) return;
    const timer = window.setTimeout(() => setTorn(false), 250);
    return () => window.clearTimeout(timer);
  }, [torn]);
  useEffect(() => {
    document.title = "Whim — AI for your group chat";
    document.documentElement.style.colorScheme = "light";
    document.documentElement.style.background = "#faf9f6";
    const query = window.matchMedia("(prefers-reduced-motion: reduce), (any-hover: none)");
    const update = () => setMotion(!query.matches);
    update(); query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return <div className="whim-page">
    <nav className="nav shell" aria-label="Main navigation">
      <a href="#" className="wordmark" aria-label="Whim home">whim<span>✳</span></a>
      <div className="nav-actions"><a className="dashboard-link" href="/dashboard">Dashboard</a><a className="button small" href="/dashboard">Try widgets</a></div>
    </nav>
    <main>
      <section className="hero shell">
        <div className="hero-copy">

          <h1>An AI agent for<br />your <span className="ideas">group chat<svg viewBox="0 0 300 20" aria-hidden="true"><path d="M4 12 Q135 -2 290 10 M30 18 Q170 4 270 17" /></svg></span><span className="coral">.</span></h1>
          <p>Plan trips, find tickets, and create games<br className="desktop-break" /> you can share with your friends.</p>

        </div>
        <div className="hero-scene">

          <div className="scene-art" role="img" aria-label="Five friends sharing pizza and playing cards on a rooftop at sunset">
            {motion ? <HalftoneReveal src={ART} mode="color" paperColor="#faf9f6" dotDensity={160} dotSize={0.75} idleReveal={0.4} contrast={1} revealRadius={0.26} edge={0.5} follow={0.08} borderRadius="0px" /> : <img src={ART} alt="" />}
          </div>
          <div className="chat-float"><span className="avatar">J</span><div><b>Jules</b><p>whim, help us plan friday night</p></div><span>♡</span></div>
          <div className="reply-float"><span>✳</span><div><b>Whim</b><p>Here are a few ideas.</p></div><span>✦</span></div>


        </div>
      </section>

      <div className="ribbon" aria-label="Plan something, play something, make something"><TextLoop viewBox="0 208 1200 104" text="Plan something ✦ Play something ✦ Make something" separator="✦" shape="wave" curviness={12} speed={motion ? 55 : 0} fontSize={30} fontWeight={800} ribbonColor="#84efc4" color="#153c30" ribbonWidth={48} /></div>
      <section id="widgets" className="widget-section">
        <div className="shell widget-showcase">
          <div className="widget-intro">
            <h2>Plan a trip.<br />Make a game.</h2>
            <p>Tell Whim what you want to do.<br />Share what it makes with your group.</p>
            <div className="widget-tabs" role="tablist" aria-label="Widget examples">
              {MODES.map((name, i) => <button key={name} role="tab" id={`widget-tab-${i}`} aria-controls="widget-demo" aria-selected={mode === i} onClick={() => { setMode(i); setVote(null); }}>{name}</button>)}
            </div>
            <p className="widget-example-caption">{["A shared itinerary, from arrival to the last coffee.", "A quick game everyone in the chat can join.", "Make a game around your group’s own questions."][mode]}</p>
          </div>
        <div className={`widget-demo mode-${mode}`} id="widget-demo" role="tabpanel" aria-labelledby={`widget-tab-${mode}`}><MessagesDemo prompt={PROMPTS[mode]}>
          {mode===0 ? <div className="itinerary"><h3>48 hours in Montréal<span>✳</span></h3><p>A weekend itinerary for your group.</p><div className="itinerary-row"><b>FRI</b><div><strong>Check in and explore Mile End</strong><small>Bagels, a walk, and dinner</small></div><span>🥯</span></div><div className="itinerary-row"><b>SAT</b><div><strong>Visit the market and Mount Royal</strong><small>Jean-Talon Market and Mount Royal sunset</small></div><span>☀</span></div><div className="itinerary-row"><b>SUN</b><div><strong>Coffee before heading home</strong><small>Breakfast near the station</small></div><span>☕</span></div></div> : <div className="game-card"><h3>{mode===1?"Who’s most likely to…":"What’s your take?"}</h3><p>{mode===1?"turn a quick coffee into an all-day adventure?":"Does pineapple belong on pizza?"}</p><div className="game-options">{(mode===1?["Jules","Sam","You","All of us"]:["Yes 🍍","Absolutely not","No preference"]).map(name=><button key={name} className={vote===name?"voted":""} onClick={()=>setVote(name)}>{name}<span>{vote===name?"✓":""}</span></button>)}</div><div className="card-bottom" aria-live="polite">{vote?`You picked ${vote}.`:"Choose an answer."}{vote&&<button onClick={()=>setVote(null)}>Reset</button>}</div></div>}
        </MessagesDemo></div></div>
      </section>
      <section className="ticket-section shell"><div className="ticket-copy"><h2>Who’s coming?</h2><p>Find a show, get the tickets, and share<br />the details with your group.</p></div><div className="ticket-display"><span className="ticket-spark" aria-hidden="true">✳</span><TearTicket image="/images/20240628_Ushuaia_Calvin_Harris_0049_6000x4000px_-scaled.jpg" imageAlt="Concert crowd and pyrotechnics beneath the Ushuaïa stage sign" width={500} height={290} stubSize={130} background="#ffb486" color="#322018" stubBackground="#ff83ab" rotate={-5} torn={torn} onTear={()=>setTorn(true)} tilt={motion} recenter={false} recoil={false} ariaLabel="Tear the demo Calvin Harris concert ticket stub" stub={<div className="ticket-stub"><b>FRI<br />25</b><span>General admission</span></div>}><div className="ticket-body"><h3>Calvin Harris</h3><p>Ushuaïa Ibiza · September 25</p></div></TearTicket></div></section>
      <section className="closing"><span>✳</span><h2>What would you make<br />for your group chat?</h2><a className="button cream" href="/dashboard#widgets">Explore the widgets</a></section>
    </main>
  </div>;
}
