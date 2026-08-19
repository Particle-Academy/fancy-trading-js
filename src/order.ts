/**
 * The order model, its lifecycle, and the trust-but-verify gate.
 *
 * Two structural decisions, both taken from FIX and both routinely got wrong:
 *
 * 1. **Two state fields, not one.** `OrdStatus` is where the ORDER is;
 *    `ExecType` is what THIS REPORT is. One report can say "this is a trade"
 *    (`ExecType.Trade`) while the order is now `PartiallyFilled`. A single
 *    status field cannot represent that, and cannot represent `Restated` at all
 *    — which is how a venue tells you it changed your order unasked.
 * 2. **Every event carries CUMULATIVE state** (`cumQty`, `leavesQty`, `avgPx`),
 *    never just a delta. A stream of deltas is unrecoverable after a gap, and a
 *    gap is guaranteed — it is called a reconnect.
 *
 * The safety model lives here too. See {@link approve} and {@link submittable}.
 */

import { type Decimal, ZERO, add, cmp, div, mul, sub } from "./decimal.ts";

// ─── FIX-derived vocabulary ──────────────────────────────────────────────────

export const OrdStatus = {
  PendingNew: "pendingNew",
  New: "new",
  PartiallyFilled: "partiallyFilled",
  Filled: "filled",
  DoneForDay: "doneForDay",
  Canceled: "canceled",
  Replaced: "replaced",
  PendingCancel: "pendingCancel",
  PendingReplace: "pendingReplace",
  Stopped: "stopped",
  Rejected: "rejected",
  Suspended: "suspended",
  Calculated: "calculated",
  Expired: "expired",
  AcceptedForBidding: "acceptedForBidding",
} as const;
export type OrdStatus = (typeof OrdStatus)[keyof typeof OrdStatus];

export const ExecType = {
  New: "new",
  Trade: "trade",
  Canceled: "canceled",
  Replaced: "replaced",
  PendingCancel: "pendingCancel",
  PendingReplace: "pendingReplace",
  Rejected: "rejected",
  Expired: "expired",
  Restated: "restated",
  TradeCorrect: "tradeCorrect",
  TradeCancel: "tradeCancel",
  OrderStatus: "orderStatus",
  DoneForDay: "doneForDay",
  Stopped: "stopped",
  Suspended: "suspended",
  CancelRejected: "cancelRejected",
  ReplaceRejected: "replaceRejected",
} as const;
export type ExecType = (typeof ExecType)[keyof typeof ExecType];

/**
 * Terminal states. `DoneForDay` is deliberately NOT here — a GTC order comes
 * back tomorrow, and treating it as terminal silently drops working orders.
 */
export const TERMINAL: ReadonlySet<OrdStatus> = new Set([
  OrdStatus.Filled,
  OrdStatus.Canceled,
  OrdStatus.Rejected,
  OrdStatus.Expired,
  OrdStatus.Replaced,
]);

export const isTerminal = (s: OrdStatus): boolean => TERMINAL.has(s);

/** Legal transitions. A venue reporting anything else is a reconciliation break. */
const TRANSITIONS: Record<OrdStatus, ReadonlySet<OrdStatus>> = {
  [OrdStatus.PendingNew]: new Set([
    OrdStatus.New,
    OrdStatus.Rejected,
    OrdStatus.PartiallyFilled,
    OrdStatus.Filled,
    OrdStatus.Canceled,
    OrdStatus.AcceptedForBidding,
  ]),
  [OrdStatus.New]: new Set([
    OrdStatus.PartiallyFilled,
    OrdStatus.Filled,
    OrdStatus.PendingCancel,
    OrdStatus.PendingReplace,
    OrdStatus.Canceled,
    OrdStatus.Replaced,
    OrdStatus.Rejected,
    OrdStatus.Expired,
    OrdStatus.DoneForDay,
    OrdStatus.Stopped,
    OrdStatus.Suspended,
  ]),
  [OrdStatus.PartiallyFilled]: new Set([
    OrdStatus.PartiallyFilled,
    OrdStatus.Filled,
    OrdStatus.PendingCancel,
    OrdStatus.PendingReplace,
    OrdStatus.Canceled,
    OrdStatus.Replaced,
    OrdStatus.Expired,
    OrdStatus.DoneForDay,
    OrdStatus.Calculated,
  ]),
  // Neither pending state is guaranteed to resolve the way you asked: both can
  // fall back to the prior state on a reject, and a fill can win the race.
  [OrdStatus.PendingCancel]: new Set([
    OrdStatus.Canceled,
    OrdStatus.New,
    OrdStatus.PartiallyFilled,
    OrdStatus.Filled,
    OrdStatus.Rejected,
  ]),
  [OrdStatus.PendingReplace]: new Set([
    OrdStatus.Replaced,
    OrdStatus.New,
    OrdStatus.PartiallyFilled,
    OrdStatus.Filled,
    OrdStatus.Rejected,
  ]),
  // Not terminal: a GTC order resumes on the next session.
  [OrdStatus.DoneForDay]: new Set([
    OrdStatus.New,
    OrdStatus.PartiallyFilled,
    OrdStatus.Canceled,
    OrdStatus.Expired,
    OrdStatus.Filled,
  ]),
  [OrdStatus.Suspended]: new Set([OrdStatus.New, OrdStatus.Canceled, OrdStatus.Expired]),
  [OrdStatus.Stopped]: new Set([OrdStatus.Filled, OrdStatus.Canceled, OrdStatus.Rejected]),
  [OrdStatus.Calculated]: new Set([OrdStatus.Filled, OrdStatus.DoneForDay, OrdStatus.Canceled]),
  [OrdStatus.AcceptedForBidding]: new Set([OrdStatus.New, OrdStatus.Rejected, OrdStatus.Canceled]),
  [OrdStatus.Filled]: new Set(),
  [OrdStatus.Canceled]: new Set(),
  [OrdStatus.Rejected]: new Set(),
  [OrdStatus.Expired]: new Set(),
  [OrdStatus.Replaced]: new Set(),
};

