/**
 * Tests for paired-bootstrap.ts — Wave E E1.C.
 *
 * Verifies the paired-bootstrap implementation against:
 *   1. Determinism (reproducibility pin) — same input + seed yields byte-identical CI.
 *   2. Null-effect distribution — mean ≈ 0, CI contains 0.
 *   3. Detectable improvement (calibrated 80% / prior 60%, N=200) — CI excludes 0 on the positive side.
 *   4. Detectable regression (calibrated 60% / prior 80%, N=200) — CI excludes 0 on the negative side.
 *   5. Underpowered (N=10 with 80%/60%) — CI is wide enough to straddle 0.
 *   6. Sentinel guard (Wave D B3) — rejects callers without SEAL_VERIFIED.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 / §4.2 / §4.5 negative-falsifier procedure.
 * source: Efron & Tibshirani (1993) Ch. 16 §16.4 — paired bootstrap.
 * source: Wave E E1 — paired-bootstrap implementation.
 */

import { describe, it, expect } from "vitest";
import {
  pairedBootstrapAccuracyDifference,
  SEAL_VERIFIED,
  type HeldoutClaim,
  type AccuracyMap,
} from "../paired-bootstrap.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const EMPTY_MAP: AccuracyMap = new Map();

/**
 * Construct N held-out claims with the given Bernoulli rates.
 *
 * Each claim's (calibrated_correct, prior_correct) is independently drawn
 * by index parity so the synthetic data is deterministic without an RNG.
 *
 * source: Efron & Tibshirani (1993) §16.4 — paired-sample setup.
 */
function makeClaims(
  n: number,
  calibratedRate: number,
  priorRate: number,
): HeldoutClaim[] {
  // Deterministic exact-count assignment. Mark ⌊n*rate⌋ entries as correct
  // for each arm. Calibrated marks indices [0, kCal); prior marks the index
  // window shifted by ⌊n/3⌋ (mod n). The shift induces partial pairing so
  // per-claim diffs are a mix of -1, 0, +1 (not degenerate alignment).
  //
  // source: Efron & Tibshirani (1993) §16.4 — paired-sample setup.
  const kCal = Math.floor(n * calibratedRate);
  const kPri = Math.floor(n * priorRate);
  const shift = Math.floor(n / 3);
  const out: HeldoutClaim[] = [];
  for (let i = 0; i < n; i++) {
    const calibrated_correct = i < kCal;
    const priorIdx = (i + shift) % n;
    const prior_correct = priorIdx < kPri;
    out.push({
      claim_id: `C${i}`,
      calibrated_correct,
      prior_correct,
    });
  }
  return out;
}

// ─── E1.C.1 — Reproducibility pin ────────────────────────────────────────────

