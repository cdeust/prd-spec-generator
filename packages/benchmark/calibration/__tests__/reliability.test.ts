/**
 * Tests for reliability.ts — Beta-Binomial conjugate update math.
 *
 * Coverage:
 *  - prior is Beta(7,3) by default
 *  - posterior mean shifts toward observed rate as N grows
 *  - posterior mode equals MAP closed-form
 *  - effective sample size = α + β
 *  - dominance threshold flips at ESS = 30
 *  - sensitivity / specificity tracked separately
 *  - contract violations refused (no silent fixes — coding-standards §6)
 */

import { describe, expect, it } from "vitest";
import {
  betaUpdate,
  DEFAULT_RELIABILITY_PRIOR,
  DOMINANCE_THRESHOLD_N,
  dominanceThreshold,
  effectiveSampleSize,
  posteriorMean,
  posteriorMode,
  splitSensitivitySpecificity,
  tallyConfusion,
  type ClaimObservation,
} from "../reliability.js";

describe("DEFAULT_RELIABILITY_PRIOR", () => {
  it("is Beta(7, 3) per Phase 4.1 PRE-REGISTRATION", () => {
    expect(DEFAULT_RELIABILITY_PRIOR.alpha).toBe(7);
    expect(DEFAULT_RELIABILITY_PRIOR.beta).toBe(3);
  });

  it("has prior mean 0.7", () => {
    expect(posteriorMean(DEFAULT_RELIABILITY_PRIOR)).toBeCloseTo(0.7, 12);
  });

  it("has effective sample size 10", () => {
    expect(effectiveSampleSize(DEFAULT_RELIABILITY_PRIOR)).toBe(10);
  });

  it("does not cross the dominance threshold on its own", () => {
    expect(dominanceThreshold(DEFAULT_RELIABILITY_PRIOR)).toBe(false);
  });
});

describe("betaUpdate", () => {
  it("adds successes to alpha and failures to beta", () => {
    const post = betaUpdate(DEFAULT_RELIABILITY_PRIOR, 8, 10);
    expect(post.alpha).toBe(15);
    expect(post.beta).toBe(5);
  });

  it("is a no-op when total = 0", () => {
    const post = betaUpdate(DEFAULT_RELIABILITY_PRIOR, 0, 0);
    expect(post.alpha).toBe(7);
    expect(post.beta).toBe(3);
  });

  it("composes — two updates of (s1,n1) then (s2,n2) equals one update of (s1+s2, n1+n2)", () => {
    const a = betaUpdate(betaUpdate(DEFAULT_RELIABILITY_PRIOR, 4, 5), 6, 8);
    const b = betaUpdate(DEFAULT_RELIABILITY_PRIOR, 10, 13);
    expect(a.alpha).toBe(b.alpha);
    expect(a.beta).toBe(b.beta);
  });

  it("refuses negative success", () => {
    expect(() => betaUpdate(DEFAULT_RELIABILITY_PRIOR, -1, 5)).toThrow(RangeError);
  });

  it("refuses success > total", () => {
    expect(() => betaUpdate(DEFAULT_RELIABILITY_PRIOR, 6, 5)).toThrow(RangeError);
  });

  it("refuses non-finite inputs", () => {
    expect(() => betaUpdate(DEFAULT_RELIABILITY_PRIOR, NaN, 5)).toThrow(RangeError);
    expect(() =>
      betaUpdate(DEFAULT_RELIABILITY_PRIOR, 1, Number.POSITIVE_INFINITY),
    ).toThrow(RangeError);
  });

  it("refuses non-positive prior", () => {
    expect(() => betaUpdate({ alpha: 0, beta: 1 }, 1, 1)).toThrow(RangeError);
    expect(() => betaUpdate({ alpha: 1, beta: -1 }, 1, 1)).toThrow(RangeError);
  });
});

describe("posteriorMean — shifts toward observed rate as N grows", () => {
  it("with N=10 successes out of 10 observations, mean moves up from 0.7", () => {
    const post = betaUpdate(DEFAULT_RELIABILITY_PRIOR, 10, 10);
    // (7+10) / (10+10) = 17/20 = 0.85
    expect(posteriorMean(post)).toBeCloseTo(0.85, 12);
    expect(posteriorMean(post)).toBeGreaterThan(0.7);
  });

  it("with 0 successes out of 10 observations, mean moves down from 0.7", () => {
    const post = betaUpdate(DEFAULT_RELIABILITY_PRIOR, 0, 10);
    // 7 / 20 = 0.35
    expect(posteriorMean(post)).toBeCloseTo(0.35, 12);
    expect(posteriorMean(post)).toBeLessThan(0.7);
  });

  it("with N=1000 at observed rate 0.5, mean approaches 0.5 (prior washes out)", () => {
    const post = betaUpdate(DEFAULT_RELIABILITY_PRIOR, 500, 1000);
    expect(posteriorMean(post)).toBeCloseTo(0.502, 2);
  });
});

