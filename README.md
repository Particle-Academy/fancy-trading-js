# @particle-academy/fancy-trading

[![Fancified](art/fancified.svg)](https://particle.academy)

Headless trading domain core for the [Fancy Dev Kit](https://ui.particle.academy). **Zero runtime dependencies.** No React, no network, no opinions about
how you build a strategy.

```bash
npm install @particle-academy/fancy-trading
```

<!-- fancy-agents-note:start -->
> **For agents.** This package is listed on the Fancy MCP catalog server at
> `https://ui.particle.academy/mcp` (streamable HTTP, no API key; MCP id `fancy-ui`),
> with install commands and docs, alongside the rest of the kit. How an agent
> installs and uses this package is in [AGENTS.md](https://github.com/Particle-Academy/fancy-trading-js/blob/main/AGENTS.md).
<!-- fancy-agents-note:end -->

## What it is

The plumbing a trading application needs and should not write twice:

- **Exact decimal money** — integer minor units on `bigint`. `Math.trunc(19.99 * 100)`
  is `1998`; this is not.
- **Position and P&L** — average-cost, FIFO and LIFO, position flips, futures
  multipliers, and inverse (coin-margined) contracts whose P&L is non-linear.
- **The order lifecycle** — the FIX `OrdStatus` / `ExecType` pair, a validated
  transition table, and cumulative-state events that survive a reconnect gap.
- **A trust-but-verify gate** — agents propose, humans confirm, structurally.

## What it is NOT

No strategy DSL, no prescribed workflow, no indicator library, and no advice.
It shows you the shapes; what you build on them is yours.

## Quick look

```ts
import { parseDecimal, formatDecimal } from "@particle-academy/fancy-trading";
import { emptyPosition, applyFill, unrealised } from "@particle-academy/fancy-trading";

const equity = { contractType: "linear" as const, multiplier: parseDecimal("1", 0), moneyExp: 2 };

let pos = emptyPosition("fifo");
pos = applyFill(pos, { side: "buy", qty: parseDecimal("100", 0), price: parseDecimal("10.00", 2), at: 1 }, equity).position;
pos = applyFill(pos, { side: "buy", qty: parseDecimal("100", 0), price: parseDecimal("20.00", 2), at: 2 }, equity).position;

const { position, realisedDelta } = applyFill(
  pos, { side: "sell", qty: parseDecimal("100", 0), price: parseDecimal("25.00", 2), at: 3 }, equity,
);

formatDecimal(realisedDelta);                              // "1500.00"  (FIFO)
formatDecimal(unrealised(position, parseDecimal("25.00", 2), equity)); // "500.00"
```

Switch `emptyPosition("average")` and the same fills realise `1000.00` with
`1000.00` unrealised. Both are correct; they are different questions. That is
why the basis is a required argument.

## Licence

MIT.
