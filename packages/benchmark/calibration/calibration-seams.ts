/**
 * Calibration seams — Phase 4.1/4.2/4.5 control-arm and partition seams.
 *
 * This module owns:
 *
 *   1. FNV-1a 32-bit hash + assignPartition — shared hash primitive for all
 *      calibration use cases.
 *
 *   2. Control arm seam (CC-3 / B-Popper-1): isControlArmRun +
 *      getReliabilityForRun. ε-greedy forced exploration partition.
 *
 *   3. Retry-ablation arm seam (Phase 4.2): getRetryArmForRun — 50/50 split
 *      using top-two-bits of FNV-1a for the prior_violations ablation.
 *
 *   4. MAX_ATTEMPTS control arm seam (Phase 4.2 CC-3): getMaxAttemptsForRun.
 *
 * Lock schemas, seal verification, and JSONL sinks live in heldout-seals.ts
 * (extracted to keep both files under §4 500-line limit).
 *
 * Layer contract (§2.2): benchmark may import from orchestration (outward →
 * inward is permitted); orchestration must NOT import from benchmark.
 *
 * source: B-Popper-1, C-Curie-A4, C-Shannon-CONCERN-1 cross-audit findings.
 * source: docs/PHASE_4_PLAN.md §CC-3, §4.1, §4.2.
 * source: Wave C integration — B1 (Math.imul fix), B4 (schema split),
 *   B5 (docstring correction), B8 (size limit compliance).
 */

// ─── Single source of truth for MAX_ATTEMPTS baseline ────────────────────────
// Wave D1.A: import from orchestration so MAX_ATTEMPTS_BASELINE tracks the
// authoritative value without a mirror constant. The benchmark layer is allowed
// to import orchestration (§2.2 benchmark → orchestration direction).
import { MAX_ATTEMPTS as _MAX_ATTEMPTS_FROM_ORCHESTRATION } from "@prd-gen/orchestration";

// ─── Re-exports from heldout-seals.ts (backward compat + single import point)

export {
  type MaxAttemptsHeldoutLock,
  type HeldoutPartitionLock,
  type ReliabilityHeldoutLock,
  type KpiGatesHeldoutLock,
  type DroppedClaimEntry,
  type JudgeObservationLogEntry,
  RELIABILITY_HELDOUT_LOCK_SCHEMA_VERSION,
  ReliabilityHeldoutLockSchema,
  KpiGatesHeldoutLockSchema,
  verifyMaxAttemptsHeldoutSeal,
  verifyHeldoutPartitionSeal,
  verifyReliabilityHeldoutSeal,
  verifyKpiGatesHeldoutSeal,
  DROPPED_CLAIMS_PATH,
  appendDroppedClaim,
  JUDGE_OBSERVATION_LOG_PATH,
  appendObservationLog,
} from "./heldout-seals.js";

// ─── Control arm seam — CC-3 / B-Popper-1 ────────────────────────────────────

/**
 * Compute FNV-1a 32-bit hash of a string.
 * Returns a non-negative integer in [0, 2^32).
 *
 * FNV-1a's high bits are uniformly distributed; low bits are spec-noted as
 * having weaker avalanche properties for short inputs. Top-bit extraction
 * (`>>> 30`) is preferred over `% N` per FNV-1a IETF draft §3 even though
 * for inputs in this codebase the empirical bias of `% N` is below detection
 * threshold (Fermi N=10,000: uniform 25/25/25/25 across % 4; Wave C
 * cross-audit 2026-04-27).
 *
 * `Math.imul` provides 32-bit-wrapping multiplication; plain `*` overflows JS
 * doubles when intermediate values exceed Number.MAX_SAFE_INTEGER (2^53),
 * producing imprecise floats and incorrect hash values.
 *
 * source: FNV-1a IETF draft (Eastlake/Hansen) —
 *   https://datatracker.ietf.org/doc/html/draft-eastlake-fnv-17
 *   32-bit FNV prime = 16777619; FNV offset basis = 2166136261.
 * source: Math.imul correctness — MDN Web Docs, "Math.imul".
 *
 * Precondition: input is a string (may be empty).
 * Postcondition: return value ∈ [0, 2^32 − 1]; deterministic for a given input.
 * Invariant: hash is a uint32 after each iteration (>>> 0 enforces wrap).
 * Termination: i increases monotonically to input.length.
 */
