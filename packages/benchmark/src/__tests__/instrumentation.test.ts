import { describe, it, expect } from "vitest";
import {
  extractMismatchEvents,
  tallyByKind,
  MISMATCH_KINDS,
  MISMATCH_DIAGNOSTIC_PREFIX,
} from "../instrumentation.js";

describe("instrumentation.extractMismatchEvents", () => {
  it("returns empty extraction when state.errors is empty", () => {
    const ext = extractMismatchEvents({ errors: [] });
    expect(ext.fired).toBe(false);
    expect(ext.distinctKinds).toEqual([]);
    expect(ext.events).toEqual([]);
  });

  it("ignores unrelated error strings", () => {
    const ext = extractMismatchEvents({
      errors: ["some other error", "[handler] something else failed"],
    });
    expect(ext.fired).toBe(false);
  });

  it("extracts content_mutation diagnostic", () => {
    const ext = extractMismatchEvents({
      errors: [
        `${MISMATCH_DIAGNOSTIC_PREFIX}content_mutation`,
      ],
    });
    expect(ext.fired).toBe(true);
    expect(ext.distinctKinds).toEqual(["content_mutation"]);
  });

  it("extracts ordering_regression diagnostic", () => {
    const ext = extractMismatchEvents({
      errors: [
        `${MISMATCH_DIAGNOSTIC_PREFIX}ordering_regression`,
      ],
    });
    expect(ext.fired).toBe(true);
    expect(ext.distinctKinds).toEqual(["ordering_regression"]);
  });

  it("deduplicates distinct-kind output across repeated diagnostics", () => {
    const ext = extractMismatchEvents({
      errors: [
        `${MISMATCH_DIAGNOSTIC_PREFIX}content_mutation`,
        `${MISMATCH_DIAGNOSTIC_PREFIX}content_mutation`,
      ],
    });
    expect(ext.fired).toBe(true);
    expect(ext.distinctKinds).toEqual(["content_mutation"]);
    expect(ext.events.length).toBe(2);
  });

  it("throws on unknown mismatch_kind to surface format drift loudly", () => {
    expect(() =>
      extractMismatchEvents({
        errors: [`${MISMATCH_DIAGNOSTIC_PREFIX}some_new_kind`],
      }),
    ).toThrow(/unknown mismatch_kind/);
  });

  it("tallyByKind aggregates across multiple extractions", () => {
    const a = extractMismatchEvents({
      errors: [`${MISMATCH_DIAGNOSTIC_PREFIX}content_mutation`],
    });
    const b = extractMismatchEvents({
      errors: [
        `${MISMATCH_DIAGNOSTIC_PREFIX}content_mutation`,
        `${MISMATCH_DIAGNOSTIC_PREFIX}ordering_regression`,
      ],
    });
    const c = extractMismatchEvents({ errors: [] });
    const tally = tallyByKind([a, b, c]);
    expect(tally.content_mutation).toBe(2);
    expect(tally.ordering_regression).toBe(1);
  });

  it("MISMATCH_KINDS is the closed enumeration", () => {
    expect(MISMATCH_KINDS).toEqual(["content_mutation", "ordering_regression"]);
  });
});
