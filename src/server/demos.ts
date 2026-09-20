import { PALETTE, TICKET_CSS, TICKET_FONTS } from "../theme";
import { searchTrack } from "./tools/music";

/**
 * /demo — the Linq showcase suite (music, flights, dating, tickets, payments,
 * health), each rebuilt as a page a card can open into. Same ticket language
 * as /w and /p: cream ground, ink, mono, perforations, and a finished state
 * that flips the whole page teal. Every page is self-contained HTML; the
 * only server data is the music page's preview list (iTunes, via the same
 * searchTrack the agent uses).
 */

const DEMO_CSS = `
.dm-back{display:inline-block;margin-bottom:14px;font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--soft);text-decoration:none;}
.dm-back:active{opacity:.5;}
a.tk-row{text-decoration:none;}
.dm-arrow{flex:none;color:var(--soft);}
/* Flat ink block variants of the action, side by side. */
.dm-actions{display:flex;gap:10px;margin-top:14px;}
.dm-actions .tk-action{margin-top:0;flex:1;}
.tk-action.is-ghost{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 2px var(--ink);}
.is-done .tk-action.is-ghost{color:var(--ink);box-shadow:inset 0 0 0 2px var(--ink);}
.dm-code{display:block;width:100%;max-width:300px;height:54px;color:var(--ink);}
.dm-codenum{margin-top:6px;font-size:11.5px;letter-spacing:.3em;color:var(--soft);}
@media (prefers-reduced-motion: reduce){ *{animation:none !important;transition:none !important;} }
`;

function page(title: string, body: string, css = "", js = ""): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light"><title>${title}</title>
<link rel="stylesheet" href="${TICKET_FONTS}">
<style>html,body{margin:0;background:${PALETTE.paper};}html.done,body.done{background:${PALETTE.teal};}${TICKET_CSS}${DEMO_CSS}${css}</style></head>
<body><div class="tk-page" id="page"><div class="tk-wrap">${body}</div></div>
<script>function flip(){document.getElementById("page").classList.add("is-done");document.documentElement.classList.add("done");document.body.classList.add("done");}
${js}</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}

const back = `<a class="dm-back" href="/demo">&larr; All apps</a>`;

/** Decorative code-128 look: deterministic stripes so the pass never changes between loads. */
function barcode(seed: number, num: string): string {
  let s = seed;
  const rects: string[] = [];
  let x = 0;
  while (x < 232) {
    s = (s * 48271) % 2147483647;
    const w = 1 + (s % 4);
    if (s % 7 !== 0) rects.push(`<rect x="${x}" y="0" width="${w}" height="54"/>`);
    x += w + 1 + (s % 3);
  }
  return `<svg class="dm-code" viewBox="0 0 232 54" preserveAspectRatio="none" fill="currentColor" aria-hidden="true">${rects.join("")}</svg>
<div class="dm-codenum">${num}</div>`;
}

// ---------------------------------------------------------------------------
// Launcher

const APPS: { path: string; mark: string; name: string; sub: string }[] = [
  { path: "music", mark: "◉", name: "Play music", sub: "Road Trip '26 — the chat's collab playlist" },
  { path: "flight", mark: "✈", name: "Book flights", sub: "Boarding pass, gate and seat in the bubble" },
  { path: "dating", mark: "♥", name: "Dating", sub: "Swipe the match pool, drop a match in the chat" },
  { path: "tickets", mark: "▣", name: "Buy tickets", sub: "Tonight's events, pick a seat, walk out paid" },
  { path: "pay", mark: "$", name: "Make payments", sub: "Settle up without leaving the thread" },
  { path: "health", mark: "✚", name: "Stay healthy", sub: "BodyBuddy logs the meal you just texted" },
];

