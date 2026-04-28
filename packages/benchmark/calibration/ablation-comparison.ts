/**
 * Ablation comparison — Phase 4.2 / 4.1 / 4.5 cross-arm analysis (Wave D B2 + Wave E E1.B).
 *
 * Computes the AP-3 falsification metrics by aggregating observation logs
 * across run_ids grouped by ablation arm. Three comparison functions:
 *
 *   computeAblationComparison    — 4.2 retry-ablation (prior_violations arm).
 *   computeReliabilityComparison — 4.1 reliability (calibrated vs prior-only).
 *   computeKpiGateComparison     — 4.5 KPI gate fire rates (control vs treatment).
 *
 * All three verify the relevant held-out seal BEFORE reading any data
 * (Popper AP-5). After Wave E E1, the paired bootstrap (Efron & Tibshirani
 * 1993 §16.4) is the falsifier instrument.
 *
 * Layer contract (§2.2): imports from Node stdlib, local calibration files,
 * and zod only. No orchestration, no SQLite.
 *
 * source: docs/PHASE_4_PLAN.md §4.1, §4.2, §4.5 (AP-3 falsification).
 * source: Efron & Tibshirani (1993) Ch. 16 §16.4 — paired-sample bootstrap.
 * source: Wave D B2 / B3 + Wave E E1 remediation.
 */

import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import {
  verifyMaxAttemptsHeldoutSeal,
  verifyReliabilityHeldoutSeal,
  verifyKpiGatesHeldoutSeal,
  type MaxAttemptsHeldoutLock,
  type ReliabilityHeldoutLock,
} from "./heldout-seals.js";
import {
  getRetryArmForRun,
  isControlArmRun,
  type RetryArm,
} from "./calibration-seams.js";
import { clopperPearson } from "./clopper-pearson.js";
import {
  pairedBootstrapAccuracyDifference,
  SEAL_VERIFIED,
  type HeldoutClaim,
  type AccuracyMap,
} from "./paired-bootstrap.js";
import {
  pairByClaimId,
  bootstrapRecommendation,
  stringSeedToNumber,
} from "./ablation-pairing-helpers.js";

// ─── Pre-registered constants ────────────────────────────────────────────────

/** Bootstrap iteration count (Efron & Tibshirani 1993 §16.1; PHASE_4_PLAN §4.1). */
const BOOTSTRAP_ITERATIONS = 10_000 as const;

const EMPTY_ACCURACY_MAP: AccuracyMap = new Map();

// ─── Output schemas ──────────────────────────────────────────────────────────

/** source: PHASE_4_PLAN.md §4.2 ablation arm estimand. */
export interface ArmStats {
  readonly n: number;
  readonly pass_rate: number;
  readonly ci95: readonly [number, number];
}

/** source: PHASE_4_PLAN.md §4.2. */
export interface AblationComparisonReport {
  readonly schema_version: 1;
  readonly arms: { readonly with: ArmStats; readonly without: ArmStats };
  readonly difference: {
    readonly delta: number;
    readonly ci95_paired_bootstrap: readonly [number, number] | null;
    readonly p_value: number | null;
  };
  readonly recommendation:
    | "with_prior_violations_helps"
    | "without_helps"
    | "inconclusive_underpowered";
}

/** source: PHASE_4_PLAN.md §4.1. */
export interface ReliabilityComparisonReport {
  readonly schema_version: 1;
  readonly calibrated: ArmStats;
  readonly prior_only: ArmStats;
  readonly difference: {
    readonly delta: number;
    readonly ci95_paired_bootstrap: readonly [number, number] | null;
    readonly p_value: number | null;
  };
  readonly recommendation:
    | "calibration_helps"
    | "prior_helps"
    | "inconclusive_underpowered";
}

/** source: PHASE_4_PLAN.md §4.5. */
export interface KpiGateComparisonReport {
  readonly schema_version: 1;
  readonly control: ArmStats;
  readonly treatment: ArmStats;
  readonly difference: {
    readonly delta: number;
    readonly ci95_paired_bootstrap: readonly [number, number] | null;
    readonly p_value: number | null;
  };
  readonly recommendation:
    | "treatment_better"
    | "control_better"
    | "inconclusive_underpowered";
}

