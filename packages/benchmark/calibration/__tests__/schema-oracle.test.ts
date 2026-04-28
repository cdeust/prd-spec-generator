/**
 * Tests for schemaOracle (E2.A).
 *
 * Contract under test:
 *   - truth = (Ajv.validate(schema, instance) === expected_valid)
 *   - oracle_evidence is always non-empty
 *
 * Stakes: Medium — calibration infrastructure; not auth/billing.
 */

import { describe, it, expect } from "vitest";
import { schemaOracle } from "../schema-oracle.js";

const NUMBER_SCHEMA = {
  title: "PositiveNumber",
  type: "object",
  properties: {
    value: { type: "number", minimum: 0 },
  },
  required: ["value"],
  additionalProperties: false,
};

describe("schemaOracle", () => {
  it("conformant instance + claim valid → truth=true", async () => {
    const result = await schemaOracle({
      schema: NUMBER_SCHEMA,
      instance: { value: 42 },
      expected_valid: true,
    });

    expect(result.truth).toBe(true);
    expect(result.oracle_evidence).toBeTruthy();
    expect(result.oracle_evidence.length).toBeGreaterThan(0);
    expect(result.oracle_evidence).toContain("Ajv.validate=true");
    expect(result.oracle_evidence).toContain("truth=true");
  });

  it("schema-violating instance + claim valid → truth=false", async () => {
    const result = await schemaOracle({
      schema: NUMBER_SCHEMA,
      instance: { value: -1 }, // violates minimum: 0
      expected_valid: true,
    });

    expect(result.truth).toBe(false);
    expect(result.oracle_evidence).toBeTruthy();
    expect(result.oracle_evidence).toContain("Ajv.validate=false");
    expect(result.oracle_evidence).toContain("truth=false");
    // Ajv should report the minimum violation
    expect(result.oracle_evidence).toContain("errors=");
  });

  it("conformant instance + claim invalid → truth=false", async () => {
    // The instance IS valid, but the claim says it should NOT be.
    // truth = (true === false) = false.
    const result = await schemaOracle({
      schema: NUMBER_SCHEMA,
      instance: { value: 10 },
      expected_valid: false,
    });

    expect(result.truth).toBe(false);
    expect(result.oracle_evidence).toBeTruthy();
    expect(result.oracle_evidence).toContain("Ajv.validate=true");
    expect(result.oracle_evidence).toContain("expected_valid=false");
    expect(result.oracle_evidence).toContain("truth=false");
  });

  it("schema-violating instance + claim invalid → truth=true", async () => {
    // The instance is NOT valid, and the claim says it should not be.
    // truth = (false === false) = true.
    const result = await schemaOracle({
      schema: NUMBER_SCHEMA,
      instance: { value: "not-a-number" },
      expected_valid: false,
    });

    expect(result.truth).toBe(true);
    expect(result.oracle_evidence).toBeTruthy();
    expect(result.oracle_evidence).toContain("truth=true");
  });

  it("malformed schema → truth=false with error in evidence", async () => {
    // Ajv will throw on schema compile failure; oracle handles it gracefully.
    const result = await schemaOracle({
      schema: { type: "INVALID_TYPE_XYZ" } as Record<string, unknown>,
      instance: { anything: true },
      expected_valid: true,
    });

    // Either the schema throws or validates to false; either way truth is false
    // and evidence is non-empty.
    expect(result.truth).toBe(false);
    expect(result.oracle_evidence).toBeTruthy();
    expect(result.oracle_evidence.length).toBeGreaterThan(0);
  });

  it("oracle_evidence includes schema title when present", async () => {
    const result = await schemaOracle({
      schema: NUMBER_SCHEMA, // has title "PositiveNumber"
      instance: { value: 1 },
      expected_valid: true,
    });

    expect(result.oracle_evidence).toContain("PositiveNumber");
  });
});
