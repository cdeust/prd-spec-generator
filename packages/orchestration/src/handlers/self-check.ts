/**
 * Self-check (SKILL.md Rule 13).
 *
 * Two-phase:
 *   Phase A — emit a multi-judge verification batch over all generated sections.
 *             The host spawns the judges in parallel via the Agent tool and
 *             feeds the verdicts back as a `subagent_batch_result`.
 *   Phase B — combine deterministic `validateDocument` violations + multi-judge
 *             VerificationReport into the final `done` summary.
 *
 * If verification yields zero claims (e.g. nothing extractable from a tiny
 * PRD), Phase B runs immediately on Phase A's "no judges to run" path.
 */

import type { StepHandler } from "../runner.js";
import type { ActionResult, NextAction } from "../types/actions.js";
import { appendError, type PipelineState } from "../types/state.js";
import { validateDocument } from "@prd-gen/validation";
import {
  planDocumentVerification,
  concludeDocument,
  buildJudgePrompt,
} from "@prd-gen/verification";
import {
  VerdictSchema,
  agentSubagentType,
  extractJsonObject,
  type JudgeRequest,
  type JudgeVerdict,
} from "@prd-gen/core";
import { z } from "zod";
import { SELF_CHECK_JUDGE_INV_PREFIX } from "./protocol-ids.js";

const VERIFY_BATCH_ID = "self_check_verify";

const RawVerdictSchema = z.object({
  verdict: VerdictSchema,
  rationale: z.string(),
  caveats: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

interface JudgeIndexEntry {
  request: JudgeRequest;
  invocation_id: string;
}

function invocationIdFor(idx: number): string {
  return `${SELF_CHECK_JUDGE_INV_PREFIX}${idx.toString().padStart(4, "0")}`;
}

function gatherSections(state: PipelineState) {
  // Exclude jira_tickets — generated outside the section validation loop;
  // no claim extractor is defined for ticket format.
  return state.sections
    .filter((s) => s.content && s.section_type !== "jira_tickets")
    .map((s) => ({ type: s.section_type, content: s.content! }));
}

function buildVerifyAction(
  requests: readonly JudgeRequest[],
): NextAction {
  return {
    kind: "spawn_subagents",
    purpose: "judge",
    batch_id: VERIFY_BATCH_ID,
    invocations: requests.map((req, idx) => {
      const built = buildJudgePrompt(req);
      return {
        invocation_id: invocationIdFor(idx),
        subagent_type: agentSubagentType(req.judge),
        description: built.description,
        prompt: built.prompt,
        isolation: "none" as const,
      };
    }),
  };
}

function parseVerdicts(
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
      });
    } catch (err) {
      out.push({
        judge: entry.request.judge,
        claim_id: entry.request.claim.claim_id,
        verdict: "INCONCLUSIVE",
        rationale: `parse failure: ${(err as Error).message}`,
        caveats: ["parse_error"],
        confidence: 0,
      });
    }
  }
  return out;
}

function finalize(
  state: PipelineState,
  verdicts: readonly JudgeVerdict[] = [],
) {
  const sections = gatherSections(state);
  const docReport = validateDocument(sections);
  const verificationReport = concludeDocument(verdicts);

  const sectionsPassed = state.sections.filter((s) => s.status === "passed")
    .length;
  const sectionsFailed = state.sections.filter((s) => s.status === "failed")
    .length;
  const sectionsTotal = state.sections.length;
  const docCritical = docReport.violations.filter((v) => v.isCritical).length;

  const summary = [
    `Self-check complete.`,
    `Sections: ${sectionsPassed}/${sectionsTotal} passed, ${sectionsFailed} failed.`,
    `Deterministic violations: ${docReport.violations.length} (${docCritical} critical)`,
    `Hard-output score: ${docReport.totalScore.toFixed(2)} / 1.00`,
    `Multi-judge claims: ${verificationReport.claims_evaluated}`,
    `  PASS:           ${verificationReport.distribution.PASS}`,
    `  SPEC-COMPLETE:  ${verificationReport.distribution["SPEC-COMPLETE"]}`,
    `  NEEDS-RUNTIME:  ${verificationReport.distribution["NEEDS-RUNTIME"]}`,
    `  INCONCLUSIVE:   ${verificationReport.distribution.INCONCLUSIVE}`,
    `  FAIL:           ${verificationReport.distribution.FAIL}`,
    verificationReport.distribution_suspicious
      ? `  ⚠ Distribution suspicious — 100% PASS suggests confirmatory bias.`
      : "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  return {
    state: { ...state, current_step: "complete" as const },
    action: {
      kind: "done" as const,
      summary,
      artifacts: state.sections.map((s) => `${s.section_type}: ${s.status}`),
      // Typed verification surface (Phase 3+4 cross-audit closure). Callers
      // MUST consume this field, not regex-parse `summary`. The string
      // remains as a human-readable artifact only.
      verification: {
        claims_evaluated: verificationReport.claims_evaluated,
        distribution: verificationReport.distribution,
        distribution_suspicious: verificationReport.distribution_suspicious,
      },
    },
  };
}

/**
 * Phase A — plan the multi-judge batch and dispatch it. If there's nothing
 * to verify (no claim-rich sections, or extractor produces zero claims),
 * finalize immediately on the fast path.
 */
