import { describe, expect, test } from "vitest";
import { formatDecimal, parseDecimal as P, dec } from "../src/decimal.ts";
import {
  applyFill,
  averagePrice,
  closePnl,
  emptyPosition,
  unrealised,
  type CostBasis,
  type Fill,
  type PnlInstrument,
} from "../src/position.ts";

const equity: PnlInstrument = {
  contractType: "linear",
  multiplier: dec(1n, 0),
  moneyExp: 2,
};

const fill = (side: "buy" | "sell", qty: string, price: string, at = 0): Fill => ({
  side,
  qty: P(qty, 0),
  price: P(price, 2),
  at,
});

describe("the worked example where the methods disagree", () => {
  // Buy 100 @ 10, buy 100 @ 20, sell 100 @ 25, mark 25.
  // Total economic P&L is $2,000 under EVERY method; what differs is the
  // realised/unrealised split. An implementation with one cost-basis path
  // cannot produce all three rows.
  const seq: Fill[] = [fill("buy", "100", "10.00", 1), fill("buy", "100", "20.00", 2)];
  const expected: Record<CostBasis, { realised: string; unrealised: string }> = {
    fifo: { realised: "1500.00", unrealised: "500.00" },
    average: { realised: "1000.00", unrealised: "1000.00" },
    lifo: { realised: "500.00", unrealised: "1500.00" },
  };

  for (const basis of ["fifo", "average", "lifo"] as const) {
    test(`${basis}: realised ${expected[basis].realised}, unrealised ${expected[basis].unrealised}`, () => {
      let pos = emptyPosition(basis);
      for (const f of seq) pos = applyFill(pos, f, equity).position;
      const r = applyFill(pos, fill("sell", "100", "25.00", 3), equity);
      expect(formatDecimal(r.position.realised)).toBe(expected[basis].realised);
      expect(formatDecimal(unrealised(r.position, P("25.00", 2), equity))).toBe(expected[basis].unrealised);
    });
  }

  test("total economic P&L is identical across all three methods", () => {
    for (const basis of ["fifo", "average", "lifo"] as const) {
      let pos = emptyPosition(basis);
      for (const f of seq) pos = applyFill(pos, f, equity).position;
      pos = applyFill(pos, fill("sell", "100", "25.00", 3), equity).position;
      const total = Number(formatDecimal(pos.realised)) +
        Number(formatDecimal(unrealised(pos, P("25.00", 2), equity)));
      expect(total, `${basis} should total 2000`).toBe(2000);
    }
  });
});

describe("position flip — the classic bug", () => {
  // Buy 100 @ 10, then SELL 150 @ 20. This must close 100 (realising $1,000)
  // and OPEN a new short of 50 based at 20 — not leave "-50 at the old average".
  for (const basis of ["fifo", "average", "lifo"] as const) {
    test(`${basis}: closes 100 and opens a NEW short of 50 based at the sell price`, () => {
      let pos = emptyPosition(basis);
      pos = applyFill(pos, fill("buy", "100", "10.00", 1), equity).position;
      const r = applyFill(pos, fill("sell", "150", "20.00", 2), equity);

      expect(formatDecimal(r.position.qty), "should be short 50").toBe("-50");
      expect(formatDecimal(r.realisedDelta), "realises on the 100 closed").toBe("1000.00");
      // The new short's basis is the SELL price, so at a mark of 20 it is flat.
      expect(formatDecimal(unrealised(r.position, P("20.00", 2), equity)), "new short must be based at 20.00, not at the old 10.00").toBe("0.00");
      // And it profits as price falls.
      expect(formatDecimal(unrealised(r.position, P("18.00", 2), equity))).toBe("100.00");
    });
  }
});

describe("short positions", () => {
  test("a short profits when price falls", () => {
    let pos = emptyPosition("average");
    pos = applyFill(pos, fill("sell", "10", "100.00", 1), equity).position;
    expect(formatDecimal(pos.qty)).toBe("-10");
    expect(formatDecimal(unrealised(pos, P("90.00", 2), equity))).toBe("100.00");
    expect(formatDecimal(unrealised(pos, P("110.00", 2), equity))).toBe("-100.00");
  });

  test("covering a short realises correctly", () => {
    let pos = emptyPosition("fifo");
    pos = applyFill(pos, fill("sell", "10", "100.00", 1), equity).position;
    const r = applyFill(pos, fill("buy", "10", "90.00", 2), equity);
    expect(formatDecimal(r.realisedDelta)).toBe("100.00");
    expect(formatDecimal(r.position.qty)).toBe("0");
    expect(r.position.lots.length, "flat position holds no lots").toBe(0);
  });
});

