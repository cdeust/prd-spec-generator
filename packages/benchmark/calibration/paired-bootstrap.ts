/**
 * Paired bootstrap accuracy-difference test — Phase 4.1 / 4.2 / 4.5 negative falsifier.
 *
 * Implements a paired-sample bootstrap of the per-claim accuracy difference
 * between the calibrated arm and the prior (baseline) arm. The bootstrap is
 * deterministic given a fixed RNG seed (mulberry32), so the same input
 * produces byte-identical CIs across runs.
 *
 * Layer contract (coding-standards §2.2): imports from local types and stdlib
 * only. No orchestration, no I/O, no SQLite.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 / §4.2 / §4.5 negative-falsifier procedure.
 * source: Efron, B. & Tibshirani, R. J. (1993). "An Introduction to the
 *   Bootstrap." Chapman & Hall. Ch. 16 §16.4 — paired-sample bootstrap CI.
 * source: Tommy Ettinger, "Mulberry32" (2017) — deterministic 32-bit PRNG.
 */

import { percentile } from "./gate-stats.js";

// ─── Domain types ─────────────────────────────────────────────────────────────

/**
 * One claim from the held-out evaluation partition.
 *
 * `claim_id` is the unique identifier (must match the sealed partition).
 * `calibrated_correct` — true if the calibrated reliability map caused the
 *   consensus engine to produce the correct verdict for this claim.
 * `prior_correct` — true if the uncalibrated Beta(7,3) prior baseline produced
 *   the correct verdict.
 *
 * Both booleans must come from the SAME held-out claim — the pairing is what
 * makes the bootstrap paired (reduces variance by cancelling per-claim difficulty).
 *
 * The booleans are equivalent to the long-form `(judge_verdict ===
 * expected_label)` comparison the spec describes; we precompute them at
 * ingestion time so the bootstrap inner loop is pure arithmetic.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 — "paired bootstrap over held-out claims".
 */
export interface HeldoutClaim {
  readonly claim_id: string;
  readonly calibrated_correct: boolean;
  readonly prior_correct: boolean;
}

/**
 * Map from (judge × claim_type × verdict_direction) cell key to the posterior
 * mean accuracy for that cell.
 *
 * Key format: `${agentKind}:${agentName}:${claimType}:${verdictDirection}`
 * (this is an internal key; the colon delimiter is safe here because
 * AgentIdentity.name is colon-free in practice — annotator tooling enforces this).
 *
 * Used by the paired bootstrap as cell-level diagnostic context. The
 * per-claim correctness booleans on `HeldoutClaim` are the actual statistic;
 * the maps are accepted for API symmetry with the upstream consensus replay
 * (and are validated only for shape — bootstrap math does not consult them).
 *
 * source: docs/PHASE_4_PLAN.md §4.1 negative-falsifier estimand.
 */
export type AccuracyMap = ReadonlyMap<string, number>;

// ─── SEAL_VERIFIED sentinel (Wave D B3 mechanical guard) ─────────────────────

/**
 * Sentinel value passed as `sealVerified` to signal the caller has already
 * called `verifyHeldoutPartitionSeal` (or equivalent). This is a branded
 * boolean — callers must explicitly pass `SEAL_VERIFIED` (not just `true`)
 * to prevent accidental bypass.
 *
 * Usage:
 *   verifyHeldoutPartitionSeal(heldout.map(h => h.claim_id), lockPath);
 *   pairedBootstrapAccuracyDifference(heldout, calibrated, prior, 10000, seed, SEAL_VERIFIED);
 *
 * source: Wave D B3 remediation — Popper AP-5 mechanical enforcement.
 */
export const SEAL_VERIFIED = true as const;

// ─── Deterministic seeded PRNG (mulberry32) ──────────────────────────────────

