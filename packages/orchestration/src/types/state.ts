/**
 * Runner state — externalized so the host (Claude Code) can persist it
 * across MCP tool calls without re-injecting it into context every time.
 *
 * The pipeline tools (start_pipeline, submit_action_result,
 * get_pipeline_state) are the canonical entry surface; this is the
 * single authoritative state shape.
 */

import { z } from "zod";
import {
  PRDContextSchema,
  SectionTypeSchema,
  AgentIdentitySchema,
} from "@prd-gen/core";
import {
  StrategyAssignmentSchema,
  ExecutionResultSchema,
} from "@prd-gen/strategy";

export const PipelineStepSchema = z.enum([
  "banner",
  "preflight",
  "context_detection",
  "input_analysis",
  "feasibility_gate",
  "clarification",
  "budget",
  "section_generation",
  "jira_generation",
  "file_export",
  "self_check",
  "complete",
]);
export type PipelineStep = z.infer<typeof PipelineStepSchema>;

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
});
export type SectionStatus = z.infer<typeof SectionStatusSchema>;

export const ClarificationTurnSchema = z.object({
  round: z.number().int().min(1),
  question: z.string(),
  answer: z.string().optional(),
  asked_at: z.string(),
  answered_at: z.string().optional(),
});
export type ClarificationTurn = z.infer<typeof ClarificationTurnSchema>;

/**
 * Snapshot of the verification plan dispatched in self-check Phase A.
 * Persisted so Phase B can map invocation_id → claim/judge without re-running
 * planDocumentVerification (which would corrupt attribution if state.sections
 * mutated between phases).
 *
 * `judges[i]` is the AgentIdentity that received `claim_ids[i]`. Storing both
 * preserves judge attribution in `ConsensusVerdict.judges` even on the
 * plan-mismatch fallback path — Bayesian reliability lookups remain correct.
 *
 * INVARIANT (load-bearing): `claim_ids.length === judges.length`. The
 * fallback path in self-check.ts:parseVerdictsFromSnapshot uses positional
 * lookups (`snapshot.judges[idx]` with `idx < snapshot.claim_ids.length`).
 * If lengths diverge, an out-of-bounds read returns `undefined`, which
 * later fails `agentKey()` in consensus.ts. Enforced via Zod refinement.
 *
 * source: dijkstra cross-audit H1 (Phase 3+4, 2026-04).
 */
export const VerificationPlanSnapshotSchema = z
  .object({
    batch_id: z.string(),
    /** Claim IDs in dispatch order — index = invocation slot. */
    claim_ids: z.array(z.string()),
    /** Judge identities, parallel to claim_ids by index. */
    judges: z.array(AgentIdentitySchema),
  })
  .refine((s) => s.claim_ids.length === s.judges.length, {
    message:
      "VerificationPlanSnapshot: claim_ids and judges must have the same length (positional invariant — see self-check.ts:parseVerdictsFromSnapshot).",
    path: ["judges"],
  });
export type VerificationPlanSnapshot = z.infer<
  typeof VerificationPlanSnapshotSchema
>;