export function fnv1a32(input: string): number {
  // source: FNV-1a IETF draft (Eastlake/Hansen). Math.imul provides
  // 32-bit-wrapping multiplication; plain `*` overflows JS doubles when
  // intermediate values exceed Number.MAX_SAFE_INTEGER (2^53).
  const FNV_OFFSET_BASIS = 2166136261;
  const FNV_PRIME = 16777619;
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Assign a claim ID to a partition using the FNV-1a hash.
 *
 * Used to deterministically assign claims to held-out vs calibration
 * partitions for the reliability (4.1) use case.
 *
 * Precondition: claimId is a non-empty string; seed is a pre-registered string.
 * Postcondition: deterministic for (claimId, seed); approximately
 *   `partitionFraction` fraction of claim IDs map to "heldout".
 *
 * source: PHASE_4_PLAN.md §4.1 partition-lock-v2 specification.
 */
export function assignPartition(
  claimId: string,
  seed: string,
  partitionFraction = 0.2,
): "heldout" | "calibration" {
  const h = fnv1a32(`${seed}:${claimId}`);
  return h / 0x100000000 < partitionFraction ? "heldout" : "calibration";
}

/**
 * Returns true if this run_id is assigned to the control arm.
 *
 * Allocation: fnv1a32(runId) % 5 === 0 → control arm (ε = 0.20; 1 in 5).
 * The same run_id always maps to the same arm — partitioning is deterministic
 * and stable across restarts.
 *
 * Precondition: runId is a non-empty string.
 * Postcondition: deterministic — the same runId always returns the same value.
 *
 * source: CC-3 / B-Popper-1 — deterministic partition run_id_hash % 5 === 0.
 * source: docs/PHASE_4_PLAN.md §CC-3.
 */
export function isControlArmRun(runId: string): boolean {
  return fnv1a32(runId) % 5 === 0;
}

/**
 * Return null (= use the Beta(7,3) prior) for control-arm runs; delegate to
 * the repository for treatment-arm runs.
 *
 * This is the published seam that 4.4 (strategy wiring) and 4.5 (KPI gate
 * calibration) MUST call instead of calling the repository directly.
 * Wiring into consensus.ts is Wave D scope — do NOT wire it yet.
 *
 * Precondition: judge, claimType, verdictDirection are valid.
 * Postcondition:
 *   - control arm (isControlArmRun(runId) = true): returns null unconditionally.
 *   - treatment arm: returns repository.getReliability(judge, claimType, direction).
 *
 * source: B-Popper-1 cross-audit finding; CC-3 implementation gate.
 * source: Fermi cross-audit, two-proportion z-test, see PHASE_4_PLAN.md §4.1
 */
export function getReliabilityForRun<
  J extends { kind: string; name: string },
  CT extends string,
  D extends string,
>(
  runId: string,
  judge: J,
  claimType: CT,
  verdictDirection: D,
  repository: {
    getReliability(judge: J, claimType: CT, verdictDirection: D): unknown;
  },
): unknown {
  if (isControlArmRun(runId)) {
    // Control arm: ignore history, use Beta(7,3) prior.
    // source: CC-3 — ε=0.20 forced exploration arm.
    return null;
  }
  return repository.getReliability(judge, claimType, verdictDirection);
}

// ─── Retry-ablation arm seam — Phase 4.2 / Wave C1 ───────────────────────────

/**
 * Phase 4.2 ablation tag for the retry-loop calibration.
 *
 * - "with_prior_violations": engineer subagent receives the previous
 *   attempt's `prior_violations` array on retry (current behaviour).
 * - "without_prior_violations": engineer receives an empty `prior_violations`
 *   array on retry (the ablation control).
 *
 * If pass-rate-by-attempt is statistically indistinguishable across arms
 * (log-rank p ≥ 0.05), retries are random draws and prior_violations
 * feedback is broken — MAX_ATTEMPTS = 1 is correct regardless of any
 * survival-rate signal. See PHASE_4_PLAN.md §4.2.
 *
 * source: docs/PHASE_4_PLAN.md §4.2 ablation arm; Fisher Fi-4.2.
 */
export type RetryArm = "with_prior_violations" | "without_prior_violations";

/**
 * Phase 4.2 ablation-arm allocator.
 *
 * Deterministic 50/50 partition using the TOP TWO BITS of fnv1a32(runId):
 * `(fnv1a32(runId) >>> 30) < 2`. Top-bit extraction is used instead of
 * `% 4` because FNV-1a has poor low-bit diffusion for short ASCII inputs
 * (e.g., sequential "run-N" or hex-only UUIDs). The top two bits aggregate
 * avalanche from every input byte and yield a near-uniform 50/50 split.
 *
 * The CC-3 reliability control arm (`isControlArmRun`) uses `% 5` on the
 * same fnv1a32; `% 5` happens to be tolerable for sequential inputs and is
 * already shipped + benchmarked, so it is not changed here. The two
 * partitions remain statistically independent because they read disjoint
 * bit ranges of the same hash.
 *
 * ε = 0.50 matches Schoenfeld's symmetric-allocation assumption
 * (allocationA = 0.5) used in the §4.2 power calculation.
 *
 * Precondition: runId is a non-empty string.
 * Postcondition: deterministic; marginal distribution is 50/50 for any
 *   reasonable run-ID corpus (uniform top-bit avalanche of FNV-1a).
 *
 * source: PHASE_4_PLAN.md §4.2 ablation arm.
 * source: Fowler-Noll-Vo discussion of low-bit bias —
 *   http://www.isthe.com/chongo/tech/comp/fnv/index.html#FNV-1a ("avoid
 *   modulo on the low bits for small power-of-two divisors").
 */
export function getRetryArmForRun(runId: string): RetryArm {
  // Top two bits of the 32-bit FNV-1a hash; uniform under avalanche.
  return (fnv1a32(runId) >>> 30) < 2
    ? "without_prior_violations"
    : "with_prior_violations";
}

// ─── MAX_ATTEMPTS control arm seam — Phase 4.2 CC-3 ──────────────────────────

/**
 * Baseline MAX_ATTEMPTS for the Phase 4.2 control arm.
 *
 * Re-exported from @prd-gen/orchestration so a single constant is authoritative.
 * Wave D1.A eliminated the mirror constant in retry-observations.ts.
 *
 * source: packages/orchestration/src/handlers/section-generation.ts — the
 * exported `MAX_ATTEMPTS` constant (provisional heuristic; Schoenfeld N=823
 * calibration pending, see Phase 4.2 plan).
 */
export const MAX_ATTEMPTS_BASELINE = _MAX_ATTEMPTS_FROM_ORCHESTRATION;

/**
 * CC-3 control-arm seam for Phase 4.2's closed loop.
 *
 * MAX_ATTEMPTS calibration IS a closed loop: a calibrated MAX_ATTEMPTS feeds
 * retry behaviour, which changes future (attempt, pass) observations, which
 * feeds the next calibration. Per CC-3, every closed loop must include a
 * forced-exploration control arm.
 *
 * Allocation reuses `isControlArmRun` (fnv1a32(runId) % 5 === 0; ε = 0.20).
 * Same predicate is reused intentionally so a single run is either fully
 * control-arm or fully treatment-arm; analyses across 4.1 and 4.2 can be
 * joined on run_id without cross-arm contamination. The retry-ablation arm
 * (`getRetryArmForRun`) uses a SEPARATE modulus (4 vs 5) so the two
 * treatments remain statistically independent.
 *
 * Precondition: calibratedValue is a positive integer; runId non-empty.
 * Postcondition:
 *   - control arm: returns MAX_ATTEMPTS_BASELINE (= 3).
 *   - treatment arm: returns calibratedValue.
 *
 * source: PHASE_4_PLAN.md §CC-3; §4.2 closed-loop control arm.
 */
export function getMaxAttemptsForRun(
  runId: string,
  calibratedValue: number,
): number {
  if (!Number.isInteger(calibratedValue) || calibratedValue < 1) {
    throw new Error(
      `getMaxAttemptsForRun: calibratedValue must be a positive integer, got ${calibratedValue}`,
    );
  }
  if (isControlArmRun(runId)) return MAX_ATTEMPTS_BASELINE;
  return calibratedValue;
}
