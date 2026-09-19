import type { CartSummary } from "./types";

/**
 * Who paid what, and who owes whom. Worked out fresh every time from things
 * the plan already knows — the carts and who covered each, the headcount —
 * plus anything a person paid outside a cart and told the chat about. There is
 * no ledger of its own to drift out of step with the carts: change a cart,
 * pay one, or change who is going, and the invoice is already different.
 *
 * Shared by the Worker (the ticket, the model's context) and the vote page
 * (the live, itemised version), so the two can never disagree. Everything is
 * in integer cents; the display strings the store gave us are parsed once.
 */

/** Money a person paid that never went through a cart: the bill, a deposit, the cab. */
export type Expense = {
  id: string;
  /** Display name of who paid. */
  who: string;
  /** As they said it: "$86.40", "CA$20". */
  amount: string;
  what: string;
  /**
   * Display names it is split across. Omitted means everyone going. One name
   * makes it a transfer — "Jordan paid Maya back $32" is Jordan paying $32 for
   * Maya alone — which is how paying someone back settles a debt.
   */
  for?: string[];
};

export type InvoiceEntry = {
  id: string;
  kind: "cart" | "expense";
  what: string;
  amount: number;
  /** Nobody yet for a cart still waiting to be paid. */
  who?: string;
  among: string[];
};

/** net > 0: they are owed that much. net < 0: they owe it. */
export type InvoiceLine = { name: string; paid: number; share: number; net: number };

export type Transfer = { from: string; to: string; amount: number };

export type Invoice =
  | {
      ok: true;
      symbol: string;
      /** Everything bought or logged, paid or not. */
      total: number;
      /** The part someone has actually paid. */
      paid: number;
      people: string[];
      /** Creditors first, then debtors, each group in people order. */
      lines: InvoiceLine[];
      /** The fewest payments that square everyone up. */
      transfers: Transfer[];
      entries: InvoiceEntry[];
      unpaid: CartSummary[];
      /** Every cart paid for: nothing is owed to a store any more. */
      settled: boolean;
    }
  | { ok: false; reason: "mixed" | "empty" };

export function parseMoney(s: string): { symbol: string; cents: number } {
  const symbol = s.replace(/[0-9.,\s-]/g, "") || "$";
  const cents = Math.round((Number(s.replace(/[^0-9.]/g, "")) || 0) * 100);
  return { symbol, cents };
}

export function fmtMoney(symbol: string, cents: number): string {
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  return `${cents < 0 ? "-" : ""}${symbol}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** Whole cents, each person's share rounded down, the odd cents going one each to the first names. */
function split(cents: number, among: string[]): Map<string, number> {
  const shares = new Map<string, number>();
  if (!among.length) return shares;
  const each = Math.floor(cents / among.length);
  const odd = cents - each * among.length;
  among.forEach((name, i) => shares.set(name, each + (i < odd ? 1 : 0)));
  return shares;
}

export function invoiceFor(carts: CartSummary[], expenses: Expense[], people: string[]): Invoice {
  if (!carts.length && !expenses.length) return { ok: false, reason: "empty" };
  const monies = [...carts.map((c) => parseMoney(c.total)), ...expenses.map((e) => parseMoney(e.amount))];
  const symbols = new Set(monies.map((m) => m.symbol));
  if (symbols.size > 1) return { ok: false, reason: "mixed" };
  const symbol = [...symbols][0];

  const entries: InvoiceEntry[] = [
    ...carts.map((c, i) => ({
      id: `cart:${c.shop}`,
      kind: "cart" as const,
      what: c.shop,
      amount: monies[i].cents,
      who: c.paidBy,
      among: people.length ? people : c.paidBy ? [c.paidBy] : [],
    })),
    ...expenses.map((e, i) => {
      const among = e.for?.length ? e.for : people.length ? people : [e.who];
      return { id: e.id, kind: "expense" as const, what: e.what, amount: monies[carts.length + i].cents, who: e.who, among };
    }),
  ];

  // Everyone with a stake: the people going, then anyone else who paid or was paid for.
  const names = [...people];
  for (const e of entries) for (const n of [e.who, ...e.among]) if (n && !names.includes(n)) names.push(n);
  const paid = new Map(names.map((n) => [n, 0]));
  const share = new Map(names.map((n) => [n, 0]));
  for (const e of entries) {
    if (!e.who) continue; // nobody has paid it: nobody is owed for it
    paid.set(e.who, paid.get(e.who)! + e.amount);
    for (const [n, c] of split(e.amount, e.among)) share.set(n, share.get(n)! + c);
  }
  const lines = names.map((name) => ({ name, paid: paid.get(name)!, share: share.get(name)!, net: paid.get(name)! - share.get(name)! }));
  // A stable sort: creditors ahead of debtors, people order inside each group.
  lines.sort((a, b) => Math.sign(b.net) - Math.sign(a.net));

  // Largest creditor against largest debtor, repeatedly. Nets sum to zero by
  // construction, so this always closes.
  const creditors = lines.filter((l) => l.net > 0).map((l) => ({ name: l.name, left: l.net })).sort((a, b) => b.left - a.left);
  const debtors = lines.filter((l) => l.net < 0).map((l) => ({ name: l.name, left: -l.net })).sort((a, b) => b.left - a.left);
  const transfers: Transfer[] = [];
  let ci = 0;
  let di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const amount = Math.min(creditors[ci].left, debtors[di].left);
    transfers.push({ from: debtors[di].name, to: creditors[ci].name, amount });
    creditors[ci].left -= amount;
    debtors[di].left -= amount;
    if (creditors[ci].left === 0) ci++;
    if (debtors[di].left === 0) di++;
  }

  return {
    ok: true,
    symbol,
    total: entries.reduce((n, e) => n + e.amount, 0),
    paid: entries.reduce((n, e) => n + (e.who ? e.amount : 0), 0),
    people,
    lines,
    transfers,
    entries,
    unpaid: carts.filter((c) => !c.paidBy),
    settled: carts.every((c) => Boolean(c.paidBy)),
  };
}