function handleSelfCheckPhaseA(state: PipelineState) {
  const sections = gatherSections(state);
  if (sections.length === 0) {
    return finalize(state);
  }

  const plan = planDocumentVerification(sections);
  if (plan.judge_requests.length === 0) {
    return finalize(state);
  }

  return {
    state: {
      ...state,
      verification_plan: {
        batch_id: VERIFY_BATCH_ID,
        claim_ids: plan.judge_requests.map((r) => r.claim.claim_id),
        judges: plan.judge_requests.map((r) => r.judge),
      },
    },
    action: buildVerifyAction(plan.judge_requests),
  };
}

/**
 * Phase B — verdicts came back. Use the snapshot persisted in Phase A
 * rather than re-deriving so Phase B is immune to any state mutation
 * between phases (and to non-determinism in plan generation).
 *
 * No snapshot can mean: (a) Phase B was never preceded by Phase A, or
 * (b) Phase B already ran (snapshot was cleared) and the host is retrying
 * with stale state. Both cases produce the same "no judges to aggregate"
 * outcome — finalize idempotently with zero verdicts.
 */
function handleSelfCheckPhaseB(
  state: PipelineState,
  result: Extract<ActionResult, { kind: "subagent_batch_result" }>,
) {
  const snapshot = state.verification_plan;
  if (!snapshot || snapshot.batch_id !== VERIFY_BATCH_ID) {
    return finalize(state);
  }
  const verdicts = parseVerdictsFromSnapshot(snapshot, state, result);

  // Surface plan-mismatch diagnostics into state.errors so they're
  // observable to operators and tests. The caveats carry the mismatchKind
  // ("ordering_regression" | "content_mutation"); without this append, the
  // diagnostic was buried inside synthetic INCONCLUSIVE JudgeVerdict objects
  // that consensus() does not propagate to the typed `done.verification`
  // surface (cross-audit MED-19, Phase 3+4 follow-up, 2026-04).
  let stateAfter: PipelineState = { ...state, verification_plan: null };
  const mismatchSeen = new Set<string>();
  for (const v of verdicts) {
    for (const caveat of v.caveats) {
      if (caveat.startsWith("mismatch_kind:") && !mismatchSeen.has(caveat)) {
        mismatchSeen.add(caveat);
        stateAfter = appendError(
          stateAfter,
          `[self_check] plan mismatch detected — ${caveat}`,
          "structural", // protocol-level diagnostic — not a section validator
        );
      }
    }
  }

  return finalize(stateAfter, verdicts);
}

export const handleSelfCheck: StepHandler = ({ state, result }) => {
  if (
    result?.kind === "subagent_batch_result" &&
    result.batch_id === VERIFY_BATCH_ID
  ) {
    return handleSelfCheckPhaseB(state, result);
  }
  return handleSelfCheckPhaseA(state);
};

/**
 * Phase B verdict parsing using the persisted snapshot. We re-run
 * planDocumentVerification only to recover the JudgeRequest objects (judge
 * identities and claim metadata); the AUTHORITATIVE ordering comes from the
 * snapshot's claim_ids array. If the re-derived plan no longer matches, we
 * fall back to constructing minimal JudgeVerdicts from the snapshot ids.
 *
 * The snapshot now also carries judges[], so attribution survives the
 * fallback path without needing to invent a synthetic identity.
 */
function parseVerdictsFromSnapshot(
  snapshot: NonNullable<PipelineState["verification_plan"]>,
  state: PipelineState,
  batchResult: Extract<ActionResult, { kind: "subagent_batch_result" }>,
): JudgeVerdict[] {
  const sections = gatherSections(state);
  const rederived = planDocumentVerification(sections).judge_requests;

  const sameLength = rederived.length === snapshot.claim_ids.length;
  const sameOrder =
    sameLength &&
    rederived.every((r, i) => r.claim.claim_id === snapshot.claim_ids[i]);

  if (sameOrder) {
    const index: JudgeIndexEntry[] = rederived.map((req, idx) => ({
      request: req,
      invocation_id: invocationIdFor(idx),
    }));
    return parseVerdicts(index, batchResult);
  }

  // Diagnose the mismatch reason — set vs order — for the caller to persist.
  // The mismatchKind is encoded in each verdict's caveats so the consensus
  // engine + the caller's state.errors append (in handleSelfCheck) can both
  // surface the diagnostic. Curie A5 (pass-2): the previous `void mismatchKind`
  // discarded the info entirely, blocking the K=200 plan-mismatch
  // investigation in Phase 4.3.
  const snapshotSet = new Set(snapshot.claim_ids);
  const rederivedIds = rederived.map((r) => r.claim.claim_id);
  const sameSet =
    sameLength && rederivedIds.every((id) => snapshotSet.has(id));
  const mismatchKind: "ordering_regression" | "content_mutation" = sameSet
    ? "ordering_regression"
    : "content_mutation";

  // Mutation occurred between phases — degrade gracefully. We still know the
  // exact judge identity for each slot (snapshot.judges[idx]), so attribution
  // in ConsensusVerdict.judges and Bayesian reliability lookups remain correct.
  const byId = new Map(
    batchResult.responses.map((r) => [r.invocation_id, r]),
  );
  const out: JudgeVerdict[] = [];
  for (let idx = 0; idx < snapshot.claim_ids.length; idx++) {
    const claim_id = snapshot.claim_ids[idx];
    const judge = snapshot.judges[idx];
    const response = byId.get(invocationIdFor(idx));
    out.push({
      judge,
      claim_id,
      verdict: "INCONCLUSIVE",
      rationale:
        response?.error ??
        "Plan mismatch between Phase A and Phase B — original verdict cannot be parsed without JudgeRequest context",
      caveats: ["plan_mismatch", `mismatch_kind:${mismatchKind}`],
      confidence: 0,
    });
  }
  return out;
}