function launcher(): Response {
  const rows = APPS.map(
    (a) => `<a class="tk-row" href="/demo/${a.path}"><span class="tk-mark">${a.mark}</span>
<span class="tk-grow"><span class="tk-name">${a.name}</span><span class="tk-sub">${a.sub}</span></span>
<span class="dm-arrow">&rarr;</span></a>`,
  ).join("");
  return page(
    "Plan — iMessage apps",
    `<div class="tk-meta">Plan · iMessage apps</div>
<h1 class="tk-title">The drawer</h1>
<hr class="tk-perf">
<div class="tk-rows">${rows}</div>
<hr class="tk-perf">
<p class="tk-small" style="margin:0">Each page is what a card opens into — sent by the agent, rendered inside the bubble.</p>`,
  );
}

// ---------------------------------------------------------------------------
// Music — real 30s previews via the agent's own iTunes lookup.

const PLAYLIST: { title: string; artist: string; by: string }[] = [
  { title: "Passionfruit", artist: "Drake", by: "Luka" },
  { title: "Kilby Girl", artist: "The Backseat Lovers", by: "Maya" },
  { title: "Pink + White", artist: "Frank Ocean", by: "Jules" },
  { title: "Redbone", artist: "Childish Gambino", by: "Sam" },
  { title: "Myth", artist: "Beach House", by: "Maya" },
  { title: "Sofia", artist: "Clairo", by: "Luka" },
];

let tracksCache: Promise<unknown[]> | null = null;
function playlistTracks(): Promise<unknown[]> {
  tracksCache ??= Promise.all(
    PLAYLIST.map(async (t) => {
      try {
        const hit = await searchTrack(t.title, t.artist);
        // A karaoke cover is worse than no preview: keep the hit only when the
        // artist actually matches what the chat added.
        const ok = hit && hit.artist.toLowerCase().includes(t.artist.toLowerCase().split(" ")[0]);
        return { ...(ok ? hit : { title: t.title, artist: t.artist }), by: t.by };
      } catch {
        return { title: t.title, artist: t.artist, by: t.by };
      }
    }),
  );
  return tracksCache;
}

function music(): Response {
  const css = `
.dm-disc{width:min(210px,58vw);aspect-ratio:1;border-radius:50%;background:var(--ink);margin:24px auto 0;position:relative;animation:dm-spin 3.6s linear infinite;animation-play-state:paused;}
.dm-disc.is-on{animation-play-state:running;}
.dm-disc::before{content:"";position:absolute;inset:9%;border-radius:50%;border:2px dotted rgba(239,231,214,.38);}
.dm-disc::after{content:"";position:absolute;inset:39%;border-radius:50%;background:var(--ground);}
@keyframes dm-spin{to{transform:rotate(360deg);}}
.dm-ctl{display:flex;gap:10px;align-items:stretch;margin-top:14px;}
.dm-ctl .tk-action{margin-top:0;}
.dm-ctl .tk-action.dm-side{flex:none;width:64px;background:transparent;color:var(--ink);box-shadow:inset 0 0 0 2px var(--ink);}
.dm-ctl .tk-action.dm-main{flex:1;}
.dm-now{margin-top:12px;font-size:12.5px;color:var(--soft);min-height:19px;}`;
  const js = `
var tracks=[],cur=-1,au=new Audio(),disc=document.getElementById("disc"),
    rows=document.getElementById("rows"),now=document.getElementById("now"),
    play=document.getElementById("play");
au.preload="none";
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return "&#"+c.charCodeAt(0)+";";});}
function render(){
  rows.innerHTML="";
  tracks.forEach(function(t,i){
    var b=document.createElement("button");
    b.className="tk-row"+(i===cur?" is-mine":"");
    b.innerHTML='<span class="tk-num">'+String(i+1).padStart(2,"0")+'</span>'+
      '<span class="tk-grow"><span class="tk-name">'+esc(t.title)+'</span>'+
      '<span class="tk-sub">'+esc(t.artist)+" — added by "+esc(t.by)+'</span></span>'+
      '<span class="tk-num">0:30</span>';
    b.onclick=function(){start(i);};
    rows.appendChild(b);
  });
}
function start(i){
  cur=i;var t=tracks[i];render();
  if(t.previewUrl){au.src=t.previewUrl;au.play();}
  else{now.textContent="No preview for this one — skipping";setTimeout(next,700);return;}
  now.textContent="Now playing — "+t.title;
  disc.classList.add("is-on");play.textContent="Pause";
}
function toggle(){
  if(cur<0){start(0);return;}
  if(au.paused){au.play();disc.classList.add("is-on");play.textContent="Pause";}
  else{au.pause();disc.classList.remove("is-on");play.textContent="Play";}
}
function next(){start((cur+1)%tracks.length);}
function prev(){start((cur-1+tracks.length)%tracks.length);}
au.onended=next;
play.onclick=toggle;
document.getElementById("nx").onclick=next;
document.getElementById("pv").onclick=prev;
fetch("/demo/music/tracks").then(function(r){return r.json();}).then(function(ts){
  tracks=ts;render();now.textContent="Six previews queued — press play";
}).catch(function(){now.textContent="Couldn't reach iTunes for previews";});`;
  return page(
    "Road Trip '26",
    `${back}
<div class="tk-meta">Collab playlist · 4 riders</div>
<h1 class="tk-title">Road Trip '26</h1>
<div class="dm-disc" id="disc" aria-hidden="true"></div>
<hr class="tk-perf">
<div class="tk-rows" id="rows"></div>
<div class="dm-ctl">
  <button class="tk-action dm-side" id="pv" aria-label="Previous">&#171;</button>
  <button class="tk-action dm-main" id="play">Play</button>
  <button class="tk-action dm-side" id="nx" aria-label="Next">&#187;</button>
</div>
<div class="dm-now" id="now">Fetching previews&hellip;</div>`,
    css,
    js,
  );
}

