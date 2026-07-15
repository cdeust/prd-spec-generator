/**
 * Synthesizes the deterministic verdict record for claims classified
 * "mechanical" (claim-tier.ts). No judge is spawned for these — the rule
 * itself IS the verdict. Separated from claim-tier.ts (classification) per
 * SRP: this module owns "what verdict a mechanical claim gets", not
 * "whether a claim is mechanical".
 */

import type { Claim, JudgeVerdict, AgentIdentity } from "@prd-gen/core";

/**
 * Synthetic identity for rule-tier verdicts. `agentSubagentType`
 * (core/domain/agent.ts) refuses this kind — it must never be dispatched
 * as a spawn_subagents invocation.
 */
export const RULE_TIER_JUDGE: AgentIdentity = { kind: "rule", name: "rule-tier" };

/**
 * precondition:  `claim` was classified "mechanical" by classifyClaimTier
 *                (caller's responsibility — not re-checked here).
 * postcondition: returns a JudgeVerdict with verdict "SPEC-COMPLETE" (the
 *                taxonomy's "a verification method is specified, but
 *                execution — not judgment — resolves it" level; see
 *                judge-prompt.ts VERDICT_TAXONOMY), judge=RULE_TIER_JUDGE,
 *                confidence 1 (the rule fired deterministically — there is
 *                no uncertainty in WHICH rule matched, only in whether the
 *                mechanical check itself later passes at implementation
 *                time, which this verdict explicitly defers), and no
 *                `model` field (no model was dispatched).
 */
export function buildMechanicalVerdict(claim: Claim): JudgeVerdict {
  return {
    judge: RULE_TIER_JUDGE,
    claim_id: claim.claim_id,
    verdict: "SPEC-COMPLETE",
    rationale:
      "verification method is mechanical; execution happens at implementation time",
    caveats: ["rule_tier"],
    confidence: 1,
  };
}

/**
 * precondition:  every `claim` in `claims` was classified "mechanical".
 * postcondition: result.length === claims.length, index-aligned.
 */
export function buildMechanicalVerdicts(
  claims: readonly Claim[],
): readonly JudgeVerdict[] {
  return claims.map(buildMechanicalVerdict);
}
