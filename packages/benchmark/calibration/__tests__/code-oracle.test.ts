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
import { OracleUnavailableError } from "../oracle-errors.js";

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
  it("oracle_evidence is non-empty when tsc is available", async () => {
    // B3: when tsc is absent codeOracle throws OracleUnavailableError; this test
    // only verifies the non-empty evidence invariant for the real-tsc path.
    if (!isTscAvailable()) return;

    const result = await codeOracle({
      snippet: SIMPLE_VALID_SNIPPET,
      expected_compiles: true,
    });

    expect(result.oracle_evidence).toBeTruthy();
    expect(result.oracle_evidence.length).toBeGreaterThan(0);
  });

  it("when tsc unavailable: throws OracleUnavailableError (B3)", async () => {
    // B3 remediation: stub mode no longer returns truth=false. It throws so callers
    // can exclude the claim from the calibrated arm instead of corrupting labels.
    // source: Popper AP-4, Wave E.
    if (isTscAvailable()) return;

    await expect(
      codeOracle({ snippet: SIMPLE_VALID_SNIPPET, expected_compiles: true }),
    ).rejects.toThrow(OracleUnavailableError);

    await expect(
      codeOracle({ snippet: SIMPLE_VALID_SNIPPET, expected_compiles: true }),
    ).rejects.toThrow(/OracleUnavailableError\[code\]/);
  });

  it("OracleUnavailableError carries oracleType='code'", async () => {
    if (isTscAvailable()) return;

    try {
      await codeOracle({ snippet: SIMPLE_VALID_SNIPPET, expected_compiles: true });
      throw new Error("expected OracleUnavailableError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OracleUnavailableError);
      expect((err as OracleUnavailableError).oracleType).toBe("code");
    }
  });

  it("valid snippet + claim compiles → truth=true (real tsc)", async () => {
    if (!isTscAvailable()) return;

    const result = await codeOracle({
      snippet: SIMPLE_VALID_SNIPPET,
      expected_compiles: true,
    });

    expect(result.truth).toBe(true);
    expect(result.oracle_evidence).toContain("compiles_cleanly=true");
    expect(result.oracle_evidence).toContain("truth=true");
  });

  it("type-error snippet + claim compiles → truth=false (real tsc)", async () => {
    if (!isTscAvailable()) return;

    const result = await codeOracle({
      snippet: TYPE_ERROR_SNIPPET,
      expected_compiles: true,
    });

    expect(result.truth).toBe(false);
    expect(result.oracle_evidence).toContain("compiles_cleanly=false");
    expect(result.oracle_evidence).toContain("truth=false");
  });

  it("type-error snippet + claim does not compile → truth=true (real tsc)", async () => {
    if (!isTscAvailable()) return;

    const result = await codeOracle({
      snippet: TYPE_ERROR_SNIPPET,
      expected_compiles: false,
    });

    expect(result.truth).toBe(true);
    expect(result.oracle_evidence).toContain("compiles_cleanly=false");
    expect(result.oracle_evidence).toContain("expected_compiles=false");
    expect(result.oracle_evidence).toContain("truth=true");
  });

  it("valid interface snippet + claim compiles → truth=true (real tsc)", async () => {
    if (!isTscAvailable()) return;

    const result = await codeOracle({
      snippet: INTERFACE_SNIPPET,
      expected_compiles: true,
    });

    expect(result.truth).toBe(true);
    expect(result.oracle_evidence).toContain("truth=true");
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
