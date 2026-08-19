# AGENTS.md — fancy-trading-js

The headless trading domain core. `CLAUDE.md` points here. Read the envelope's
`AGENTS.md` too — process rules live there, not here.

## The rule that shapes this repo

**Zero runtime dependencies, and it stays that way.** `dependencies` is empty.
Everything in here is a distinct data shape the kit exists to provide —
instrument and order models, position and P&L arithmetic, normalisation across
asset classes — so it is homegrown by policy, not by preference.

That includes the decimal arithmetic. A decimal library would hide the one
decision that must be made per call site: **what rounding, at what scale**. So
`div()` takes both as required arguments and there is no default.

## The three things that are wrong in most implementations

Each has a test that fails against the naive version. If you change this code,
those tests are the specification.

1. **Money is never a float.** `Math.trunc(19.99 * 100)` is **1998**. Values are
   `{ v: bigint, exp: number }` and the only way in from a decimal is
   `parseDecimal(string, exp)`. `dec()` **throws** on a non-integer `number`,
   deliberately — accepting `19.99` there would reintroduce the float the type
   exists to keep out. Verified real trunc failures: `0.29`, `0.57`, `1.13`.
   `0.07` and `8.615` are CONTROL rows the naive version gets right by luck;
   they exist so a "fix" that only swaps trunc for round is not mistaken for a
   correct one.

2. **Realised P&L depends on the cost-basis method, and the methods disagree.**
   Buy 100@10, buy 100@20, sell 100@25 realises **1500 (FIFO) / 1000 (average) /
   500 (LIFO)** — identical total economic P&L, different realised/unrealised
   split. That split is what tax, the daily blotter and any realised-P&L risk
   limit fire on. Never report a realised number without its method.

3. **A position flip is a close plus an open.** Buy 100, sell 150 closes 100 and
   opens a **new short of 50 based at the SELL price** — not "−50 at the old
   average". Tested under all three bases.

Plus one that only bites on crypto: **inverse contracts are non-linear.**
`(exit − entry) * qty` is wrong for a coin-margined contract, where P&L accrues
in the base currency as `contracts * multiplier * (1/entry − 1/exit)`. Equal
moves up and down produce *unequal* P&L, and there is a test asserting exactly
that asymmetry.

## The order model

**Two state fields, not one**, following FIX. `OrdStatus` is where the ORDER is;
`ExecType` is what THIS REPORT is. One report legitimately says
`ExecType.Trade` + `OrdStatus.PartiallyFilled`. A single-status model cannot
represent that, and cannot represent `Restated` at all.

**Every event carries cumulative state** (`cumQty`, `leavesQty`, `avgPx`), and
`applyEvent` **takes those from the event rather than accumulating locally**.
That is what makes a dropped message repairable by the next one. A stream of
deltas is unrecoverable after a gap, and a gap is guaranteed — it is called a
reconnect.

**`DoneForDay` is NOT terminal.** A GTC order comes back tomorrow. Treating it
as terminal silently drops working orders.

**`ExecType.OrderStatus` may assert any state** without a transition check — it
is the solicited snapshot that repairs state after a reconnect.

## The safety gate — do not weaken this

`submittable(intent, approval?)` is the only path to a submittable order.

- A **`human`** intent passes through with no approval. A trader's own one-click
  is a human decision and this kit does not second-guess it.
- An **`agent`** intent **requires** a matching `Approval`, and `Approval` is a
  branded type whose only constructor is `approve()`. An unapproved agent order
  is not "rejected at runtime" — it is unrepresentable.
- `origin` is **set by the transport, never the caller.** An intent arriving
  over the MCP bridge is stamped `agent` at the bridge boundary.
- **There is no options object, no `pendingMode: false`, no force flag**, and a
  test asserts `submittable.length === 2` as a tripwire against one being added.

An approval naming a different `clientOrderId` does not authorise the intent —
that is the confused-deputy shape (approve a $10 order, submit a $10,000 one)
and it has its own test.

## Commands

```bash
npm test        # node --test over tests/*.ts — no install required
npm run typecheck
```

## Conventions

- **Tests run on Node's built-in runner** (`node:test` + `node:assert`), not
  vitest, because this package currently has **no `node_modules` at all** — no
  third-party code has been installed here. That is a deliberate state under the
  standing approval rule, not an oversight. Converting to vitest is a small
  change once the toolchain is approved; the assertions are the same shape.
- **`erasableSyntaxOnly` is on** in `tsconfig.json`. Node's type-stripping does
  NOT support TypeScript parameter properties (`constructor(public readonly x)`)
  or enums — the compiler flag makes that a type error rather than a runtime
  surprise.
- Import paths carry the **`.ts` extension**, which is what lets Node run the
  sources directly.
- `Decimal` is a plain `{ v, exp }` object so it is structurally comparable and
  cheap. It is deliberately **not** JSON-serialisable as-is (`bigint`); use
  `formatDecimal` at the wire boundary.