describe("pairedBootstrapAccuracyDifference — reproducibility pin", () => {
  it("produces byte-identical output for the same input + seed", () => {
    // Postcondition: same heldout + iterations + rngSeed → equal meanDifference, ci95, pValue.
    const heldout = makeClaims(50, 0.7, 0.6);
    const a = pairedBootstrapAccuracyDifference(
      heldout,
      EMPTY_MAP,
      EMPTY_MAP,
      10000,
      42,
      SEAL_VERIFIED,
    );
    const b = pairedBootstrapAccuracyDifference(
      heldout,
      EMPTY_MAP,
      EMPTY_MAP,
      10000,
      42,
      SEAL_VERIFIED,
    );
    expect(a.meanDifference).toBe(b.meanDifference);
    expect(a.ci95[0]).toBe(b.ci95[0]);
    expect(a.ci95[1]).toBe(b.ci95[1]);
    expect(a.pValue).toBe(b.pValue);
    expect(a.iterations).toBe(b.iterations);
  });

  it("CI bounds match to 12 decimal places for the same seed", () => {
    // Postcondition: byte-identical guarantee in textual representation.
    const heldout = makeClaims(100, 0.75, 0.65);
    const a = pairedBootstrapAccuracyDifference(
      heldout,
      EMPTY_MAP,
      EMPTY_MAP,
      10000,
      12345,
      SEAL_VERIFIED,
    );
    const b = pairedBootstrapAccuracyDifference(
      heldout,
      EMPTY_MAP,
      EMPTY_MAP,
      10000,
      12345,
      SEAL_VERIFIED,
    );
    expect(a.ci95[0].toFixed(12)).toBe(b.ci95[0].toFixed(12));
    expect(a.ci95[1].toFixed(12)).toBe(b.ci95[1].toFixed(12));
  });

  it("different seeds yield different bootstrap distributions", () => {
    // Sanity: the seed actually drives the resamples, not just the inputs.
    const heldout = makeClaims(100, 0.7, 0.6);
    const a = pairedBootstrapAccuracyDifference(
      heldout, EMPTY_MAP, EMPTY_MAP, 10000, 1, SEAL_VERIFIED,
    );
    const b = pairedBootstrapAccuracyDifference(
      heldout, EMPTY_MAP, EMPTY_MAP, 10000, 2, SEAL_VERIFIED,
    );
    // meanDifference is identical (it's the observed statistic, not a resample).
    expect(a.meanDifference).toBe(b.meanDifference);
    // CI bounds will differ slightly between seeds (sampling noise).
    expect(a.ci95[0]).not.toBe(b.ci95[0]);
  });
});

// ─── E1.C.2 — Null effect (calibrated == prior) ──────────────────────────────

describe("pairedBootstrapAccuracyDifference — null-effect distribution", () => {
  it("CI contains 0 and meanDifference ≈ 0 when both arms are identical", () => {
    // Precondition: every claim's calibrated_correct === prior_correct.
    // Postcondition: every d_i = 0, every resample sum = 0, mean = 0,
    //   CI = [0, 0], pValue = 1 (two-sided p with all resamples at 0).
    const n = 100;
    const heldout: HeldoutClaim[] = [];
    for (let i = 0; i < n; i++) {
      const correct = i % 3 !== 0; // arbitrary deterministic pattern
      heldout.push({
        claim_id: `C${i}`,
        calibrated_correct: correct,
        prior_correct: correct,
      });
    }
    const result = pairedBootstrapAccuracyDifference(
      heldout, EMPTY_MAP, EMPTY_MAP, 10000, 42, SEAL_VERIFIED,
    );
    expect(result.meanDifference).toBe(0);
    expect(result.ci95[0]).toBe(0);
    expect(result.ci95[1]).toBe(0);
    // Two-sided p-value with degenerate (all zeros) distribution: pLeq = 1, pGeq = 1, p = 2*min = 2 → clamped to 1.
    expect(result.pValue).toBe(1);
  });
});

// ─── E1.C.3 — Detectable improvement (calibrated 80% vs prior 60%, N=200) ───

describe("pairedBootstrapAccuracyDifference — detectable improvement", () => {
  it("mean ≈ +0.2 and CI excludes 0 on the positive side at N=200, 80%/60%", () => {
    // Precondition: 200 claims, calibrated correct 80%, prior correct 60%.
    // Postcondition: meanDifference ≈ 0.2 (within ~0.05 of nominal due to interleave);
    //   ci95[0] > 0 → improvement detected.
    const heldout = makeClaims(200, 0.8, 0.6);
    const result = pairedBootstrapAccuracyDifference(
      heldout, EMPTY_MAP, EMPTY_MAP, 10000, 42, SEAL_VERIFIED,
    );
    // meanDifference depends on the deterministic interleave; assert sign + magnitude.
    expect(result.meanDifference).toBeGreaterThan(0.1);
    expect(result.meanDifference).toBeLessThan(0.3);
    // CI lower bound is positive — calibration provably helps.
    expect(result.ci95[0]).toBeGreaterThan(0);
    // p-value should be small (calibration help is detectable).
    expect(result.pValue).toBeLessThan(0.05);
  });
});

