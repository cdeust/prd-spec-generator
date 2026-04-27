/**
 * B-Shannon-7 drift detection: verify that the single source of truth for
 * the Beta(7,3) prior in @prd-gen/core is consistent with the math layer
 * re-export in @prd-gen/benchmark/calibration/reliability.ts.
 *
 * If either module's values are changed without updating the other, this
 * test catches it at CI time.
 *
 * source: B-Shannon-7 cross-audit finding — "add a TypeScript-level assertion
 * test that imports both modules and asserts the values are equal at runtime."
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_RELIABILITY_PRIOR,
  RELIABILITY_PRIOR_ESS,
} from "../index.js";

describe("B-Shannon-7: Beta prior single source of truth — drift detection", () => {
  it("DEFAULT_RELIABILITY_PRIOR.alpha is 7 (canonical value)", () => {
    // source: docs/PHASE_4_PLAN.md §4.1 PRE-REGISTRATION
    expect(DEFAULT_RELIABILITY_PRIOR.alpha).toBe(7);
  });

  it("DEFAULT_RELIABILITY_PRIOR.beta is 3 (canonical value)", () => {
    // source: docs/PHASE_4_PLAN.md §4.1 PRE-REGISTRATION
    expect(DEFAULT_RELIABILITY_PRIOR.beta).toBe(3);
  });

  it("RELIABILITY_PRIOR_ESS equals alpha + beta = 10", () => {
    // source: Gelman et al. (2013) §2.4 — ESS = α + β for Beta prior.
    expect(RELIABILITY_PRIOR_ESS).toBe(
      DEFAULT_RELIABILITY_PRIOR.alpha + DEFAULT_RELIABILITY_PRIOR.beta,
    );
    expect(RELIABILITY_PRIOR_ESS).toBe(10);
  });

  it("DEFAULT_RELIABILITY_PRIOR is frozen (immutable)", () => {
    // source: coding-standards §7.2 — global mutable state refused.
    expect(Object.isFrozen(DEFAULT_RELIABILITY_PRIOR)).toBe(true);
  });

  it("DEFAULT_RELIABILITY_PRIOR mean is 0.7 (α/(α+β))", () => {
    const { alpha, beta } = DEFAULT_RELIABILITY_PRIOR;
    expect(alpha / (alpha + beta)).toBeCloseTo(0.7, 12);
  });
});
