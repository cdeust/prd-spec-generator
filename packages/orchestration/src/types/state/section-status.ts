import { z } from "zod";
import { SectionTypeSchema } from "@prd-gen/core";
import { StrategyAssignmentSchema } from "@prd-gen/strategy";

export const SectionStatusSchema = z.object({
  section_type: SectionTypeSchema,
  status: z.enum([
    "pending",
    "retrieving",
    "generating",
    "passed",
    "failed",
  ]),
  attempt: z.number().int().nonnegative(),
  violation_count: z.number().int().nonnegative(),
  last_violations: z.array(z.string()).default([]),
  /** Markdown content of the section — populated after generation passes validation */
  content: z.string().optional(),
  /**
   * Strategy assignment chosen by `@prd-gen/strategy.selectStrategy` at the
   * pending → retrieving transition. Persisted on the section so retries
   * use the SAME strategies (not re-selecting per attempt) and so
   * `EffectivenessTracker.recordExecution` has the assignment to attribute
   * the outcome to.
   *
   * source: Phase 4 strategy-wiring (2026-04). Optional because the
   * selection is gated by the orchestration layer; legacy state snapshots
   * predating the wiring may be absent.
   */
  strategy_assignment: StrategyAssignmentSchema.optional(),
  /**
   * Per-attempt observation log. One entry per draft attempt, recording
   * exactly which violations were fed into the prompt for that attempt.
   *
   * Invariant: attempt_log.length === section.attempt at any stable point
   * (after each validateAndAdvance call). The log is written BEFORE the
   * next draft action is emitted, so the benchmark extraction reads it
   * synchronously rather than inferring from terminal state only.
   *
   * Field semantics:
   *   attempt          — 1-indexed attempt number.
   *   violations_fed   — the violation strings actually passed to the
   *                      engineer subagent prompt for this attempt.
   *                      Empty ([]) on attempt 1 (no prior violations exist).
   *                      For attempt k≥2: the last_violations from the
   *                      previous attempt — OR [] if the run is in the
   *                      without_prior_violations ablation arm (D1.C).
   *                      `violations_fed` is the OBSERVED value, not inferred
   *                      from the arm; this closes the Curie A2 observability
   *                      gap flagged in retry-observations.ts TODO(C1).
   *
   * Defaults to [] for backward compatibility with state snapshots predating
   * Wave D1.B.
   *
   * source: Phase 4.2 ablation design (PHASE_4_PLAN.md §4.2) — per-attempt
   * precision required for Schoenfeld N≈2,070 analysis (curie cross-audit
   * A2: instrumentation must observe behavior, not infer it).
   */
  attempt_log: z
    .array(
      z.object({
        attempt: z.number().int().positive(),
        violations_fed: z.array(z.string()).readonly(),
      }),
    )
    .readonly()
    .default([]),
});
export type SectionStatus = z.infer<typeof SectionStatusSchema>;