// ─── E1.C.4 — Detectable regression (calibrated 60% vs prior 80%, N=200) ────

describe("pairedBootstrapAccuracyDifference — detectable regression", () => {
  it("mean ≈ -0.2 and CI excludes 0 on the negative side at N=200, 60%/80%", () => {
    // Precondition: same shape but calibrated underperforms prior.
    // Postcondition: ci95[1] < 0 — prior is provably better.
    const heldout = makeClaims(200, 0.6, 0.8);
    const result = pairedBootstrapAccuracyDifference(
      heldout, EMPTY_MAP, EMPTY_MAP, 10000, 42, SEAL_VERIFIED,
    );
    expect(result.meanDifference).toBeLessThan(-0.1);
    expect(result.meanDifference).toBeGreaterThan(-0.3);
    expect(result.ci95[1]).toBeLessThan(0);
    expect(result.pValue).toBeLessThan(0.05);
  });
});

// ─── E1.C.5 — Underpowered (N=10, 80%/60%) ───────────────────────────────────

describe("pairedBootstrapAccuracyDifference — underpowered", () => {
  it("CI straddles 0 when N=10 and effect is 80%/60%", () => {
    // Precondition: only 10 claims at 80%/60% rates.
    // Postcondition: CI is wide enough to include 0 — inconclusive.
    // (Sample size is too small to resolve a 0.2 effect via bootstrap.)
    const heldout = makeClaims(10, 0.8, 0.6);
    const result = pairedBootstrapAccuracyDifference(
      heldout, EMPTY_MAP, EMPTY_MAP, 10000, 42, SEAL_VERIFIED,
    );
    // CI must include 0 (lower ≤ 0 ≤ upper).
    expect(result.ci95[0]).toBeLessThanOrEqual(0);
    expect(result.ci95[1]).toBeGreaterThanOrEqual(0);
  });
});

// ─── E1.C.6 — Sentinel guard (B3) ────────────────────────────────────────────

describe("pairedBootstrapAccuracyDifference — SEAL_VERIFIED guard", () => {
  it("throws precondition error when sealVerified is not SEAL_VERIFIED", () => {
    // Postcondition: the precondition guard fires before the bootstrap body.
    // Type-unsafe call simulates a JS caller bypassing the typed parameter.
    const heldout = makeClaims(20, 0.5, 0.5);

    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pairedBootstrapAccuracyDifference(heldout, EMPTY_MAP, EMPTY_MAP, 10000, 0, false as any),
    ).toThrow(/precondition violated/i);
  });

  it("rejects empty heldout", () => {
    expect(() =>
      pairedBootstrapAccuracyDifference([], EMPTY_MAP, EMPTY_MAP, 10000, 42, SEAL_VERIFIED),
    ).toThrow(/heldout must be non-empty/);
  });

  it("rejects iterations below 1000", () => {
    const heldout = makeClaims(20, 0.5, 0.5);
    expect(() =>
      pairedBootstrapAccuracyDifference(heldout, EMPTY_MAP, EMPTY_MAP, 999, 42, SEAL_VERIFIED),
    ).toThrow(/iterations must be an integer ≥ 1000/);
  });

  it("rejects negative rngSeed", () => {
    const heldout = makeClaims(20, 0.5, 0.5);
    expect(() =>
      pairedBootstrapAccuracyDifference(heldout, EMPTY_MAP, EMPTY_MAP, 10000, -1, SEAL_VERIFIED),
    ).toThrow(/rngSeed must be a non-negative finite number/);
  });
});

// ─── CONCERN-2 — continuous-null p-value uniformity sanity test ───────────────

