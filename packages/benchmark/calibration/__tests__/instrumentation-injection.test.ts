/**
 * AP-5 fault-injection harness for instrumentation.
 *
 * Purpose (Curie A3 / Popper AP-5 negative falsifier):
 *   A 0-fire calibration result is ONLY meaningful if the instrumentation can
 *   actually detect mismatch events. This test suite provides a synthetic
 *   injection round-trip check — it proves that `extractMismatchEvents`
 *   correctly fires and correctly stays silent, using known-good and known-bad
 *   synthetic PipelineState inputs.
 *
 *   If the diagnostic prefix in `instrumentation.ts:MISMATCH_DIAGNOSTIC_PREFIX`
 *   ever rotates, the "known-good injection" cases below will fail loudly,
 *   which is the correct behaviour — it forces the developer to update BOTH
 *   the handler emitter and this harness together.
 *
 * Three groups of tests:
 *   1. Known-good injection (events expected)
 *   2. Empty state (no events expected)
 *   3. Deliberately misspelled prefix (no events expected — silent-skip
 *      vulnerability, documented in the pre-reg as an accepted limitation)
 *
 * source: Curie A3 / Phase 3+4 cross-audit (2026-04); pre-registration in
 *         docs/PHASE_4_PLAN.md §4.3 "AP-5 negative falsifier".
 */

import { describe, it, expect } from "vitest";
import {
  extractMismatchEvents,
  MISMATCH_DIAGNOSTIC_PREFIX,
  MISMATCH_KINDS,
  type MismatchKind,
} from "../../src/instrumentation.js";

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Build the canonical error string for a given kind, using the LIVE
 * MISMATCH_DIAGNOSTIC_PREFIX export. This is the coupling point: if the
 * prefix rotates in instrumentation.ts, these strings change and the
 * known-good-injection tests fail loudly.
 */
function makeErrorString(kind: MismatchKind): string {
  return `${MISMATCH_DIAGNOSTIC_PREFIX}${kind}`;
}

// ── Group 1: known-good injection ─────────────────────────────────────────

describe("instrumentation-injection: known-good injection round-trip", () => {
  it("fires for content_mutation injected into state.errors", () => {
    const state = {
      errors: [makeErrorString("content_mutation")],
    };
    const result = extractMismatchEvents(state);
    expect(result.events.length).toBeGreaterThanOrEqual(1);
    expect(result.distinctKinds).toContain("content_mutation");
    expect(result.fired).toBe(true);
  });

  it("fires for ordering_regression injected into state.errors", () => {
    const state = {
      errors: [makeErrorString("ordering_regression")],
    };
    const result = extractMismatchEvents(state);
    expect(result.events.length).toBeGreaterThanOrEqual(1);
    expect(result.distinctKinds).toContain("ordering_regression");
    expect(result.fired).toBe(true);
  });

  it("fires for BOTH known kinds injected simultaneously", () => {
    const state = {
      errors: [
        makeErrorString("content_mutation"),
        makeErrorString("ordering_regression"),
        "unrelated error — should be ignored",
      ],
    };
    const result = extractMismatchEvents(state);

    // Postcondition: at least 2 events (one per injected mismatch string).
    expect(result.events.length).toBeGreaterThanOrEqual(2);

    // Postcondition: distinctKinds contains exactly the injected set.
    const injectedSet = new Set<MismatchKind>(["content_mutation", "ordering_regression"]);
    const resultSet = new Set(result.distinctKinds);
    expect(resultSet).toEqual(injectedSet);

    // Postcondition: no throw occurred (test reaching this line proves it).
    expect(result.fired).toBe(true);
  });

  it("covers all MISMATCH_KINDS: every kind round-trips without throwing", () => {
    // If a new kind is added to MISMATCH_KINDS but not tested above, this
    // loop ensures it is still exercised.
    for (const kind of MISMATCH_KINDS) {
      const state = { errors: [makeErrorString(kind)] };
      const result = extractMismatchEvents(state);
      expect(result.fired).toBe(true);
      expect(result.distinctKinds).toContain(kind);
    }
  });
});

// ── Group 2: empty state ───────────────────────────────────────────────────

describe("instrumentation-injection: empty state produces no events", () => {
  it("returns events.length === 0 when state.errors is empty", () => {
    const result = extractMismatchEvents({ errors: [] });
    expect(result.events.length).toBe(0);
    expect(result.fired).toBe(false);
  });

  it("returns events.length === 0 when errors contain no mismatch prefix", () => {
    const result = extractMismatchEvents({
      errors: [
        "[section_gen] validation failed: missing acceptance_criteria",
        "[handler] structural error: unknown step",
      ],
    });
    expect(result.events.length).toBe(0);
    expect(result.fired).toBe(false);
  });
});

// ── Group 3: deliberately misspelled prefix ────────────────────────────────

describe("instrumentation-injection: misspelled prefix is a silent skip", () => {
  it("returns events.length === 0 when the prefix is misspelled", () => {
    // TODO(silent-skip vulnerability): this test intentionally documents that
    // a misspelled prefix in the HANDLER emitter (self-check.ts) produces a
    // 0-fire result here — indistinguishable from "no mismatches occurred".
    // This is an accepted limitation documented in docs/PHASE_4_PLAN.md §4.3
    // under "AP-5 negative falsifier". The pre-flight injection check in
    // mismatch-fire-rate.ts:runPreflightInjectionCheck guards the ANALYSIS
    // path (if the instrumentation module's own prefix drifts, the preflight
    // aborts). However, it cannot detect drift in the EMITTER (self-check.ts)
    // if the emitter changes its prefix while the parser keeps its own.
    // Mitigation: the two are tested together in C3
    // (packages/orchestration/src/__tests__/self-check-fires-mismatch.test.ts).

    const MISSPELLED = "[self_check] plan mismatch detected - mismatch_kind:content_mutation";
    // Note: uses ASCII hyphen-minus `-` instead of the em-dash `—` in the real prefix.
    const result = extractMismatchEvents({ errors: [MISSPELLED] });
    expect(result.events.length).toBe(0);
  });
});