// ---------------------------------------------------------------------------
// Flight — a boarding pass that is already a ticket.

function flight(): Response {
  const rows: [string, string][] = [
    ["Passenger", "Luka Lavric"],
    ["Date", "Fri, Sep 19 2026"],
    ["Boarding", "2:50 PM · Group 6"],
    ["Departs", "4:17 PM · Gate 37, Terminal B"],
    ["Arrives", "7:11 PM · Terminal D"],
  ];
  const list = rows
    .map(
      ([k, v]) => `<div class="tk-row"><span class="tk-grow"><span class="tk-sub">${k}</span><span class="tk-name">${v}</span></span></div>`,
    )
    .join("");
  const js = `
document.getElementById("share").onclick=function(){
  flip();
  this.textContent="Sent to the chat";this.disabled=true;
  document.getElementById("meta").textContent="AC 8837 · Shared · On time";
};`;
  return page(
    "YYZ → SFO",
    `${back}
<div class="tk-meta" id="meta">Boarding pass · AC 8837 · On time</div>
<div class="tk-head">
  <div><h1 class="tk-title">YYZ &rarr; SFO</h1>
  <p class="tk-small" style="margin:8px 0 0">Toronto Pearson to San Francisco</p></div>
  <div class="tk-stub"><b>10C</b><span class="tk-meta">Seat</span></div>
</div>
<hr class="tk-perf">
<div class="tk-rows">${list}</div>
<hr class="tk-perf">
${barcode(8837, "0087 4471 9920 3315")}
<button class="tk-action" id="share">Share flight</button>`,
    "",
    js,
  );
}

// ---------------------------------------------------------------------------
// Dating — swipe the match pool; a like flips the page green.

