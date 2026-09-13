# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

This package is pre-1.0: **breaking changes land in MINOR releases**, so read
the entry before upgrading a minor. The version number cannot carry that promise
yet and saying so is more useful than implying otherwise.

## [Unreleased]

## [0.2.1] - 2026-09-13

### Fixed

- **The package description on npm reads "â€”" where it means "—".** The em dash in `package.json` was double-encoded (UTF-8 bytes read as Windows-1252 and saved again), so the registry page and `npm view` showed mojibake. Fixed in the source; it reaches npm with the next release. Nothing to do.

### Security

- Development only: `esbuild` is overridden to `^0.28.1` for GHSA-g7r4-m6w7-qqqr (arbitrary file read from the dev server on Windows), matching the rest of the kit. It is a build tool, not shipped in the package.

## [0.2.0] - 2026-09-03

### Fixed

- **`parseDecimal` accepted a missing `exp` and returned a value with no
  scale.** In plain JS a caller can omit the second argument, and nothing
  refused it: `frac.length > undefined` is false so the precision check never
  fired, and `padEnd(undefined)` left the fraction unpadded. The result was
  `{ v: 10n, exp: undefined }` (fancy-trading-js#1).

  Two consequences, and the second is the one that matters:

  - arithmetic threw `TypeError: Cannot mix BigInt and other types`;
  - **`formatDecimal` silently returned a different number** —
    `formatDecimal(parseDecimal("1.0"))` rendered `".10"`, with no error.

  The arithmetic was never wrong. `dec()` already refused a bad `exp`;
  `parseDecimal` — the only other way in — did not, so it now carries the same
  guard. The value is REFUSED rather than repaired: nothing downstream can
  recover a scale that was never recorded, and guessing one is how a price
  quietly becomes a different price.

  **BREAKING in the sense that matters:** a call that omitted `exp` used to
  return a wrong value and now throws. Any code it breaks was already computing
  the wrong number. Pass the scale — `parseDecimal("1.0", 1)`.

### Changed

- **A malformed operand now names itself.** Arithmetic validates its inputs, so
  a bad value reports `left operand is not a Decimal: expected { v: bigint,
  exp: integer }` instead of surfacing as a BigInt mixing error from inside
  `align`. The old message pointed at the arithmetic rather than at whatever
  produced the input; the reporter said that misdirection cost them a while.

  `ZERO` is a function taking an exp and reads like a constant, so
  `add(ZERO, x)` — passing the function itself — is called out by name with the
  fix: `did you mean ZERO(exp)?`


## [0.1.0] - 2026-08-19

### Added

- **Exact decimal arithmetic** (`src/decimal.ts`) on `{ v: bigint, exp: number }`
  scaled integers, with `parseDecimal` / `formatDecimal` round-tripping exactly.
  `div` requires an explicit target scale AND rounding mode — there is no correct
  default, and hiding the choice is how a fee and a share count end up rounded
  the same way. Five rounding modes including `half-even`.
- **`roundToTick`, where tick size is a FUNCTION of price**, not a scalar —
  Kalshi's `price_level_structure` gives different steps in different price
  ranges and a scalar tick cannot express it. Constant-tick venues pass
  `() => tick`.
- **Position and P&L** (`src/position.ts`) with **average-cost, FIFO and LIFO**
  bases, correct position-flip handling, short positions, futures multipliers,
  and **inverse (coin-margined) contracts**, whose P&L is non-linear in price.
- **The order model and lifecycle** (`src/order.ts`): the FIX-derived
  `OrdStatus` / `ExecType` pair, a validated transition table, cumulative-state
  events, cancel/replace-reject handling that returns the order to its prior
  state, and `ExecType.OrderStatus` as the reconnect repair path.
- **`submittable()` — the trust-but-verify gate.** Human-origin intents pass
  through; agent-origin intents require a branded `Approval` obtainable only
  from `approve()`. Not defeatable by any option.
- **`isReconciliationBreak()`** — surfaces a disagreement between our view and
  the venue's rather than letting it diverge silently.
- **`Order.receivedAt` and `Order.becameExecutableAt`**, plus an idempotent
  `markExecutable()`. SEC Rule 605 measures time-to-execution from the moment an
  order became EXECUTABLE — not from receipt — for every non-marketable limit and
  stop order. That moment is driven by market data, so no venue event carries it:
  **if it is not stamped as it happens it cannot be reconstructed**, and the
  report becomes impossible to produce. `markExecutable` is idempotent so a
  re-triggering stop does not reset the clock.

- **A `shared/trading-pnl` conformance table** in `fancy-conformance`, wired up
  in `tests/conformance.test.ts`. 11 rows covering the three-way cost-basis
  disagreement, position flips, inverse-contract non-linearity and the futures
  multiplier — so the eventual PHP and Python twins are checked against the same
  table rather than trusted.

### Notes

- **Zero RUNTIME dependencies**, and that is a maintained property rather than a
  current fact — `dependencies` is empty and the allowlist gate keeps it honest.
- Tests run on **vitest**, matching every sibling package.
