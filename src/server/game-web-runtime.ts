/** Injected into every generated web game — shared lobby, CAS state, live polling. */
export const WHIM_MULTIPLAYER_RUNTIME = String.raw`
(function () {
  var params = new URLSearchParams(location.search);
  var pid = (params.get("pid") || "").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 16);
  var randomPid = function () {
    var bytes = new Uint32Array(2);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else { bytes[0] = Math.random() * 4294967296; bytes[1] = Date.now(); }
    return "p" + Array.from(bytes).map(function (n) { return n.toString(36); }).join("").slice(0, 15);
  };
  var myId = pid || randomPid();
  var me = (params.get("player") || ("Player " + myId.slice(-4))).trim().slice(0, 32);
  var statePath = location.pathname.replace(/\/$/, "") + "/state";
  var cached = { revision: 0, state: null };
  var listeners = [];
  var pollMs = 1200;
  var heartbeatMs = 10000;
  var presenceTtlMs = 45000;

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
    var index = players.findIndex(function (p) { return p.id === myId; });
    var mine = index >= 0 ? players[index] : null;
    var now = Date.now();
    if (!mine) {
      mine = { id: myId, name: me, joinedAt: now, lastSeenAt: now };
      players.push(mine);
    } else {
      mine = Object.assign({}, mine, { name: me, lastSeenAt: now });
      players[index] = mine;
    }
    state.players = players;
    return mine;
  }

  async function save(mutator, options) {
    for (var attempt = 0; attempt < 10; attempt++) {
      var cur = cached.revision ? cached : await pull();
      var nextState = baseState(JSON.parse(JSON.stringify(cur.state || {})));
      var mine = ensurePlayer(nextState);
      if (mutator(nextState, mine) === false) {
        cached = cur;
        notify(cur.state);
        return cur.state;
      }
      var out = await push(cur.revision, nextState);
      if (out.res.ok && out.body.ok) {
        cached = { revision: out.body.revision, state: out.body.state };
        notify(out.body.state);
        return out.body.state;
      }
      if (out.res.status === 409) {
        cached = { revision: out.body.revision, state: out.body.state };
        if (options && options.gameSnapshot !== undefined && JSON.stringify(baseState(out.body.state).game ?? null) !== options.gameSnapshot) {
          notify(out.body.state);
          return out.body.state;
        }
        continue;
      }
      throw new Error("save failed");
    }
    throw new Error("save conflict");
  }

  window.WHIM = {
    me: me,
    myId: function () { return myId; },
    ready: async function () {
      var cur = await pull();
      cached = cur;
      return save(function () { return true; });
    },
    get: function () { return baseState(cached.state); },
    game: function () { var s = baseState(cached.state); return s.game; },
    players: function () {
      var cutoff = Date.now() - presenceTtlMs;
      return baseState(cached.state).players.filter(function (p) { return Number(p.lastSeenAt) >= cutoff; }).slice();
    },
    setGame: function (game) {
      if (!cached.state) return window.WHIM.ready().then(function () { return window.WHIM.setGame(game); });
      var gameSnapshot = JSON.stringify(cached.state.game ?? null);
      return save(function (s) { s.game = game; s.updatedAt = Date.now(); s.updatedBy = me; return true; }, { gameSnapshot: gameSnapshot });
    },
    patchGame: function (patch) {
      if (!cached.state) return window.WHIM.ready().then(function () { return window.WHIM.patchGame(patch); });
      var gameSnapshot = JSON.stringify(cached.state.game ?? null);
      return save(function (s) {
        s.game = Object.assign({}, s.game || {}, patch);
        s.updatedAt = Date.now();
        s.updatedBy = me;
        return true;
      }, { gameSnapshot: gameSnapshot });
    },
    updateGame: function (reducer) {
      if (!cached.state) return window.WHIM.ready().then(function () { return window.WHIM.updateGame(reducer); });
      return save(function (s, mine) {
        var next = reducer(s.game, mine);
        if (typeof next === "undefined") return false;
        s.game = next;
        s.updatedAt = Date.now();
        s.updatedBy = me;
        return true;
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
      setInterval(function () {
        save(function () { return true; }).catch(function () {});
      }, heartbeatMs);
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

/** Prompts whose games need shared player identity and live shared state. */
export function requiresMultiplayerRuntime(prompt: string): boolean {
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

/** Prompts that need a generated web game instead of quiz/tap surfaces. */
export function shouldBuildWebGame(prompt: string, route: { status: string }): boolean {
  return route.status === "copy_risk" || requiresMultiplayerRuntime(prompt);
}
