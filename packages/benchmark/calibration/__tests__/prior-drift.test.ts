/**
 * B-Shannon-7 drift detection (benchmark side): verify that the Beta prior
 * values re-exported from reliability.ts match the canonical values in
 * @prd-gen/core at runtime.
 *
 * This test catches future drift if either module's constants are changed
 * without updating the other. It is the enforcement complement to the import
 * chain (reliability.ts imports DEFAULT_RELIABILITY_PRIOR from @prd-gen/core
 * and re-exports it — so these values MUST match by construction, but this
 * test makes the assertion explicit and visible in CI output).
 *
 * source: B-Shannon-7 cross-audit finding.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_RELIABILITY_PRIOR as CORE_PRIOR,
  RELIABILITY_PRIOR_ESS as CORE_ESS,
} from "@prd-gen/core";
import {
  DEFAULT_RELIABILITY_PRIOR as BENCH_PRIOR,
  PRIOR_ESS as BENCH_ESS,
} from "../reliability.js";

describe("B-Shannon-7: Beta prior drift detection — core vs benchmark", () => {
  it("DEFAULT_RELIABILITY_PRIOR.alpha matches between core and benchmark", () => {
    expect(BENCH_PRIOR.alpha).toBe(CORE_PRIOR.alpha);
  });

  it("DEFAULT_RELIABILITY_PRIOR.beta matches between core and benchmark", () => {
    expect(BENCH_PRIOR.beta).toBe(CORE_PRIOR.beta);
  });

  it("PRIOR_ESS (benchmark) matches RELIABILITY_PRIOR_ESS (core)", () => {
    expect(BENCH_ESS).toBe(CORE_ESS);
  });

  it("both priors have alpha=7, beta=3, ESS=10", () => {
    // Explicit value assertions so CI output names the expected constant.
    // source: docs/PHASE_4_PLAN.md §4.1 PRE-REGISTRATION; Gelman et al. (2013) §2.4.
    expect(CORE_PRIOR.alpha).toBe(7);
    expect(CORE_PRIOR.beta).toBe(3);
    expect(CORE_ESS).toBe(10);
  });
});
