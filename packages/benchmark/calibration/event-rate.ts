/**
 * §4.2 first-attempt fail-rate measurement (Wave D / D3.2).
 *
 * Approximate measurement from PipelineKpis aggregates. The exact per-attempt
 * count requires SectionStatus.attempt_log (D1 territory; not yet wired). Until
 * the per-attempt log lands, this estimator uses:
 *
 *   planned_sections      = section_pass_count + section_fail_count
 *   total_attempts_per_run ≈ round(mean_section_attempts × planned_sections)
 *   events_per_run         = max(0, total_attempts - planned_sections)
 *
 * Each (attempt < terminal) is a "failed_pending_retry" event by definition.
 * A passed section that took k>1 attempts contributed (k-1) such events; a
 * failed-terminal section that took k=MAX_ATTEMPTS contributed (MAX_ATTEMPTS-1).
 * Either way: events = total_attempts − planned_sections.
 *
 * source: docs/PHASE_4_PLAN.md §4.2 event_rate=0.30 PROVISIONAL anchor hedge.
 * source: retry-observations.ts "GAP" comment — per-attempt log not in state yet.
 *
 * Layer contract (§2.2): imports types from src/pipeline-kpis.js (same package);
 * no orchestration types — keeps the calibration perimeter clean.
 */

import type { PipelineKpis } from "../src/pipeline-kpis.js";

export interface EventRateMeasurement {
  readonly totalAttempts: number;
  readonly events: number;
}

/**
 * Estimate (totalAttempts, events) across an array of canned-baseline runs.
 *
 * Precondition: `kpis` is a non-empty array (caller enforces K ≥ 1).
 * Postcondition: events ≤ totalAttempts; both ≥ 0; deterministic given input.
 *
 * source: §4.2 event_rate definition; retry-observations.ts retry_outcome
 *   classification.
 */
export function measureEventRate(
  kpis: ReadonlyArray<PipelineKpis>,
): EventRateMeasurement {
  let totalAttempts = 0;
  let events = 0;
  for (const k of kpis) {
    const failed = k.section_fail_count;
    // From section_pass_rate = passed / planned ⇒ planned = passed + failed.
    // Solve for `passed` from the pass_rate identity:
    //   passed = pass_rate × planned ⇒ passed = pass_rate × (passed + failed).
    //   passed × (1 − pass_rate) = pass_rate × failed
    //   passed = (pass_rate × failed) / (1 − pass_rate)   when pass_rate < 1.
    // pass_rate = 1 (all passed) ⇒ failed = 0; planned = passed; we recover
    //   planned only via mean_section_attempts × planned ≥ 1. Use the fact
    //   that mean_section_attempts is per-section (planned > 0 ⇒ mean ≥ 1).
    const passed =
      k.section_pass_rate >= 1
        ? // All passed — failed=0 by mass conservation; planned unknown without
          // a side channel. Skip events for this run (events=0 by construction
          // since failed=0 means every section passed first try ONLY if
          // mean_attempts ≈ 1; if mean > 1, multi-attempt passes still
          // contributed events that we cannot count from this surface).
          // This is a documented under-count vs the true rate.
          0
        : Math.round(
            (k.section_pass_rate * failed) /
              Math.max(1 - k.section_pass_rate, 1e-9),
          );
    const planned = passed + failed;
    if (planned === 0) continue;
    const totalAttemptsThisRun = Math.round(k.mean_section_attempts * planned);
    const eventsThisRun = Math.max(0, totalAttemptsThisRun - planned);
    totalAttempts += totalAttemptsThisRun;
    events += eventsThisRun;
  }
  return { totalAttempts, events };
}
