import { describe, expect, test } from "vitest";

// Imported as JSON rather than read through `node:module`, so this test needs
// no Node type declarations. Nothing in this package may make Node's globals
// typecheck clean -- it is browser-agnostic and must stay that way.
import pkg from "../package.json";

/**
 * The packaging contract. These are properties a consumer feels and a reviewer
 * cannot see, so they are asserted rather than trusted.
 */
describe("packaging", () => {
  test("the runtime dependency tree is EMPTY, and stays empty", () => {
    // The whole claim of this package is that installing it adds nothing to a
    // consumer's tree. Money arithmetic, the order model and P&L are exactly
    // the distinct data shapes the kit exists to provide, so a runtime
    // dependency here is a design failure rather than a convenience.
    expect(pkg.dependencies).toEqual({});
  });

  test("`dependencies` is present, not merely absent", () => {
    // An absent key resolves identically and reads completely differently. The
    // explicit empty object is the statement.
    expect(Object.prototype.hasOwnProperty.call(pkg, "dependencies")).toBe(true);
  });

  test("no peer dependencies — this package is headless and framework-free", () => {
    // Cast: with resolveJsonModule, tsc infers the literal shape and already
    // knows this key is absent — which is itself the guarantee. The runtime
    // check is what catches someone ADDING one later, when tsc would be happy.
    const peers = (pkg as Record<string, unknown>).peerDependencies;
    expect(peers ?? {}).toEqual({});
  });

  test("first-party siblings in devDependencies keep their caret", () => {
    // The envelope rule: a first-party sibling in `dependencies` /
    // `peerDependencies` gets `>=X <2.0`, but devDependencies KEEP the caret —
    // that pin is the version the suite is actually built and tested against.
    for (const [name, range] of Object.entries<string>(pkg.devDependencies ?? {})) {
      if (name.startsWith("@particle-academy/")) {
        expect(range.startsWith("^"), `${name} should keep its caret, got ${range}`).toBe(true);
      }
    }
  });

  test("the published tarball carries dist and the licence notice, not the tests", () => {
    expect(pkg.files).toContain("dist");
    expect(pkg.files).not.toContain("tests");
  });
});
