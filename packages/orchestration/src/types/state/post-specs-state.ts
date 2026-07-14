/**
 * Post-specs state — the Phases 3-5 implementation loop
 * (design-phases-3-5.md), nested under `state.post_specs`.
 *
 * Design decision (§2.1 of the design doc explicitly gives every field of
 * this shape; PR 3b only WIRES `decision` + `impact_queries`): the full
 * shape is declared here in one pass rather than growing this file once per
 * sub-PR (3c/4a/4b/5). Justification —
 *   1. The design doc already fixes the exact contract for all 6 groups;
 *      this is transcription of a settled shape, not incremental design.
 *   2. Adding one group at a time would touch this file, its barrel
 *      re-export, and every test importing `PipelineState` five more times
 *      for the SAME nested object — a self-inflicted shotgun-surgery risk
 *      this file's sibling `core-state.ts` doc explicitly warns against
 *      (§4.1 cohesion).
 *   3. Zero behavior change: every not-yet-wired group defaults to `null`
 *      (or, for `decision`, `"pending"`) and no handler outside 3b's own
 *      `implementation_gate` / `pre_impl_grounding` reads or writes them —
 *      the schema addition is inert until a future PR's handler touches it.
 *
 * `post_specs` itself is nullable, default `null`, on `PipelineState` (see
 * core-state.ts) — every existing consumer/test that never reaches the
 * post-specs loop is unaffected (matches the `verification_plan` /
 * `retry_policy` nullable-field precedent already established there).
 *
 * Every AP payload is stored as an opaque `z.record(z.string(), z.unknown())`
 * passthrough — orchestration never parses AP response shapes (mirrors
 * `codebase_grounding` / `prd_validation` precedent in core-state.ts).
 *
 * source: design-phases-3-5.md §2.1 (schema), §5 (PR 3b scope).
 */

import { z } from "zod";

/**
 * One `get_impact` round trip's outcome for a single affected symbol.
 * `success: false` entries are retained (not dropped) so `finalize`'s
 * remember content and any future review-stage prompt can see WHICH
 * symbols failed to ground, not just a partial-success count.
 */
export const ImpactQueryResultSchema = z.object({
  qualified_name: z.string(),
  success: z.boolean(),
  data: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});
export type ImpactQueryResult = z.infer<typeof ImpactQueryResultSchema>;

/**
 * `pre_impl_grounding`'s cursor state (PR 3b). `index` is the number of
 * symbols already processed (success or failure) — also the 0-based index
 * of the NEXT symbol to query. `done` is set once the cursor has walked the
 * full (capped) symbol list, or once the step decided there is nothing to
 * ground (no graph / no sidecar).
 */
export const ImpactQueriesStateSchema = z.object({
  done: z.boolean().default(false),
  index: z.number().int().nonnegative().default(0),
  results: z.array(ImpactQueryResultSchema).default([]),
});
export type ImpactQueriesState = z.infer<typeof ImpactQueriesStateSchema>;

/**
 * `implementation` step's outcome (Phase 4a — NOT wired in 3b). Nullable;
 * stays null until the `implementation` handler exists and runs.
 */
export const ImplementationStateSchema = z.object({
  branch: z.string(),
  worktree_path: z.string().nullable(),
  changed_files: z.array(z.string()).default([]),
  raw_report: z.string(),
});
export type ImplementationState = z.infer<typeof ImplementationStateSchema>;

/**
 * `post_impl_verification` step's outcome (Phase 3c/4a — NOT wired in 3b).
 */
export const VerificationStateSchema = z.object({
  detect_changes: z.record(z.string(), z.unknown()).nullable().default(null),
  verify_semantic_diff: z.record(z.string(), z.unknown()).nullable().default(null),
  check_security_gates: z.record(z.string(), z.unknown()).nullable().default(null),
  gates_passed: z.boolean().default(false),
});
export type VerificationState = z.infer<typeof VerificationStateSchema>;

/** `testing` step's outcome (Phase 4b — NOT wired in 3b). */
export const TestingStateSchema = z.object({
  raw_report: z.string(),
});
export type TestingState = z.infer<typeof TestingStateSchema>;

/** `review` step's outcome (Phase 4b — NOT wired in 3b). */
export const ReviewStateSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  findings: z.array(z.string()).default([]),
  attempt: z.number().int().positive(),
});
export type ReviewState = z.infer<typeof ReviewStateSchema>;

/** `pr_creation` step's outcome (Phase 5 — NOT wired in 3b). */
export const PrStateSchema = z.object({
  pushed: z.boolean().default(false),
  url: z.string().nullable().default(null),
});
export type PrState = z.infer<typeof PrStateSchema>;

export const PostSpecsStateSchema = z.object({
  /**
   * Set by `implementation_gate`'s ask_user answer. `"pending"` is the
   * pre-gate default (self_check's finalize() initializes post_specs but
   * leaves decision at its schema default until the gate answers).
   */
  decision: z.enum(["pending", "implement", "prd_only"]).default("pending"),
  /** PR 3b — wired by pre_impl_grounding.ts. */
  impact_queries: ImpactQueriesStateSchema.default({
    done: false,
    index: 0,
    results: [],
  }),
  /** Phase 4a — not wired in 3b. */
  implementation: ImplementationStateSchema.nullable().default(null),
  /** Phase 3c/4a — not wired in 3b. */
  verification: VerificationStateSchema.nullable().default(null),
  /** Phase 4b — not wired in 3b. */
  testing: TestingStateSchema.nullable().default(null),
  /** Phase 4b — not wired in 3b. */
  review: ReviewStateSchema.nullable().default(null),
  /** Phase 5 — not wired in 3b. */
  pr: PrStateSchema.nullable().default(null),
  /** Phase 4b review-loop counter — not wired in 3b. */
  retry_count: z.number().int().nonnegative().default(0),
});
export type PostSpecsState = z.infer<typeof PostSpecsStateSchema>;

/**
 * precondition:  none.
 * postcondition: returns a fresh PostSpecsState with every schema default
 *                applied (decision:"pending", impact_queries:{done:false,
 *                index:0,results:[]}, every other group null/0). Used by
 *                `implementation_gate` the first time a run reaches the
 *                post-specs loop (state.post_specs is null until then).
 */
export function initialPostSpecs(): PostSpecsState {
  return PostSpecsStateSchema.parse({});
}
