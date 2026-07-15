import { z } from "zod";

/**
 * Judge-panel budget for self-check's multi-judge verification batch
 * (handlers/self-check.ts / handlers/self-check-verify-budget.ts).
 *
 * The composition root (mcp-server) MAY inject an override on
 * `PipelineState.verify_budget` before a run starts — mirrors `retry_policy`
 * in core-state.ts. The reducer only ever READS this field; it never derives
 * or mutates it (§1.5 DIP / §5.2 composition-root pattern). `null` means
 * "use DEFAULT_VERIFY_BUDGET" (handlers/self-check-verify-budget.ts).
 *
 * Rationale for the shape: judging PRD claims is read-and-compare work, not
 * frontier reasoning — it does not need the session's own model. A run with
 * ~29 claims under the PRIOR uncapped panel (2-3 genius + 1-2 team judges per
 * claim, all dispatched with no `model`/`effort` field, so the host ran every
 * one under the session model) produced 89 judge invocations in one batch.
 * source: measured e2e run run_mrlqa0aj_u2rh15 (2026-07-15), batch_id
 * self_check_verify, 89 invocations, 3 judges x 28 FR/AC claims + a 5-judge
 * architecture panel x 1 architecture claim.
 */
export const VerifyBudgetConfigSchema = z.object({
  /** Judges dispatched per claim, for every claim_type except "architecture". */
  judges_per_claim: z.number().int().positive(),
  /**
   * Judges dispatched per "architecture"-typed claim. Kept above
   * `judges_per_claim` by default — architecture claims are the highest-
   * stakes panel in PANELS (judge-selector.ts: high_stakes: true, 5-judge
   * full panel) so a single judge's mistake is more costly there.
   */
  architecture_judges_per_claim: z.number().int().positive(),
  /**
   * Above this invocation count (post-reduction, pre-sampling), self-check
   * emits `ask_user` instead of dispatching `spawn_subagents` — see
   * handlers/self-check-verify-budget.ts:buildBudgetGateQuestion.
   */
  invocation_cap: z.number().int().positive(),
  /** Model every judge invocation is dispatched under (spawn_subagents invocation.model). */
  judge_model: z.string(),
  /** Effort level every judge invocation is dispatched under (spawn_subagents invocation.effort). */
  judge_effort: z.enum(["low", "medium", "high"]),
});
export type VerifyBudgetConfig = z.infer<typeof VerifyBudgetConfigSchema>;
