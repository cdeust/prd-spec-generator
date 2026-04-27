/**
 * Reliability repository — interface and types for per-judge Beta-posterior storage.
 *
 * Placement rationale: core declares ports (DIP §1.5 / coding-standards §2.3).
 * Infrastructure implements them. No SQLite import here.
 *
 * Per-judge × per-(claim_type, verdict_direction) reliability is stored as
 * separate Beta parameters for sensitivity (correct on FAIL claims) and
 * specificity (correct on PASS claims). The open Curie hand-off in
 * docs/PHASE_4_PLAN.md §4.1 mandated this split.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 — "Verdict-direction asymmetry: maintain
 * TWO Beta posteriors per (agent, claim_type) cell."
 */

import type { AgentIdentity } from "../index.js";
import type { Claim } from "../domain/agent.js";

// ─── Schema version ──────────────────────────────────────────────────────────

/**
 * Schema version for the agent_reliability table.
 *
 * On open, the implementation reads this value from the DB and refuses to
 * proceed if it does not match. Auto-migration is out of scope for Wave B.
 *
 * source: Laplace L6 — "Implementation gates require persisted records carry
 * a schema-version snapshot for forward compatibility."
 */
export const RELIABILITY_SCHEMA_VERSION = 1 as const;

// ─── Beta prior ─────────────────────────────────────────────────────────────

/**
 * Default prior parameters: Beta(7, 3).
 * Mean = 7/10 = 0.7, effective sample size (ESS) = 10.
 *
 * This is the fallback when no observations exist for a (judge × claim_type
 * × verdict_direction) cell. It is moderately informative toward reliability,
 * NOT a weak prior — the prior doc-comment in consensus.ts previously
 * described it as "uniform weak prior," which was incorrect.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 — "Prior: Beta(7, 3) — mean 0.7,
 * effective sample size 10. (Laplace: this is moderately-informative-toward-
 * reliability, NOT weak; the existing comment is corrected.)"
 *
 * These values are to be replaced by the B1 wave's `reliability.ts` exports
 * once that module lands. The import comment below documents the expected
 * interface for B1 to implement.
 *
 * B1 interface contract (to-be): export const BETA_PRIOR: { alpha: number; beta: number }
 * from packages/benchmark/calibration/reliability.ts
 */
export const BETA_PRIOR_ALPHA = 7;
export const BETA_PRIOR_BETA = 3;

// ─── Domain types ────────────────────────────────────────────────────────────

/**
 * Direction of the verdict being assessed:
 * - 'pass': the judge reported PASS / SPEC-COMPLETE / NEEDS-RUNTIME for a claim
 *   where ground truth is pass → specificity measurement.
 * - 'fail': the judge reported FAIL for a claim where ground truth is fail
 *   → sensitivity measurement.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 Curie hand-off resolution.
 */
export type VerdictDirection = "pass" | "fail";

/**
 * One persisted reliability record for a (judge × claim_type × verdict_direction)
 * cell.
 *
 * Fields:
 *   agentKind, agentName    — uniquely identify the judge (mirrors AgentIdentity)
 *   claimType               — from ClaimSchema.claim_type
 *   verdictDirection        — sensitivity ('fail') or specificity ('pass') track
 *   alpha                   — Beta posterior α (≥ BETA_PRIOR_ALPHA)
 *   beta                    — Beta posterior β (≥ BETA_PRIOR_BETA)
 *   nObservations           — count of ground-truth-matched observations (= α + β - 10)
 *                             stored explicitly for readability; redundant with α,β.
 *   lastUpdated             — ISO-8601 UTC timestamp of last write
 *   schemaVersion           — snapshot of RELIABILITY_SCHEMA_VERSION at write time;
 *                             enables audit replay (Laplace L6)
 */
