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
   * Always advances to `testing` (PR 4b) once the sequence settles —
   * success and degrade both continue; there is nothing left to verify
   * once all 4 calls have run or degraded.
   */
  "post_impl_verification",
  /**
   * `testing` (PR 4b, design-phases-3-5.md §3): one `spawn_subagents`
   * (purpose "test", subagent_type "test-engineer", isolation "none" — SAME
   * branch/worktree `implementation` recorded, no second worktree). A
   * test-engineer failure DEGRADES (surfaced to `review` as a finding, not
   * an abort — design §4). Always advances to `review`.
   */
  "testing",
  /**
   * `review` (PR 4b, design-phases-3-5.md §3): one `spawn_subagents`
   * (purpose "review", subagent_type "code-reviewer") fed the verification +
   * testing verdicts. A parsed FAIL verdict retries `implementation` on the
   * SAME worktree with the findings injected into the prompt, bounded by
   * `REVIEW_RETRY_CAP` (review.ts). PASS, or cap exhaustion (degrade to
   * advisory FAIL), advances to `finalize` — `pr_gate`/`pr_creation` are NOT
   * yet in this enum (PR 5).
   */
  "review",
  /**
   * Relocated Phase C (Cortex `remember` → `done`) — the only step that
   * advances `current_step` to `complete`. `implementation_gate`
   * ("prd_only") and every failure/degrade/terminal path in
   * `pre_impl_grounding` / `implementation` / `post_impl_verification` /
   * `testing` / `review` dead-ends here (PR 4b: `pr_gate` / `pr_creation`
   * named in the design doc are NOT yet in this enum — they land in PR 5).
   */
  "finalize",
  "complete",
]);
export type PipelineStep = z.infer<typeof PipelineStepSchema>;
