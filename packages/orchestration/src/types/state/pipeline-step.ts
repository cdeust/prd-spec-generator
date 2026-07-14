import { z } from "zod";

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
  /**
   * Post-specs implementation loop (design-phases-3-5.md, PR 3b).
   * `self_check`'s finalize() now advances here instead of emitting
   * `remember`/`done` directly — see finalize.ts, now the sole step that
   * reaches `complete`.
   */
  "implementation_gate",
  "pre_impl_grounding",
  /**
   * `post_impl_verification` (PR 3c, design-phases-3-5.md §1, §3, §5): the
   * 4-call POST-implementation verification sequence (index_codebase(worktree)
   * → detect_changes → verify_semantic_diff → check_security_gates). The
   * handler is registered in runner.ts's HANDLERS and independently
   * unit-tested (post-impl-verification.test.ts), but this PR does NOT wire
   * any transition INTO this step — `implementation` (PR 4a), the only
   * handler that would hand off here, does not exist yet. Reachable today
   * only by directly constructing a state with
   * `current_step: "post_impl_verification"` (as the unit tests do); no
   * runner-driven smoke path can reach it (see
   * smoke-implementation-gate.test.ts's "never reaches post_impl_verification"
   * assertion). The step must still be a member of this enum: HANDLERS is a
   * `Record<PipelineState["current_step"], StepHandler>` in runner.ts, so the
   * TypeScript compiler enforces the handler's presence.
   */
  "post_impl_verification",
  /**
   * Relocated Phase C (Cortex `remember` → `done`) — the only step that
   * advances `current_step` to `complete`. PR 3b dead-ends both
   * `implementation_gate` ("prd_only") and `pre_impl_grounding` (grounding
   * gathered or skipped) straight here; `post_impl_verification` (PR 3c) is
   * registered but unreachable (see above). The `implementation` / `testing`
   * / `review` / `pr_gate` / `pr_creation` steps named in the design doc are
   * NOT yet in this enum — they land in PRs 4a/4b/5.
   */
  "finalize",
  "complete",
]);
export type PipelineStep = z.infer<typeof PipelineStepSchema>;
