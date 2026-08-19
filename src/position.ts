/**
 * Position and P&L arithmetic.
 *
 * Three things here are wrong in most implementations, and each has a test that
 * fails against the naive version:
 *
 * 1. **Realised P&L depends on the cost-basis method**, and the methods
 *    genuinely disagree. Average cost and FIFO split the same total economic
 *    P&L differently between realised and unrealised — which is what tax, the
 *    daily blotter, and any "stop at -$2,000 realised" risk limit fire on. A
 *    realised number without a stated method is meaningless.
 * 2. **A position flip is a close plus an open.** Buy 100 then sell 150 closes
 *    100 against the existing basis and opens a NEW short of 50 based at the
 *    SELL price — not "-50 at the old average".
 * 3. **Inverse contracts are non-linear in price.** `(exit - entry) * qty` is
 *    simply wrong for a coin-margined contract, where P&L accrues in the base
 *    currency as `contracts * multiplier * (1/entry - 1/exit)`. Equal moves up
 *    and down do not produce equal P&L.
 */

import {
  type Decimal,
  type Rounding,
  ZERO,
  abs,
  add,
  cmp,
  dec,
  div,
  mul,
  neg,
  sign,
  sub,
} from "./decimal.ts";

export type CostBasis = "average" | "fifo" | "lifo";
export type ContractType = "linear" | "inverse" | "spot";
export type Side = "buy" | "sell";

/** Only what the arithmetic needs — the full instrument shape lives elsewhere. */
export type PnlInstrument = {
  contractType: ContractType;
  /** Currency per 1.00 of price movement per contract. */
  multiplier: Decimal;
  /** Scale for money results. */
  moneyExp: number;
  /** Rounding for the money results of a division. */
  rounding?: Rounding;
};

export type Lot = {
  /** Always positive — the side is carried by the position's sign. */
  readonly qty: Decimal;
  readonly price: Decimal;
  readonly acquiredAt: number;
  readonly id?: string;
};

export type Position = {
  /** Signed: positive is long, negative is short. */
  readonly qty: Decimal;
  /** Open lots, oldest first. Empty when flat. */
  readonly lots: readonly Lot[];
  /** Realised P&L accumulated on this position, in money units. */
  readonly realised: Decimal;
  /** Fees paid, tracked separately so the basis convention stays explicit. */
  readonly fees: Decimal;
  readonly basis: CostBasis;
};

export type Fill = {
  readonly side: Side;
  /** Always positive. */
  readonly qty: Decimal;
  readonly price: Decimal;
  readonly at: number;
  readonly fee?: Decimal;
  readonly id?: string;
};

export function emptyPosition(basis: CostBasis, moneyExp = 2): Position {
  return {
    qty: ZERO(0),
    lots: [],
    realised: ZERO(moneyExp),
    fees: ZERO(moneyExp),
    basis,
  };
}

/**
 * P&L of closing `qty` units opened at `entry` and closed at `exit`, for a LONG.
 * Dispatches on contract type — a single linear formula is wrong for a third of
 * the crypto market.
 */
export function closePnl(
  qty: Decimal,
  entry: Decimal,
  exit: Decimal,
  inst: PnlInstrument,
): Decimal {
  const mode = inst.rounding ?? "half-up";
  if (inst.contractType === "inverse") {
    // Settled in the BASE currency: contracts * multiplier * (1/entry - 1/exit)
    const invEntry = div(dec(1n, 0), entry, inst.moneyExp + 8, mode);
    const invExit = div(dec(1n, 0), exit, inst.moneyExp + 8, mode);
    return rescaleMoney(mul(mul(qty, inst.multiplier), sub(invEntry, invExit)), inst, mode);
  }
  return rescaleMoney(mul(mul(qty, inst.multiplier), sub(exit, entry)), inst, mode);
}

function rescaleMoney(d: Decimal, inst: PnlInstrument, mode: Rounding): Decimal {
  // Reuse rescale via div by 1 so the rounding mode is applied consistently.
  return div(d, dec(1n, 0), inst.moneyExp, mode);
}

/** Weighted-average price across the open lots. Derived, never stored as truth. */
export function averagePrice(pos: Position, priceExp?: number): Decimal {
  if (pos.lots.length === 0) return ZERO(priceExp ?? 0);
  let totalQty = ZERO(0);
  let totalCost = ZERO(0);
  for (const l of pos.lots) {
    totalQty = add(totalQty, l.qty);
    totalCost = add(totalCost, mul(l.qty, l.price));
  }
  if (totalQty.v === 0n) return ZERO(priceExp ?? 0);
  const exp = priceExp ?? pos.lots[0]!.price.exp;
  return div(totalCost, totalQty, exp, "half-up");
}

