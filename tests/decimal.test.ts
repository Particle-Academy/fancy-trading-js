import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  add,
  cmp,
  dec,
  div,
  formatDecimal,
  fromMinorUnits,
  mul,
  parseDecimal,
  rescale,
  roundToTick,
  sub,
  toMinorUnits,
} from "../src/decimal.ts";

describe("the float traps", () => {
  // Every row here FAILS against `Math.trunc(Number(s) * 10 ** exp)`, which is
  // the implementation everyone writes first.
  test("19.99 at exp 2 is 1999, not 1998", () => {
    assert.equal(toMinorUnits("19.99", 2), 1999n);
    // proof the naive version is genuinely wrong, so this test has teeth
    assert.equal(Math.trunc(19.99 * 100), 1998);
  });

  // Verified by sweeping every 0.01 step up to 2000: these are real trunc
  // failures, not assumed ones.
  for (const [s, expected, naive] of [
    ["0.29", 29n, 28],
    ["0.57", 57n, 56],
    ["1.13", 113n, 112],
  ] as const) {
    test(`${s} at exp 2 is ${expected}, naive trunc gives ${naive}`, () => {
      assert.equal(toMinorUnits(s, 2), expected);
      assert.equal(Math.trunc(Number(s) * 100), naive);
    });
  }

  test("0.07 and 8.615 are CONTROL rows — the naive version gets these right", () => {
    // Both land correctly under trunc by luck. They are here so that an
    // implementation which "fixes" the cases above by switching trunc for
    // round is not mistaken for a correct one: the bug is the float, not the
    // rounding mode, and only exact parsing removes it.
    assert.equal(toMinorUnits("0.07", 2), 7n);
    assert.equal(Math.trunc(0.07 * 100), 7);
    assert.equal(toMinorUnits("8.615", 3), 8615n);
    assert.equal(Math.trunc(8.615 * 1000), 8615);
  });

  test("1.005 at exp 2 refuses rather than silently dropping a digit", () => {
    assert.throws(() => toMinorUnits("1.005", 2), /decimal places/);
  });

  test("dec() refuses a non-integer number outright", () => {
    assert.throws(() => dec(19.99, 2), /INTEGER count of minor units/);
  });

  test("summing a cent a million times stays exact", () => {
    let acc = dec(0n, 2);
    const cent = dec(1n, 2);
    for (let i = 0; i < 1_000_000; i++) acc = add(acc, cent);
    assert.equal(formatDecimal(acc), "10000.00");
    // the float version drifts
    let f = 0;
    for (let i = 0; i < 1_000_000; i++) f += 0.01;
    assert.notEqual(f, 10000);
  });
});

describe("parse / format round-trip", () => {
  for (const [s, exp] of [
    ["0", 0],
    ["0.00", 2],
    ["-0.01", 2],
    ["123.4567", 4],
    ["-98765.4321", 4],
    ["1000000.00", 2],
  ] as const) {
    test(`${s} @ ${exp}`, () => {
      assert.equal(formatDecimal(parseDecimal(s, exp)), Number(s) === 0 && s.startsWith("-") ? s.replace("-", "") === s ? s : s : s);
    });
  }

  test("negative fractions format with the sign outside", () => {
    assert.equal(formatDecimal(parseDecimal("-0.05", 2)), "-0.05");
  });

  test("fromMinorUnits inverts toMinorUnits", () => {
    assert.equal(fromMinorUnits(toMinorUnits("19.99", 2), 2), "19.99");
    assert.equal(fromMinorUnits(-1n, 2), "-0.01");
  });
});

describe("arithmetic", () => {
  test("add/sub align scales without losing precision", () => {
    assert.equal(formatDecimal(add(parseDecimal("1.5", 1), parseDecimal("0.005", 3))), "1.505");
    assert.equal(formatDecimal(sub(parseDecimal("1.5", 1), parseDecimal("0.005", 3))), "1.495");
  });

  test("mul is exact — the scale is the sum of the scales", () => {
    const r = mul(parseDecimal("1.10", 2), parseDecimal("1.10", 2));
    assert.equal(formatDecimal(r), "1.2100");
    // the float version does not produce 1.21
    assert.notEqual(1.1 * 1.1, 1.21);
  });

  test("div requires an explicit scale and rounding mode", () => {
    assert.equal(formatDecimal(div(parseDecimal("1", 0), parseDecimal("3", 0), 4, "trunc")), "0.3333");
    assert.equal(formatDecimal(div(parseDecimal("2", 0), parseDecimal("3", 0), 4, "half-up")), "0.6667");
  });

  test("division by zero throws rather than producing Infinity", () => {
    assert.throws(() => div(parseDecimal("1", 0), parseDecimal("0", 0), 2, "trunc"), /division by zero/);
  });
});

describe("rounding modes, including the signed cases", () => {
  const cases: Array<[string, number, Parameters<typeof rescale>[2], string]> = [
    ["2.5", 0, "half-up", "3"],
    ["-2.5", 0, "half-up", "-3"],
    ["2.5", 0, "half-even", "2"],
    ["3.5", 0, "half-even", "4"],
    ["-2.5", 0, "half-even", "-2"],
    ["2.4", 0, "trunc", "2"],
    ["-2.4", 0, "trunc", "-2"],
    ["-2.4", 0, "floor", "-3"],
    ["2.4", 0, "ceil", "3"],
    ["-2.4", 0, "ceil", "-2"],
  ];
  for (const [input, exp, mode, expected] of cases) {
    test(`${input} -> exp ${exp} (${mode}) = ${expected}`, () => {
      assert.equal(formatDecimal(rescale(parseDecimal(input, 1), exp, mode)), expected);
    });
  }
});

describe("tick rounding", () => {
  const quarter = () => parseDecimal("0.25", 2); // ES futures

  test("rounds a price onto a constant tick grid", () => {
    assert.equal(formatDecimal(roundToTick(parseDecimal("4500.13", 2), quarter)), "4500.25");
    assert.equal(formatDecimal(roundToTick(parseDecimal("4500.12", 2), quarter)), "4500.00");
  });

  test("tick size is a FUNCTION of price — a scalar cannot express Kalshi", () => {
    // Kalshi's price_level_structure gives a different step in different ranges.
    // Below $0.05 the step is 0.001; above it, 0.01.
    const kalshi = (p: { v: bigint; exp: number }) =>
      cmp(p, parseDecimal("0.05", 4)) < 0 ? parseDecimal("0.001", 4) : parseDecimal("0.01", 4);

    assert.equal(formatDecimal(roundToTick(parseDecimal("0.0234", 4), kalshi)), "0.0230");
    assert.equal(formatDecimal(roundToTick(parseDecimal("0.4234", 4), kalshi)), "0.4200");
  });
});
