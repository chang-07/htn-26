/**
 * Splitting a venue's one-line address into checkout fields: no server, no model.
 *
 *   npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isComplete, parseAddress } from "../src/delivery.ts";

test("a Canadian address with everything", () => {
  assert.deepEqual(parseAddress("123 King St W, Toronto, ON M5H 1A1, Canada"), {
    line1: "123 King St W",
    city: "Toronto",
    region: "ON",
    postal: "M5H 1A1",
    country: "CA",
  });
});

test("a US address, region trailing the city, unit in the middle", () => {
  const a = parseAddress("500 W 2nd St, Suite 1900, Austin TX 78701");
  assert.deepEqual(a, { line1: "500 W 2nd St", line2: "Suite 1900", city: "Austin", region: "TX", postal: "78701", country: "US" });
  assert.ok(isComplete(a));
});

test("a postal code typed without its space", () => {
  assert.equal(parseAddress("200 University Ave W, Waterloo, ON N2L3G1").postal, "N2L 3G1");
});

test("a street number is not mistaken for a ZIP", () => {
  const a = parseAddress("12345 Main St, Springfield, IL 62701");
  assert.equal(a.postal, "62701");
  assert.equal(a.line1, "12345 Main St");
});

test("a street and city only: a partial prefill, not a guess", () => {
  const a = parseAddress("88 Queen St, Kitchener");
  assert.deepEqual(a, { line1: "88 Queen St", city: "Kitchener" });
  assert.ok(!isComplete(a));
});
