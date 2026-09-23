import { test } from "node:test";
import assert from "node:assert/strict";
import { injectWhimMultiplayer, shouldBuildWebGame, WHIM_MULTIPLAYER_RUNTIME } from "../src/server/game-web-runtime.ts";

test("injectWhimMultiplayer adds the runtime before </head>", () => {
  const html = "<html><head><title>T</title></head><body></body></html>";
  const out = injectWhimMultiplayer(html);
  assert.match(out, /window\.WHIM/);
  assert.ok(out.indexOf("window.WHIM") < out.indexOf("</head>"));
});

test("injectWhimMultiplayer falls back to after <body> when there is no head", () => {
  const html = "<html><body class=\"x\"><p>hi</p></body></html>";
  const out = injectWhimMultiplayer(html);
  assert.ok(out.indexOf("<body class=\"x\">") < out.indexOf("window.WHIM"));
  assert.ok(out.indexOf("window.WHIM") < out.indexOf("<p>hi</p>"));
});

test("injectWhimMultiplayer prepends when there is neither head nor body", () => {
  const html = "<html><p>bare</p></html>";
  const out = injectWhimMultiplayer(html);
  assert.ok(out.startsWith("<script>"));
  assert.ok(out.indexOf("window.WHIM") < out.indexOf("<p>bare</p>"));
});

test("shouldBuildWebGame routes copy-risk and multiplayer board games to web", () => {
  assert.equal(shouldBuildWebGame("uno for our group", { status: "copy_risk" }), true);
  assert.equal(shouldBuildWebGame("two player tic tac toe with friends", { status: "needs_choice" }), true);
  assert.equal(shouldBuildWebGame("quick trivia about cats", { status: "needs_choice" }), false);
  assert.equal(shouldBuildWebGame("chess with friends", { status: "accepted" }), false);
});

test("runtime defines the lobby, save, and poll entry points", () => {
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /\bready:\s*async function/);
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /\bsetGame:\s*function/);
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /\bpatchGame:\s*function/);
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /\bonRemote:\s*function/);
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /window\.WHIM\.startPolling\(\)/);
});

test("runtime reads the player from the query and caps it at 32 characters", () => {
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /params\.get\("player"\)/);
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /\.slice\(0, 32\)/);
});

test("runtime keys the lobby on a stable id, using pid when the phone supplies one", () => {
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /params\.get\("pid"\)/);
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /var myId = idFor\(me\)/);
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /p\.id === myId/);
  assert.doesNotMatch(WHIM_MULTIPLAYER_RUNTIME, /p\.name === me/);
});
