/**
 * Exact decimal arithmetic on scaled integers.
 *
 * Money is never a float here, and neither is a price, a size, or a P&L. Every
 * value is an integer `v` plus a decimal exponent `exp`, so `19.99` at exp 2 is
 * `{ v: 1999n, exp: 2 }` and nothing is ever rounded by the representation.
 *
 * The trap this exists to remove is one line long and one cent wide:
 * `Math.trunc(19.99 * 100)` is **1998** in every IEEE-754 language, because the
 * nearest double to 19.99 is 19.98999999999999843... Trading multiplies that
 * mistake by every fill.
 *
 * There is no third-party decimal library here on purpose. The arithmetic is
 * `bigint` addition and multiplication plus an explicit rounding decision on
 * division, which is the part a library would hide and the part that has to be
 * chosen per call site anyway.
 */

/** A decimal value as `v / 10^exp`. `exp` is always >= 0. */
export type Decimal = { readonly v: bigint; readonly exp: number };

/** How to resolve a division that does not land exactly on the target scale. */
export type Rounding =
  | "trunc" // toward zero
  | "floor" // toward -inf
  | "ceil" // toward +inf
  | "half-up" // .5 away from zero — the common money convention
  | "half-even"; // .5 to even — banker's rounding

const POW10: bigint[] = [];
function pow10(n: number): bigint {
  if (n < 0) throw new RangeError(`negative exponent: ${n}`);
  for (let i = POW10.length; i <= n; i++) {
    POW10[i] = i === 0 ? 1n : POW10[i - 1]! * 10n;
  }
  return POW10[n]!;
}

export function dec(v: bigint | number | string, exp: number): Decimal {
  if (!Number.isInteger(exp) || exp < 0) {
    throw new RangeError(`exp must be a non-negative integer, got ${exp}`);
  }
  if (typeof v === "bigint") return { v, exp };
  if (typeof v === "number") {
    if (!Number.isInteger(v)) {
      // Refusing this is the whole point: accepting 19.99 here would silently
      // reintroduce the float that the type exists to keep out.
      throw new TypeError(
        `dec() takes an INTEGER count of minor units, got ${v}. ` +
          `Use parseDecimal("${v}", ${exp}) to convert a decimal string.`,
      );
    }
    return { v: BigInt(v), exp };
  }
  return { v: BigInt(v), exp };
}

/**
 * Parse a decimal STRING exactly. This is the only supported way in, because a
 * string is the only representation that has not already lost precision.
 */
export function parseDecimal(s: string, exp: number): Decimal {
  // The same guard `dec()` carries. Without it a caller who omitted `exp` —
  // legal in plain JS, where the type cannot stop them — got back
  // `{ v, exp: undefined }`: `frac.length > undefined` is false so the
  // precision check never fired, and `padEnd(undefined)` left the fraction
  // unpadded. The result was a value with no scale, which formatted as a
  // DIFFERENT number (`parseDecimal("1.0")` rendered as ".10") and threw an
  // unrelated-looking BigInt error the moment it met arithmetic.
  //
  // Refused here rather than repaired: nothing downstream can recover a scale
  // that was never recorded, and guessing one is how a price quietly becomes a
  // different price. These two constructors are the only ways in, so this is
  // where it has to be caught. Reported as fancy-trading-js#1.
  if (!Number.isInteger(exp) || exp < 0) {
    throw new RangeError(
      `exp must be a non-negative integer, got ${exp}. ` +
        `parseDecimal needs the scale explicitly — e.g. parseDecimal(${JSON.stringify(s)}, 2).`,
    );
  }
  const t = s.trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) {
    throw new TypeError(`not a decimal: ${JSON.stringify(s)}`);
  }
  const sign = m[1] === "-" ? -1n : 1n;
  const whole = m[2] || "0";
  const frac = m[3] ?? "";
  if (frac.length > exp) {
    // Silently dropping digits is how a price becomes a slightly different
    // price. The caller must say what should happen.
    throw new RangeError(
      `"${s}" has ${frac.length} decimal places, more than exp ${exp}. ` +
        `Use rescale(..., "${exp}", rounding) to state the rounding explicitly.`,
    );
  }
  const padded = frac.padEnd(exp, "0");
  return { v: sign * BigInt(whole + (padded === "" ? "" : padded)), exp };
}

/** Render exactly, with all `exp` decimal places. Never lossy. */
export function formatDecimal(d: Decimal): string {
  const neg = d.v < 0n;
  const abs = neg ? -d.v : d.v;
  const s = abs.toString().padStart(d.exp + 1, "0");
  const whole = s.slice(0, s.length - d.exp);
  const frac = d.exp === 0 ? "" : "." + s.slice(s.length - d.exp);
  return (neg ? "-" : "") + whole + frac;
}

function applyRounding(q: bigint, r: bigint, den: bigint, mode: Rounding): bigint {
  if (r === 0n) return q;
  const negative = r < 0n !== den < 0n;
  const twice = (r < 0n ? -r : r) * 2n;
  const d = den < 0n ? -den : den;
  switch (mode) {
    case "trunc":
      return q;
    case "floor":
      return negative ? q - 1n : q;
    case "ceil":
      return negative ? q : q + 1n;
    case "half-up":
      if (twice >= d) return negative ? q - 1n : q + 1n;
      return q;
    case "half-even":
      if (twice > d) return negative ? q - 1n : q + 1n;
      if (twice < d) return q;
      return q % 2n === 0n ? q : negative ? q - 1n : q + 1n;
  }
}