export function canTransition(from: OrdStatus, to: OrdStatus): boolean {
  return TRANSITIONS[from].has(to);
}

// ─── The order ───────────────────────────────────────────────────────────────

export type Side = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stopLimit" | "trailingStop";
export type TimeInForce = "day" | "gtc" | "gtd" | "ioc" | "fok" | "opg" | "cls";

/**
 * Where an instruction came from. **Set by the transport, never by the caller.**
 * An instruction arriving over the MCP bridge is stamped `agent` at the bridge
 * boundary, and no argument can change it.
 */
export type Origin = "human" | "agent";

export type OrderIntent = {
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly qty: Decimal;
  readonly type: OrderType;
  /** Named, never IBKR's overloaded `auxPrice`. */
  readonly limitPrice?: Decimal;
  readonly triggerPrice?: Decimal;
  readonly trailOffset?: Decimal;
  readonly tif: TimeInForce;
  readonly reduceOnly?: boolean;
  readonly postOnly?: boolean;
  readonly origin: Origin;
  /** Free-form, carried to the venue where supported. */
  readonly tag?: string;
};

export type Order = {
  readonly clientOrderId: string;
  readonly venueOrderId?: string;
  /** Chains a replace back to what it replaced, so the id history reconstructs. */
  readonly replacesClientOrderId?: string;
  readonly intent: OrderIntent;
  readonly status: OrdStatus;
  /** Cumulative, always — never a delta. */
  readonly cumQty: Decimal;
  readonly leavesQty: Decimal;
  readonly avgPx: Decimal;
  /** A requested change not yet confirmed by the venue. Rendered as an overlay. */
  readonly pendingIntent?: Partial<OrderIntent>;
  readonly updatedAt: number;
};

export type OrderEvent = {
  readonly clientOrderId: string;
  readonly execType: ExecType;
  readonly status: OrdStatus;
  readonly cumQty: Decimal;
  readonly leavesQty: Decimal;
  readonly avgPx: Decimal;
  readonly lastQty?: Decimal;
  readonly lastPx?: Decimal;
  readonly venueOrderId?: string;
  readonly reason?: string;
  readonly at: number;
};

// ─── Trust but verify ────────────────────────────────────────────────────────

/**
 * Proof that a human confirmed a specific agent-proposed intent.
 *
 * This is a branded type with a private symbol, so it **cannot be forged by a
 * consumer** — the only way to obtain one is {@link approve}, which is what a
 * human-facing confirmation UI calls. That is the difference between a rule and
 * a convention: an unapproved agent order is not "rejected at runtime", it is
 * unrepresentable, because {@link submittable} will not typecheck without one.
 */
declare const APPROVAL: unique symbol;
export type Approval = {
  readonly [APPROVAL]: true;
  readonly clientOrderId: string;
  readonly approvedBy: string;
  readonly at: number;
};

/** Called by the human-facing confirmation affordance, never by an agent path. */
export function approve(
  intent: OrderIntent,
  approvedBy: string,
  at: number = Date.now(),
): Approval {
  if (!approvedBy) throw new TypeError("approve() requires the confirming human's identity");
  return { clientOrderId: intent.clientOrderId, approvedBy, at } as Approval;
}