// ─── JSONL schemas ────────────────────────────────────────────────────────────

/**
 * source: heldout-seals.ts:JudgeObservationLogEntry.
 *
 * Wave E extension: `oracle_resolved_truth` (optional) carries the ground-truth
 * verdict produced by invokeOracle() at log-write time for externally-grounded
 * claims. When present, computeReliabilityComparison uses it instead of the
 * annotator-supplied `ground_truth`, breaking the Curie A2 annotator-circularity.
 *
 * source: PHASE_4_PLAN.md §4.1 "Externally-grounded held-out subset".
 */
const ObservationLogEntrySchema = z.object({
  run_id: z.string(),
  judge_id: z.object({ kind: z.string(), name: z.string() }),
  claim_id: z.string(),
  claim_type: z.string(),
  ground_truth: z.boolean(),
  judge_verdict: z.boolean(),
  timestamp: z.string(),
  schema_version: z.literal(1),
  /**
   * Oracle-resolved ground truth (Wave E B1). Present when the claim has external
   * grounding and invokeOracle() was called at annotation time. Absent for
   * legacy entries without external grounding (falls back to ground_truth).
   * source: Curie A2.3, PHASE_4_PLAN.md §4.1.
   */
  oracle_resolved_truth: z.boolean().optional(),
  /**
   * Human-readable oracle evidence for forensic replay (Wave E B1).
   * Non-empty iff oracle_resolved_truth is present.
   * source: Curie A2.3, PHASE_4_PLAN.md §4.1.
   */
  oracle_evidence: z.string().optional(),
});
type ObservationLogEntry = z.infer<typeof ObservationLogEntrySchema>;

/** source: PHASE_4_PLAN.md §4.5; machine-class.ts:GateBlockedLogEntry. */
const GateBlockedEntrySchema = z.object({
  run_id: z.string(),
  gate_id: z.string(),
  fired: z.boolean(),
  timestamp: z.string(),
  schema_version: z.literal(1).optional(),
});
type GateBlockedEntry = z.infer<typeof GateBlockedEntrySchema>;

// ─── JSONL readers + Clopper-Pearson + arm stats ─────────────────────────────

function readJsonl<T>(path: string, schema: z.ZodType<T>): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = schema.safeParse(JSON.parse(trimmed));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // Skip malformed lines — log may grow concurrently.
    }
  }
  return out;
}

/**
 * Compute exact 95% Clopper-Pearson CI for a proportion. n=0 → [0, 1].
 *
 * source: Clopper & Pearson (1934). Biometrika 26(4):404–413.
 */
function ci95(successes: number, n: number): readonly [number, number] {
  if (n === 0) return [0, 1];
  const interval = clopperPearson(successes, n, 0.95);
  return [interval.lower, interval.upper];
}

/** source: PHASE_4_PLAN.md §4.2 per-arm estimand. */
function armStats(outcomes: readonly boolean[]): ArmStats {
  const n = outcomes.length;
  if (n === 0) return { n: 0, pass_rate: 0, ci95: [0, 1] };
  const successes = outcomes.filter(Boolean).length;
  return { n, pass_rate: successes / n, ci95: ci95(successes, n) };
}

/**
 * Read the MaxAttempts lock to extract `rng_seed`. Caller must have already
 * called verifyMaxAttemptsHeldoutSeal; this trusts the file is valid.
 *
 * source: heldout-seals.ts:MaxAttemptsHeldoutLockSchema.
 */
function readMaxAttemptsLock(lockPath: string): MaxAttemptsHeldoutLock {
  return JSON.parse(readFileSync(lockPath, "utf8")) as MaxAttemptsHeldoutLock;
}

// ─── 4.2 — computeAblationComparison ─────────────────────────────────────────

