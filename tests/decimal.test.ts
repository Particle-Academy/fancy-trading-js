import { describe, expect, test } from "vitest";
import {
  add,
  cmp,
  dec,
  ZERO,
  type Decimal,
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
    expect(toMinorUnits("19.99", 2)).toBe(1999n);
    // proof the naive version is genuinely wrong, so this test has teeth
    expect(Math.trunc(19.99 * 100)).toBe(1998);
  });

  // Verified by sweeping every 0.01 step up to 2000: these are real trunc
  // failures, not assumed ones.
  for (const [s, expected, naive] of [
    ["0.29", 29n, 28],
    ["0.57", 57n, 56],
    ["1.13", 113n, 112],
  ] as const) {
    test(`${s} at exp 2 is ${expected}, naive trunc gives ${naive}`, () => {
      expect(toMinorUnits(s, 2)).toBe(expected);
      expect(Math.trunc(Number(s) * 100)).toBe(naive);
    });
  }

  test("0.07 and 8.615 are CONTROL rows — the naive version gets these right", () => {
    // Both land correctly under trunc by luck. They are here so that an
    // implementation which "fixes" the cases above by switching trunc for
    // round is not mistaken for a correct one: the bug is the float, not the
    // rounding mode, and only exact parsing removes it.
    expect(toMinorUnits("0.07", 2)).toBe(7n);
    expect(Math.trunc(0.07 * 100)).toBe(7);
    expect(toMinorUnits("8.615", 3)).toBe(8615n);
    expect(Math.trunc(8.615 * 1000)).toBe(8615);
  });

  test("1.005 at exp 2 refuses rather than silently dropping a digit", () => {
    expect(() => toMinorUnits("1.005", 2)).toThrow(/decimal places/);
  });

  test("dec() refuses a non-integer number outright", () => {
    expect(() => dec(19.99, 2)).toThrow(/INTEGER count of minor units/);
  });

  test("summing a cent a million times stays exact", () => {
    let acc = dec(0n, 2);
    const cent = dec(1n, 2);
    for (let i = 0; i < 1_000_000; i++) acc = add(acc, cent);
    expect(formatDecimal(acc)).toBe("10000.00");
    // the float version drifts
    let f = 0;
    for (let i = 0; i < 1_000_000; i++) f += 0.01;
    expect(f).not.toBe(10000);
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
      expect(formatDecimal(parseDecimal(s, exp))).toBe(Number(s) === 0 && s.startsWith("-") ? s.replace("-", "") === s ? s : s : s);
    });
  }

  test("negative fractions format with the sign outside", () => {
    expect(formatDecimal(parseDecimal("-0.05", 2))).toBe("-0.05");
  });

  test("fromMinorUnits inverts toMinorUnits", () => {
    expect(fromMinorUnits(toMinorUnits("19.99", 2), 2)).toBe("19.99");
    expect(fromMinorUnits(-1n, 2)).toBe("-0.01");
  });
});

describe("arithmetic", () => {
  test("add/sub align scales without losing precision", () => {
    expect(formatDecimal(add(parseDecimal("1.5", 1), parseDecimal("0.005", 3)))).toBe("1.505");
    expect(formatDecimal(sub(parseDecimal("1.5", 1), parseDecimal("0.005", 3)))).toBe("1.495");
  });

  test("mul is exact — the scale is the sum of the scales", () => {
    const r = mul(parseDecimal("1.10", 2), parseDecimal("1.10", 2));
    expect(formatDecimal(r)).toBe("1.2100");
    // the float version does not produce 1.21
    expect(1.1 * 1.1).not.toBe(1.21);
  });

  test("div requires an explicit scale and rounding mode", () => {
    expect(formatDecimal(div(parseDecimal("1", 0), parseDecimal("3", 0), 4, "trunc"))).toBe("0.3333");
    expect(formatDecimal(div(parseDecimal("2", 0), parseDecimal("3", 0), 4, "half-up"))).toBe("0.6667");
  });

  test("division by zero throws rather than producing Infinity", () => {
    expect(() => div(parseDecimal("1", 0), parseDecimal("0", 0), 2, "trunc")).toThrow(/division by zero/);
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
      expect(formatDecimal(rescale(parseDecimal(input, 1), exp, mode))).toBe(expected);
    });
  }
});

