/**
 * What the group chat is renamed to once a plan is booked: no server, no model.
 *
 *   npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_EMOJI, groupName, planEmoji } from "../src/dressing.ts";

const booked = (extra = {}) => ({
  title: "Friday dinner",
  emoji: "🍜",
  options: [
    { id: "a", title: "Kinton Ramen" },
    { id: "b", title: "Pai" },
  ],
  chosenOptionId: "a",
  ...extra,
});

test("the emoji is the model's, when it gave one", () => {
  assert.equal(planEmoji(booked()), "🍜");
  assert.equal(planEmoji(booked({ emoji: "🎳 " })), "🎳", "trailing space");
  assert.equal(planEmoji(booked({ emoji: "🧗‍♀️" })), "🧗‍♀️", "a ZWJ sequence stays whole");
});

test("anything that is not an emoji falls back to the pin", () => {
  assert.equal(planEmoji(booked({ emoji: undefined })), DEFAULT_EMOJI);
  assert.equal(planEmoji(booked({ emoji: "" })), DEFAULT_EMOJI);
  assert.equal(planEmoji(booked({ emoji: "ramen" })), DEFAULT_EMOJI);
  assert.equal(planEmoji(booked({ emoji: "🍜 ramen" })), "🍜", "only the first grapheme is used");
});

test("the name is emoji, plan, venue", () => {
  assert.equal(groupName(booked()), "🍜 Friday dinner · Kinton Ramen");
});

test("no winner, or a winner already named in the title, means no repeat", () => {
  assert.equal(groupName(booked({ chosenOptionId: undefined })), "🍜 Friday dinner");
  assert.equal(groupName(booked({ title: "Kinton Ramen friday" })), "🍜 Kinton Ramen friday");
});

test("a long venue name is clipped, so the thread list still shows the plan", () => {
  const name = groupName(booked({ options: [{ id: "a", title: "The Very Long Name Of A Restaurant On Queen Street West" }] }));
  assert.ok(name.length <= 48, `${name.length} chars: ${name}`);
  assert.ok(name.startsWith("🍜 Friday dinner · The Very"), name);
  assert.ok(name.endsWith("…"), name);
});
