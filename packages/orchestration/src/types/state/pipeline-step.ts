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
   * Relocated Phase C (Cortex `remember` → `done`) — the only step that
   * advances `current_step` to `complete`. PR 3b dead-ends both
   * `implementation_gate` ("prd_only") and `pre_impl_grounding` (grounding
   * gathered or skipped) straight here; the `implementation` /
   * `post_impl_verification` / `testing` / `review` / `pr_gate` /
   * `pr_creation` steps named in the design doc are NOT yet in this enum —
   * they land in PRs 3c/4a/4b/5.
   */
  "finalize",
  "complete",
]);
export type PipelineStep = z.infer<typeof PipelineStepSchema>;
