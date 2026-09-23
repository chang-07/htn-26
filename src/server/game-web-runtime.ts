/** Injected into every generated web game — shared lobby, CAS state, live polling. */
export const WHIM_MULTIPLAYER_RUNTIME = String.raw`
(function () {
  var params = new URLSearchParams(location.search);
  var me = (params.get("player") || "Player").slice(0, 32);
  var statePath = location.pathname.replace(/\/$/, "") + "/state";
  var cached = { revision: 0, state: null };
  var listeners = [];
  var pollMs = 1200;

  function idFor(name) {
    var s = String(name).replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
    return s.slice(0, 10) || ("p" + Math.random().toString(36).slice(2, 8));
  }

  async function pull() {
    var res = await fetch(statePath, { cache: "no-store" });
    if (!res.ok) throw new Error("state unavailable");
    return res.json();
  }

  async function push(expectedRevision, state) {
    var res = await fetch(statePath, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: expectedRevision, state: state }),
    });
    var body = await res.json();
    return { res: res, body: body };
  }

  function notify(state) {
    for (var i = 0; i < listeners.length; i++) listeners[i](state);
  }

  function baseState(raw) {
    var s = raw || {};
    if (!Array.isArray(s.players)) s.players = [];
    if (!("game" in s)) s.game = null;
    return s;
  }

  function ensurePlayer(state) {
    var players = state.players.slice();
    var mine = players.find(function (p) { return p.name === me; });
    if (!mine) {
      mine = { id: idFor(me), name: me, joinedAt: Date.now() };
      players.push(mine);
    }
    state.players = players;
    return mine;
  }

  async function save(mutator) {
    for (var attempt = 0; attempt < 10; attempt++) {
      var cur = cached.revision ? cached : await pull();
      var nextState = baseState(JSON.parse(JSON.stringify(cur.state || {})));
      ensurePlayer(nextState);
      mutator(nextState, ensurePlayer(nextState));
      var out = await push(cur.revision, nextState);
      if (out.res.ok && out.body.ok) {
        cached = { revision: out.body.revision, state: out.body.state };
        notify(out.body.state);
        return out.body.state;
      }
      if (out.res.status === 409) {
        cached = { revision: out.body.revision, state: out.body.state };
        continue;
      }
      throw new Error("save failed");
    }
    throw new Error("save conflict");
  }

  window.WHIM = {
    me: me,
    myId: function () { return idFor(me); },
    ready: async function () {
      var cur = await pull();
      cached = cur;
      var state = baseState(cur.state);
      if (!state.players.some(function (p) { return p.name === me; })) {
        state = await save(function (s) { ensurePlayer(s); });
      }
      return state;
    },
    get: function () { return baseState(cached.state); },
    game: function () { var s = baseState(cached.state); return s.game; },
    players: function () { return baseState(cached.state).players.slice(); },
    setGame: function (game) {
      return save(function (s) { s.game = game; s.updatedAt = Date.now(); s.updatedBy = me; });
    },
    patchGame: function (patch) {
      return save(function (s) {
        s.game = Object.assign({}, s.game || {}, patch);
        s.updatedAt = Date.now();
        s.updatedBy = me;
      });
    },
    onRemote: function (fn) {
      listeners.push(fn);
    },
    startPolling: function () {
      setInterval(async function () {
        try {
          var cur = await pull();
          if (cur.revision !== cached.revision) {
            cached = cur;
            notify(baseState(cur.state));
          }
        } catch (e) {}
      }, pollMs);
    },
  };
  window.WHIM.startPolling();
})();
`;

/** Wrap generated HTML with the shared multiplayer runtime (served live, not stored). */
export function injectWhimMultiplayer(html: string): string {
  const script = `<script>${WHIM_MULTIPLAYER_RUNTIME}</script>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${script}</head>`);
  if (/<body[\s>]/i.test(html)) return html.replace(/<body([^>]*)>/i, `<body$1>${script}`);
  return `${script}${html}`;
}

/** Prompts that need a generated web game instead of quiz/tap surfaces. */
export function shouldBuildWebGame(prompt: string, route: { status: string }): boolean {
  if (route.status === "copy_risk") return true;
  if (route.status !== "needs_choice") return false;
  const p = prompt.toLowerCase();
  const multiplayer =
    /\b(multiplayer|multi-player|multi player|versus|vs\.?|against each other|with friends|our group|everyone|each phone|two player|2 player|2-player|play together)\b/.test(
      p,
    );
  const board =
    /\b(tic[\s-]?tac[\s-]?toe|connect\s*four|checkers|chess|battleship|hangman|pong|reversi|dots|boxes|word\s*league)\b/.test(
      p,
    );
  return multiplayer || board;
}