/**
 * mulberry32 PRNG — matches the implementation in paired-bootstrap.ts.
 * Used here to generate random null datasets without importing private internals.
 * source: matches packages/benchmark/calibration/paired-bootstrap.ts:mulberry32.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sanity test: under the continuous null (each claim's calibrated_correct
 * and prior_correct are drawn independently from the SAME Bernoulli(0.5)),
 * p-values should be approximately uniformly distributed over [0, 1].
 *
 * Key insight: `makeClaims(N, 0.5, 0.5)` uses a deterministic interleave that
 * produces meanDifference=0 exactly for every dataset (degenerate → all p=1).
 * To get genuine null variation we must draw per-claim Bernoullis randomly, not
 * deterministically. We use mulberry32 with varying seeds for this purpose.
 *
 * This is a qualitative uniformity check — not a strict KS test (which would
 * require >1000 samples to be reliable). With 100 null datasets we assert:
 *   - at least 5 p-values < 0.10 (test has approximately correct size)
 *   - at least 5 p-values > 0.90 (test is not systematically conservative)
 *   - mean p-value within [0.3, 0.7] (roughly uniform center of mass)
 *
 * Uses a deterministic outer seed (seed=77_777) so the test is reproducible.
 * Each null dataset draws per-claim coins with seed = datasetSeed + i.
 *
 * source: Efron & Tibshirani (1993) §15.3 — bootstrap p-value calibration.
 * source: CONCERN-2, Fermi cross-audit, Wave E remediation.
 */
describe("pairedBootstrapAccuracyDifference — continuous-null p-value uniformity", () => {
  it("p-value distribution under continuous null is approximately uniform", () => {
    // Precondition: 100 null datasets, per-claim Bernoulli(0.5) drawn randomly.
    // Postcondition: collected p-values satisfy qualitative uniformity:
    //   ≥5 below 0.10, ≥5 above 0.90, mean within [0.3, 0.7].
    // Invariant: all datasets use deterministic seeds (reproducible across runs).
    const NUM_NULL_DATASETS = 100;
    const N = 50;
    const pValues: number[] = [];

    // Invariant: outer loop index i ∈ [0, NUM_NULL_DATASETS) determines both
    //   the per-claim coin flip seed and the bootstrap seed, so results are
    //   fully deterministic without shared mutable RNG state.
    // Termination: loop runs exactly NUM_NULL_DATASETS iterations.
    for (let i = 0; i < NUM_NULL_DATASETS; i++) {
      // Generate a random null dataset: per-claim independent Bernoulli(0.5).
      // Seed = 77_777 + 2*i for data generation; 77_777 + 2*i + 1 for bootstrap.
      // This keeps data and bootstrap RNGs independent.
      const dataRng = mulberry32(77_777 + 2 * i);
      const heldout: HeldoutClaim[] = [];
      for (let j = 0; j < N; j++) {
        heldout.push({
          claim_id: `C${j}`,
          calibrated_correct: dataRng() < 0.5,
          prior_correct: dataRng() < 0.5,
        });
      }

      const result = pairedBootstrapAccuracyDifference(
        heldout,
        EMPTY_MAP,
        EMPTY_MAP,
        1000,                  // 1000 iterations: fast in CI, sufficient for a p-value.
        77_777 + 2 * i + 1,   // bootstrap seed distinct from data seed.
        SEAL_VERIFIED,
      );
      pValues.push(result.pValue);
    }

    // Qualitative uniformity checks.
    const below010 = pValues.filter((p) => p < 0.10).length;
    const above090 = pValues.filter((p) => p > 0.90).length;
    const mean = pValues.reduce((acc, p) => acc + p, 0) / pValues.length;

    // Expected under U[0,1]: E[below010] = 10, E[above090] = 10.
    // Use lenient thresholds (≥5) to avoid flakiness with B=1000 bootstrap samples.
    // source: binomial expectation; lenient bound is ≈ 3σ below E[10] for p=0.10, N=100.
    expect(below010).toBeGreaterThanOrEqual(5);
    expect(above090).toBeGreaterThanOrEqual(5);
    // Mean should be near 0.5; generous bounds for 100 samples.
    expect(mean).toBeGreaterThan(0.3);
    expect(mean).toBeLessThan(0.7);
  });
});
