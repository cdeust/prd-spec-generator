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
   * `implementation` (PR 4a, design-phases-3-5.md §3): one `spawn_subagents`
   * (purpose "implement", subagent_type "engineer", isolation "worktree")
   * that hands the validated specs + pre-impl grounding to an engineer
   * subagent. `pre_impl_grounding` always transitions here once its
   * (optional) grounding loop settles — grounding is best-effort context for
   * the engineer, not a gate on reaching implementation. On success,
   * advances to `post_impl_verification`; on subagent error or an
   * unparseable report, aborts straight to `finalize` (design §4 —
   * "nothing to verify without code").
   */
  "implementation",
  /**
   * `post_impl_verification` (PR 3c wiring, PR 4a reachability,
   * design-phases-3-5.md §1, §3, §5): the 4-call POST-implementation
   * verification sequence (index_codebase(worktree) → detect_changes →
   * verify_semantic_diff → check_security_gates). Reached from
   * `implementation` once the engineer's report is parsed successfully.
   */
  "post_impl_verification",
  /**
   * Relocated Phase C (Cortex `remember` → `done`) — the only step that
   * advances `current_step` to `complete`. `implementation_gate`
   * ("prd_only") and every failure/degrade path in `pre_impl_grounding` /
   * `implementation` / `post_impl_verification` dead-end here (PR 4a: the
   * `testing` / `review` / `pr_gate` / `pr_creation` steps named in the
   * design doc are NOT yet in this enum — they land in PRs 4b/5).
   */
  "finalize",
  "complete",
]);
export type PipelineStep = z.infer<typeof PipelineStepSchema>;
