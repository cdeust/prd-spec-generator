/**
 * Judge-verdict parsing + rule-tier verdict computation for self-check's
 * Phase A/B multi-judge verification batch. Extracted from self-check.ts
 * (§4.1 500-line file cap) — this module owns ONE concern: turning raw
 * `subagent_batch_result` responses (plus the claim/judge/model context
 * that produced each invocation) into typed `JudgeVerdict[]`, and
 * synthesizing the rule-tier verdicts for mechanical-tier claims
 * (claim-tier.ts) that never received an invocation at all.
 *
 * self-check.ts owns phase sequencing, dispatch, and snapshot bookkeeping;
 * this module owns the pure parsing/synthesis functions. Both are
 * "self-check's own files" — no other handler imports from here.
 */

import { z } from "zod";
import type { ActionResult } from "../types/actions.js";
import type { VerifyBudgetConfig } from "../types/state/verify-budget.js";
import {
  planDocumentVerification,
  buildMechanicalVerdicts,
} from "@prd-gen/verification";
import {
  VerdictSchema,
  extractJsonObject,
  type JudgeRequest,
  type JudgeVerdict,
  type SectionType,
} from "@prd-gen/core";
import { SELF_CHECK_JUDGE_INV_PREFIX } from "./protocol-ids.js";
import { assignJudgeModels } from "./self-check-verify-budget.js";

/**
 * Defensive char cap for a single JudgeVerdict.rationale persisted into
 * `pending_completion.verification.judge_verdicts` (state serialized into
 * MCP responses — see bounded-io.ts:MAX_RESPONSE_CHARS derivation). The judge
 * prompt asks for "one paragraph" (judge-prompt.ts) — a few sentences, so 500
 * chars matches the project's existing per-item convention for short
 * judge/error text (bounded-io.ts:ERROR_MESSAGE_CHARS). At the 20-invocation
 * default cap (DEFAULT_VERIFY_BUDGET.invocation_cap), 20 verdicts x ~600
 * chars each (rationale + judge/claim_id/verdict/confidence/caveats
 * overhead) is ~12,000 chars — well inside the 100,000-char budget alongside
 * the rest of pending_completion.
 * source: self-check-verify-budget.ts DEFAULT_VERIFY_BUDGET.invocation_cap
 * (20) + bounded-io.ts ERROR_MESSAGE_CHARS convention (500).
 */
const JUDGE_VERDICT_RATIONALE_TRUNCATE_CHARS = 500;
const JUDGE_VERDICT_RATIONALE_TRUNCATION_MARKER = "...";

export function truncateJudgeVerdictRationale(v: JudgeVerdict): JudgeVerdict {
  return v.rationale.length > JUDGE_VERDICT_RATIONALE_TRUNCATE_CHARS
    ? {
        ...v,
        rationale:
          v.rationale.slice(0, JUDGE_VERDICT_RATIONALE_TRUNCATE_CHARS) +
          JUDGE_VERDICT_RATIONALE_TRUNCATION_MARKER,
      }
    : v;
}

