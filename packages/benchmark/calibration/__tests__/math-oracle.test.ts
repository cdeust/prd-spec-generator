/**
 * Tests for mathOracle (E2.B).
 *
 * Contract under test:
 *   - truth = |mathjs.evaluate(expression) - expected_value| ≤ tolerance
 *   - eval() is never used (security invariant)
 *   - oracle_evidence is always non-empty
 *
 * Stakes: Medium — calibration infrastructure.
 */

import { describe, it, expect } from "vitest";
import { mathOracle } from "../math-oracle.js";

describe("mathOracle", () => {
  it("2+2=4 → truth=true", async () => {
    const result = await mathOracle({
      expression: "2 + 2",
      expected_value: 4,
    });

    expect(result.truth).toBe(true);
    expect(result.oracle_evidence).toBeTruthy();
    expect(result.oracle_evidence).toContain("computed=4");
    expect(result.oracle_evidence).toContain("truth=true");
  });

  it("2+2=5 → truth=false", async () => {
    const result = await mathOracle({
      expression: "2 + 2",
      expected_value: 5,
    });

    expect(result.truth).toBe(false);
    expect(result.oracle_evidence).toBeTruthy();
    expect(result.oracle_evidence).toContain("truth=false");
  });

  it("sqrt(2)^2 ≈ 2 within tolerance 1e-10 → truth=true", async () => {
    // sqrt(2)^2 = 2 in exact arithmetic; floating-point result is ~1.9999...
    // or ~2.0000... depending on rounding. 1e-10 tolerance covers typical FP drift.
    const result = await mathOracle({
      expression: "sqrt(2)^2",
      expected_value: 2,
      tolerance: 1e-10,
    });

    expect(result.truth).toBe(true);
    expect(result.oracle_evidence).toContain("truth=true");
  });

  it("sqrt(2)^2 with tolerance=0 may be false (exact FP equality)", async () => {
    // With zero tolerance, floating-point drift may cause truth=false.
    // This test documents the contract: tolerance matters.
    const result = await mathOracle({
      expression: "sqrt(2)^2",
      expected_value: 2,
      tolerance: 0,
    });

    // We don't assert truth here — it's platform-dependent. We only assert
    // that oracle_evidence is non-empty and the result is boolean.
    expect(typeof result.truth).toBe("boolean");
    expect(result.oracle_evidence).toBeTruthy();
  });

  it("injection attempt eval(...) → throws or truth=false", async () => {
    // mathjs does not recognise 'eval' as a built-in function.
    // It throws ScopeError / "Undefined symbol". The oracle must return
    // truth=false (not propagate the exception to the caller).
    const result = await mathOracle({
      expression: 'eval("1 + 1")',
      expected_value: 2,
    });

    expect(result.truth).toBe(false);
    expect(result.oracle_evidence).toBeTruthy();
    // Evidence must mention the failure cause
    expect(result.oracle_evidence).toMatch(/threw|non-number|truth=false/);
  });

  it("expression with complex number → truth=false (type guard)", async () => {
    // sqrt(-1) returns complex in mathjs. Oracle must reject non-number result.
    const result = await mathOracle({
      expression: "sqrt(-1)",
      expected_value: 0,
    });

    // complex number is not typeof 'number' — oracle returns truth=false
    expect(result.truth).toBe(false);
    expect(result.oracle_evidence).toBeTruthy();
  });

  it("10! (factorial) = 3628800 → truth=true", async () => {
    const result = await mathOracle({
      expression: "10!",
      expected_value: 3_628_800,
    });

    expect(result.truth).toBe(true);
    expect(result.oracle_evidence).toContain("truth=true");
  });

  it("oracle_evidence always contains expression and computed value", async () => {
    const result = await mathOracle({
      expression: "3 * 7",
      expected_value: 21,
    });

    expect(result.oracle_evidence).toContain('expression="3 * 7"');
    expect(result.oracle_evidence).toContain("computed=21");
  });
});