/**
 * Compute the 4.2 retry-ablation comparison from the observation log.
 *
 * Seal (B3): verifyMaxAttemptsHeldoutSeal called BEFORE reading data.
 * Bootstrap (E1.B): paired bootstrap on claim_id-paired observations,
 * iterations=10_000, rngSeed = lock.rng_seed.
 *
 * Precondition: observationLogPath / lockPath are valid; lock is sealed.
 * Postcondition: returns AblationComparisonReport. Never throws on empty log.
 *
 * source: PHASE_4_PLAN.md §4.2; Wave D B2/B3; Wave E E1.B.
 */
export function computeAblationComparison(
  observationLogPath: string,
  lockPath: string,
): AblationComparisonReport {
  const entries = readJsonl(observationLogPath, ObservationLogEntrySchema);
  const runIds = [...new Set(entries.map((e) => e.run_id))];
  // FAILS_ON: lock missing/unsealed → throws.
  verifyMaxAttemptsHeldoutSeal(runIds, lockPath);
  const lock = readMaxAttemptsLock(lockPath);

  const withOutcomes: boolean[] = [];
  const withoutOutcomes: boolean[] = [];
  for (const entry of entries) {
    const arm: RetryArm = getRetryArmForRun(entry.run_id);
    const judgeCorrect = entry.judge_verdict !== entry.ground_truth;
    if (arm === "with_prior_violations") withOutcomes.push(judgeCorrect);
    else withoutOutcomes.push(judgeCorrect);
  }
  const withStats = armStats(withOutcomes);
  const withoutStats = armStats(withoutOutcomes);
  const delta = withStats.pass_rate - withoutStats.pass_rate;

  const { pairs } = pairByClaimId<RetryArm>(
    entries,
    (e) => getRetryArmForRun(e.run_id),
    "with_prior_violations",
    "without_prior_violations",
  );

  let ci95Bootstrap: readonly [number, number] | null = null;
  let pValue: number | null = null;
  let rec: AblationComparisonReport["recommendation"] = "inconclusive_underpowered";

  if (pairs.length >= 1) {
    const result = pairedBootstrapAccuracyDifference(
      pairs,
      EMPTY_ACCURACY_MAP,
      EMPTY_ACCURACY_MAP,
      BOOTSTRAP_ITERATIONS,
      lock.rng_seed,
      SEAL_VERIFIED,
    );
    ci95Bootstrap = result.ci95;
    pValue = result.pValue;
    const which = bootstrapRecommendation(result.ci95[0], result.ci95[1], pairs.length);
    if (which === "calibrated") rec = "with_prior_violations_helps";
    else if (which === "prior") rec = "without_helps";
  }

  return {
    schema_version: 1,
    arms: { with: withStats, without: withoutStats },
    difference: { delta, ci95_paired_bootstrap: ci95Bootstrap, p_value: pValue },
    recommendation: rec,
  };
}

// ─── 4.1 — computeReliabilityComparison ──────────────────────────────────────

/**
 * Compute the 4.1 reliability comparison (calibrated vs prior-only Beta(7,3)).
 *
 * Seal (B3): verifyReliabilityHeldoutSeal called BEFORE reading.
 * Bootstrap (E1.B): paired bootstrap on per-claim majority outcomes,
 * iterations=10_000, rngSeed = stringSeedToNumber(lock.seed).
 * Oracle wiring (E2): when an observation entry carries `oracle_resolved_truth`,
 * that value is used as ground truth instead of the annotator-supplied
 * `ground_truth`, breaking the Curie A2 annotator-circularity for that claim.
 * For entries WITHOUT `oracle_resolved_truth`, the function falls back to
 * consensus-majority and emits a console.warn flagging the circularity.
 *
 * Precondition: observationLogPath valid; lockPath points to v2 reliability lock.
 * Postcondition: returns ReliabilityComparisonReport.
 *   - calibrated arm uses oracle_resolved_truth where available.
 *   - prior arm uses consensus-majority for all entries (baseline comparison).
 *
 * source: PHASE_4_PLAN.md §4.1; Wave D B2/B3; Wave E E1.B + E2.
 */