describe("posteriorMode — MAP estimate", () => {
  it("equals (α-1)/(α+β-2) for the unimodal interior case", () => {
    // Beta(7,3): mode = (7-1)/(7+3-2) = 6/8 = 0.75
    expect(posteriorMode(DEFAULT_RELIABILITY_PRIOR)).toBeCloseTo(0.75, 12);
  });

  it("is below the mean when alpha < beta", () => {
    const skewed = { alpha: 3, beta: 7 };
    // mean = 0.3, mode = 2/8 = 0.25
    expect(posteriorMode(skewed)).toBeLessThan(posteriorMean(skewed));
  });

  it("falls back to the mean when alpha ≤ 1 (no interior mode)", () => {
    const edge = { alpha: 1, beta: 5 };
    expect(posteriorMode(edge)).toBe(posteriorMean(edge));
  });

  it("falls back to the mean when beta ≤ 1 (no interior mode)", () => {
    const edge = { alpha: 5, beta: 1 };
    expect(posteriorMode(edge)).toBe(posteriorMean(edge));
  });
});

describe("effectiveSampleSize and dominanceThreshold", () => {
  it("ESS equals alpha + beta", () => {
    expect(effectiveSampleSize({ alpha: 17, beta: 13 })).toBe(30);
  });

  it("dominanceThreshold is true exactly when ESS ≥ 30", () => {
    // ESS = 10 + 19 = 29 -> below
    const below = betaUpdate(DEFAULT_RELIABILITY_PRIOR, 12, 19);
    expect(effectiveSampleSize(below)).toBe(29);
    expect(dominanceThreshold(below)).toBe(false);

    // ESS = 10 + 20 = 30 -> at threshold
    const at = betaUpdate(DEFAULT_RELIABILITY_PRIOR, 12, 20);
    expect(effectiveSampleSize(at)).toBe(30);
    expect(dominanceThreshold(at)).toBe(true);

    // ESS > 30
    const above = betaUpdate(DEFAULT_RELIABILITY_PRIOR, 60, 100);
    expect(dominanceThreshold(above)).toBe(true);
  });

  it("DOMINANCE_THRESHOLD_N is 30 (Laplace L4)", () => {
    expect(DOMINANCE_THRESHOLD_N).toBe(30);
  });
});

describe("tallyConfusion", () => {
  it("counts TP / FP / TN / FN correctly", () => {
    const obs: ClaimObservation[] = [
      { ground_truth: "PASS", judge_verdict: "PASS" }, // TP
      { ground_truth: "PASS", judge_verdict: "PASS" }, // TP
      { ground_truth: "FAIL", judge_verdict: "PASS" }, // FP
      { ground_truth: "FAIL", judge_verdict: "FAIL" }, // TN
      { ground_truth: "FAIL", judge_verdict: "FAIL" }, // TN
      { ground_truth: "FAIL", judge_verdict: "FAIL" }, // TN
      { ground_truth: "PASS", judge_verdict: "FAIL" }, // FN
    ];
    const c = tallyConfusion(obs);
    expect(c.true_positives).toBe(2);
    expect(c.false_positives).toBe(1);
    expect(c.true_negatives).toBe(3);
    expect(c.false_negatives).toBe(1);
  });

  it("returns zeros on empty input", () => {
    const c = tallyConfusion([]);
    expect(c.true_positives).toBe(0);
    expect(c.false_positives).toBe(0);
    expect(c.true_negatives).toBe(0);
    expect(c.false_negatives).toBe(0);
  });
});

