/**
 * Tests for the invokeOracle registry dispatch (E2.E / E2.F).
 *
 * Contract under test:
 *   - invokeOracle dispatches to the correct implementation for each type
 *   - Each implementation returns { truth: boolean, oracle_evidence: string }
 *   - oracle_evidence is always non-empty
 *   - An unknown type throws TypeError
 *
 * Stakes: Medium — calibration infrastructure.
 */

import { describe, it, expect } from "vitest";
import { invokeOracle } from "../external-oracle.js";

describe("invokeOracle — registry dispatch", () => {
  it("dispatches schema type and returns OracleResult shape", async () => {
    const result = await invokeOracle({
      id: "test-schema-1",
      type: "schema",
      payload: {
        schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false },
        instance: { n: 1 },
        expected_valid: true,
      },
    });

    expect(typeof result.truth).toBe("boolean");
    expect(typeof result.oracle_evidence).toBe("string");
    expect(result.oracle_evidence.length).toBeGreaterThan(0);
    expect(result.truth).toBe(true);
  });

  it("dispatches math type and returns OracleResult shape", async () => {
    const result = await invokeOracle({
      id: "test-math-1",
      type: "math",
      payload: {
        expression: "3 + 4",
        expected_value: 7,
      },
    });

    expect(typeof result.truth).toBe("boolean");
    expect(typeof result.oracle_evidence).toBe("string");
    expect(result.oracle_evidence.length).toBeGreaterThan(0);
    expect(result.truth).toBe(true);
  });

  it("dispatches code type and returns OracleResult shape", async () => {
    const result = await invokeOracle({
      id: "test-code-1",
      type: "code",
      payload: {
        snippet: "const n: number = 1; export { n };",
        expected_compiles: true,
      },
    });

    expect(typeof result.truth).toBe("boolean");
    expect(typeof result.oracle_evidence).toBe("string");
    expect(result.oracle_evidence.length).toBeGreaterThan(0);
  });

  it("dispatches spec type and returns OracleResult shape", async () => {
    const result = await invokeOracle({
      id: "test-spec-1",
      type: "spec",
      payload: {
        markdown: "## Overview\nThis is a test.",
        section_type: "overview",
        expected_passes: true,
      },
    });

    expect(typeof result.truth).toBe("boolean");
    expect(typeof result.oracle_evidence).toBe("string");
    expect(result.oracle_evidence.length).toBeGreaterThan(0);
    expect(result.oracle_evidence).toContain("internally-grounded");
  });

  it("unknown type throws TypeError", async () => {
    await expect(
      invokeOracle({
        id: "test-unknown",
        type: "not_a_type" as "schema",
        payload: {} as never,
      }),
    ).rejects.toThrow(TypeError);
  });

  it("all four oracle types produce non-empty oracle_evidence", async () => {
    const inputs = [
      {
        id: "e1",
        type: "schema" as const,
        payload: { schema: { type: "string" }, instance: "hello", expected_valid: true },
      },
      {
        id: "e2",
        type: "math" as const,
        payload: { expression: "1 + 1", expected_value: 2 },
      },
      {
        id: "e3",
        type: "code" as const,
        payload: { snippet: "export const x = 1;", expected_compiles: true },
      },
      {
        id: "e4",
        type: "spec" as const,
        payload: { markdown: "# Hello", section_type: "overview", expected_passes: true },
      },
    ];

    for (const input of inputs) {
      const result = await invokeOracle(input);
      expect(result.oracle_evidence.length).toBeGreaterThan(0);
      expect(typeof result.truth).toBe("boolean");
    }
  });
});
