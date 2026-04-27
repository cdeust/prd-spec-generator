/**
 * Retry-attempt observation types and extraction for the 4.2 ablation arm.
 *
 * C1 (research-scientist) owns the Kaplan-Meier estimator that consumes these
 * records. This module owns:
 *   - The observation type shape (all 6 fields required by the ablation design)
 *   - Pure extraction from PipelineState (no I/O)
 *   - Append-only JSONL audit log (write-only infrastructure seam)
 *
 * DO NOT import from this module in orchestration — it is benchmark-layer
 * infrastructure only (§2.2: benchmark → orchestration is allowed; reverse
 * is forbidden).
 *
 * source: PHASE_4_PLAN.md §4.2 "Mechanistic instrumentation (Curie A4 /
 * Deming)" + "Ablation arm" — both specify the 6-field shape and the audit
 * log requirement.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SectionType } from "@prd-gen/core";
import type { PipelineState, SectionStatus } from "@prd-gen/orchestration";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Ablation arm identifier — mirrors C1's `getRetryArmForRun` output contract.
 * C1 must export `getRetryArmForRun(run_id: string): RetryArm` before the
 * extraction is fully wired. Until then, callers pass `arm` explicitly.
 *
 * source: PHASE_4_PLAN.md §4.2 ablation arm specification.
 */
export type RetryArm =
  | "with_prior_violations"
  | "without_prior_violations";

/**
 * Terminal outcome for a single retry attempt.
 *
 * - "passed"              — validation succeeded at this attempt
 * - "failed_terminal"     — failed AND attempt >= MAX_ATTEMPTS (no further retries)
 * - "failed_pending_retry"— failed AND attempt < MAX_ATTEMPTS (next retry queued)
 *
 * source: PHASE_4_PLAN.md §4.2 "retry_outcome" field specification.
 */
export type RetryOutcome =
  | "passed"
  | "failed_terminal"
  | "failed_pending_retry";

/**
 * One record per retry attempt per section. All 6 fields are required —
 * partial records must not be written to the audit log.
 *
 * Join keys: (run_id, section_type, attempt) is unique per pipeline run.
 * C1's Kaplan-Meier estimator joins on (run_id, section_type) to build
 * survival curves.
 *
 * source: PHASE_4_PLAN.md §4.2 — all 6 fields named explicitly:
 *   attempt, prior_violations_count, prior_violations_used, arm,
 *   retry_outcome, section_type + run_id.
 */
export interface RetryAttemptObservation {
  /** 1-indexed. Attempt 1 is the initial draft; attempt 2+ are retries. */
  readonly attempt: number;
  /**
   * Count of violation strings actually fed into the retry prompt at this
   * attempt. NOT the count from the previous attempt's failure report —
   * this is the count consumed by the engineer subagent at this attempt.
   *
   * On attempt 1 (first draft) this is always 0 because no prior violations
   * exist yet. On attempt k≥2 this is `last_violations.length` from the
   * section status BEFORE this attempt's draft action was emitted.
   */
  readonly prior_violations_count: number;
  /**
   * True iff the retry handler actually consumed `last_violations` when
   * building the draft prompt. This is the load-bearing ablation signal:
   * FALSE in the without_prior_violations arm even when prior violations
   * exist (they are zeroed before the prompt is built).
   *
   * TODO(C1): when section-generation.ts is wired to the ablation arm via
   * `getRetryArmForRun`, the handler must set a `prior_violations_used`
   * boolean on SectionStatus (or emit it in a side-channel) so extraction
   * here is direct rather than inferred. Until then, this field is INFERRED:
   *   prior_violations_used = (arm === "with_prior_violations" && attempt > 1)
   * Inference is correct for synthetic benchmark runs but cannot distinguish
   * a handler bug (arm=with but violations not consumed) from correct
   * behavior. The TODO is a gap in observability, not a correctness bug for
   * the ablation.
   */
  readonly prior_violations_used: boolean;
  /** Ablation arm assignment for this run. Set by C1's `getRetryArmForRun`. */
  readonly arm: RetryArm;
  /** Terminal outcome of THIS attempt (not the section's overall outcome). */
  readonly retry_outcome: RetryOutcome;
  /** Section type — join key with C1's survival curve stratification. */
  readonly section_type: SectionType;
  /** Pipeline run ID — join key with PipelineState and EvidenceRepository. */
  readonly run_id: string;
}

// ─── MAX_ATTEMPTS mirror ─────────────────────────────────────────────────────

/**
 * Mirror of section-generation.ts MAX_ATTEMPTS. Must stay in sync.
 *
 * TODO(C1): export MAX_ATTEMPTS from orchestration so both sites read one
 * constant. Until the export exists, this shadow constant is the interim
 * solution. If MAX_ATTEMPTS changes in section-generation.ts without updating
 * this value, the `failed_terminal` vs `failed_pending_retry` classification
 * will be wrong for real-state extractions.
 *
 * source: section-generation.ts line 46 ("const MAX_ATTEMPTS = 3").
 */
const MAX_ATTEMPTS_MIRROR = 3;

// ─── Extraction ──────────────────────────────────────────────────────────────