export function computeReliabilityComparison(
  observationLogPath: string,
  lockPath: string,
): ReliabilityComparisonReport {
  const lock: ReliabilityHeldoutLock = verifyReliabilityHeldoutSeal(lockPath);
  const entries = readJsonl(observationLogPath, ObservationLogEntrySchema);

  // Separate entries by oracle grounding presence.
  // FAILS_ON: entries with oracle_resolved_truth=undefined → circularity warning logged.
  let circularityWarnFired = false;
  for (const e of entries) {
    if (e.oracle_resolved_truth === undefined && !circularityWarnFired) {
      console.warn(
        `[computeReliabilityComparison] claim "${e.claim_id}" has no oracle_resolved_truth; ` +
          `falling back to consensus-majority ground_truth — annotator-circularity (Curie A2) ` +
          `applies for this claim. To resolve: call invokeOracle() at log-write time and store ` +
          `the result in oracle_resolved_truth. See PHASE_4_PLAN.md §4.1.`,
      );
      circularityWarnFired = true; // Emit once per call to avoid log flooding.
    }
  }

  // calibrated arm: uses oracle_resolved_truth when available; falls back to ground_truth.
  // prior arm: always uses ground_truth (annotator-derived, baseline comparison).
  // Invariant: both arrays have the same length === entries.length.
  const calibratedOutcomes: boolean[] = [];
  const priorOutcomes: boolean[] = [];
  for (const e of entries) {
    const effectiveTruth =
      e.oracle_resolved_truth !== undefined ? e.oracle_resolved_truth : e.ground_truth;
    const calibratedCorrect = e.judge_verdict !== effectiveTruth;
    const priorCorrect = e.judge_verdict !== e.ground_truth;
    calibratedOutcomes.push(calibratedCorrect);
    priorOutcomes.push(priorCorrect);
  }

  const calibratedStats = armStats(calibratedOutcomes);
  const priorStats = armStats(priorOutcomes);
  const delta = calibratedStats.pass_rate - priorStats.pass_rate;

  // Per-claim pairing for the bootstrap.
  // Invariant: claimMap accumulates per-claim correct counts for BOTH arms.
  const claimMap = new Map<
    string,
    { calibratedCorrect: number; priorCorrect: number; total: number }
  >();
  for (const e of entries) {
    const effectiveTruth =
      e.oracle_resolved_truth !== undefined ? e.oracle_resolved_truth : e.ground_truth;
    const calibratedCorrect = e.judge_verdict !== effectiveTruth;
    const priorCorrect = e.judge_verdict !== e.ground_truth;
    let b = claimMap.get(e.claim_id);
    if (!b) {
      b = { calibratedCorrect: 0, priorCorrect: 0, total: 0 };
      claimMap.set(e.claim_id, b);
    }
    b.total++;
    if (calibratedCorrect) b.calibratedCorrect++;
    if (priorCorrect) b.priorCorrect++;
  }
  const claims: HeldoutClaim[] = [];
  for (const [claim_id, b] of claimMap) {
    const calibratedMajority = b.calibratedCorrect * 2 > b.total;
    const priorMajority = b.priorCorrect * 2 > b.total;
    claims.push({
      claim_id,
      calibrated_correct: calibratedMajority,
      prior_correct: priorMajority,
    });
  }

  let ci95Bootstrap: readonly [number, number] | null = null;
  let pValue: number | null = null;
  let rec: ReliabilityComparisonReport["recommendation"] = "inconclusive_underpowered";

  if (claims.length >= 1) {
    const result = pairedBootstrapAccuracyDifference(
      claims,
      EMPTY_ACCURACY_MAP,
      EMPTY_ACCURACY_MAP,
      BOOTSTRAP_ITERATIONS,
      stringSeedToNumber(lock.seed),
      SEAL_VERIFIED,
    );
    ci95Bootstrap = result.ci95;
    pValue = result.pValue;
    const which = bootstrapRecommendation(result.ci95[0], result.ci95[1], claims.length);
    if (which === "calibrated") rec = "calibration_helps";
    else if (which === "prior") rec = "prior_helps";
  }

  return {
    schema_version: 1,
    calibrated: calibratedStats,
    prior_only: priorStats,
    difference: { delta, ci95_paired_bootstrap: ci95Bootstrap, p_value: pValue },
    recommendation: rec,
  };
}