describe("tick rounding", () => {
  const quarter = () => parseDecimal("0.25", 2); // ES futures

  test("rounds a price onto a constant tick grid", () => {
    expect(formatDecimal(roundToTick(parseDecimal("4500.13", 2), quarter))).toBe("4500.25");
    expect(formatDecimal(roundToTick(parseDecimal("4500.12", 2), quarter))).toBe("4500.00");
  });

  test("tick size is a FUNCTION of price — a scalar cannot express Kalshi", () => {
    // Kalshi's price_level_structure gives a different step in different ranges.
    // Below $0.05 the step is 0.001; above it, 0.01.
    const kalshi = (p: { v: bigint; exp: number }) =>
      cmp(p, parseDecimal("0.05", 4)) < 0 ? parseDecimal("0.001", 4) : parseDecimal("0.01", 4);

    expect(formatDecimal(roundToTick(parseDecimal("0.0234", 4), kalshi))).toBe("0.0230");
    expect(formatDecimal(roundToTick(parseDecimal("0.4234", 4), kalshi))).toBe("0.4200");
  });
});

describe("a malformed Decimal names itself", () => {
  // Reported as fancy-trading-js#1. `parseDecimal` accepted a missing `exp` and
  // returned `{ v, exp: undefined }`. Two consequences, and the SECOND is the
  // dangerous one: arithmetic threw "Cannot mix BigInt and other types", and
  // `formatDecimal` silently returned a different number.
  //
  //   parseDecimal("1.0")                  -> { v: 10n, exp: undefined }
  //   formatDecimal(parseDecimal("1.0"))   -> ".10"   <- wrong, no error
  //
  // `dec()` already refused a bad `exp`; `parseDecimal` simply did not, and the
  // two are the only ways in. Nothing downstream can recover a scale that was
  // never recorded, so the value has to be refused where it is constructed.

  test("refuses a missing exp instead of building a scale-less value", () => {
    // @ts-expect-error — the type says exp is required; JS callers can omit it.
    expect(() => parseDecimal("1.0")).toThrow(RangeError);
    // @ts-expect-error — the same deliberate omission of exp (TS2554 without it); this time the message must name exp.
    expect(() => parseDecimal("1.0")).toThrow(/exp/);
  });

  test("refuses a non-integer or negative exp, exactly as dec() does", () => {
    expect(() => parseDecimal("1.0", 1.5)).toThrow(RangeError);
    expect(() => parseDecimal("1.0", -1)).toThrow(RangeError);
  });

  test("still parses correctly once exp is supplied", () => {
    expect(formatDecimal(parseDecimal("1.0", 1))).toBe("1.0");
    expect(formatDecimal(add(parseDecimal("0.1", 2), parseDecimal("0.2", 2)))).toBe("0.30");
  });

  test("blames the malformed VALUE, not the arithmetic that received it", () => {
    // The original error said "Cannot mix BigInt and other types", which points
    // at align() rather than at whatever produced the bad input — the reporter
    // said that cost them a while. Arithmetic now names the offender.
    const bad = { v: 10n } as unknown as Decimal;

    expect(() => add(bad, dec(1n, 0))).toThrow(TypeError);
    expect(() => add(bad, dec(1n, 0))).toThrow(/exp/);
  });

  test("catches ZERO passed without being called", () => {
    // `ZERO` is a FUNCTION taking an exp, so `add(ZERO, x)` passes the function
    // itself. It reads like a constant, which is exactly why it needs to say so.
    expect(() => add(ZERO as unknown as Decimal, dec(1n, 0))).toThrow(TypeError);
    // And the correct call keeps working.
    expect(formatDecimal(add(ZERO(2), parseDecimal("1.50", 2)))).toBe("1.50");
  });
});
