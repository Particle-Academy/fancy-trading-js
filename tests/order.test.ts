import { describe, expect, test } from "vitest";
import { parseDecimal as P, formatDecimal } from "../src/decimal.ts";
import {
  ApprovalRequired,
  ExecType,
  IllegalTransition,
  OrdStatus,
  applyEvent,
  approve,
  canTransition,
  isReconciliationBreak,
  isTerminal,
  markExecutable,
  newOrder,
  submittable,
  type OrderEvent,
  type OrderIntent,
} from "../src/order.ts";

const intent = (over: Partial<OrderIntent> = {}): OrderIntent => ({
  clientOrderId: "c-1",
  symbol: "ES",
  side: "buy",
  qty: P("10", 0),
  type: "limit",
  limitPrice: P("4500.00", 2),
  tif: "day",
  origin: "human",
  ...over,
});

const ev = (over: Partial<OrderEvent> = {}): OrderEvent => ({
  clientOrderId: "c-1",
  execType: ExecType.New,
  status: OrdStatus.New,
  cumQty: P("0", 0),
  leavesQty: P("10", 0),
  avgPx: P("0.00", 2),
  at: 1,
  ...over,
});

describe("trust but verify — the asymmetry", () => {
  test("a HUMAN intent submits with no approval (one-click stays available)", () => {
    const i = intent({ origin: "human" });
    expect(submittable(i)).toBe(i);
  });

  test("an AGENT intent without approval throws", () => {
    const i = intent({ origin: "agent" });
    expect(() => submittable(i)).toThrow(ApprovalRequired);
  });

  test("an AGENT intent with a matching human approval submits", () => {
    const i = intent({ origin: "agent" });
    expect(submittable(i, approve(i, "glenn"))).toBe(i);
  });

  test("an approval for a DIFFERENT order does not authorise this one", () => {
    // The confused-deputy shape: approve a small order, submit a large one.
    const small = intent({ origin: "agent", clientOrderId: "c-small", qty: P("1", 0) });
    const large = intent({ origin: "agent", clientOrderId: "c-large", qty: P("10000", 0) });
    expect(() => submittable(large, approve(small, "glenn"))).toThrow(ApprovalRequired);
  });

  test("approve() demands the confirming human's identity", () => {
    expect(() => approve(intent(), "")).toThrow(/identity/);
  });

  test("there is NO option that relaxes the agent gate", () => {
    // This is the test that must fail against a permissive implementation.
    // submittable's only parameters are the intent and an Approval; there is no
    // options object, no pendingMode:false, no force flag. If someone adds one,
    // this assertion on the function arity is the tripwire.
    expect(submittable.length, "submittable must take exactly (intent, approval?)").toBe(2);
  });
});

describe("the two-field state model", () => {
  test("a trade report leaves the order PartiallyFilled — one field cannot say this", () => {
    let o = newOrder(intent());
    o = applyEvent(o, ev());
    o = applyEvent(
      o,
      ev({
        execType: ExecType.Trade, // what THIS report is
        status: OrdStatus.PartiallyFilled, // where the ORDER is
        cumQty: P("4", 0),
        leavesQty: P("6", 0),
        avgPx: P("4500.00", 2),
        lastQty: P("4", 0),
        lastPx: P("4500.00", 2),
        at: 2,
      }),
    );
    expect(o.status).toBe(OrdStatus.PartiallyFilled);
    expect(formatDecimal(o.cumQty)).toBe("4");
    expect(formatDecimal(o.leavesQty)).toBe("6");
  });

  test("cumulative fields are taken from the event, not accumulated locally", () => {
    // A dropped message must be repaired by the NEXT message. If we accumulated
    // locally, a missed partial fill would corrupt the total permanently.
    let o = newOrder(intent());
    o = applyEvent(o, ev());
    // pretend the cumQty=4 event was lost; the cumQty=9 event still repairs us
    o = applyEvent(
      o,
      ev({ execType: ExecType.Trade, status: OrdStatus.PartiallyFilled, cumQty: P("9", 0), leavesQty: P("1", 0), avgPx: P("4501.00", 2), at: 3 }),
    );
    expect(formatDecimal(o.cumQty)).toBe("9");
    expect(formatDecimal(o.leavesQty)).toBe("1");
  });
});

