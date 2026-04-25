/**
 * Verification orchestrator — high-level entry point.
 *
 * Two-phase API matching the host-queue model used by the runner:
 *
 *   plan(section)  → JudgeRequest[]   // claims × selected panel
 *   conclude(verdicts) → VerificationReport
 *
 * The caller (orchestration package or mcp-server tool) feeds the
 * JudgeRequest[] into a HostQueueSubagentClient, drains the responses, and
 * passes them back via `conclude`.
 *
 * No I/O. No LLM calls. Pure dispatch + aggregation.
 */

import type {
  SectionType,
  Verdict,
  Claim,
  JudgeRequest,
  JudgeVerdict,
} from "@prd-gen/core";
import { extractClaims, extractClaimsFromDocument } from "./claim-extractor.js";
import { selectJudges } from "./judge-selector.js";
import {
  consensus,
  type ConsensusConfig,
  type ConsensusVerdict,
} from "./consensus.js";

export interface VerificationPlan {
  readonly claims: readonly Claim[];
  readonly judge_requests: readonly JudgeRequest[];
}

export interface VerificationReport {
  readonly section_type: SectionType | "document";
  readonly claims_evaluated: number;
  readonly judges_invoked: number;
  readonly results: readonly ConsensusVerdict[];
  /** Counts per final verdict */
  readonly distribution: Readonly<Record<Verdict, number>>;
  /** Critical failures — any FAIL verdict */
  readonly failures: readonly ConsensusVerdict[];
  /** Warning verdicts — INCONCLUSIVE / NEEDS-RUNTIME / SPEC-COMPLETE */
  readonly warnings: readonly ConsensusVerdict[];
  /** Was the verdict distribution suspicious? (all PASS = confirmatory bias) */
  readonly distribution_suspicious: boolean;
}

export interface PlanOptions {
  /** Optional codebase excerpts to include in each judge prompt */
  readonly codebase_excerpts?: readonly string[];
  /** Optional memory excerpts to include in each judge prompt */
  readonly memory_excerpts?: readonly string[];
  /** Pass the section content as prd_excerpt to each judge */
  readonly include_prd_excerpt?: boolean;
}

// ─── Plan ───────────────────────────────────────────────────────────────────

export function planSectionVerification(
  sectionType: SectionType,
  content: string,
  options: PlanOptions = {},
): VerificationPlan {
  const claims = extractClaims(sectionType, content);
  const judge_requests = buildRequests(claims, options, content);
  return { claims, judge_requests };
}

export function planDocumentVerification(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
  options: PlanOptions = {},
): VerificationPlan {
  const claims = extractClaimsFromDocument(sections);
  const concatenated = sections
    .map((s) => `## ${s.type}\n\n${s.content}`)
    .join("\n\n");
  const judge_requests = buildRequests(claims, options, concatenated);
  return { claims, judge_requests };
}

function buildRequests(
  claims: readonly Claim[],
  options: PlanOptions,
  prdExcerpt: string,
): readonly JudgeRequest[] {
  const requests: JudgeRequest[] = [];
  const includePrd = options.include_prd_excerpt !== false;

  for (const claim of claims) {
    const judges = selectJudges(claim);
    for (const judge of judges) {
      requests.push({
        judge,
        claim,
        context: {
          prd_excerpt: includePrd ? prdExcerpt : undefined,
          codebase_excerpts: [...(options.codebase_excerpts ?? [])],
          memory_excerpts: [...(options.memory_excerpts ?? [])],
        },
      });
    }
  }
  return requests;
}

// ─── Conclude ───────────────────────────────────────────────────────────────

export function concludeSection(
  sectionType: SectionType,
  verdicts: readonly JudgeVerdict[],
  consensusConfig: ConsensusConfig = {},
): VerificationReport {
  return concludeFromVerdicts(sectionType, verdicts, consensusConfig);
}

export function concludeDocument(
  verdicts: readonly JudgeVerdict[],
  consensusConfig: ConsensusConfig = {},
): VerificationReport {
  return concludeFromVerdicts("document", verdicts, consensusConfig);
}

function concludeFromVerdicts(
  scope: SectionType | "document",
  verdicts: readonly JudgeVerdict[],
  consensusConfig: ConsensusConfig,
): VerificationReport {
  const byClaim = new Map<string, JudgeVerdict[]>();
  for (const v of verdicts) {
    const list = byClaim.get(v.claim_id) ?? [];
    list.push(v);
    byClaim.set(v.claim_id, list);
  }

  const results: ConsensusVerdict[] = [];
  for (const [claim_id, vs] of byClaim) {
    results.push(consensus(claim_id, vs, consensusConfig));
  }

  const distribution: Record<Verdict, number> = {
    PASS: 0,
    "SPEC-COMPLETE": 0,
    "NEEDS-RUNTIME": 0,
    INCONCLUSIVE: 0,
    FAIL: 0,
  };
  for (const r of results) distribution[r.verdict] += 1;

  const failures = results.filter((r) => r.verdict === "FAIL");
  const warnings = results.filter(
    (r) =>
      r.verdict === "INCONCLUSIVE" ||
      r.verdict === "NEEDS-RUNTIME" ||
      r.verdict === "SPEC-COMPLETE",
  );

  const passRate =
    results.length > 0 ? distribution.PASS / results.length : 0;
  /**
   * Confirmatory-bias detector. Fires when every claim votes PASS unanimously
   * AND the claim count is large enough for the unanimity to be informative.
   *
   * source: provisional heuristic. The minimum cluster size of 5 reflects
   * Move-2 reasoning: a 5-label distribution (PASS / SPEC-COMPLETE /
   * NEEDS-RUNTIME / INCONCLUSIVE / FAIL) requires ≥5 observations before
   * a 100%-PASS run is statistically distinguishable from "small-N noise."
   * The exact 1.0 threshold is conservative; a softer threshold (e.g. 0.95)
   * with a larger minimum cluster is on the Phase 4.5 calibration list.
   * Refinement requires K≥100 labelled runs (PHASE_4_PLAN.md §4.5).
   */
  const SUSPICIOUS_MIN_CLUSTER = 5;
  const SUSPICIOUS_PASS_RATE = 1.0;
  const distribution_suspicious =
    results.length >= SUSPICIOUS_MIN_CLUSTER && passRate >= SUSPICIOUS_PASS_RATE;

  return {
    section_type: scope,
    claims_evaluated: results.length,
    judges_invoked: verdicts.length,
    results,
    distribution,
    failures,
    warnings,
    distribution_suspicious,
  };
}
