/**
 * Tests for codeOracle (E2.C).
 *
 * Contract under test:
 *   - truth = (tsc exits 0 === expected_compiles)
 *   - oracle_evidence is always non-empty
 *
 * Hermetic-test contract (Wave-C no-skip rule):
 *   Tests do NOT skip when tsc is unavailable. When tsc is absent:
 *     - isTscAvailable() returns false
 *     - codeOracle() returns stub result with truth=false and a stub-mode evidence string
 *     - Tests check for the stub-mode behaviour so CI always gets a verdict
 *   When tsc is present:
 *     - Tests check for real compilation verdicts
 *
 * Stakes: Medium — calibration infrastructure.
 */

import { describe, it, expect } from "vitest";
import { codeOracle, isTscAvailable } from "../code-oracle.js";

const SIMPLE_VALID_SNIPPET = `
const x: number = 42;
const greeting: string = "hello";
export { x, greeting };
`;

const TYPE_ERROR_SNIPPET = `
const x: number = "this is not a number";
export { x };
`;

const INTERFACE_SNIPPET = `
interface User {
  id: number;
  name: string;
}
const u: User = { id: 1, name: "Alice" };
export { u };
`;

describe("codeOracle", () => {
  it("oracle_evidence is always non-empty regardless of tsc availability", async () => {
    const result = await codeOracle({
      snippet: SIMPLE_VALID_SNIPPET,
      expected_compiles: true,
    });

    expect(result.oracle_evidence).toBeTruthy();
    expect(result.oracle_evidence.length).toBeGreaterThan(0);
  });

  it("when tsc unavailable: returns stub result with truth=false and stub-mode evidence", async () => {
    if (isTscAvailable()) {
      // tsc IS available — this branch skips the stub check; the real-tsc
      // tests below provide coverage.
      return;
    }

    const result = await codeOracle({
      snippet: SIMPLE_VALID_SNIPPET,
      expected_compiles: true,
    });

    expect(result.truth).toBe(false);
    expect(result.oracle_evidence).toContain("STUB MODE");
    expect(result.oracle_evidence).toContain("tsc not found");
  });

  it("valid snippet + claim compiles → truth=true (real tsc) or stub evidence (no tsc)", async () => {
    const result = await codeOracle({
      snippet: SIMPLE_VALID_SNIPPET,
      expected_compiles: true,
    });

    if (isTscAvailable()) {
      expect(result.truth).toBe(true);
      expect(result.oracle_evidence).toContain("compiles_cleanly=true");
      expect(result.oracle_evidence).toContain("truth=true");
    } else {
      // Stub mode: always false, but evidence is present.
      expect(result.truth).toBe(false);
      expect(result.oracle_evidence).toContain("STUB MODE");
    }
  });

  it("type-error snippet + claim compiles → truth=false (real tsc) or stub evidence", async () => {
    const result = await codeOracle({
      snippet: TYPE_ERROR_SNIPPET,
      expected_compiles: true,
    });

    if (isTscAvailable()) {
      expect(result.truth).toBe(false);
      expect(result.oracle_evidence).toContain("compiles_cleanly=false");
      expect(result.oracle_evidence).toContain("truth=false");
    } else {
      expect(result.truth).toBe(false);
      expect(result.oracle_evidence).toContain("STUB MODE");
    }
  });

  it("type-error snippet + claim does not compile → truth=true (real tsc)", async () => {
    const result = await codeOracle({
      snippet: TYPE_ERROR_SNIPPET,
      expected_compiles: false,
    });

    if (isTscAvailable()) {
      expect(result.truth).toBe(true);
      expect(result.oracle_evidence).toContain("compiles_cleanly=false");
      expect(result.oracle_evidence).toContain("expected_compiles=false");
      expect(result.oracle_evidence).toContain("truth=true");
    } else {
      // In stub mode truth is always false; document the limitation.
      expect(result.truth).toBe(false);
      expect(result.oracle_evidence).toContain("STUB MODE");
    }
  });

  it("valid interface snippet + claim compiles → truth=true (real tsc)", async () => {
    const result = await codeOracle({
      snippet: INTERFACE_SNIPPET,
      expected_compiles: true,
    });

    if (isTscAvailable()) {
      expect(result.truth).toBe(true);
      expect(result.oracle_evidence).toContain("truth=true");
    } else {
      expect(result.oracle_evidence).toContain("STUB MODE");
    }
  });

  it("evidence includes tsc version when tsc is available", async () => {
    if (!isTscAvailable()) return;

    const result = await codeOracle({
      snippet: SIMPLE_VALID_SNIPPET,
      expected_compiles: true,
    });

    expect(result.oracle_evidence).toMatch(/tsc="Version \d+\.\d+/);
  });
});
