/**
 * Tests for paired-bootstrap.ts stub — M4 / Shannon residual.
 *
 * The paired bootstrap implementation is Wave C+ scope. These tests verify
 * that the stub correctly signals its unimplemented state (so callers cannot
 * accidentally rely on it before it is implemented).
 *
 * source: docs/PHASE_4_PLAN.md §4.1 negative-falsifier procedure.
 * source: M4 residual — Shannon: paired-bootstrap stub missing.
 */

import { describe, it, expect } from "vitest";
import {
  pairedBootstrapAccuracyDifference,
  type HeldoutClaim,
  type AccuracyMap,
} from "../paired-bootstrap.js";

describe("pairedBootstrapAccuracyDifference — stub contract (M4)", () => {
  it("throws with PAIRED_BOOTSTRAP_NOT_YET_IMPLEMENTED message", () => {
    // Precondition: any valid-shaped arguments.
    // Postcondition: throws with the expected sentinel message so callers
    //   cannot silently fall through to wrong results before Wave C+.
    const heldout: HeldoutClaim[] = [
      { claim_id: "C1", calibrated_correct: true, prior_correct: false },
    ];
    const calibrated: AccuracyMap = new Map([["genius:feynman:correctness:sensitivity_arm", 0.8]]);
    const prior: AccuracyMap = new Map([["genius:feynman:correctness:sensitivity_arm", 0.7]]);

    expect(() =>
      pairedBootstrapAccuracyDifference(heldout, calibrated, prior, 1000, 42),
    ).toThrow(/PAIRED_BOOTSTRAP_NOT_YET_IMPLEMENTED/);
  });

  it("throws with 'Wave C+ scope' in the error message", () => {
    // Verify the scope note is present — allows callers to grep for the
    // unimplemented marker in error logs.
    const heldout: HeldoutClaim[] = [];
    const calibrated: AccuracyMap = new Map();
    const prior: AccuracyMap = new Map();

    expect(() =>
      pairedBootstrapAccuracyDifference(heldout, calibrated, prior, 1000, 0),
    ).toThrow(/Wave C\+ scope/);
  });
});