export interface JudgeReliabilityRecord {
  readonly agentKind: AgentIdentity["kind"];
  readonly agentName: string;
  readonly claimType: Claim["claim_type"];
  readonly verdictDirection: VerdictDirection;
  readonly alpha: number;
  readonly beta: number;
  readonly nObservations: number;
  readonly lastUpdated: string;
  readonly schemaVersion: number;
}

/**
 * One ground-truth-verified observation fed into recordObservation.
 *
 * Only observations from the calibration set (ground_truth from both the
 * deterministic validator AND an independent human reviewer agree) are valid
 * inputs. Parse-failure verdicts (INCONCLUSIVE with caveats: ["parse_error"])
 * must be EXCLUDED before calling this.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 — "Ground-truth procedure (Curie R2)."
 */
export interface ReliabilityObservation {
  /**
   * The ground-truth outcome for this claim.
   * true = the claim is a genuine FAIL (used for sensitivity).
   * false = the claim is a genuine PASS (used for specificity).
   */
  readonly groundTruthIsFail: boolean;
  /**
   * Whether the judge's verdict matched the ground truth.
   */
  readonly judgeWasCorrect: boolean;
}

// ─── Port ────────────────────────────────────────────────────────────────────

/**
 * Port (core declares, infrastructure implements — DIP §1.5).
 *
 * Consumers (e.g. the consensus engine in @prd-gen/verification) import only
 * this interface and the domain types. They never import the SQLite
 * implementation directly.
 *
 * Empty-DB / first-run contract:
 *   getReliability(...) returns null for an unseen cell.
 *   Callers must interpret null as "use BETA_PRIOR_ALPHA / BETA_PRIOR_BETA."
 *   This keeps the fallback logic in the caller (consensus.ts) — the
 *   repository does not embed policy.
 *
 * Schema-version contract:
 *   The implementation must call getSchemaVersion() internally on open and
 *   throw if the persisted version != RELIABILITY_SCHEMA_VERSION. The caller
 *   is NOT required to call getSchemaVersion() — it is exposed only for
 *   diagnostics and test assertions.
 */
export interface ReliabilityRepository {
  /**
   * Return the persisted record for (judge_id, claim_type, verdict_direction),
   * or null if no observations have been recorded for that cell yet.
   */
  getReliability(
    judge: AgentIdentity,
    claimType: Claim["claim_type"],
    verdictDirection: VerdictDirection,
  ): JudgeReliabilityRecord | null;

  /**
   * Record one ground-truth-matched observation for (judge × claim_type).
   *
   * The verdict_direction is derived from the observation:
   *   groundTruthIsFail = true  → update the 'fail' (sensitivity) cell.
   *   groundTruthIsFail = false → update the 'pass' (specificity) cell.
   *
   * The Beta posterior is updated as:
   *   if judgeWasCorrect → alpha += 1
   *   else               → beta  += 1
   * nObservations increments by 1 regardless.
   *
   * source: docs/PHASE_4_PLAN.md §4.1 — "Posterior: Beta(7 + correct, 3 + incorrect)"
   *
   * Thread-safety: SQLite WAL mode serializes concurrent writes at the file
   * lock. Callers must not assume in-memory atomicity across multiple calls.
   *
   * source: docs/PHASE_4_PLAN.md §Persistence concurrency — "EvidenceRepository
   * writes from concurrent runs serialize at the SQLite file lock. WAL mode is on."
   */
  recordObservation(
    judge: AgentIdentity,
    claimType: Claim["claim_type"],
    observation: ReliabilityObservation,
  ): void;

  /**
   * Return all records — used by control-chart rendering (CC-4).
   * Never returns records from a schema-version-mismatched DB (the ctor throws
   * before this can be called on a mismatched DB).
   */
  getAllRecords(): ReadonlyArray<JudgeReliabilityRecord>;

  /**
   * Return the schema version stored in the DB.
   * Exposed for diagnostics and tests; the impl verifies this internally on open.
   */
  getSchemaVersion(): number;

  /** Release the DB connection. Idempotent. */
  close(): void;
}