export const PipelineStateSchema = z.object({
  run_id: z.string(),
  current_step: PipelineStepSchema,
  prd_context: PRDContextSchema.nullable(),
  feature_description: z.string(),
  codebase_path: z.string().nullable(),
  /**
   * Filesystem path returned by automatised-pipeline `index_codebase`
   * (response field `graph_path`). Subsequent graph-query tools (query_graph,
   * get_symbol, etc.) use this as their `graph_path` argument.
   */
  codebase_graph_path: z.string().nullable(),
  /** Output directory passed to `index_codebase` so retries are idempotent. */
  codebase_output_dir: z.string().nullable(),
  codebase_indexed: z.boolean(),
  /**
   * Preflight gate state — `null` while preflight has not been attempted
   * yet, `"ok"` once Cortex (and ai-architect, when a codebase is given)
   * passed their liveness checks. Treated as a precondition: the runner
   * may not enter section_generation while preflight is unset.
   *
   * source: missing-Cortex bug found 2026-04-26 — silent per-section
   * recall failures should surface as ONE clear startup error, not as
   * degraded generation across every section.
   */
  preflight_status: z.enum(["ok", "skipped"]).nullable().default(null),
  sections: z.array(SectionStatusSchema).default([]),
  clarifications: z.array(ClarificationTurnSchema).default([]),
  /**
   * Set when the user types "proceed" or clarification reaches max rounds.
   * Read by handleBudget to sanity-check that clarification finished cleanly
   * before generation starts.
   */
  proceed_signal: z.boolean().default(false),
  started_at: z.string(),
  updated_at: z.string(),
  /** Genuine error messages only. NOT a progress log. */
  errors: z.array(z.string()).default([]),
  /**
   * Parallel to `errors[]` (same length, same order). Tags each error as
   * one of three kinds. pipeline-kpis.ts:structural_error_count reads
   * `"structural"` count DIRECTLY rather than deriving it by subtraction.
   *
   *   "section_failure"   — section validator failed after MAX_ATTEMPTS.
   *                         1-per-failed-section by convention. Section-
   *                         level retries are not counted; only the final
   *                         fail-out increments. KPI: section_fail_count.
   *
   *   "structural"        — handler bug, runner protocol violation,
   *                         schema mismatch, uncaught exception. The KPI
   *                         gate `structural_error_count_max=0` blocks
   *                         any run with a structural defect.
   *
   *   "upstream_failure"  — recoverable failure in an external service
   *                         the pipeline tolerates (jira-generation
   *                         subagent fails → continue without JIRA;
   *                         index_codebase tool fails → fail input_analysis
   *                         but do not blame the handler). Counted
   *                         separately so the structural gate does not
   *                         fire spuriously on real-LLM runs where
   *                         upstream services have realistic flake rates
   *                         (cross-audit curie H1, Phase 3+4 follow-up,
   *                         2026-04).
   *
   * source: curie cross-audit H-2 (Phase 3+4, 2026-04) for the introduction
   * of the parallel array; curie H1 (Phase 3+4 follow-up, 2026-04) for the
   * upstream_failure split.
   */
  error_kinds: z
    .array(z.enum(["section_failure", "structural", "upstream_failure"]))
    .default([]),
  /** Paths of files successfully written during file_export. Append-only. */
  written_files: z.array(z.string()).default([]),
  /**
   * Verification plan dispatched in self-check Phase A. Set during Phase A;
   * read in Phase B to attribute verdicts. Null until Phase A runs.
   */
  verification_plan: VerificationPlanSnapshotSchema.nullable().default(null),
  /**
   * Append-only queue of strategy execution results, populated when a
   * section transitions to a terminal status (passed/failed). The
   * composition root (mcp-server) drains this queue after each step and
   * forwards entries to `EffectivenessTracker.recordExecution` so the
   * closed feedback loop populates `EvidenceRepository`.
   *
   * Decouples orchestration (pure reducer) from infrastructure (SQLite
   * persistence) per §2.2: the reducer emits data; the composition
   * root is the only layer that performs I/O.
   *
   * source: Phase 4 strategy-wiring (2026-04).
   */
  strategy_executions: z.array(ExecutionResultSchema).default([]),
})
  .refine((s) => s.errors.length === s.error_kinds.length, {
    message:
      "PipelineState: errors[] and error_kinds[] must have the same length (lockstep invariant — use appendError() to append, never spread directly).",
    path: ["error_kinds"],
  });
export type PipelineState = z.infer<typeof PipelineStateSchema>;

// ─── Helpers ────────────────────────────────────────────────────────────────

export function newPipelineState(input: {
  run_id: string;
  feature_description: string;
  codebase_path?: string | null;
  /**
   * When true, the preflight step is skipped — the runner advances straight
   * past missing-Cortex / missing-ai-architect checks. Use only when the
   * caller has another mechanism for ensuring those MCPs are wired (or
   * accepts degraded section generation without persistent memory recall).
   *
   * source: missing-Cortex bug found 2026-04-26.
   */
  skip_preflight?: boolean;
}): PipelineState {
  const now = new Date().toISOString();
  return PipelineStateSchema.parse({
    run_id: input.run_id,
    current_step: "banner",
    prd_context: null,
    feature_description: input.feature_description,
    codebase_path: input.codebase_path ?? null,
    codebase_graph_path: null,
    codebase_output_dir: null,
    codebase_indexed: false,
    preflight_status: input.skip_preflight ? "skipped" : null,
    sections: [],
    clarifications: [],
    proceed_signal: false,
    started_at: now,
    updated_at: now,
    errors: [],
    written_files: [],
    verification_plan: null,
    strategy_executions: [],
  });
}

export function touch(state: PipelineState): PipelineState {
  return { ...state, updated_at: new Date().toISOString() };
}

/**
 * Append a single error with its kind tag. Use this at every error-append
 * site instead of `errors: [...state.errors, message]`. Keeps the parallel
 * `error_kinds[]` array in lockstep with `errors[]`.
 *
 * source: curie cross-audit H-2 (Phase 3+4, 2026-04). Tag taxonomy
 * extended to three kinds in curie H1 (Phase 3+4 follow-up, 2026-04).
 */
export function appendError(
  state: PipelineState,
  message: string,
  kind: "section_failure" | "structural" | "upstream_failure",
): PipelineState {
  return {
    ...state,
    errors: [...state.errors, message],
    error_kinds: [...state.error_kinds, kind],
  };
}