/** Change the scale of a value, rounding explicitly when digits are lost. */
export function rescale(d: Decimal, exp: number, mode: Rounding = "half-up"): Decimal {
  if (exp === d.exp) return d;
  if (exp > d.exp) return { v: d.v * pow10(exp - d.exp), exp };
  const den = pow10(d.exp - exp);
  const q = d.v / den;
  const r = d.v % den;
  return { v: applyRounding(q, r, den, mode), exp };
}

/**
 * Reject a value that is not a well-formed Decimal, naming what is wrong.
 *
 * Without this, a malformed operand surfaced from inside `align` as
 * "Cannot mix BigInt and other types" — an error that points at the
 * arithmetic rather than at whatever produced the bad input. The consumer who
 * reported it said that misdirection cost them a while, and they were right
 * to: the arithmetic was correct the whole time.
 */
function assertDecimal(d: Decimal, role: string): void {
  if (typeof d === "function") {
    // `ZERO` takes an exp and reads like a constant, so `add(ZERO, x)` passes
    // the function itself. Common enough to name directly.
    throw new TypeError(
      `${role} is a function, not a Decimal — did you mean ZERO(exp)? ` +
        `exp is missing because the value was never constructed.`,
    );
  }
  if (d === null || typeof d !== "object" || typeof d.v !== "bigint" || !Number.isInteger(d.exp)) {
    throw new TypeError(
      `${role} is not a Decimal: expected { v: bigint, exp: integer }, got ` +
        `${JSON.stringify(d, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}. ` +
        `Build one with dec() or parseDecimal(value, exp).`,
    );
  }
}

/** Line the two values up on the wider scale — exact, never lossy. */
function align(a: Decimal, b: Decimal): [bigint, bigint, number] {
  assertDecimal(a, "left operand");
  assertDecimal(b, "right operand");
  const exp = Math.max(a.exp, b.exp);
  return [a.v * pow10(exp - a.exp), b.v * pow10(exp - b.exp), exp];
}

export function add(a: Decimal, b: Decimal): Decimal {
  const [x, y, exp] = align(a, b);
  return { v: x + y, exp };
}

export function sub(a: Decimal, b: Decimal): Decimal {
  const [x, y, exp] = align(a, b);
  return { v: x - y, exp };
}

/** Exact product. The scale is the sum of the scales, so nothing is rounded. */
export function mul(a: Decimal, b: Decimal): Decimal {
  return { v: a.v * b.v, exp: a.exp + b.exp };
}

/**
 * Divide to a stated scale with a stated rounding mode. Both are required
 * arguments because there is no correct default: a fee rounds differently from
 * a share count, and an inverse-contract P&L differently again.
 */
export function div(a: Decimal, b: Decimal, exp: number, mode: Rounding): Decimal {
  if (b.v === 0n) throw new RangeError("division by zero");
  // (a.v / 10^a.exp) / (b.v / 10^b.exp) scaled to 10^exp
  const num = a.v * pow10(b.exp + exp);
  const den = b.v * pow10(a.exp);
  const q = num / den;
  const r = num % den;
  return { v: applyRounding(q, r, den, mode), exp };
}

export function neg(a: Decimal): Decimal {
  return { v: -a.v, exp: a.exp };
}

export function abs(a: Decimal): Decimal {
  return { v: a.v < 0n ? -a.v : a.v, exp: a.exp };
}

export function cmp(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export const eq = (a: Decimal, b: Decimal): boolean => cmp(a, b) === 0;
export const lt = (a: Decimal, b: Decimal): boolean => cmp(a, b) < 0;
export const lte = (a: Decimal, b: Decimal): boolean => cmp(a, b) <= 0;
export const gt = (a: Decimal, b: Decimal): boolean => cmp(a, b) > 0;
export const gte = (a: Decimal, b: Decimal): boolean => cmp(a, b) >= 0;
export const isZero = (a: Decimal): boolean => a.v === 0n;
export const sign = (a: Decimal): -1 | 0 | 1 => (a.v < 0n ? -1 : a.v > 0n ? 1 : 0);

export const ZERO = (exp = 0): Decimal => ({ v: 0n, exp });

/**
 * Convert a decimal STRING to integer minor units — the conformance case.
 * `toMinorUnits("19.99", 2)` is `1999n`, not `1998n`.
 */
export function toMinorUnits(amount: string, exponent: number): bigint {
  return parseDecimal(amount, exponent).v;
}

/** Inverse of {@link toMinorUnits}. */
export function fromMinorUnits(minor: bigint, exponent: number): string {
  return formatDecimal({ v: minor, exp: exponent });
}

/**
 * Round a price to a venue's tick grid.
 *
 * `tickSize` is a FUNCTION of price, not a scalar, because Kalshi's
 * `price_level_structure` gives different steps in different price ranges and a
 * scalar tick cannot express it. Venues with a constant tick pass `() => tick`.
 */
export function roundToTick(
  price: Decimal,
  tickSizeAt: (p: Decimal) => Decimal,
  mode: Rounding = "half-up",
): Decimal {
  const tick = tickSizeAt(price);
  if (tick.v === 0n) throw new RangeError("tick size must be non-zero");
  const steps = div(price, tick, 0, mode);
  return rescale(mul(steps, tick), Math.max(price.exp, tick.exp), "trunc");
}