/**
 * Extract retry observations from a completed (or in-progress) PipelineState.
 * Pure function — reads state only, no I/O, no mutation.
 *
 * Postcondition: every returned observation has all 6 required fields.
 * Postcondition: for attempt 1, prior_violations_count === 0 and
 *   prior_violations_used === false (no violations to consume on first draft).
 * Postcondition: the returned array length equals the total attempt count
 *   across all sections that have at least one attempt recorded.
 *
 * State shape dependency:
 *   SectionStatus.attempt    — current (latest) attempt number.
 *   SectionStatus.status     — "passed" | "failed" | "generating" | ...
 *   SectionStatus.last_violations — violations from the LAST completed attempt.
 *
 * GAP: PipelineState does not currently persist per-attempt history. Only the
 * latest attempt's `last_violations` is visible. This means:
 *   - For a section with attempt=3 and status=failed, we can only reconstruct
 *     the FINAL attempt's record with certainty; earlier attempts are inferred
 *     from the monotone attempt counter.
 *   - `prior_violations_count` on intermediate attempts is UNKNOWN and
 *     reported as 0 (conservative — undercounts real usage).
 *   - `prior_violations_used` on intermediate attempts is INFERRED from arm.
 *
 * TODO(C1): To close this gap, SectionStatus needs an `attempt_log` field:
 *   attempt_log: Array<{ attempt: number; violations_fed: string[] }>
 * This would let extraction read exact violation counts per attempt rather
 * than only the terminal state. Required for Schoenfeld N≈2,070 analysis
 * precision. Until added to state.ts, the benchmark produces approximate
 * observations sufficient for the ablation pilot but not for the full study.
 *
 * @param state - Completed pipeline state (any step, any terminal status).
 * @param arm   - Ablation arm for this run, from C1's `getRetryArmForRun`.
 * @returns     - One observation per attempt across all sections.
 *               - Empty if no sections have been attempted.
 */
export function extractRetryObservations(
  state: PipelineState,
  arm: RetryArm,
): ReadonlyArray<RetryAttemptObservation> {
  const observations: RetryAttemptObservation[] = [];

  for (const section of state.sections) {
    const sectionObs = extractSectionObservations(section, arm, state.run_id);
    observations.push(...sectionObs);
  }

  return observations;
}

/**
 * Extract per-attempt observations for one section.
 * Internal helper — not exported.
 *
 * Precondition: section.attempt >= 0.
 * Postcondition: returns exactly section.attempt records (one per attempt
 *   the section underwent). Returns [] if section.attempt === 0 (never started).
 */
function extractSectionObservations(
  section: SectionStatus,
  arm: RetryArm,
  run_id: string,
): RetryAttemptObservation[] {
  if (section.attempt === 0) return [];

  const obs: RetryAttemptObservation[] = [];
  const totalAttempts = section.attempt;

  for (let i = 1; i <= totalAttempts; i++) {
    const isLastAttempt = i === totalAttempts;
    const isTerminallyFailed = section.status === "failed" && isLastAttempt;
    const isPassed = section.status === "passed" && isLastAttempt;

    // prior_violations_count: on the last attempt we can read last_violations
    // length (those were the violations fed into THIS attempt's prompt, set
    // during the previous attempt's validateAndAdvance retry branch).
    // On earlier attempts we have no history — report 0 (see GAP note above).
    const prior_violations_count =
      isLastAttempt && i > 1 ? section.last_violations.length : 0;

    // prior_violations_used: INFERRED until C1 wires the state field.
    // On attempt 1: always false (no violations exist yet).
    // On attempt k≥2, with_prior_violations arm: true (violations were fed).
    // On attempt k≥2, without_prior_violations arm: false (arm zeroed them).
    const prior_violations_used =
      arm === "with_prior_violations" && i > 1;

    const retry_outcome: RetryOutcome = isPassed
      ? "passed"
      : isTerminallyFailed || (i >= MAX_ATTEMPTS_MIRROR && !isPassed)
        ? "failed_terminal"
        : "failed_pending_retry";

    obs.push({
      attempt: i,
      prior_violations_count,
      prior_violations_used,
      arm,
      retry_outcome,
      section_type: section.section_type,
      run_id,
    });
  }

  return obs;
}

// ─── Audit log (append-only JSONL) ───────────────────────────────────────────

/**
 * Default audit log path. Gitignored (see .gitignore).
 * Uses resolve() so callers in different cwd contexts get the same path.
 *
 * source: calibration-seams pattern — append-only JSONL, never truncated.
 */
const DEFAULT_AUDIT_LOG_PATH = resolve(
  process.cwd(),
  "data/retry-observation-log.jsonl",
);

/**
 * Append one observation to the JSONL audit log.
 *
 * Postcondition: the file at `logPath` has one additional newline-terminated
 *   JSON object appended. Existing content is never modified.
 * Postcondition: if the containing directory does not exist it is created
 *   (recursive) before the first write.
 *
 * The write is synchronous to avoid interleaving from concurrent benchmark
 * workers. If concurrent writes are introduced, switch to an exclusive-lock
 * write pattern (flock or a per-process queue).
 *
 * @param obs     - Fully populated observation (all 6 fields required).
 * @param logPath - Override for testing. Defaults to data/retry-observation-log.jsonl.
 */
export function appendRetryObservationLog(
  obs: RetryAttemptObservation,
  logPath: string = DEFAULT_AUDIT_LOG_PATH,
): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(obs) + "\n", "utf-8");
}
