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

/**
 * Bounded-I/O caps for in-memory pipeline arrays (Phase 1c).
 *
 * PipelineState lives in the runStore and is serialized into MCP responses
 * (get_pipeline_state format:"full" returns the whole state; section prompts
 * embed clarification_qa). Two append-only arrays can grow without bound:
 * `clarifications` (one turn per Q&A round) and `errors` (one per failure).
 * Neither had a contract cap before Phase 1c — the per-context clarification
 * range bounds rounds in the handler, but for the default tier
 * CAPABILITIES.maxClarificationRounds is Infinity, so the schema is the only
 * guaranteed bound.
 *
 * Budget derivation (measured, not invented):
 *   Claude Code rejects MCP tool results over 25,000 tokens = 100,000 chars
 *   of compact JSON.
 *   source: Claude Code 2.1.170 binary, extracted 2026-06-10 — default
 *   MAX_MCP_OUTPUT_TOKENS d4O=25000, estimator chars/4 → 100,000 char cap.
 *   Verified char-exact against a rejected 324,429-char response. Mirrors the
 *   Cortex sibling repo's MAX_RESPONSE_CHARS = 100_000.
 */
// source: Claude Code 2.1.170 binary cap (see block comment above).
// Exported so the response boundary (mcp-server get_pipeline_state format:"full")
// derives its single aggregate ceiling from the SAME measured constant the input
// contracts use — no second, drifting copy of the budget (Phase 1d).
export const MAX_RESPONSE_CHARS = 100_000;

/**
 * Max clarification turns retained. A turn serializes to ~1,000 chars
 * (round + question + answer + two ISO timestamps; question/answer are short
 * sentences). get_pipeline_state format:"full" ships the whole array over MCP,
 * and section prompts embed clarification_qa, so the turns must fit the
 * 100,000-char response budget alongside the rest of the state.
 *   source: measured 2026-06-10 — a representative clarification turn from a
 *   production run serialized to 740 chars compact-JSON; rounded up to 1,000
 *   to leave headroom for long freeform answers.
 * Cap = floor((MAX_RESPONSE_CHARS / 2) / 1000) = 50. Half the budget is
 * reserved for clarifications so the other half covers the rest of the state
 * (sections, errors, grounding) when format:"full" is requested.
 */
const CLARIFICATION_TURN_CHARS = 1_000; // measured 740, rounded up (see above)
export const MAX_CLARIFICATION_TURNS = Math.floor(
  MAX_RESPONSE_CHARS / 2 / CLARIFICATION_TURN_CHARS,
); // 50

/**
 * Max error messages retained (FIFO). Genuine error messages only — not a
 * progress log. An error string is short (≤500 chars by convention), and the
 * parallel error_kinds entry is a single enum token. The errors array ships
 * its length over MCP (envelope.state_summary.errors) but its contents ship in
 * format:"full". Cap so the array cannot dominate the 100,000-char response
 * budget: floor((MAX_RESPONSE_CHARS / 4) / 500) = 50. A quarter of the budget
 * is allotted to errors+kinds; the rest covers sections, clarifications, and
 * grounding.
 *   source: 500-char error floor is the project convention (errors are
 *   single-sentence failure messages, not stack dumps); measured 2026-06-10,
 *   longest observed pipeline error was 312 chars.
 * Eviction is FIFO with a dropped count surfaced via appendError's return —
 * never silent loss (Phase 1c rule). The oldest errors are dropped because the
 * most recent failures are the ones a caller acts on.
 */
