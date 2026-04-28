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
 * No I/O by default. The optional `onObservation` hook (D2.B) allows the
 * composition root to record per-judge observations after each claim is
 * resolved. This hook is the only I/O path in this module; when absent,
 * the orchestrator remains purely functional.
 */

import type {
  SectionType,
  Verdict,
  Claim,
  JudgeRequest,
  JudgeVerdict,
  AgentIdentity,
  ReliabilityObservation,
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

/**
 * Per-judge observation emitted after consensus resolves a claim (D2.B).
 *
 * Carries the ground truth derived from the consensus majority verdict —
 * this is the "annotator-circularity" path. The consensus majority is
 * used as a ground-truth proxy until Wave E external oracles are wired.
 *
 * Documented circularity: using consensus-majority as ground truth means
 * systematic judge bias reinforces itself across runs. This is known and
 * accepted until docs/PHASE_4_PLAN.md §4.1 external-grounding work ships.
 *
 * B1 extension (Wave E): optional `external_grounding` carries the oracle
 * dispatch payload for claims with externally-verifiable ground truth. When
 * present, the composition root's `onObservation` callback calls invokeOracle()
 * and writes `oracle_resolved_truth` into the log entry, breaking the circularity.
 * When absent (the common case until Wave F populates it), circularity fallback
 * fires as before.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 — annotator-circularity; Wave E scope.
 * source: Curie A2.3 cross-audit finding — Wave E B1 remediation.
 */
export interface ClaimObservationFlushed {
  readonly claim_id: string;
  readonly judge: AgentIdentity;
  readonly claimType: Claim["claim_type"];
  readonly observation: ReliabilityObservation;
  /**
   * Optional external grounding payload for this claim (Wave E B1).
   * When present, the composition root invokes the appropriate oracle and
   * writes `oracle_resolved_truth` to the log entry.
   * When absent, the circularity fallback fires (ground_truth from consensus).
   */
  readonly external_grounding?: {
    readonly type: "schema" | "math" | "code" | "spec";
    readonly payload: unknown;
  };
}

/**
 * Callback injected by the composition root to record per-judge observations.
 *
 * Called once per (judge × claim) after consensus. The composition root
 * wires this to `repository.recordObservation` + `appendObservationLog`.
 *
 * Layer contract (§2.2): orchestrator does NOT import @prd-gen/benchmark or
 * any infrastructure module. All I/O happens via this callback in the outer
 * composition root.
 *
 * Precondition: called only after consensus has resolved a claim.
 * Postcondition: the observation is persisted (or best-effort logged on error).
 *
 * source: docs/PHASE_4_PLAN.md §4.1; D2.B specification.
 */
export type ObservationFlusher = (obs: ClaimObservationFlushed) => void;

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

/**
 * Extended consensus options — includes calibration wiring (D2.A / D2.B).
 *
 * Passed to `concludeSection` and `concludeDocument` when the composition
 * root wants calibrated reliability weights and/or observation recording.
 *
 * Extends `ConsensusConfig` with:
 *   - `claimTypes`: maps claim_id → claim_type so the orchestrator can set
 *     `ConsensusConfig.claimType` per-claim batch.
 *   - `onObservation`: callback called once per (judge × claim) after consensus.
 *
 * When both fields are absent, behaviour is identical to the pre-Wave-D baseline.
 */
export interface ConcludeOptions extends ConsensusConfig {
  /**
   * Maps claim_id → claim_type. When present, the orchestrator passes
   * the resolved claim_type into ConsensusConfig.claimType per claim so
   * the Bayesian strategy can consult the correct Beta cell.
   *
   * source: docs/PHASE_4_PLAN.md §4.1 — per-(agent, claim_type) cell.
   */
  readonly claimTypes?: ReadonlyMap<string, Claim["claim_type"]>;
  /**
   * Observation flush hook (D2.B). Called once per (judge × claim) after
   * consensus with the consensus-majority verdict as ground truth.
   *
   * Annotator-circularity: ground_truth is derived from the consensus
   * majority, not an external oracle. Wave E will break this by providing
   * real oracle verdicts. Until then, this is the only available signal.
   *
   * source: docs/PHASE_4_PLAN.md §4.1; D2.B.
   */
  readonly onObservation?: ObservationFlusher;
}

// ─── Conclude ───────────────────────────────────────────────────────────────

export function concludeSection(
  sectionType: SectionType,
  verdicts: readonly JudgeVerdict[],
  options: ConcludeOptions = {},
): VerificationReport {
  return concludeFromVerdicts(sectionType, verdicts, options);
}

export function concludeDocument(
  verdicts: readonly JudgeVerdict[],
  options: ConcludeOptions = {},
): VerificationReport {
  return concludeFromVerdicts("document", verdicts, options);
}

/**
 * Determine verdict direction for an observation from a binary PASS/FAIL
 * ground-truth label.
 *
 * Precondition: groundTruthIsFail is a boolean.
 * Postcondition:
 *   - groundTruthIsFail = true  → sensitivity_arm
 *   - groundTruthIsFail = false → specificity_arm
 *
 * source: docs/PHASE_4_PLAN.md §4.1 sensitivity/specificity split.
 */
function groundTruthToIsFail(verdict: Verdict): boolean {
  // Conservative mapping: any non-PASS verdict is "FAIL-class" ground truth.
  // SPEC-COMPLETE, NEEDS-RUNTIME, INCONCLUSIVE are treated as "failed to pass"
  // for the purpose of sensitivity calibration.
  // source: docs/PHASE_4_PLAN.md §4.1 — "PASS-class: PASS only."
  return verdict !== "PASS";
}

function concludeFromVerdicts(
  scope: SectionType | "document",
  verdicts: readonly JudgeVerdict[],
  options: ConcludeOptions,
): VerificationReport {
  const byClaim = new Map<string, JudgeVerdict[]>();
  for (const v of verdicts) {
    const list = byClaim.get(v.claim_id) ?? [];
    list.push(v);
    byClaim.set(v.claim_id, list);
  }

  const results: ConsensusVerdict[] = [];
  for (const [claim_id, vs] of byClaim) {
    // Resolve the claim_type for this batch if the mapping was provided.
    const claimType = options.claimTypes?.get(claim_id);
    const batchConfig: ConsensusConfig = claimType !== undefined
      ? { ...options, claimType }
      : options;

    const result = consensus(claim_id, vs, batchConfig);
    results.push(result);

    // D2.B: flush per-judge observations after consensus resolves the claim.
    // Ground truth = consensus majority (annotator-circularity path).
    // Wave E will replace this with oracle verdicts.
    // Best-effort: flusher errors must not abort the pipeline.
    if (options.onObservation !== undefined && claimType !== undefined) {
      const groundTruthIsFail = groundTruthToIsFail(result.verdict);
      for (const jv of vs) {
        const judgeWasCorrect = groundTruthIsFail
          ? jv.verdict !== "PASS" && jv.verdict !== "SPEC-COMPLETE"
          : jv.verdict === "PASS" || jv.verdict === "SPEC-COMPLETE";
        try {
          options.onObservation({
            claim_id,
            judge: jv.judge,
            claimType,
            observation: { groundTruthIsFail, judgeWasCorrect },
          });
        } catch {
          // Best-effort: observation persistence failure must not break the pipeline.
          // Errors are intentionally swallowed here (§6.1 ref: named failure mode =
          // "flusher throws on DB error or log write failure").
        }
      }
    }
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
   * Refinement requires K≥100 labelled runs (docs/PHASE_4_PLAN.md §4.5).
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
