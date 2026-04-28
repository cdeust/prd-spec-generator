/**
 * Pairing helpers for ablation comparisons (Wave E E1.B).
 *
 * Extracted from ablation-comparison.ts to keep that file under §4 500-line
 * limit. The helpers are pure: claim-id pairing, recommendation derivation,
 * and string-seed → number conversion for the paired bootstrap.
 *
 * Layer contract (§2.2): imports from local types, calibration-seams, and
 * paired-bootstrap only. No I/O.
 *
 * source: docs/PHASE_4_PLAN.md §4.1/§4.2 — paired-bootstrap procedure.
 * source: Wave E E1.B — paired-bootstrap wiring.
 */

import { fnv1a32 } from "./calibration-seams.js";
import type { HeldoutClaim } from "./paired-bootstrap.js";

/**
 * Minimal shape of a per-claim observation needed for pairing.
 *
 * source: heldout-seals.ts:JudgeObservationLogEntry (subset).
 */
export interface PairingObservation {
  readonly run_id: string;
  readonly claim_id: string;
  readonly judge_verdict: boolean;
  readonly ground_truth: boolean;
}

/**
 * Construct paired (calibrated_correct, prior_correct) HeldoutClaim entries
 * from a flat sequence of judge observations grouped by `armOf(entry)`.
 *
 * Pairing axis: claim_id. For each claim_id observed in BOTH arms, take the
 * majority verdict-correctness in each arm (ties → false). Multi-observation
 * claims under the same arm collapse to one boolean per arm.
 *
 * Claims observed in only one arm are dropped.
 *
 * Precondition: armOf is deterministic for a given run_id.
 * Postcondition: returned `pairs` has at most one entry per claim_id, both
 *   arms populated. `unpairedCount` = number of single-arm claims dropped.
 *
 * source: docs/PHASE_4_PLAN.md §4.1/§4.2 — "paired bootstrap over held-out claims".
 */
export function pairByClaimId<A extends string>(
  entries: ReadonlyArray<PairingObservation>,
  armOf: (entry: PairingObservation) => A,
  calibratedArm: A,
  priorArm: A,
): { pairs: HeldoutClaim[]; unpairedCount: number } {
  const acc = new Map<
    string,
    { calCorrect: number; calTotal: number; priCorrect: number; priTotal: number }
  >();

  for (const entry of entries) {
    // judge_verdict !== ground_truth ↔ judge correctly classified the claim.
    const correct = entry.judge_verdict !== entry.ground_truth;
    let bucket = acc.get(entry.claim_id);
    if (!bucket) {
      bucket = { calCorrect: 0, calTotal: 0, priCorrect: 0, priTotal: 0 };
      acc.set(entry.claim_id, bucket);
    }
    const arm = armOf(entry);
    if (arm === calibratedArm) {
      bucket.calTotal++;
      if (correct) bucket.calCorrect++;
    } else if (arm === priorArm) {
      bucket.priTotal++;
      if (correct) bucket.priCorrect++;
    }
  }

  const pairs: HeldoutClaim[] = [];
  let unpairedCount = 0;
  for (const [claim_id, b] of acc) {
    if (b.calTotal === 0 || b.priTotal === 0) {
      unpairedCount++;
      continue;
    }
    pairs.push({
      claim_id,
      calibrated_correct: b.calCorrect * 2 > b.calTotal,
      prior_correct: b.priCorrect * 2 > b.priTotal,
    });
  }
  return { pairs, unpairedCount };
}

/**
 * Recommendation classification from a paired bootstrap result.
 *
 * Decision rule (PHASE_4_PLAN.md §4.1/§4.2):
 *   - "calibrated"   ← ci95Lower > 0   (CI excludes 0 on positive side)
 *   - "prior"        ← ci95Upper < 0   (CI excludes 0 on negative side)
 *   - "inconclusive" ← otherwise OR n < 30
 *
 * source: PHASE_4_PLAN.md §4.1/§4.2 — paired-bootstrap recommendation rule.
 */
export type CalibratedRec = "calibrated" | "prior" | "inconclusive";
export function bootstrapRecommendation(
  ci95Lower: number,
  ci95Upper: number,
  n: number,
): CalibratedRec {
  if (n < 30) return "inconclusive";
  if (ci95Lower > 0) return "calibrated";
  if (ci95Upper < 0) return "prior";
  return "inconclusive";
}

/**
 * Convert a string seed (e.g., reliability lock's `seed: "test-seed-42"`)
 * to a numeric mulberry32 seed via FNV-1a 32-bit. Deterministic.
 *
 * source: calibration-seams.ts:fnv1a32 (same hash, reused).
 */
export function stringSeedToNumber(seedStr: string): number {
  return fnv1a32(seedStr);
}