describe("futures multiplier", () => {
  const es: PnlInstrument = { contractType: "linear", multiplier: dec(50n, 0), moneyExp: 2 };

  test("P&L scales by the contract multiplier", () => {
    let pos = emptyPosition("average");
    pos = applyFill(pos, { ...fill("buy", "2", "4500.00", 1), price: P("4500.00", 2) }, es).position;
    // 2 contracts * $50 * 4 points = $400
    expect(formatDecimal(unrealised(pos, P("4504.00", 2), es))).toBe("400.00");
  });
});

describe("inverse contracts are non-linear", () => {
  // Coin-margined: pnl_in_base = contracts * multiplier * (1/entry - 1/exit)
  const inverse: PnlInstrument = {
    contractType: "inverse",
    multiplier: dec(1n, 0), // $1 per contract
    moneyExp: 8, // settled in BTC, 8 dp
  };

  test("equal moves up and down do NOT produce equal P&L", () => {
    let pos = emptyPosition("average", 8);
    pos = applyFill(
      pos,
      { side: "buy", qty: P("10000", 0), price: P("50000", 0), at: 1 },
      inverse,
    ).position;

    const up = unrealised(pos, P("55000", 0), inverse);
    const down = unrealised(pos, P("45000", 0), inverse);

    // 10000 * (1/50000 - 1/55000) = 0.01818181...
    expect(formatDecimal(up)).toBe("0.01818182");
    // 10000 * (1/50000 - 1/45000) = -0.02222222...
    expect(formatDecimal(down)).toBe("-0.02222222");

    // The asymmetry is the point: a linear formula would give equal magnitudes.
    expect(formatDecimal(up).replace("-", "")).not.toBe(formatDecimal(down).replace("-", ""));
  });

  test("a linear formula would be wrong here, and demonstrably so", () => {
    const linearAnswer = closePnl(P("10000", 0), P("50000", 0), P("55000", 0), {
      contractType: "linear",
      multiplier: dec(1n, 0),
      moneyExp: 8,
    });
    const inverseAnswer = closePnl(P("10000", 0), P("50000", 0), P("55000", 0), inverse);
    expect(formatDecimal(linearAnswer)).toBe("50000000.00000000");
    expect(formatDecimal(inverseAnswer)).toBe("0.01818182");
  });
});

describe("averaging and partial reduces", () => {
  test("average price is the weighted average of the open lots", () => {
    let pos = emptyPosition("average");
    pos = applyFill(pos, fill("buy", "100", "10.00", 1), equity).position;
    pos = applyFill(pos, fill("buy", "300", "20.00", 2), equity).position;
    expect(formatDecimal(averagePrice(pos, 2))).toBe("17.50");
  });

  test("average cost does NOT change the basis on a reduce", () => {
    let pos = emptyPosition("average");
    pos = applyFill(pos, fill("buy", "100", "10.00", 1), equity).position;
    pos = applyFill(pos, fill("buy", "100", "20.00", 2), equity).position;
    const r = applyFill(pos, fill("sell", "50", "30.00", 3), equity);
    expect(formatDecimal(averagePrice(r.position, 2))).toBe("15.00");
    expect(formatDecimal(r.position.qty)).toBe("150");
  });

  test("fifo relieves the oldest lot first", () => {
    let pos = emptyPosition("fifo");
    pos = applyFill(pos, fill("buy", "100", "10.00", 1), equity).position;
    pos = applyFill(pos, fill("buy", "100", "20.00", 2), equity).position;
    const r = applyFill(pos, fill("sell", "50", "30.00", 3), equity);
    // relieves 50 of the $10 lot -> 50 * 20 = 1000
    expect(formatDecimal(r.realisedDelta)).toBe("1000.00");
    expect(r.position.lots.length).toBe(2);
    expect(formatDecimal(r.position.lots[0]!.qty)).toBe("50");
    expect(formatDecimal(r.position.lots[0]!.price)).toBe("10.00");
  });

  test("lifo relieves the newest lot first", () => {
    let pos = emptyPosition("lifo");
    pos = applyFill(pos, fill("buy", "100", "10.00", 1), equity).position;
    pos = applyFill(pos, fill("buy", "100", "20.00", 2), equity).position;
    const r = applyFill(pos, fill("sell", "50", "30.00", 3), equity);
    // relieves 50 of the $20 lot -> 50 * 10 = 500
    expect(formatDecimal(r.realisedDelta)).toBe("500.00");
  });
});

describe("guards", () => {
  test("a non-positive fill quantity is refused", () => {
    const pos = emptyPosition("fifo");
    expect(() => applyFill(pos, { side: "buy", qty: P("0", 0), price: P("1.00", 2), at: 0 }, equity)).toThrow(/must be positive/);
  });
});