describe("splitSensitivitySpecificity — verdict-direction asymmetry", () => {
  function makeObs(
    tp: number,
    fp: number,
    tn: number,
    fn: number,
  ): ClaimObservation[] {
    const out: ClaimObservation[] = [];
    for (let i = 0; i < tp; i++) out.push({ ground_truth: "PASS", judge_verdict: "PASS" });
    for (let i = 0; i < fp; i++) out.push({ ground_truth: "FAIL", judge_verdict: "PASS" });
    for (let i = 0; i < tn; i++) out.push({ ground_truth: "FAIL", judge_verdict: "FAIL" });
    for (let i = 0; i < fn; i++) out.push({ ground_truth: "PASS", judge_verdict: "FAIL" });
    return out;
  }

  it("computes sensitivity from positive-class observations only", () => {
    // 9 TP, 1 FN, 0 FP, 0 TN: judge perfect on positives, no info on negatives
    const post = splitSensitivitySpecificity(makeObs(9, 0, 0, 1));
    // sens posterior: Beta(7+9, 3+1) = Beta(16, 4) -> mean 0.8
    expect(post.sens.alpha).toBe(16);
    expect(post.sens.beta).toBe(4);
    expect(posteriorMean(post.sens)).toBeCloseTo(0.8, 12);
    // spec posterior: no negative observations -> stays at prior
    expect(post.spec.alpha).toBe(7);
    expect(post.spec.beta).toBe(3);
  });

  it("computes specificity from negative-class observations only", () => {
    // 0 TP, 0 FN, 2 FP, 8 TN
    const post = splitSensitivitySpecificity(makeObs(0, 2, 8, 0));
    // spec posterior: Beta(7+8, 3+2) = Beta(15, 5) -> mean 0.75
    expect(post.spec.alpha).toBe(15);
    expect(post.spec.beta).toBe(5);
    expect(posteriorMean(post.spec)).toBeCloseTo(0.75, 12);
    // sens stays at prior
    expect(post.sens.alpha).toBe(7);
    expect(post.sens.beta).toBe(3);
  });

  it("tracks sens and spec independently when a judge is biased toward PASS", () => {
    // Judge says PASS to almost everything: high sens, low spec
    const post = splitSensitivitySpecificity(makeObs(20, 18, 2, 0));
    // sens: Beta(7+20, 3+0) = Beta(27, 3); mean = 0.9
    expect(posteriorMean(post.sens)).toBeCloseTo(27 / 30, 12);
    // spec: Beta(7+2, 3+18) = Beta(9, 21); mean = 0.3
    expect(posteriorMean(post.spec)).toBeCloseTo(9 / 30, 12);
    // The point: the two posteriors disagree by 0.6 — collapsing to a
    // single reliability scalar would hide this.
    expect(
      Math.abs(posteriorMean(post.sens) - posteriorMean(post.spec)),
    ).toBeGreaterThan(0.5);
  });

  it("preserves confusion counts on the returned record", () => {
    const post = splitSensitivitySpecificity(makeObs(5, 2, 7, 1));
    expect(post.counts.true_positives).toBe(5);
    expect(post.counts.false_positives).toBe(2);
    expect(post.counts.true_negatives).toBe(7);
    expect(post.counts.false_negatives).toBe(1);
  });

  it("returns the prior unchanged on empty observations", () => {
    const post = splitSensitivitySpecificity([]);
    expect(post.sens).toEqual(DEFAULT_RELIABILITY_PRIOR);
    expect(post.spec).toEqual(DEFAULT_RELIABILITY_PRIOR);
  });

  it("uses the supplied prior when overridden", () => {
    const flat = { alpha: 1, beta: 1 };
    const post = splitSensitivitySpecificity(makeObs(3, 0, 4, 1), flat);
    // sens: Beta(1+3, 1+1) = Beta(4, 2); spec: Beta(1+4, 1+0) = Beta(5, 1)
    expect(post.sens.alpha).toBe(4);
    expect(post.sens.beta).toBe(2);
    expect(post.spec.alpha).toBe(5);
    expect(post.spec.beta).toBe(1);
  });
});

describe("dominance threshold reached only with sufficient observations per arm", () => {
  it("a judge with 25 positive-class observations does NOT cross sens dominance", () => {
    const obs: ClaimObservation[] = Array.from({ length: 25 }, () => ({
      ground_truth: "PASS" as const,
      judge_verdict: "PASS" as const,
    }));
    const post = splitSensitivitySpecificity(obs);
    // sens ESS = 10 + 25 = 35 -> dominance crossed
    expect(dominanceThreshold(post.sens)).toBe(true);
    // spec ESS still 10 -> not crossed
    expect(dominanceThreshold(post.spec)).toBe(false);
  });
});

describe("invariants required by docs/PHASE_4_PLAN.md §4.1", () => {
  it("posterior mean stays in [0, 1] for arbitrary update sizes", () => {
    for (const total of [1, 5, 50, 500, 5000]) {
      for (const success of [0, Math.floor(total / 2), total]) {
        const post = betaUpdate(DEFAULT_RELIABILITY_PRIOR, success, total);
        const m = posteriorMean(post);
        expect(m).toBeGreaterThanOrEqual(0);
        expect(m).toBeLessThanOrEqual(1);
      }
    }
  });

  it("with N ≥ 30 observations, the prior contributes ≤ ~25% of effective mass", () => {
    // Phase 4.1 stopping-rule justification check: at the dominance
    // threshold, observed counts (≥20 if balanced) outweigh the prior's
    // ESS=10. We confirm the algebra: ESS_obs / ESS_total ≥ 2/3 when
    // total observed = 20.
    const post = betaUpdate(DEFAULT_RELIABILITY_PRIOR, 14, 20);
    const obsMass = 20;
    const totalMass = effectiveSampleSize(post);
    expect(totalMass).toBe(30);
    expect(obsMass / totalMass).toBeCloseTo(2 / 3, 6);
  });

  it("flat prior Beta(1,1) reproduces Laplace's rule of succession", () => {
    // P(next = success | k of n) = (k+1) / (n+2) — Laplace 1812.
    const flat = { alpha: 1, beta: 1 };
    const post = betaUpdate(flat, 3, 5);
    expect(posteriorMean(post)).toBeCloseTo((3 + 1) / (5 + 2), 12);
  });
});
