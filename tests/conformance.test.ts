import { describe, expect, it } from "vitest";
import {
  formatSummary,
  listSuites,
  loadSuite,
  runTable,
  type ConformanceCase,
} from "@particle-academy/fancy-conformance";

import { formatDecimal, parseDecimal as P } from "../src/decimal.ts";
import { applyFill, closePnl, emptyPosition, unrealised, type CostBasis } from "../src/position.ts";

const SUITE = "shared/trading-pnl";

/**
 * The `shared/trading-pnl` table, run against THIS side.
 *
 * The point of the table is cross-LANGUAGE parity: the PHP and Python twins
 * will read the identical rows from the identical file, so a divergence is a
 * red build in whichever runtime drifted rather than a support ticket months
 * later. The rows themselves are already asserted inline in `position.test.ts`
 * — this file adds the shared-table mechanism, not the coverage.
 *
 * Loaded from the INSTALLED package, never a relative path to a sibling
 * checkout. The conformance repo's own notes record why: two older parity
 * harnesses hard-coded `../../<repo>/src/`, so they worked in exactly one
 * directory layout and silently no-op'd everywhere else, CI included.
 *
 * ## Why this can be skipped, and why that is not the usual lie
 *
 * The suite is authored in `repos/fancy-conformance` and is not on the registry
 * yet. Until it ships, the installed package genuinely does not contain it.
 * A skip here is honest ONLY because:
 *
 *   1. every row is independently asserted inline in `position.test.ts`, so
 *      nothing is uncovered while this sleeps; and
 *   2. the skip names the exact remedy, and the guard below FAILS rather than
 *      skips once the suite is present, so it cannot quietly stay asleep.
 */
const available = listSuites().includes(SUITE);

/** Moved deliberately, never automatically. A pin that follows disk asserts nothing. */
const PINNED_SUITE_VERSION = "0.5.0";

/** Dispatch one case to the implementation under test. */
function runCase(c: ConformanceCase): unknown {
  const i = c.input as Record<string, string | number | CostBasis | Array<Record<string, string | number>>>;
  const inst = {
    contractType: i.contractType as "linear" | "inverse" | "spot",
    multiplier: P(String(i.multiplier), 0),
    moneyExp: Number(i.moneyExp),
  };

  if (c.fn === "closePnl") {
    return formatDecimal(
      closePnl(P(String(i.qty), 0), P(String(i.entry), inst.moneyExp === 8 ? 0 : 2), P(String(i.exit), inst.moneyExp === 8 ? 0 : 2), inst),
    );
  }

  if (c.fn === "realisedAndUnrealised") {
    let pos = emptyPosition(i.basis as CostBasis, inst.moneyExp);
    for (const f of i.fills as Array<Record<string, string | number>>) {
      pos = applyFill(
        pos,
        {
          side: f.side as "buy" | "sell",
          qty: P(String(f.qty), 0),
          price: P(String(f.price), inst.moneyExp),
          at: Number(f.at),
        },
        inst,
      ).position;
    }
    return {
      realised: formatDecimal(pos.realised),
      unrealised: formatDecimal(unrealised(pos, P(String(i.mark), inst.moneyExp), inst)),
      qty: formatDecimal(pos.qty),
    };
  }

  throw new Error(`unknown fn in ${SUITE}: ${String(c.fn)}`);
}

describe.skipIf(!available)(SUITE, () => {
  it("the installed suite is the version this package was pinned to", () => {
    expect(loadSuite(SUITE).manifest.since).toBe(PINNED_SUITE_VERSION);
  });

  it("every row passes", () => {
    const summary = runTable(SUITE, runCase, { language: "node" });
    if (summary.failed > 0) throw new Error("\n" + formatSummary(summary));
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBeGreaterThan(0);
  });

  it("the table still contains the rows that carry the weight", () => {
    const ids = loadSuite(SUITE).cases.map((c) => c.id);
    // If a headline row is ever deleted, this fails rather than the suite
    // quietly getting easier.
    for (const needle of ["basis-fifo", "basis-average", "basis-lifo", "flip-", "inverse-"]) {
      expect(ids.filter((id) => id.includes(needle))).not.toHaveLength(0);
    }
  });
});

// Runs ALWAYS. Turns "the suite is not published yet" from an invisible skip
// into a visible, dated statement that someone has to act on.
it("conformance wiring: reports whether the shared table is reachable", () => {
  if (!available) {
    console.warn(
      `[${SUITE}] not in the installed @particle-academy/fancy-conformance ` +
        `(${listSuites().length} suites present). The table is authored in ` +
        `repos/fancy-conformance/suites/shared/trading-pnl and needs that package ` +
        `released before cross-language parity can be asserted. Rows are covered ` +
        `inline by position.test.ts meanwhile.`,
    );
  }
  expect(Array.isArray(listSuites())).toBe(true);
});
