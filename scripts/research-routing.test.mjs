import test from "node:test";
import assert from "node:assert/strict";
import { travelKindOf } from "../src/server/research-routing.ts";

test("a brief that is about flights or somewhere to stay names the tool that answers in this turn", () => {
  assert.equal(travelKindOf("hotel in Toronto for one guest on Sunday September 20"), "stay");
  assert.equal(travelKindOf("Bookable Toronto hotels for next Sunday, Sept 20, one guest"), "stay");
  assert.equal(travelKindOf("a place to stay in downtown Vancouver Oct 10-12"), "stay");
  assert.equal(travelKindOf("airbnb for 6 near Blue Mountain"), "stay");
  assert.equal(travelKindOf("flights Toronto to Vancouver tonight Sept 19 for one traveler"), "flight");
  assert.equal(travelKindOf("cheapest one-way flight YYZ to YVR on 2026-10-10"), "flight");
  assert.equal(travelKindOf("Live Toronto → Vancouver flights for tonight"), "flight");
});

test("a brief about venues is left to research, even when it mentions a hotel or a flight in passing", () => {
  assert.equal(travelKindOf("birthday dinner for eight near King West, ~$60 a head"), undefined);
  assert.equal(travelKindOf("hotel bars with a rooftop in Toronto"), undefined);
  assert.equal(travelKindOf("late night ramen near the hotel on Front St"), undefined);
  assert.equal(travelKindOf("things to do in Vancouver after our flight lands"), undefined);
  assert.equal(travelKindOf("a spa near the airport for the afternoon before the flight"), undefined);
  assert.equal(travelKindOf("escape rooms downtown that stay open late"), undefined);
});
