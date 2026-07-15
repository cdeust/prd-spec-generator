/**
 * Verification acceptance policy for self-check's multi-judge verification
 * results — closes the gap identified in e2e run run_mrlqa0aj_u2rh15
 * (2026-07-15): the jury returned 1 FAIL (AC-008) and 20 INCONCLUSIVE
 * verdicts, yet `implementation_gate` asked its "Implement / PRD only"
 * question exactly as if every claim had passed — nothing in the pipeline
 * stated what closes that gap; the human had to notice the FAIL in the
 * rendered report themselves. This schema is the explicit, versionable,
 * composition-root-injectable statement of what "acceptable" means for a
 * verification result, mirroring the DeepMind-style `verification_policy`
 * strict-mode concept (design-phases-3-5.md §7).
 *
 * Mirrors `VerifyBudgetConfigSchema` (verify-budget.ts) — nullable on
 * `PipelineState.verification_policy`, composition-root-injected only; the
 * reducer only ever READS it (§1.5 DIP / §5.2 composition-root pattern).
 * `null` means "use DEFAULT_VERIFICATION_POLICY"
 * (handlers/verification-policy.ts).
 *
 * source: design-phases-3-5.md §7 "verification_policy" discussion; e2e run
 * run_mrlqa0aj_u2rh15 (2026-07-15).
 */

import { z } from "zod";
import { VerdictSchema } from "@prd-gen/core";

export const VerificationPolicySchema = z.object({
  /**
   * Any claim carrying a verdict in this set is an UNCONDITIONAL block:
   * `implementation_gate` never offers a bare "Implement" option while any
   * claim's verdict is in `block_on` — see handlers/verification-policy.ts
   * `evaluatePolicy`. `block_on` is absolute by design (no warn/ask nuance,
   * unlike the other two gates below): the 5-level verdict taxonomy's own
   * expected-distribution table (core/domain/verdict.ts,
   * `EXPECTED_VERDICT_DISTRIBUTION`, SKILL.md Rule 15) already states FAIL
   * should be 0% "after self-check — violations should be fixed before
   * delivery"; any FAIL surviving to this gate is an anomaly the taxonomy
   * itself says should not exist, so it blocks rather than merely warns.
   *
   * Default: ["FAIL"].
   */
  block_on: z.array(VerdictSchema).default(["FAIL"]),
  /**
   * Minimum fraction of SUBJECTIVE-tier claims (claim-tier.ts) that must
   * have received at least one real (model-dispatched or rule-tier — but
   * mechanical claims are never in the denominator, see
   * `VerificationSummarySchema.total_subjective_claims` doc) judge verdict.
   * Below this fraction, `on_unsampled_below_ratio` fires. Mechanical-tier
   * claims are NEVER counted as "unsampled" — they are rule-verdicted
   * deterministically (mechanical-verdict.ts) and were never subject to
   * `sampleWithinCap` in the first place.
   *
   * Default 0.5 — measured e2e baseline, not a normative claim. Under
   * DEFAULT_VERIFY_BUDGET's 20-invocation cap, run_mrlqa0aj_u2rh15's 29
   * claims (28 subjective FR/AC + 1 architecture) sampled ~20/29 ≈ 69% at
   * 1 judge/claim — a run sampling LESS than half its subjective claims is a
   * materially different verification posture than that calibration
   * baseline and should not silently pass through the gate the same way.
   * source: measured e2e run run_mrlqa0aj_u2rh15 (2026-07-15).
   */
  min_subjective_sampled_ratio: z.number().min(0).max(1).default(0.5),
  /**
   * Action when the sampled ratio falls below `min_subjective_sampled_ratio`.
   *   "warn"  — reported in 10-verification-report.md; does not change gate status.
   *   "ask"   — escalates the gate to `needs_attention`; a human decides
   *             whether the reduced coverage is acceptable for this run.
   *   "block" — unconditional block, same severity as `block_on`.
   * Default "ask".
   */
  on_unsampled_below_ratio: z.enum(["warn", "ask", "block"]).default("ask"),
  /**
   * Action when a subjective claim's judges disagree ACROSS MODELS (>=2
   * distinct `JudgeVerdict.model` values produced different verdicts for the
   * same claim_id) — see `VerifyBudgetConfigSchema.diversity_models` doc for
   * why cross-model disagreement is a meaningful signal distinct from
   * within-model disagreement: it crossed the exact monoculture-mitigation
   * boundary the architecture judge panel exists to probe.
   *   "warn" — reported in the report; does not change gate status.
   *   "ask"  — escalates the gate to `needs_attention`. A cross-model split
   *            is an explicit human-escalation signal, never silently
   *            averaged into the majority verdict by consensus.ts.
   * Default "ask" — cross-model disagreement is never averaged away.
   */
  on_cross_model_disagreement: z.enum(["warn", "ask"]).default("ask"),
});
export type VerificationPolicyConfig = z.infer<typeof VerificationPolicySchema>;