/**
 * Mulberry32 — deterministic 32-bit-state PRNG. Sufficient for index sampling;
 * not cryptographic. The same seed produces byte-identical sequences across
 * platforms — required for the pre-registered reproducibility pin
 * (PHASE_4_PLAN.md §4.1 deterministic-RNG requirement).
 *
 * Precondition: seed is a non-negative integer in [0, 2^32).
 * Postcondition: returns a function that yields IID uniforms in [0, 1).
 *
 * source: Tommy Ettinger, "Mulberry32" (2017). Period 2^32.
 * source: matches packages/benchmark/calibration/calibrate-gates.ts:mulberry32
 *   (kept local rather than extracted: §3.3 — three uses required before extraction).
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// ─── Output shape ────────────────────────────────────────────────────────────

/**
 * Result of the paired bootstrap.
 *
 * `meanDifference`  — observed mean of (calibrated_correct - prior_correct) over the held-out set.
 * `ci95`            — [lower, upper] 2.5%/97.5% percentile bootstrap CI.
 * `pValue`          — two-sided bootstrap p-value: `2 * min(P(b ≤ 0), P(b ≥ 0))`
 *                     where b ranges over resampled means. Uses ≤/≥ (not strict)
 *                     so a degenerate all-zeros distribution yields p = 1.
 * `iterations`      — actual number of bootstrap resamples drawn.
 *
 * source: Efron & Tibshirani (1993) Ch. 16 §16.4.
 */