/**
 * Apply a fill, returning the new position and the realised P&L this fill
 * produced. Handles adds, partial reduces, full closes and flips.
 */
export function applyFill(
  pos: Position,
  fill: Fill,
  inst: PnlInstrument,
): { position: Position; realisedDelta: Decimal } {
  if (sign(fill.qty) <= 0) throw new RangeError("fill qty must be positive");

  const mode = inst.rounding ?? "half-up";
  const fee = fill.fee ?? ZERO(inst.moneyExp);
  const dir = fill.side === "buy" ? 1 : -1;
  const posDir = sign(pos.qty);

  let lots: Lot[] = pos.lots.map((l) => ({ ...l }));
  let realisedDelta = ZERO(inst.moneyExp);
  let remaining = fill.qty;

  const opposes = posDir !== 0 && posDir !== dir;

  if (opposes) {
    // Reduce, close, or flip. Relieve lots in the order the basis dictates.
    const openQty = abs(pos.qty);
    const closing = cmp(remaining, openQty) <= 0 ? remaining : openQty;

    if (pos.basis === "average") {
      const avg = averagePrice(pos, fill.price.exp);
      // For a short, entry and exit swap: profit when exit < entry.
      const pnl =
        posDir > 0
          ? closePnl(closing, avg, fill.price, inst)
          : closePnl(closing, fill.price, avg, inst);
      realisedDelta = add(realisedDelta, pnl);
      // Average cost keeps ONE basis: reduce the quantity, never the price.
      const left = sub(openQty, closing);
      lots = left.v === 0n ? [] : [{ qty: left, price: avg, acquiredAt: pos.lots[0]?.acquiredAt ?? fill.at }];
    } else {
      let toClose = closing;
      const order = pos.basis === "fifo" ? lots : [...lots].reverse();
      const consumed: Lot[] = [];
      for (const lot of order) {
        if (toClose.v === 0n) {
          consumed.push(lot);
          continue;
        }
        const take = cmp(lot.qty, toClose) <= 0 ? lot.qty : toClose;
        const pnl =
          posDir > 0
            ? closePnl(take, lot.price, fill.price, inst)
            : closePnl(take, fill.price, lot.price, inst);
        realisedDelta = add(realisedDelta, pnl);
        toClose = sub(toClose, take);
        const left = sub(lot.qty, take);
        if (left.v !== 0n) consumed.push({ ...lot, qty: left });
      }
      lots = pos.basis === "fifo" ? consumed : consumed.reverse();
    }

    remaining = sub(remaining, closing);
  }

  // Anything left either adds to the existing side, or opens the new one after
  // a flip. Either way it is a NEW lot at the fill price — this is the flip
  // case, and getting it wrong is the classic bug.
  if (remaining.v !== 0n) {
    lots.push({ qty: remaining, price: fill.price, acquiredAt: fill.at, id: fill.id });
    if (pos.basis === "average" && lots.length > 1) {
      // Collapse to a single lot at the weighted average.
      let q = ZERO(0);
      let c = ZERO(0);
      for (const l of lots) {
        q = add(q, l.qty);
        c = add(c, mul(l.qty, l.price));
      }
      lots = [
        {
          qty: q,
          price: div(c, q, fill.price.exp, mode),
          acquiredAt: lots[0]!.acquiredAt,
        },
      ];
    }
  }

  const newQty = add(pos.qty, dir === 1 ? fill.qty : neg(fill.qty));

  return {
    position: {
      qty: newQty,
      lots: newQty.v === 0n ? [] : lots,
      realised: add(pos.realised, realisedDelta),
      fees: add(pos.fees, fee),
      basis: pos.basis,
    },
    realisedDelta,
  };
}

/**
 * Unrealised P&L against a mark price.
 *
 * The caller passes the MARK, not the last trade. On a perpetual the exchange
 * margins and liquidates on mark; valuing against `last` produces a number that
 * disagrees with the venue and a wrong distance-to-liquidation.
 */
export function unrealised(pos: Position, mark: Decimal, inst: PnlInstrument): Decimal {
  if (pos.qty.v === 0n) return ZERO(inst.moneyExp);
  const long = sign(pos.qty) > 0;
  let total = ZERO(inst.moneyExp);
  for (const lot of pos.lots) {
    total = add(
      total,
      long ? closePnl(lot.qty, lot.price, mark, inst) : closePnl(lot.qty, mark, lot.price, inst),
    );
  }
  return total;
}