const PROFILES = [
  { name: "Maya", age: 21, km: 2, school: "Waterloo SE '27", into: "Film cameras, bouldering, late ramen", line: "Will judge your road-trip playlist." },
  { name: "Jules", age: 22, km: 5, school: "OCAD illustration", into: "Vinyl digging, figure drawing", line: "Looking for a museum-date rival." },
  { name: "Sam", age: 21, km: 1, school: "UofT EngSci", into: "Pickup ball, espresso, chess", line: "Ask about the halftime buzzer-beater." },
  { name: "Noor", age: 20, km: 8, school: "McMaster health sci", into: "Trail runs, crosswords, dumplings", line: "Sunday hikes are non-negotiable." },
  { name: "Alex", age: 23, km: 3, school: "Indie game dev", into: "Synths, night drives, arcades", line: "Beat my Galaga score and I'll cook." },
  { name: "Rio", age: 22, km: 4, school: "TMU media", into: "Concert photos, thrift maps", line: "Knows every venue's back door." },
];

function dating(): Response {
  const css = `
.dm-deck{position:relative;height:340px;margin-top:18px;}
.dm-card{position:absolute;inset:0;background:var(--ground);border:2px solid var(--ink);padding:18px;touch-action:none;user-select:none;-webkit-user-select:none;}
.dm-card .tk-title{font-size:clamp(24px,7vw,32px);}
.dm-stamp{position:absolute;top:16px;font-family:"Archivo",system-ui,sans-serif;font-weight:800;font-size:30px;letter-spacing:.06em;padding:4px 12px;border:3px solid var(--ink);transform:rotate(-14deg);opacity:0;}
.dm-stamp.like{right:14px;}
.dm-stamp.pass{left:14px;transform:rotate(14deg);}
.dm-count{margin-top:12px;font-size:12.5px;color:var(--soft);}
#match{display:none;}`;
  const js = `
var profiles=${JSON.stringify(PROFILES)},idx=0,
    deck=document.getElementById("deck"),count=document.getElementById("count");
function card(p){
  var d=document.createElement("div");d.className="dm-card";
  d.innerHTML='<div class="tk-meta">'+p.km+' km away · Match pool</div>'+
    '<h1 class="tk-title">'+p.name+", "+p.age+'</h1>'+
    '<hr class="tk-perf">'+
    '<div class="tk-row"><span class="tk-grow"><span class="tk-sub">School</span><span class="tk-name">'+p.school+'</span></span></div>'+
    '<div class="tk-row"><span class="tk-grow"><span class="tk-sub">Into</span><span class="tk-name">'+p.into+'</span></span></div>'+
    '<p class="tk-small" style="margin:10px 0 0">&ldquo;'+p.line+'&rdquo;</p>'+
    '<span class="dm-stamp like">LIKE</span><span class="dm-stamp pass">PASS</span>';
  return d;
}
function show(){
  deck.innerHTML="";
  if(idx>=profiles.length){count.textContent="That's everyone nearby.";return;}
  if(idx+1<profiles.length){var under=card(profiles[idx+1]);under.style.transform="scale(.96) translateY(8px)";deck.appendChild(under);}
  var top=card(profiles[idx]);deck.appendChild(top);drag(top);
  count.textContent=(profiles.length-idx)+" left in the pool";
}
function decide(liked){
  if(liked){
    var p=profiles[idx];
    document.getElementById("mname").textContent="You and "+p.name+" both said yes.";
    document.getElementById("pool").style.display="none";
    document.getElementById("match").style.display="block";
    flip();return;
  }
  idx++;show();
}
function drag(el){
  var x0=0,dx=0,down=false,
      like=el.querySelector(".dm-stamp.like"),pass=el.querySelector(".dm-stamp.pass");
  el.addEventListener("pointerdown",function(e){down=true;x0=e.clientX;el.setPointerCapture(e.pointerId);});
  el.addEventListener("pointermove",function(e){
    if(!down)return;dx=e.clientX-x0;
    el.style.transform="translateX("+dx+"px) rotate("+(dx/18)+"deg)";
    like.style.opacity=dx>0?Math.min(1,dx/80):0;
    pass.style.opacity=dx<0?Math.min(1,-dx/80):0;
  });
  el.addEventListener("pointerup",function(){
    down=false;
    if(Math.abs(dx)>80){
      var liked=dx>0;
      el.style.transition="transform .18s ease-in";
      el.style.transform="translateX("+(dx>0?500:-500)+"px) rotate("+(dx/8)+"deg)";
      setTimeout(function(){decide(liked);},170);
    } else { el.style.transform="";like.style.opacity=0;pass.style.opacity=0; }
    dx=0;
  });
}
document.getElementById("btn-pass").onclick=function(){decide(false);};
document.getElementById("btn-like").onclick=function(){decide(true);};
show();`;
  return page(
    "Match pool",
    `${back}
<div id="pool">
<div class="tk-meta">Match pool · ${PROFILES.length} nearby</div>
<h1 class="tk-title">Who's around</h1>
<div class="dm-deck" id="deck"></div>
<div class="dm-actions">
  <button class="tk-action is-ghost" id="btn-pass">Pass</button>
  <button class="tk-action" id="btn-like">Like</button>
</div>
<div class="dm-count" id="count"></div>
</div>
<div id="match">
<div class="tk-meta">Match pool</div>
<h1 class="tk-title">It's a match</h1>
<hr class="tk-perf">
<p style="margin:0" id="mname"></p>
<button class="tk-action" onclick="this.textContent='Dropped — check the chat';this.disabled=true">Drop it in the chat</button>
</div>`,
    css,
    js,
  );
}

