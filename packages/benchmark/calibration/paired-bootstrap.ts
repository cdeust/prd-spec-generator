/**
 * Paired bootstrap accuracy-difference test — Phase 4.1 negative falsifier.
 *
 * Spec: docs/PHASE_4_PLAN.md §4.1 negative-falsifier procedure ("paired bootstrap
 * over held-out claims"). Implementation is Wave C+ scope; this file is the
 * typed stub that makes the contract visible before the math is implemented.
 *
 * Layer contract (coding-standards §2.2): imports from local types and stdlib
 * only. No orchestration, no I/O, no SQLite.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 negative-falsifier procedure.
 * source: Efron & Tibshirani (1993), "An Introduction to the Bootstrap", Ch. 16
 *   (bootstrap confidence intervals for paired comparisons).
 * source: M4 residual — Shannon: paired-bootstrap stub missing.
 */

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
 * Used by the paired bootstrap to look up per-cell accuracy for each claim.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 negative-falsifier estimand.
 */
export type AccuracyMap = ReadonlyMap<string, number>;

// ─── Stub function ────────────────────────────────────────────────────────────

/**
 * Paired bootstrap estimate of the accuracy difference between the calibrated
 * reliability map and the Beta(7,3) prior baseline, over the sealed held-out set.
 *
 * **Implementation status: STUB — Wave C+ scope.**
 * The function signature, types, and contract are final; the body is not.
 * Call `verifyHeldoutPartitionSeal` before calling this function.
 *
 * Precondition:
 *   - `heldout` is a non-empty ReadonlyArray of HeldoutClaim, one entry per
 *     held-out claim. The claim_ids must match the sealed partition
 *     (verified by `verifyHeldoutPartitionSeal` upstream).
 *   - `calibrated` and `prior` are AccuracyMaps covering all cells
 *     referenced by the held-out claims.
 *   - `iterations` ≥ 1000 (Efron & Tibshirani 1993, §16.1 — fewer iterations
 *     give unstable CI bounds).
 *   - `rngSeed` is the same frozen RNG seed recorded in the lock file.
 *
 * Postcondition:
 *   - `meanDifference` = mean(calibrated_correct) − mean(prior_correct)
 *     over the held-out set.
 *   - `ci95` = [lower, upper] 95% bootstrap CI for `meanDifference`.
 *   - `iterations` = the actual number of bootstrap resamples drawn
 *     (may differ from input if implementation clips to a max).
 *
 * Rejection rule (docs/PHASE_4_PLAN.md §4.1): reject calibration (revert
 * to prior; investigate) IFF ci95[1] < 0 (the upper CI bound is negative,
 * meaning calibration is worse than prior with 95% confidence).
 *
 * source: docs/PHASE_4_PLAN.md §4.1 negative-falsifier procedure.
 * source: Efron & Tibshirani (1993), "An Introduction to the Bootstrap", Ch. 16.
 * source: M4 residual — Shannon: paired-bootstrap stub missing.
 */
export function pairedBootstrapAccuracyDifference(
  heldout: ReadonlyArray<HeldoutClaim>,
  calibrated: AccuracyMap,
  prior: AccuracyMap,
  iterations: number,
  rngSeed: number,
): { meanDifference: number; ci95: [number, number]; iterations: number } {
  // Suppress unused-parameter warnings in the stub.
  void heldout;
  void calibrated;
  void prior;
  void iterations;
  void rngSeed;

  throw new Error(
    "PAIRED_BOOTSTRAP_NOT_YET_IMPLEMENTED — Wave C+ scope. " +
      "See PHASE_4_PLAN.md §4.1 negative-falsifier procedure for the spec.",
  );
}
