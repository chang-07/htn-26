/**
 * The invoice math, on its own: no server, no model.
 *
 *   npm test
 *
 * Node strips the types itself, so src/invoice.ts is imported as is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtMoney, invoiceFor, parseMoney } from "../src/invoice.ts";

const cart = (shop, total, paidBy) => ({ shop, checkoutUrl: `https://${shop}/cart`, total, lines: [{ title: "x", quantity: 1, price: total }], paidBy });
const FOUR = ["Maya", "Sam", "Jordan", "Alex"];
const by = (inv, name) => inv.lines.find((l) => l.name === name);

test("parseMoney keeps the store's currency prefix and works in cents", () => {
  assert.deepEqual(parseMoney("$36.00"), { symbol: "$", cents: 3600 });
  assert.deepEqual(parseMoney("CA$1,234.56"), { symbol: "CA$", cents: 123456 });
  assert.deepEqual(parseMoney("20"), { symbol: "$", cents: 2000 });
  assert.deepEqual(parseMoney("€19.99"), { symbol: "€", cents: 1999 });
});

test("fmtMoney always shows cents", () => {
  assert.equal(fmtMoney("$", 100), "$1.00");
  assert.equal(fmtMoney("CA$", 123456), "CA$1,234.56");
  assert.equal(fmtMoney("$", 5), "$0.05");
});

test("one paid cart split four ways: the payer is owed three shares", () => {
  const inv = invoiceFor([cart("levainbakery.com", "$128.00", "Maya")], [], FOUR);
  assert.equal(inv.ok, true);
  assert.equal(inv.symbol, "$");
  assert.equal(inv.total, 12800);
  assert.equal(inv.paid, 12800);
  assert.equal(inv.settled, true);
  assert.deepEqual(by(inv, "Maya"), { name: "Maya", paid: 12800, share: 3200, net: 9600 });
  assert.deepEqual(by(inv, "Jordan"), { name: "Jordan", paid: 0, share: 3200, net: -3200 });
  assert.deepEqual(
    inv.transfers,
    ["Sam", "Jordan", "Alex"].map((from) => ({ from, to: "Maya", amount: 3200 })),
  );
});

test("an unpaid cart counts toward the total but nobody owes for it yet", () => {
  const inv = invoiceFor([cart("levainbakery.com", "$128.00", "Maya"), cart("partycity.com", "$41.50")], [], FOUR);
  assert.equal(inv.total, 16950);
  assert.equal(inv.paid, 12800);
  assert.equal(inv.settled, false);
  assert.equal(inv.unpaid.length, 1);
  assert.equal(by(inv, "Maya").net, 9600);
  assert.equal(inv.lines.reduce((n, l) => n + l.net, 0), 0);
});

test("odd cents go one each to the first people in the split, so the nets still sum to zero", () => {
  const inv = invoiceFor([cart("a.com", "$10.00", "Sam")], [], ["Maya", "Sam", "Jordan"]);
  assert.deepEqual(
    inv.lines.map((l) => [l.name, l.share]).sort(),
    [
      ["Jordan", 333],
      ["Maya", 334],
      ["Sam", 333],
    ],
  );
  assert.equal(inv.lines.reduce((n, l) => n + l.net, 0), 0);
});

test("two payers: the smaller payer still owes the larger one the difference", () => {
  const inv = invoiceFor([cart("levainbakery.com", "$128.00", "Maya"), cart("partycity.com", "$41.50", "Sam")], [], FOUR);
  assert.equal(inv.settled, true);
  assert.equal(by(inv, "Maya").net, 8562);
  assert.equal(by(inv, "Sam").net, -88);
  assert.deepEqual(inv.transfers, [
    { from: "Jordan", to: "Maya", amount: 4237 },
    { from: "Alex", to: "Maya", amount: 4237 },
    { from: "Sam", to: "Maya", amount: 88 },
  ]);
});

test("an expense with no `for` is shared by everyone going", () => {
  const inv = invoiceFor([], [{ id: "e1", who: "Maya", amount: "$86.40", what: "dinner at Kinton" }], FOUR);
  assert.equal(inv.total, 8640);
  assert.equal(by(inv, "Maya").net, 6480);
  assert.equal(inv.entries[0].kind, "expense");
  assert.deepEqual(inv.entries[0].among, FOUR);
});

test("paying someone back is an expense for that one person, and it clears the debt", () => {
  const inv = invoiceFor(
    [cart("levainbakery.com", "$128.00", "Maya")],
    [{ id: "e1", who: "Jordan", amount: "$32", what: "paid Maya back", for: ["Maya"] }],
    FOUR,
  );
  assert.equal(by(inv, "Jordan").net, 0);
  assert.equal(by(inv, "Maya").net, 6400);
  assert.equal(inv.transfers.length, 2);
  assert.ok(inv.transfers.every((t) => t.from !== "Jordan"));
});

test("someone who paid but is not going owes nothing and is owed the lot", () => {
  const inv = invoiceFor([cart("levainbakery.com", "$128.00", "Priya")], [], FOUR);
  assert.deepEqual(by(inv, "Priya"), { name: "Priya", paid: 12800, share: 0, net: 12800 });
  assert.equal(inv.lines.length, 5);
});

test("lines come creditors first, then debtors, in the order of the people list", () => {
  const inv = invoiceFor([cart("a.com", "$40.00", "Jordan")], [], FOUR);
  assert.deepEqual(
    inv.lines.map((l) => l.name),
    ["Jordan", "Maya", "Sam", "Alex"],
  );
});

test("a cart paid by someone with nobody else in the chat is their own bill", () => {
  const inv = invoiceFor([cart("a.com", "$40.00", "Maya")], [], []);
  assert.equal(by(inv, "Maya").net, 0);
  assert.deepEqual(inv.transfers, []);
});

test("mixed currencies cannot be added, so there is no invoice", () => {
  const inv = invoiceFor([cart("a.com", "$10.00", "Maya"), cart("b.ca", "CA$10.00", "Sam")], [], FOUR);
  assert.deepEqual(inv, { ok: false, reason: "mixed" });
});

test("nothing bought and nothing logged is no invoice at all", () => {
  assert.deepEqual(invoiceFor([], [], FOUR), { ok: false, reason: "empty" });
});