// ---------------------------------------------------------------------------
// Tickets — list, seat grid, green PAID stub. One page, three states.

const EVENTS = [
  { name: "Raptors vs Celtics", venue: "Scotiabank Arena", time: "7:30 PM", price: 86 },
  { name: "Daniel Caesar", venue: "History", time: "8:00 PM", price: 74 },
  { name: "Leafs vs Habs", venue: "Scotiabank Arena", time: "7:00 PM", price: 112 },
  { name: "Warehouse afterparty", venue: "RBC Place", time: "10:00 PM", price: 15 },
];

function tickets(): Response {
  const css = `
.dm-grid{display:grid;grid-template-columns:repeat(10,1fr);gap:6px;margin-top:16px;}
.dm-seat{aspect-ratio:1;border:1.5px solid var(--ink);background:transparent;padding:0;cursor:pointer;}
.dm-seat.taken{border-color:transparent;background:var(--rule);cursor:default;}
.dm-seat.mine{background:var(--ink);}
.dm-stage{margin-top:14px;border-top:2px solid var(--ink);padding-top:6px;text-align:center;}
#pick,#paid{display:none;}`;
  const js = `
var events=${JSON.stringify(EVENTS)},ev=null,seat=null;
var list=document.getElementById("list"),grid=document.getElementById("grid"),
    buy=document.getElementById("buy");
events.forEach(function(e,i){
  var b=document.createElement("button");b.className="tk-row";
  b.innerHTML='<span class="tk-grow"><span class="tk-name">'+e.name+'</span>'+
    '<span class="tk-sub">'+e.venue+" · tonight "+e.time+'</span></span>'+
    '<span class="tk-num">$'+e.price+'</span>';
  b.onclick=function(){open(i);};
  list.appendChild(b);
});
function open(i){
  ev=events[i];seat=null;
  document.getElementById("home").style.display="none";
  document.getElementById("pick").style.display="block";
  document.getElementById("pev").textContent=ev.name+" · "+ev.venue;
  buy.textContent="Buy — $"+ev.price;buy.disabled=true;
  grid.innerHTML="";
  for(var s=0;s<60;s++){
    (function(s){
      var t=(s*7+3)%11<4;
      var b=document.createElement("button");
      b.className="dm-seat"+(t?" taken":"");
      b.setAttribute("aria-label","Row "+(Math.floor(s/10)+1)+" seat "+(s%10+1));
      if(!t)b.onclick=function(){
        var old=grid.querySelector(".mine");if(old)old.classList.remove("mine");
        b.classList.add("mine");seat=s;buy.disabled=false;
      };
      grid.appendChild(b);
    })(s);
  }
}
buy.onclick=function(){
  document.getElementById("pick").style.display="none";
  document.getElementById("paid").style.display="block";
  document.getElementById("tname").textContent=ev.name;
  document.getElementById("trows").innerHTML=
    '<div class="tk-row"><span class="tk-grow"><span class="tk-sub">Venue</span><span class="tk-name">'+ev.venue+'</span></span></div>'+
    '<div class="tk-row"><span class="tk-grow"><span class="tk-sub">Tonight</span><span class="tk-name">'+ev.time+", doors one hour before"+'</span></span></div>'+
    '<div class="tk-row"><span class="tk-grow"><span class="tk-sub">Paid</span><span class="tk-name">$'+ev.price+" · Visa &middot;&middot;&middot;&middot; 4417"+'</span></span></div>';
  document.getElementById("tseat").textContent="R"+(Math.floor(seat/10)+1)+"-"+(seat%10+1);
  flip();
};`;
  return page(
    "Box office",
    `${back}
<div id="home">
<div class="tk-meta">Box office · Tonight</div>
<h1 class="tk-title">Near you</h1>
<hr class="tk-perf">
<div class="tk-rows" id="list"></div>
</div>
<div id="pick">
<div class="tk-meta" id="pev"></div>
<h1 class="tk-title">Pick a seat</h1>
<div class="dm-grid" id="grid"></div>
<div class="dm-stage tk-meta">Stage</div>
<button class="tk-action" id="buy" disabled>Buy</button>
</div>
<div id="paid">
<div class="tk-meta">Paid · Ticket 1 of 1</div>
<div class="tk-head">
  <div><h1 class="tk-title" id="tname"></h1></div>
  <div class="tk-stub"><b id="tseat"></b><span class="tk-meta">Seat</span></div>
</div>
<hr class="tk-perf">
<div class="tk-rows" id="trows"></div>
<hr class="tk-perf">
${barcode(4417, "TKT 2093 8841 0026")}
<button class="tk-action is-ghost" onclick="this.textContent='Held up to the scanner — beep'">Show at the door</button>
</div>`,
    css,
    js,
  );
}