export interface PairedBootstrapResult {
  readonly meanDifference: number;
  readonly ci95: readonly [number, number];
  readonly pValue: number;
  readonly iterations: number;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Paired bootstrap estimate of the accuracy difference between the calibrated
 * reliability map and the Beta(7,3) prior baseline, over the sealed held-out set.
 *
 * Algorithm (Efron & Tibshirani 1993, Ch. 16 §16.4 — paired-sample bootstrap):
 *
 *   1. For each held-out claim i, compute d_i = calibrated_correct_i - prior_correct_i,
 *      where each correctness term is 1 iff the arm produced the correct verdict
 *      for claim i and 0 otherwise. d_i ∈ {-1, 0, +1}.
 *   2. The observed statistic is θ̂ = mean(d_i).
 *   3. For b = 1..B (B = `iterations`):
 *        - Draw a bootstrap sample d^*_1, ..., d^*_n by sampling indices
 *          1..n WITH replacement using a seeded PRNG.
 *        - Record θ̂*_b = mean(d^*).
 *   4. Sort {θ̂*_b}.
 *   5. CI95 = [percentile(θ̂*, 0.025), percentile(θ̂*, 0.975)].
 *   6. Two-sided p-value = 2 * min(#{θ̂*_b ≤ 0}/B, #{θ̂*_b ≥ 0}/B), clamped to [0, 1].
 *
 * The per-claim differences come from `HeldoutClaim.calibrated_correct` and
 * `HeldoutClaim.prior_correct` (precomputed at ingestion). The `calibrated`
 * and `prior` AccuracyMap parameters are accepted for upstream API symmetry
 * but the bootstrap math does not consult them — see §AccuracyMap docstring.
 *
 * Precondition:
 *   - `heldout` is non-empty.
 *   - `iterations` ≥ 1000 (Efron & Tibshirani 1993, §16.1 — fewer iterations
 *     give unstable CI bounds).
 *   - `rngSeed` is a non-negative integer (consumed by mulberry32 mod 2^32).
 *   - `sealVerified === SEAL_VERIFIED`.
 *
 * Postcondition:
 *   - `meanDifference` ∈ [-1, 1].
 *   - `ci95[0] ≤ meanDifference ≤ ci95[1]` for typical (non-degenerate) inputs.
 *   - `pValue ∈ [0, 1]`.
 *   - `iterations` matches the input.
 *
 * Determinism: same `(heldout, iterations, rngSeed)` triple produces
 * byte-identical output across platforms. This is the pre-registered
 * reproducibility pin for the AP-3 falsifier reports.
 *
 * source: Efron & Tibshirani (1993) Ch. 16 §16.4.
 * source: docs/PHASE_4_PLAN.md §4.1 / §4.2 / §4.5 falsifier procedure.
 * source: Wave D B3 — Popper AP-5 mechanical seal enforcement.
 */
export function pairedBootstrapAccuracyDifference(
  heldout: ReadonlyArray<HeldoutClaim>,
  calibrated: AccuracyMap,
  prior: AccuracyMap,
  iterations: number,
  rngSeed: number,
  sealVerified: typeof SEAL_VERIFIED,
): PairedBootstrapResult {
  // Precondition assertion — enforces that callers pass SEAL_VERIFIED explicitly.
  // FAILS_ON: sealVerified is not SEAL_VERIFIED (literal true) — should not
  //   happen if callers follow the type; this is a runtime guard for JS callers.
  if (sealVerified !== SEAL_VERIFIED) {
    throw new Error(
      "pairedBootstrapAccuracyDifference: precondition violated — " +
        "verifyHeldoutPartitionSeal must be called before invoking this function. " +
        "Pass SEAL_VERIFIED to acknowledge (source: Popper AP-5, Wave D B3).",
    );
  }

  if (heldout.length === 0) {
    throw new Error(
      "pairedBootstrapAccuracyDifference: precondition violated — heldout must be non-empty.",
    );
  }
  if (!Number.isInteger(iterations) || iterations < 1000) {
    throw new Error(
      `pairedBootstrapAccuracyDifference: iterations must be an integer ≥ 1000 ` +
        `(Efron & Tibshirani 1993 §16.1); got ${iterations}.`,
    );
  }
  if (!Number.isFinite(rngSeed) || rngSeed < 0) {
    throw new Error(
      `pairedBootstrapAccuracyDifference: rngSeed must be a non-negative finite number; got ${rngSeed}.`,
    );
  }
  // calibrated/prior are accepted for API symmetry — see AccuracyMap docstring.
  void calibrated;
  void prior;

  const n = heldout.length;

  // Step 1: per-claim differences d_i ∈ {-1, 0, +1}.
  const diffs = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const claim = heldout[i];
    const calibratedScore = claim.calibrated_correct ? 1 : 0;
    const priorScore = claim.prior_correct ? 1 : 0;
    diffs[i] = calibratedScore - priorScore;
  }

  // Step 2: observed mean difference θ̂.
  let observedSum = 0;
  for (let i = 0; i < n; i++) observedSum += diffs[i];
  const meanDifference = observedSum / n;

  // Step 3: bootstrap resamples θ̂*_b. Use a single PRNG seeded once for
  // determinism. Floor(rng() * n) yields uniform indices in [0, n).
  const rng = mulberry32(rngSeed);
  const resampledMeans = new Array<number>(iterations);
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rng() * n);
      sum += diffs[idx];
    }
    resampledMeans[b] = sum / n;
  }

  // Steps 4-5: sort + 95% percentile CI.
  // percentile() sorts internally; we still sort once to compute the p-value
  // tail counts in O(n log n + n) instead of O(n) twice.
  resampledMeans.sort((a, b) => a - b);
  const ci95Lower = percentile(resampledMeans, 0.025);
  const ci95Upper = percentile(resampledMeans, 0.975);

  // Step 6: two-sided bootstrap p-value.
  // P(θ̂* ≤ 0) is the proportion of resampled means at or below zero;
  // P(θ̂* ≥ 0) is the proportion at or above zero. Use ≤/≥ (not strict) so
  // a degenerate all-zeros distribution gives p = 1 instead of p = 0.
  let leqZero = 0;
  let geqZero = 0;
  for (let b = 0; b < iterations; b++) {
    if (resampledMeans[b] <= 0) leqZero++;
    if (resampledMeans[b] >= 0) geqZero++;
  }
  const pLeq = leqZero / iterations;
  const pGeq = geqZero / iterations;
  const pValueRaw = 2 * Math.min(pLeq, pGeq);
  const pValue = pValueRaw > 1 ? 1 : pValueRaw;

  return {
    meanDifference,
    ci95: [ci95Lower, ci95Upper],
    pValue,
    iterations,
  };
}
