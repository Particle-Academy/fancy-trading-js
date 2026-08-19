import { test, describe } from "node:test";
import assert from "node:assert/strict";
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
      assert.equal(formatDecimal(r.position.realised), expected[basis].realised);
      assert.equal(
        formatDecimal(unrealised(r.position, P("25.00", 2), equity)),
        expected[basis].unrealised,
      );
    });
  }

  test("total economic P&L is identical across all three methods", () => {
    for (const basis of ["fifo", "average", "lifo"] as const) {
      let pos = emptyPosition(basis);
      for (const f of seq) pos = applyFill(pos, f, equity).position;
      pos = applyFill(pos, fill("sell", "100", "25.00", 3), equity).position;
      const total = Number(formatDecimal(pos.realised)) +
        Number(formatDecimal(unrealised(pos, P("25.00", 2), equity)));
      assert.equal(total, 2000, `${basis} should total 2000`);
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

      assert.equal(formatDecimal(r.position.qty), "-50", "should be short 50");
      assert.equal(formatDecimal(r.realisedDelta), "1000.00", "realises on the 100 closed");
      // The new short's basis is the SELL price, so at a mark of 20 it is flat.
      assert.equal(
        formatDecimal(unrealised(r.position, P("20.00", 2), equity)),
        "0.00",
        "new short must be based at 20.00, not at the old 10.00",
      );
      // And it profits as price falls.
      assert.equal(formatDecimal(unrealised(r.position, P("18.00", 2), equity)), "100.00");
    });
  }
});

describe("short positions", () => {
  test("a short profits when price falls", () => {
    let pos = emptyPosition("average");
    pos = applyFill(pos, fill("sell", "10", "100.00", 1), equity).position;
    assert.equal(formatDecimal(pos.qty), "-10");
    assert.equal(formatDecimal(unrealised(pos, P("90.00", 2), equity)), "100.00");
    assert.equal(formatDecimal(unrealised(pos, P("110.00", 2), equity)), "-100.00");
  });

  test("covering a short realises correctly", () => {
    let pos = emptyPosition("fifo");
    pos = applyFill(pos, fill("sell", "10", "100.00", 1), equity).position;
    const r = applyFill(pos, fill("buy", "10", "90.00", 2), equity);
    assert.equal(formatDecimal(r.realisedDelta), "100.00");
    assert.equal(formatDecimal(r.position.qty), "0");
    assert.equal(r.position.lots.length, 0, "flat position holds no lots");
  });
});

describe("futures multiplier", () => {
  const es: PnlInstrument = { contractType: "linear", multiplier: dec(50n, 0), moneyExp: 2 };

  test("P&L scales by the contract multiplier", () => {
    let pos = emptyPosition("average");
    pos = applyFill(pos, { ...fill("buy", "2", "4500.00", 1), price: P("4500.00", 2) }, es).position;
    // 2 contracts * $50 * 4 points = $400
    assert.equal(formatDecimal(unrealised(pos, P("4504.00", 2), es)), "400.00");
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
    assert.equal(formatDecimal(up), "0.01818182");
    // 10000 * (1/50000 - 1/45000) = -0.02222222...
    assert.equal(formatDecimal(down), "-0.02222222");

    // The asymmetry is the point: a linear formula would give equal magnitudes.
    assert.notEqual(formatDecimal(up).replace("-", ""), formatDecimal(down).replace("-", ""));
  });

  test("a linear formula would be wrong here, and demonstrably so", () => {
    const linearAnswer = closePnl(P("10000", 0), P("50000", 0), P("55000", 0), {
      contractType: "linear",
      multiplier: dec(1n, 0),
      moneyExp: 8,
    });
    const inverseAnswer = closePnl(P("10000", 0), P("50000", 0), P("55000", 0), inverse);
    assert.equal(formatDecimal(linearAnswer), "50000000.00000000");
    assert.equal(formatDecimal(inverseAnswer), "0.01818182");
  });
});

describe("averaging and partial reduces", () => {
  test("average price is the weighted average of the open lots", () => {
    let pos = emptyPosition("average");
    pos = applyFill(pos, fill("buy", "100", "10.00", 1), equity).position;
    pos = applyFill(pos, fill("buy", "300", "20.00", 2), equity).position;
    assert.equal(formatDecimal(averagePrice(pos, 2)), "17.50");
  });

  test("average cost does NOT change the basis on a reduce", () => {
    let pos = emptyPosition("average");
    pos = applyFill(pos, fill("buy", "100", "10.00", 1), equity).position;
    pos = applyFill(pos, fill("buy", "100", "20.00", 2), equity).position;
    const r = applyFill(pos, fill("sell", "50", "30.00", 3), equity);
    assert.equal(formatDecimal(averagePrice(r.position, 2)), "15.00");
    assert.equal(formatDecimal(r.position.qty), "150");
  });

  test("fifo relieves the oldest lot first", () => {
    let pos = emptyPosition("fifo");
    pos = applyFill(pos, fill("buy", "100", "10.00", 1), equity).position;
    pos = applyFill(pos, fill("buy", "100", "20.00", 2), equity).position;
    const r = applyFill(pos, fill("sell", "50", "30.00", 3), equity);
    // relieves 50 of the $10 lot -> 50 * 20 = 1000
    assert.equal(formatDecimal(r.realisedDelta), "1000.00");
    assert.equal(r.position.lots.length, 2);
    assert.equal(formatDecimal(r.position.lots[0]!.qty), "50");
    assert.equal(formatDecimal(r.position.lots[0]!.price), "10.00");
  });

  test("lifo relieves the newest lot first", () => {
    let pos = emptyPosition("lifo");
    pos = applyFill(pos, fill("buy", "100", "10.00", 1), equity).position;
    pos = applyFill(pos, fill("buy", "100", "20.00", 2), equity).position;
    const r = applyFill(pos, fill("sell", "50", "30.00", 3), equity);
    // relieves 50 of the $20 lot -> 50 * 10 = 500
    assert.equal(formatDecimal(r.realisedDelta), "500.00");
  });
});

describe("guards", () => {
  test("a non-positive fill quantity is refused", () => {
    const pos = emptyPosition("fifo");
    assert.throws(
      () => applyFill(pos, { side: "buy", qty: P("0", 0), price: P("1.00", 2), at: 0 }, equity),
      /must be positive/,
    );
  });
});