// ---------------------------------------------------------------------------
// Pay — keypad, big amount, green receipt.

function pay(): Response {
  const css = `
.dm-amt{font-family:"Archivo",system-ui,sans-serif;font-weight:800;font-size:clamp(44px,16vw,72px);line-height:1;letter-spacing:-.02em;margin:14px 0 0;font-variant-numeric:tabular-nums;}
.dm-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:18px;}
.dm-key{padding:13px 0;background:transparent;border:1.5px solid var(--rule);color:inherit;font:inherit;font-size:19px;cursor:pointer;}
.dm-key:active{background:var(--ink);color:var(--ground);}
#done{display:none;}`;
  const js = `
var cents=0,amt=document.getElementById("amt"),payb=document.getElementById("payb");
function draw(){
  var s="$"+(cents/100).toFixed(2);
  amt.textContent=s;payb.textContent="Pay "+s;payb.disabled=cents===0;
}
document.querySelectorAll(".dm-key").forEach(function(k){
  k.onclick=function(){
    var v=k.textContent;
    if(v==="⌫")cents=Math.floor(cents/10);
    else if(cents<100000)cents=cents*10+Number(v);
    draw();
  };
});
payb.onclick=function(){
  document.getElementById("form").style.display="none";
  document.getElementById("done").style.display="block";
  document.getElementById("damt").textContent=amt.textContent+" sent";
  flip();
};
draw();`;
  return page(
    "Settle up",
    `${back}
<div id="form">
<div class="tk-meta">Settle up · to Nikki</div>
<div class="dm-amt" id="amt">$0.00</div>
<p class="tk-small" style="margin:8px 0 0">Road trip gas · split 4 ways</p>
<div class="dm-pad">
<button class="dm-key">1</button><button class="dm-key">2</button><button class="dm-key">3</button>
<button class="dm-key">4</button><button class="dm-key">5</button><button class="dm-key">6</button>
<button class="dm-key">7</button><button class="dm-key">8</button><button class="dm-key">9</button>
<button class="dm-key" style="visibility:hidden">·</button><button class="dm-key">0</button><button class="dm-key">⌫</button>
</div>
<button class="tk-action" id="payb" disabled>Pay</button>
</div>
<div id="done">
<div class="tk-meta">Paid · just now</div>
<h1 class="tk-title" id="damt"></h1>
<hr class="tk-perf">
<div class="tk-rows">
<div class="tk-row"><span class="tk-grow"><span class="tk-sub">To</span><span class="tk-name">Nikki H · road trip gas</span></span></div>
<div class="tk-row"><span class="tk-grow"><span class="tk-sub">From</span><span class="tk-name">Plan Cash balance</span></span></div>
</div>
<button class="tk-action is-ghost" onclick="location.href='/demo'">Back to the drawer</button>
</div>`,
    css,
    js,
  );
}

