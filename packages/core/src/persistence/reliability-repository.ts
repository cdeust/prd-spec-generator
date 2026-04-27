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
 * Schema version for the agent_reliability SQLite DB (schema_meta table).
 *
 * On open, the implementation reads this value from the DB and refuses to
 * proceed if it does not match. Auto-migration is out of scope for Wave B.
 *
 * Independent versioning namespace: bumping this constant does NOT require
 * bumping QUEUE_SCHEMA_VERSION (packages/benchmark/calibration/observations.ts).
 * They version separate artifacts — this versions the SQLite agent_reliability DB;
 * QUEUE_SCHEMA_VERSION versions the pending-observations.jsonl queue.
 *
 * source: Laplace L6 — "Implementation gates require persisted records carry
 * a schema-version snapshot for forward compatibility."
 * source: N1 residual — B-residual cross-reference between independent version namespaces.
 * source: N2 residual — bumped from 1 to 2 because the SQL CHECK constraint changed
 *   from ('pass','fail') to ('sensitivity_arm','specificity_arm'); pre-rename DBs
 *   cannot be opened safely.
 */
export const RELIABILITY_SCHEMA_VERSION = 2 as const;

// ─── Beta prior — single source of truth (B-Shannon-7) ──────────────────────

/**
 * Default prior parameters: Beta(7, 3).
 * Mean = 7/10 = 0.7, effective sample size (ESS) = 10.
 *
 * This is the canonical single source of truth for the Beta prior used by
 * reliability calibration throughout the codebase. Per DIP (coding-standards
 * §1.5), this lives in core (inner layer). The benchmark math layer imports
 * from here — not the reverse.
 *
 * This is a moderately-informative prior toward reliability, NOT a weak prior.
 * The pre-Phase-4 comment "uniform weak prior" in consensus.ts was incorrect
 * and has been corrected here.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 PRE-REGISTRATION — "Prior: Beta(7, 3) —
 * mean 0.7, effective sample size 10. (Laplace: moderately-informative-toward-
 * reliability, NOT weak.)"
 * source: Gelman et al. (2013), "Bayesian Data Analysis", 3rd ed., Ch. 2.4
 * (Beta-Binomial conjugacy; prior mean = α/(α+β); ESS = α+β).
 */
export interface BetaParamsCore {
  readonly alpha: number;
  readonly beta: number;
}

export const DEFAULT_RELIABILITY_PRIOR: BetaParamsCore = Object.freeze({
  alpha: 7,
  beta: 3,
});

/**
 * Effective sample size of the default prior = alpha + beta = 10.
 * Used by the math layer to subtract prior ESS from total ESS when computing
 * observation-only counts.
 *
 * source: Gelman et al. (2013), §2.4; docs/PHASE_4_PLAN.md §4.1.
 */
export const RELIABILITY_PRIOR_ESS =
  DEFAULT_RELIABILITY_PRIOR.alpha + DEFAULT_RELIABILITY_PRIOR.beta;

// ─── Domain types ────────────────────────────────────────────────────────────

/**
 * Direction of the verdict arm being tracked:
 * - 'sensitivity_arm': observations where ground truth is FAIL (positive class).
 *   Tracks P(judge says FAIL | ground truth is FAIL) = sensitivity.
 * - 'specificity_arm': observations where ground truth is PASS.
 *   Tracks P(judge says PASS | ground truth is PASS) = specificity.
 *
 * Renamed from 'pass'/'fail' (C-Shannon-CONCERN-3): the old labels were
 * inverted with respect to standard sensitivity/specificity definitions.
 * In the standard binary-classifier convention, 'pass'/'fail' referred to the
 * judge's output label, not the statistical quantity being measured; this led
 * to ambiguity when reasoning about which Beta posterior updates which quantity.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 — verdict-direction asymmetry;
 * Fermi/Shannon cross-audit C-Shannon-CONCERN-3.
 */
export type VerdictDirection = "sensitivity_arm" | "specificity_arm";

/**
 * One persisted reliability record for a (judge × claim_type × verdict_direction)
 * cell.
 *
 * Fields:
 *   agentKind, agentName    — uniquely identify the judge (mirrors AgentIdentity)
 *   claimType               — from ClaimSchema.claim_type
 *   verdictDirection        — 'sensitivity_arm' (gt=FAIL) or 'specificity_arm' (gt=PASS)
 *   alpha                   — Beta posterior α (≥ DEFAULT_RELIABILITY_PRIOR.alpha)
 *   beta                    — Beta posterior β (≥ DEFAULT_RELIABILITY_PRIOR.beta)
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
 *   Callers must interpret null as "use DEFAULT_RELIABILITY_PRIOR."
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
   *   groundTruthIsFail = true  → update the 'sensitivity_arm' cell.
   *   groundTruthIsFail = false → update the 'specificity_arm' cell.
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