const ERROR_MESSAGE_CHARS = 500; // project convention, measured max 312
export const MAX_PIPELINE_ERRORS = Math.floor(
  MAX_RESPONSE_CHARS / 4 / ERROR_MESSAGE_CHARS,
); // 50

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
   * Idempotency flag for the `.prd-gen/.gitignore` self-ignore guard write
   * (input_analysis.ts), set true once the corresponding `file_written`
   * result is processed. Deliberately NOT tracked in `written_files` — that
   * array is the PRD-deliverable ledger file-export.ts builds and
   * pipeline-kpis.ts counts (`written_files_count` KPI expects exactly the
   * 9 PRD output files); folding an infrastructure guard file into it would
   * silently inflate that count. source: git-hygiene defect, memory 4263670.
   */
  codebase_gitignore_written: z.boolean().default(false),
  /**
   * Code-graph grounding for the feature, returned by automatised-pipeline
   * `prepare_prd_input` in FEATURE MODE (response field `prd_context`):
   *   { matched_symbols, impacted_communities, impacted_processes,
   *     graph_stats, mode }
   * Distinct from `prd_context` above (which is the PRD *kind* enum:
   * feature/bug/incident/…). This is the code-graph evidence later steps
   * (budget / section generation) inject as grounding so generated sections
   * reference real symbols/communities/processes. Stored as an opaque object
   * because the orchestration layer is a pure passthrough — it does not parse
   * the AP payload (mirrors how `index_codebase` data is consumed inline).
   *
   * Null until `prepare_prd_input` succeeds, or permanently null when no
   * codebase/feature_description is available (skip path, backward-compatible).
   *
   * source: AP feature-mode prepare_prd_input contract (shipped 2026-06).
   */
  codebase_grounding: z.record(z.string(), z.unknown()).nullable().default(null),
  /**
   * Idempotency flag for the `prepare_prd_input` emission in input_analysis.
   * Mirrors `codebase_indexed`: set true once the grounding call has been
   * processed (success OR a skip-after-index decision) so the step advances
   * exactly once and replayed state does not re-issue the call.
   *
   * source: AP feature-mode prepare_prd_input contract (shipped 2026-06).
   */
  prd_input_prepared: z.boolean().default(false),
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
  /**
   * Bounded-I/O cap (Phase 1c): at most MAX_CLARIFICATION_TURNS turns. The
   * handler bounds rounds per-context, but the default tier's
   * CAPABILITIES.maxClarificationRounds is Infinity, so this schema cap is the
   * guaranteed bound. Over-cap state parses to a ZodError (observable) rather
   * than silently growing the MCP response. source: see MAX_CLARIFICATION_TURNS.
   */
  clarifications: z
    .array(ClarificationTurnSchema)
    .max(MAX_CLARIFICATION_TURNS, {
      message: `clarifications exceeds ${MAX_CLARIFICATION_TURNS}-turn bounded-I/O cap (Claude Code 100,000-char MCP response budget). source: see MAX_CLARIFICATION_TURNS in state.ts.`,
    })
    .default([]),
  /**
   * Set when the user types "proceed" or clarification reaches max rounds.
   * Read by handleBudget to sanity-check that clarification finished cleanly
   * before generation starts.
   */
  proceed_signal: z.boolean().default(false),
  started_at: z.string(),
  updated_at: z.string(),
  /**
   * Genuine error messages only. NOT a progress log.
   *
   * Bounded-I/O cap (Phase 1c): at most MAX_PIPELINE_ERRORS entries, kept in
   * lockstep with error_kinds. Appended ONLY via appendError(), which performs
   * FIFO eviction (drops oldest) once the cap is reached and reports the
   * dropped count — never silent loss. The schema .max() is the backstop that
   * makes a direct over-cap spread fail to parse. source: see MAX_PIPELINE_ERRORS.
   */
  errors: z
    .array(z.string())
    .max(MAX_PIPELINE_ERRORS, {
      message: `errors exceeds ${MAX_PIPELINE_ERRORS}-entry bounded-I/O cap — append via appendError() (FIFO eviction). source: see MAX_PIPELINE_ERRORS in state.ts.`,
    })
    .default([]),
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
    // Bounded-I/O cap (Phase 1c): lockstep with errors[], same cap. source: MAX_PIPELINE_ERRORS.
    .max(MAX_PIPELINE_ERRORS, {
      message: `error_kinds exceeds ${MAX_PIPELINE_ERRORS}-entry bounded-I/O cap (must stay lockstep with errors[]). source: see MAX_PIPELINE_ERRORS in state.ts.`,
    })
    .default([]),
  /**
   * Count of error entries evicted from `errors`/`error_kinds` by appendError's
   * FIFO cap (bounded-I/O, Phase 1c). Non-zero means the run produced more than
   * MAX_PIPELINE_ERRORS errors and the oldest were dropped to stay within the
   * MCP response budget — the drop is observable here, never silent.
   * source: see MAX_PIPELINE_ERRORS / appendError in this file.
   */
  errors_dropped: z.number().int().nonnegative().default(0),
  /** Paths of files successfully written during file_export. Append-only. */
  written_files: z.array(z.string()).default([]),
  /**
   * Count of Cortex `recall` tool invocations that returned zero hits.
   * A non-zero count indicates sections were generated without memory context,
   * which degrades output quality. KPI gate: pipeline-kpis.ts reads this field
   * directly to surface the metric without post-hoc regex parsing.
   *
   * Incremented in section-generation.ts at the retrieving→generating
   * transition when summarizeRecall returns an empty string (data.results is
   * absent, empty, or all entries have no content).
   *
   * source: shannon S-6 (Phase 3+4 cross-audit, 2026-04) — load-bearing
   * quantity needed for recall-efficacy analysis.
   */
  cortex_recall_empty_count: z.number().int().nonnegative().default(0),
  /**
   * Verification plan dispatched in self-check Phase A. Set during Phase A;
   * read in Phase B to attribute verdicts. Null until Phase A runs.
   */
  verification_plan: VerificationPlanSnapshotSchema.nullable().default(null),
  /**
   * PRD-vs-graph validation report from automatised-pipeline
   * `validate_prd_against_graph` (args { prd_path, graph_path }), fetched in
   * self-check after the PRD file is exported. Symbol-hallucination /
   * community-consistency / process-impact findings. Merged into the
   * self-check `done.verification` surface (not a new top-level shape).
   *
   * Stored as an opaque object — the orchestration layer is a pure passthrough
   * and does not parse the AP payload. Null until the call succeeds, or
   * permanently null when no `codebase_graph_path` exists (skip path,
   * backward-compatible).
   *
   * source: AP validate_prd_against_graph contract (shipped 2026-06).
   */
  prd_validation: z.record(z.string(), z.unknown()).nullable().default(null),
  /**
   * Idempotency flag for the `validate_prd_against_graph` emission in
   * self-check. Mirrors `prd_input_prepared`: set true once the validation
   * call has been processed (success OR skip) so self-check advances to its
   * existing verify phase exactly once.
   *
   * source: AP validate_prd_against_graph contract (shipped 2026-06).
   */
  prd_validated: z.boolean().default(false),
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
  /**
   * Per-run retry policy injected by the composition root (mcp-server) before
   * handing the state to the reducer. The reducer reads this field only —
   * it never calls `getRetryArmForRun` or `getMaxAttemptsForRun` directly,
   * preserving layer purity (§1.5 DIP / §2.2 layer rule: orchestration must
   * not import from benchmark).
   *
   * Fields:
   *   maxAttempts  — effective max attempts for this run (may differ from the
   *                  baseline MAX_ATTEMPTS for calibration treatment runs).
   *   arm          — ablation arm: "with_prior_violations" feeds last_violations
   *                  to the retry prompt; "without_prior_violations" feeds [].
   *
   * Defaults to null (= use MAX_ATTEMPTS baseline, with_prior_violations arm)
   * for backward compatibility. Wave D2 wires the composition root to populate
   * this field using getRetryArmForRun + getMaxAttemptsForRun from the
   * benchmark layer before starting the run.
   *
   * ADR (Wave D1.C, 2026-04-27): the seam is on the state object, not on a
   * separate config argument, so that the runner's pure reducer signature
   * (state → action) does not acquire a new parameter. State is the single
   * authority for all reducer inputs. The composition root is the only site
   * that calls benchmark-layer seams (§5.2 composition root pattern).
   *
   * source: Phase 4.2 ablation design (PHASE_4_PLAN.md §4.2).
   * source: §1.5 DIP — high-level modules must not depend on low-level modules.
   * source: §5.2 factory / composition root pattern.
   */
  // B9 — RetryPolicy is colocated with PipelineState rather than in a standalone
  // retry-policy.ts file because it is structurally dependent on the state shape:
  // the Zod schema here is an inline object (not a named Schema reference) so
  // it participates in PipelineStateSchema's refinement chain and Zod inference
  // without a separate parse boundary. The D1.C spec referenced a standalone
  // file; this was intentionally inlined during Wave D1 implementation to keep
  // the type adjacent to its only consumer (PipelineState). Any future caller
  // that needs the RetryPolicy type standalone can do:
  //   type RetryPolicy = NonNullable<PipelineState["retry_policy"]>
  // source: Wave D B9 ADR (2026-04-27).
  retry_policy: z
    .object({
      maxAttempts: z.number().int().positive(),
      arm: z.enum(["with_prior_violations", "without_prior_violations"]),
    })
    .nullable()
    .default(null),
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
    codebase_gitignore_written: false,
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
 * Bounded-I/O (Phase 1c): the errors/error_kinds arrays are capped at
 * MAX_PIPELINE_ERRORS to stay within the Claude Code 100,000-char MCP response
 * budget (get_pipeline_state format:"full" ships the whole state). When the
 * cap is reached this performs FIFO eviction — the OLDEST entry is dropped so
 * the most recent failures (the ones a caller acts on) survive. Eviction is
 * NOT silent: the dropped count is recorded by incrementing the returned
 * state's `errors_dropped` so observability is preserved (Phase 1c rule).
 *
 * Precondition: state.errors.length === state.error_kinds.length (lockstep
 *   invariant, enforced by the PipelineStateSchema refine).
 * Postcondition: result.errors.length === result.error_kinds.length AND
 *   result.errors.length <= MAX_PIPELINE_ERRORS AND result.errors ends with
 *   `message` (the new error is never the one evicted) AND
 *   result.errors_dropped === state.errors_dropped + (1 if eviction occurred).
 *
 * source: curie cross-audit H-2 (Phase 3+4, 2026-04). Tag taxonomy
 * extended to three kinds in curie H1 (Phase 3+4 follow-up, 2026-04).
 * Bounded-I/O cap added Phase 1c (2026-06-10).
 */
export function appendError(
  state: PipelineState,
  message: string,
  kind: "section_failure" | "structural" | "upstream_failure",
): PipelineState {
  const nextErrors = [...state.errors, message];
  const nextKinds = [...state.error_kinds, kind];
  // FIFO eviction: once over cap, drop the oldest entry from BOTH arrays in
  // lockstep. The append above already added the newest entry, so slicing the
  // front keeps the most recent MAX_PIPELINE_ERRORS entries including `message`.
  const overflow = nextErrors.length - MAX_PIPELINE_ERRORS;
  if (overflow > 0) {
    return {
      ...state,
      errors: nextErrors.slice(overflow),
      error_kinds: nextKinds.slice(overflow),
      errors_dropped: state.errors_dropped + overflow,
    };
  }
  return {
    ...state,
    errors: nextErrors,
    error_kinds: nextKinds,
  };
}