// ---------------------------------------------------------------------------
// Health — BodyBuddy's read of the meal you just texted.

function health(): Response {
  const css = `
.dm-bar{position:relative;height:10px;border:1.5px solid var(--ink);margin-top:5px;}
.dm-bar i{position:absolute;inset:0;background:var(--ink);transform-origin:left;}
.dm-streak{display:flex;gap:6px;margin-top:10px;}
.dm-day{width:15px;height:15px;border:1.5px solid var(--ink);}
.dm-day.hit{background:var(--ink);}`;
  const macro = (label: string, grams: number, target: number) =>
    `<div class="tk-row" style="display:block">
<span class="tk-sub">${label} · ${grams}g of ${target}g</span>
<div class="dm-bar"><i style="transform:scaleX(${Math.min(1, grams / target)})"></i></div>
</div>`;
  const habits: [string, string][] = [
    ["●", "Morning walk — 22 min, done"],
    ["◐", "Water — 2 of 3 bottles"],
    ["○", "Stretch — not yet"],
  ];
  const habitRows = habits
    .map(([m, t]) => `<div class="tk-row"><span class="tk-mark">${m}</span><span class="tk-grow">${t}</span></div>`)
    .join("");
  const streak = Array.from({ length: 14 }, (_, i) => `<span class="dm-day${i < 12 ? " hit" : ""}"></span>`).join("");
  return page(
    "BodyBuddy",
    `${back}
<div class="tk-meta">BodyBuddy · Day 12 streak</div>
<div class="tk-head">
  <div><h1 class="tk-title">Breakfast logged</h1>
  <p class="tk-small" style="margin:8px 0 0">&ldquo;Hey, had my usual protein smoothie&rdquo; · 8:21 AM</p></div>
  <div class="tk-stub"><b>350</b><span class="tk-meta">cal</span></div>
</div>
<hr class="tk-perf">
${macro("Protein", 25, 40)}${macro("Carbs", 35, 60)}${macro("Fat", 9, 20)}
<hr class="tk-perf">
<div class="tk-rows">${habitRows}</div>
<hr class="tk-perf">
<div class="tk-meta">Last 14 days</div>
<div class="dm-streak">${streak}</div>
<button class="tk-action" onclick="this.textContent='Noted — text me your lunch';this.disabled=true">Log lunch</button>`,
    css,
  );
}

// ---------------------------------------------------------------------------

export async function handleDemo(url: URL): Promise<Response> {
  const app = url.pathname.replace(/^\/demo\/?/, "").replace(/\/$/, "");
  switch (app) {
    case "":
      return launcher();
    case "music":
      return music();
    case "music/tracks":
      return Response.json(await playlistTracks(), { headers: { "cache-control": "no-store" } });
    case "flight":
      return flight();
    case "dating":
      return dating();
    case "tickets":
      return tickets();
    case "pay":
      return pay();
    case "health":
      return health();
    default:
      return new Response("Not found", { status: 404 });
  }
}
