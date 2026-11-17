# Using @particle-academy/fancy-trading — guide for agents

How an agent installs and uses this package in a consumer app. What the package
is, is in [README.md](./README.md). Notes for working ON this repo's code are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Install

```bash
npm install @particle-academy/fancy-trading
```

- **Node:** `>=22`. Zero runtime dependencies; no React, no network.
- The repo is `fancy-trading-js`; the npm name is `@particle-academy/fancy-trading`.
- The UI surfaces (chart, order ticket, depth) are `fancy-trading-ui`.

## Find it on the Fancy MCP server

The catalog server is `https://ui.particle.academy/mcp` (streamable HTTP, no API
key; MCP id `fancy-ui`). The registry entry is slug `fancy-trading-js`. Find it
with `search-backend-packages` (stack `node`) and get the exact commands with
`install-instructions`.

## API essentials

- **Decimals:** `Decimal` is `{ v: bigint, exp: number }`. Build from a string
  with `parseDecimal("19.99", 2)`; print with `formatDecimal`. Arithmetic:
  `add`, `sub`, `mul`, `div` (rounding and scale are required), `neg`, `abs`,
  `cmp`, `eq` / `lt` / `lte` / `gt` / `gte`, `isZero`, `sign`, `rescale`,
  `roundToTick`, `toMinorUnits`, `fromMinorUnits`, `ZERO`.
- **Positions:** `emptyPosition("fifo" | "average" | "lifo")`,
  `applyFill(position, fill, instrument)` (returns `{ position, realisedDelta }`),
  `unrealised(position, price, instrument)`, `averagePrice`, `closePnl`.
  An instrument is `{ contractType: "linear" | "inverse" | "spot", multiplier, moneyExp }`.
- **Orders (FIX model):** `OrdStatus`, `ExecType`, `newOrder`, `applyEvent`,
  `canTransition`, `isTerminal`, `markExecutable`, `impliedAvgPx`,
  `isReconciliationBreak`.
- **The safety gate:** `submittable(intent, approval?)` is the only path to a
  submittable order. A `human` intent passes; an `agent` intent needs an
  `Approval` built by `approve()` for the same `clientOrderId`.

## Traps

- **Never pass a float as money.** `dec()` throws on a non-integer `number`; use
  `parseDecimal(string, exp)`.
- **`Decimal` is not JSON-serialisable** (`bigint`); use `formatDecimal` at the
  wire boundary.
- **Realised P&L depends on the cost basis** (FIFO, average, LIFO give different
  realised numbers for the same fills). Always report the method with the
  number.
- **A position flip is a close plus an open**: the new side is based at the
  flipping fill's price.
- **Inverse (coin-margined) contracts are non-linear**; set `contractType:
  "inverse"`, never compute `(exit - entry) * qty` yourself.
- **Feed `applyEvent` the cumulative fields** (`cumQty`, `leavesQty`, `avgPx`)
  from each execution report; it takes them from the event, which is what lets
  a later report repair a gap.
- **`DoneForDay` is not terminal**; a GTC order comes back.
- **An intent's `origin` is set by the transport, never the caller.** Anything
  arriving over an MCP bridge is `agent` and needs a human's approval. There is
  no flag to skip it.
- **No strategy DSL, indicators or advice** ship here.
- **Pre-1.0:** breaking changes land in MINOR releases.
