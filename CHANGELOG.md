# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

This package is pre-1.0: **breaking changes land in MINOR releases**, so read
the entry before upgrading a minor. The version number cannot carry that promise
yet and saying so is more useful than implying otherwise.

## [Unreleased]

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

### Notes

- **Zero runtime dependencies**, and that is a maintained property rather than a
  current fact.
- Tests run on **Node's built-in test runner**; no third-party packages are
  installed in this repo. See `AGENTS.md`.