// ─── 4.5 — computeKpiGateComparison ──────────────────────────────────────────

/**
 * Compute the 4.5 KPI-gate comparison (control vs treatment fire rates).
 *
 * Seal (B3): verifyKpiGatesHeldoutSeal called BEFORE reading.
 * Pairing (E1.B): KPI runs are not naturally paired. We sort each arm by
 * run_id and zip up to min(controlN, treatmentN). Synthetic pairing yields
 * a slightly conservative CI (wider than truly paired data); arm-level n
 * and pass_rate use the un-truncated arms.
 *
 * Precondition: gateBlockedLogPath valid; lockPath points to KPI lock.
 * Postcondition: returns KpiGateComparisonReport.
 *
 * source: PHASE_4_PLAN.md §4.5; Wave D B2/B3; Wave E E1.B.
 */
export function computeKpiGateComparison(
  gateBlockedLogPath: string,
  lockPath: string,
): KpiGateComparisonReport {
  const lock = verifyKpiGatesHeldoutSeal(lockPath);
  if (lock.partition_hash === null || lock.rng_seed === null) {
    return {
      schema_version: 1,
      control: { n: 0, pass_rate: 0, ci95: [0, 1] },
      treatment: { n: 0, pass_rate: 0, ci95: [0, 1] },
      difference: { delta: 0, ci95_paired_bootstrap: null, p_value: null },
      recommendation: "inconclusive_underpowered",
    };
  }

  const entries = readJsonl(gateBlockedLogPath, GateBlockedEntrySchema);

  type Labeled = { run_id: string; pass: boolean };
  const controlList: Labeled[] = [];
  const treatmentList: Labeled[] = [];
  for (const e of entries) {
    const labeled: Labeled = { run_id: e.run_id, pass: !e.fired };
    if (isControlArmRun(e.run_id)) controlList.push(labeled);
    else treatmentList.push(labeled);
  }

  const controlStats = armStats(controlList.map((o) => o.pass));
  const treatmentStats = armStats(treatmentList.map((o) => o.pass));
  const delta = treatmentStats.pass_rate - controlStats.pass_rate;

  // Synthetic pairing: sorted-zip on run_id (no claim-level pairing axis).
  const cmp = (a: Labeled, b: Labeled) =>
    a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0;
  controlList.sort(cmp);
  treatmentList.sort(cmp);
  const pairLen = Math.min(controlList.length, treatmentList.length);
  const pairs: HeldoutClaim[] = [];
  for (let i = 0; i < pairLen; i++) {
    pairs.push({
      claim_id: `pair_${i}`,
      calibrated_correct: treatmentList[i].pass,
      prior_correct: controlList[i].pass,
    });
  }

  let ci95Bootstrap: readonly [number, number] | null = null;
  let pValue: number | null = null;
  let rec: KpiGateComparisonReport["recommendation"] = "inconclusive_underpowered";

  if (pairs.length >= 1) {
    const result = pairedBootstrapAccuracyDifference(
      pairs,
      EMPTY_ACCURACY_MAP,
      EMPTY_ACCURACY_MAP,
      BOOTSTRAP_ITERATIONS,
      lock.rng_seed,
      SEAL_VERIFIED,
    );
    ci95Bootstrap = result.ci95;
    pValue = result.pValue;
    const which = bootstrapRecommendation(result.ci95[0], result.ci95[1], pairs.length);
    if (which === "calibrated") rec = "treatment_better";
    else if (which === "prior") rec = "control_better";
  }

  return {
    schema_version: 1,
    control: controlStats,
    treatment: treatmentStats,
    difference: { delta, ci95_paired_bootstrap: ci95Bootstrap, p_value: pValue },
    recommendation: rec,
  };
}