describe("lifecycle transitions", () => {
  test("DoneForDay is NOT terminal — a GTC order returns tomorrow", () => {
    expect(isTerminal(OrdStatus.DoneForDay)).toBe(false);
    expect(canTransition(OrdStatus.DoneForDay, OrdStatus.New)).toBeTruthy();
  });

  test("Filled, Canceled, Rejected, Expired, Replaced are terminal", () => {
    for (const s of [OrdStatus.Filled, OrdStatus.Canceled, OrdStatus.Rejected, OrdStatus.Expired, OrdStatus.Replaced]) {
      expect(isTerminal(s), `${s} should be terminal`).toBe(true);
    }
  });

  test("an illegal transition throws rather than being silently accepted", () => {
    let o = newOrder(intent());
    o = applyEvent(o, ev({ status: OrdStatus.Filled, execType: ExecType.Trade, cumQty: P("10", 0), leavesQty: P("0", 0), avgPx: P("4500.00", 2) }));
    expect(() => applyEvent(o, ev({ status: OrdStatus.New, at: 5 }))).toThrow(IllegalTransition);
  });

  test("a fill can win the cancel race — PendingCancel may go to Filled", () => {
    expect(canTransition(OrdStatus.PendingCancel, OrdStatus.Filled)).toBeTruthy();
    expect(canTransition(OrdStatus.PendingReplace, OrdStatus.Filled)).toBeTruthy();
  });

  test("a cancel-reject returns the order to its prior state", () => {
    let o = newOrder(intent());
    o = applyEvent(o, ev());
    o = applyEvent(o, ev({ status: OrdStatus.PendingCancel, execType: ExecType.PendingCancel, at: 2 }));
    expect(o.status).toBe(OrdStatus.PendingCancel);
    o = applyEvent(o, ev({ execType: ExecType.CancelRejected, status: OrdStatus.PendingCancel, at: 3 }));
    // still PendingCancel's predecessor state — the order never left the book
    expect(o.status).toBe(OrdStatus.PendingCancel);
    expect(o.pendingIntent).toBe(undefined);
  });

  test("an OrderStatus snapshot may assert any state — it is the reconnect repair", () => {
    let o = newOrder(intent());
    o = applyEvent(o, ev());
    // After a reconnect the venue says: actually, this filled while you were away.
    o = applyEvent(
      o,
      ev({ execType: ExecType.OrderStatus, status: OrdStatus.Filled, cumQty: P("10", 0), leavesQty: P("0", 0), avgPx: P("4499.50", 2), at: 99 }),
    );
    expect(o.status).toBe(OrdStatus.Filled);
    expect(formatDecimal(o.avgPx)).toBe("4499.50");
  });

  test("an event for a different order is refused", () => {
    const o = newOrder(intent());
    expect(() => applyEvent(o, ev({ clientOrderId: "someone-else" }))).toThrow(/applied to order/);
  });
});

describe("reconciliation", () => {
  test("agreement is not a break", () => {
    let o = newOrder(intent());
    o = applyEvent(o, ev({ execType: ExecType.Trade, status: OrdStatus.PartiallyFilled, cumQty: P("4", 0), leavesQty: P("6", 0), avgPx: P("4500.00", 2) }));
    expect(isReconciliationBreak(o, ev({ cumQty: P("4", 0), leavesQty: P("6", 0) }))).toBe(false);
  });

  test("a venue cumQty we do not share IS a break", () => {
    let o = newOrder(intent());
    o = applyEvent(o, ev({ execType: ExecType.Trade, status: OrdStatus.PartiallyFilled, cumQty: P("4", 0), leavesQty: P("6", 0), avgPx: P("4500.00", 2) }));
    // The venue thinks 7 filled. Silent divergence is how someone finds out at
    // 3pm they have been trading a phantom, so this must be loud.
    expect(isReconciliationBreak(o, ev({ cumQty: P("7", 0), leavesQty: P("3", 0) }))).toBe(true);
  });
});

describe("Rule 605 timestamps — unreconstructable if not stamped live", () => {
  test("a market order is executable on arrival", () => {
    const o = newOrder(intent({ type: "market" }), 1000);
    expect(o.receivedAt).toBe(1000);
    expect(o.becameExecutableAt).toBe(1000);
  });

  test("a non-marketable limit is NOT executable on arrival", () => {
    const o = newOrder(intent({ type: "limit" }), 1000);
    expect(o.receivedAt).toBe(1000);
    expect(o.becameExecutableAt, "must be null until the market makes it executable — Rule 605 measures from that moment").toBe(null);
  });

  test("markExecutable stamps it, and only the FIRST time", () => {
    let o = newOrder(intent({ type: "stop" }), 1000);
    o = markExecutable(o, 1500);
    expect(o.becameExecutableAt).toBe(1500);
    // A stop that re-triggers must not reset the clock.
    o = markExecutable(o, 9999);
    expect(o.becameExecutableAt).toBe(1500);
  });

  test("receivedAt survives event application", () => {
    let o = newOrder(intent(), 1000);
    o = applyEvent(o, ev({ at: 2000 }));
    expect(o.receivedAt, "receipt time is not overwritten by updates").toBe(1000);
    expect(o.updatedAt).toBe(2000);
  });
});
