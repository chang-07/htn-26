import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the native card system uses the frontend ticket palette, type, square action, and transcript inset", async () => {
  const design = await read("ios/MessagesExtension/DesignSystem.swift");

  assert.match(design, /ticketPaper/);
  assert.match(design, /0xEF\s*\/\s*255/);
  assert.match(design, /ticketInk/);
  assert.match(design, /0x24\s*\/\s*255/);
  assert.match(design, /\.custom\("Archivo"/);
  assert.match(design, /\.custom\("IBM Plex Mono"/);
  assert.match(design, /Rectangle\(\)/);
  assert.doesNotMatch(design, /in:\s*Capsule\(\)/);
  assert.match(design, /padding\(\.top,\s*24\)/);
});

test("every native iMessage card enters through the shared ticket shell", async () => {
  for (const path of [
    "ios/MessagesExtension/GameViews.swift",
    "ios/MessagesExtension/TicketView.swift",
    "ios/MessagesExtension/TicketCardView.swift",
    "ios/MessagesExtension/CardsView.swift",
    "ios/MessagesExtension/HomeView.swift",
    "ios/MessagesExtension/ProfileForms.swift",
  ]) {
    assert.match(await read(path), /\.whimPage\(\)/, path);
  }
});