export class ApprovalRequired extends Error {
  readonly clientOrderId: string;
  constructor(clientOrderId: string) {
    super(
      `Order ${clientOrderId} originated from an agent and has no human approval. ` +
        `Agents propose; humans confirm. Obtain an Approval via approve() from a human-facing affordance.`,
    );
    this.clientOrderId = clientOrderId;
    this.name = "ApprovalRequired";
  }
}

/**
 * Turn an intent into something submittable.
 *
 * A `human` intent passes straight through — a trader's own one-click is a human
 * decision and this kit does not second-guess it. An `agent` intent REQUIRES a
 * matching {@link Approval}. There is deliberately no option, flag or prop that
 * relaxes this.
 */
export function submittable(intent: OrderIntent, approval?: Approval): OrderIntent {
  if (intent.origin === "agent") {
    if (!approval) throw new ApprovalRequired(intent.clientOrderId);
    if (approval.clientOrderId !== intent.clientOrderId) {
      // An approval for a different order is the shape a confused-deputy bug
      // takes: approve a $10 order, submit a $10,000 one.
      throw new ApprovalRequired(intent.clientOrderId);
    }
  }
  return intent;
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

export class IllegalTransition extends Error {
  readonly from: OrdStatus;
  readonly to: OrdStatus;
  readonly clientOrderId: string;
  constructor(from: OrdStatus, to: OrdStatus, clientOrderId: string) {
    super(`Order ${clientOrderId}: illegal transition ${from} -> ${to}`);
    this.from = from;
    this.to = to;
    this.clientOrderId = clientOrderId;
    this.name = "IllegalTransition";
  }
}

export function newOrder(intent: OrderIntent, at: number = Date.now()): Order {
  return {
    clientOrderId: intent.clientOrderId,
    intent,
    status: OrdStatus.PendingNew,
    cumQty: ZERO(intent.qty.exp),
    leavesQty: intent.qty,
    avgPx: ZERO(intent.limitPrice?.exp ?? 2),
    updatedAt: at,
  };
}

/**
 * Apply a venue event. The event's cumulative fields are authoritative — we do
 * not accumulate locally, precisely so a dropped message is repaired by the
 * next one rather than corrupting the running total.
 */
export function applyEvent(order: Order, ev: OrderEvent): Order {
  if (ev.clientOrderId !== order.clientOrderId) {
    throw new Error(
      `event for ${ev.clientOrderId} applied to order ${order.clientOrderId}`,
    );
  }

  // A rejected cancel/replace leaves the order in its PRIOR state. Alpaca emits
  // exactly this as an event with no corresponding status, which is why the
  // execType is checked before the status transition.
  if (ev.execType === ExecType.CancelRejected || ev.execType === ExecType.ReplaceRejected) {
    return { ...order, pendingIntent: undefined, updatedAt: ev.at };
  }

  // A solicited status snapshot (FIX ExecType=I) is how a reconnect repairs
  // state, so it may assert any status without being a transition violation.
  const snapshot = ev.execType === ExecType.OrderStatus;

  if (!snapshot && ev.status !== order.status && !canTransition(order.status, ev.status)) {
    throw new IllegalTransition(order.status, ev.status, order.clientOrderId);
  }

  return {
    ...order,
    status: ev.status,
    cumQty: ev.cumQty,
    leavesQty: ev.leavesQty,
    avgPx: ev.avgPx,
    venueOrderId: ev.venueOrderId ?? order.venueOrderId,
    pendingIntent:
      ev.status === OrdStatus.PendingCancel || ev.status === OrdStatus.PendingReplace
        ? order.pendingIntent
        : undefined,
    updatedAt: ev.at,
  };
}

/** Weighted average fill price implied by a set of fills — for reconciliation. */
export function impliedAvgPx(
  fills: ReadonlyArray<{ qty: Decimal; px: Decimal }>,
  exp: number,
): Decimal {
  let q = ZERO(0);
  let c = ZERO(0);
  for (const f of fills) {
    q = add(q, f.qty);
    c = add(c, mul(f.qty, f.px));
  }
  if (q.v === 0n) return ZERO(exp);
  return div(c, q, exp, "half-up");
}

/** True when the venue's cumulative view disagrees with ours — a loud failure. */
export function isReconciliationBreak(order: Order, venue: OrderEvent): boolean {
  return (
    cmp(order.cumQty, venue.cumQty) !== 0 ||
    cmp(sub(order.intent.qty, venue.cumQty), venue.leavesQty) !== 0
  );
}
