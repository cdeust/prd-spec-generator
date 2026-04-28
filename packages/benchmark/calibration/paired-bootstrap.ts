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
/**
 * Sentinel value passed as `sealVerified` to signal the caller has already
 * called `verifyHeldoutPartitionSeal` (or equivalent). This is a branded
 * boolean — callers must explicitly pass `SEAL_VERIFIED` (not just `true`)
 * to prevent accidental bypass.
 *
 * Usage:
 *   verifyHeldoutPartitionSeal(heldout.map(h => h.claim_id), lockPath);
 *   pairedBootstrapAccuracyDifference(heldout, calibrated, prior, 1000, seed, SEAL_VERIFIED);
 *
 * source: Wave D B3 remediation — Popper AP-5 mechanical enforcement.
 */
export const SEAL_VERIFIED = true as const;

export function pairedBootstrapAccuracyDifference(
  heldout: ReadonlyArray<HeldoutClaim>,
  calibrated: AccuracyMap,
  prior: AccuracyMap,
  iterations: number,
  rngSeed: number,
  /**
   * Precondition: caller must have called verifyHeldoutPartitionSeal (or
   * verifyMaxAttemptsHeldoutSeal) before invoking this function. Pass the
   * exported SEAL_VERIFIED sentinel to acknowledge the precondition.
   *
   * source: Wave D B3 remediation — Popper AP-5 mechanical seal enforcement.
   */
  sealVerified: typeof SEAL_VERIFIED,
): { meanDifference: number; ci95: [number, number]; iterations: number } {
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