const RawVerdictSchema = z.object({
  verdict: VerdictSchema,
  rationale: z.string(),
  caveats: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

export interface JudgeIndexEntry {
  request: JudgeRequest;
  invocation_id: string;
  /** Model this invocation was (or would be) dispatched under — assignJudgeModels(). */
  model: string;
}

export function invocationIdFor(idx: number): string {
  return `${SELF_CHECK_JUDGE_INV_PREFIX}${idx.toString().padStart(4, "0")}`;
}

/**
 * precondition:  `requests` is the FINAL invocation set (post-reduction,
 *                post-sampling) — same precondition as buildVerifyAction.
 * postcondition: result.length === requests.length, index-aligned;
 *                `invocation_id`/`model` come from the SAME deterministic
 *                mapping (invocationIdFor / assignJudgeModels) used to build
 *                the dispatched spawn_subagents action, so Phase A dispatch
 *                and Phase B parsing always agree on both.
 */
export function buildJudgeIndex(
  requests: readonly JudgeRequest[],
  config: VerifyBudgetConfig,
): readonly JudgeIndexEntry[] {
  const models = assignJudgeModels(requests, config);
  return requests.map((request, idx) => ({
    request,
    invocation_id: invocationIdFor(idx),
    model: models[idx],
  }));
}

/**
 * precondition:  `index` is the dispatched invocation index for the batch
 *                `batchResult` responds to (buildJudgeIndex output).
 * postcondition: result.length === index.length, index-aligned; a missing/
 *                errored/unparseable response degrades to an INCONCLUSIVE
 *                verdict rather than throwing — see caveats for the reason
 *                ("judge_invocation_failed" | "parse_error").
 */
export function parseVerdicts(
  index: ReadonlyArray<JudgeIndexEntry>,
  batchResult: Extract<ActionResult, { kind: "subagent_batch_result" }>,
): JudgeVerdict[] {
  // Detect duplicate invocation_ids — silent overwrite would lose verdicts.
  // Replace any duplicate with an explicit error response so the affected
  // claims surface as INCONCLUSIVE rather than silently keeping last-write.
  const byId = new Map<string, (typeof batchResult.responses)[number]>();
  for (const r of batchResult.responses) {
    if (byId.has(r.invocation_id)) {
      byId.set(r.invocation_id, {
        invocation_id: r.invocation_id,
        error: `duplicate invocation_id in batch: ${r.invocation_id}`,
      });
    } else {
      byId.set(r.invocation_id, r);
    }
  }
  const out: JudgeVerdict[] = [];
  for (const entry of index) {
    const response = byId.get(entry.invocation_id);
    if (!response || response.error || !response.raw_text) {
      out.push({
        judge: entry.request.judge,
        claim_id: entry.request.claim.claim_id,
        verdict: "INCONCLUSIVE",
        rationale: response?.error ?? "no response",
        caveats: ["judge_invocation_failed"],
        confidence: 0,
        model: entry.model,
      });
      continue;
    }
    try {
      const obj = extractJsonObject(response.raw_text);
      const parsed = RawVerdictSchema.parse(obj);
      out.push({
        judge: entry.request.judge,
        claim_id: entry.request.claim.claim_id,
        verdict: parsed.verdict,
        rationale: parsed.rationale,
        caveats: parsed.caveats,
        confidence: parsed.confidence,
        model: entry.model,
      });
    } catch (err) {
      out.push({
        judge: entry.request.judge,
        claim_id: entry.request.claim.claim_id,
        verdict: "INCONCLUSIVE",
        rationale: `parse failure: ${(err as Error).message}`,
        caveats: ["parse_error"],
        confidence: 0,
        model: entry.model,
      });
    }
  }
  return out;
}

/**
 * Rule-tier verdicts for claims classified "mechanical" (claim-tier.ts) —
 * synthesized directly, never dispatched as a judge invocation. Recomputed
 * (not persisted in the snapshot) because it is a pure function of
 * `sections`, the same rederivation strategy self-check.ts's
 * parseVerdictsFromSnapshot already relies on for the subjective-tier plan.
 * Called from BOTH Phase A's fast-paths (zero subjective claims to dispatch)
 * and Phase B (merged alongside the judge-parsed subjective verdicts) so
 * mechanical claims are present in `judge_verdicts` on every exit path, not
 * only when a judge panel also ran.
 *
 * precondition:  `sections` is the claim-rich section list (self-check.ts's
 *                gatherSections output — content-bearing, non-jira_tickets).
 * postcondition: one JudgeVerdict per mechanical claim, verdict
 *                "SPEC-COMPLETE", judge=RULE_TIER_JUDGE (mechanical-verdict.ts).
 */
export function computeMechanicalVerdicts(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): readonly JudgeVerdict[] {
  const plan = planDocumentVerification(sections);
  return buildMechanicalVerdicts(plan.mechanical_claims);
}

/**
 * Distinct SUBJECTIVE-tier claim count (claim-tier.ts) — the denominator
 * `handlers/verification-policy.ts`'s `min_subjective_sampled_ratio` gate
 * needs. `judge_requests` carries one entry per (claim, judge) pair BEFORE
 * budget reduction/sampling (orchestrator.ts `buildRequests`) — a claim with
 * a 5-judge architecture panel appears 5 times — so the distinct claim_id
 * count, not `requests.length`, is the claim count.
 *
 * precondition:  `requests` is `planDocumentVerification(sections)
 *                .judge_requests` — the FULL, pre-reduction plan (NOT the
 *                reduced/sampled dispatch set) — see
 *                `VerificationSummarySchema.total_subjective_claims` doc for
 *                why the denominator must be the pre-sampling total.
 * postcondition: pure function; returns 0 for an empty plan.
 */
export function countSubjectiveClaims(requests: readonly JudgeRequest[]): number {
  return new Set(requests.map((r) => r.claim.claim_id)).size;
}
