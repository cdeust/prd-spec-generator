/**
 * `review` — the code-reviewer spawn and bounded retry loop
 * (design-phases-3-5.md §3, §4, §6, PR 4b).
 *
 * One `spawn_subagents` (purpose "review", `subagent_type: "code-reviewer"`)
 * per attempt, fed the implementation report + post_impl_verification
 * verdicts + testing report. The reviewer's response is parsed for a
 * machine-readable `VERDICT: PASS|FAIL` + `FINDINGS:` footer (same
 * contract-ownership pattern as implementation.ts's BRANCH:/WORKTREE:
 * footer).
 *
 * Two independent things can go wrong here, and they get DIFFERENT
 * responses (design §4's "reviewer en erreur → degrade to advisory after
 * cap" is about failure mode 2 below; the FAIL-verdict retry described in
 * design §3/§6 is failure mode 1):
 *
 *   1. The reviewer responds with a PARSED verdict of "fail" — a genuine
 *      code-quality finding. Retries `implementation` (design §3, §6 open
 *      question 5 — "same worktree" continuation, see implementation.ts's
 *      retry-mode doc), carrying `findings` forward via
 *      `post_specs.review.findings`, and RESETS `verification`/`testing` to
 *      null (the fix invalidates both — they measured the REJECTED code).
 *   2. The reviewer subagent itself errors, or returns a response with no
 *      parsable VERDICT: footer — a review-INFRASTRUCTURE failure, not a
 *      code-quality verdict. Re-spawns the SAME reviewer attempt (NOT the
 *      engineer — nothing is known to be wrong with the code) on the SAME
 *      worktree/implementation/testing evidence.
 *
 * Both share ONE retry budget (`REVIEW_RETRY_CAP`, `post_specs.retry_count`)
 * — a single, simple, exhaustible counter rather than two independent caps.
 * Cap exhausted (either failure mode) → DEGRADE TO ADVISORY: `post_specs
 * .review` is set to a FAIL verdict visible to the human, `pr_gate` is
 * still reached (PR 5 — replaces the PR-4b dead-end to `finalize`; never a
 * hard abort — design §4 "jamais de blocage de finalize/remember/done").
 * A PASS verdict advances to `pr_gate` the same way — EVERY review exit
 * (PASS or advisory-degraded FAIL) reaches the trust-seam gate, which
 * decides for itself whether a FAIL verdict is acceptable to push (design
 * §3: "pr_gate ... always fires ... regardless of review verdict").
 *
 * Attempt-indexed invocation_id/batch_id (protocol-ids.ts's
 * `reviewInvocationId`, mirroring `preImplGroundingImpactCorrelationId`):
 * each attempt gets its OWN id, computed from `post_specs.retry_count + 1`
 * — a stale response from a prior attempt can never be mistaken for the
 * current one.
 *
 * Loop-guard placement (Phase 2 git-historian lesson, restated throughout
 * this loop's handlers): result-processing is evaluated FIRST, before the
 * "already reviewed" idempotency guard (which only fires on a PASS verdict
 * — see handleReview's guard doc).
 *
 * source: design-phases-3-5.md §3, §4, §6 PR 4b.
 */

import type { HandlerAction } from "../types/actions.js";
import type { StepHandler } from "../runner.js";
import { appendError, type PipelineState } from "../types/state.js";
import {
  initialPostSpecs,
  type PostSpecsState,
  type ReviewState,
} from "../types/state/post-specs-state.js";
import { buildReviewPrompt } from "@prd-gen/meta-prompting";
import { reviewInvocationId } from "./protocol-ids.js";

/**
 * Cap on review retries (shared budget for both FAIL-verdict retries and
 * reviewer-infrastructure-error retries — see module doc).
 *
 * source: design-phases-3-5.md §3, §6 open question 1 — "provisional
 * (mirrors MAX_ATTEMPTS), no source — to measure", same convention as
 * IMPACT_QUERY_SYMBOL_CAP (pre-impl-grounding.ts). Not a measured/sourced
 * constant; flagged for production-telemetry calibration before it is
 * treated as final (§10 stakes-calibration rule 8 — sources).
 */
export const REVIEW_RETRY_CAP = 3;

type HandlerStep = { state: PipelineState; action: HandlerAction };

function ensurePostSpecs(state: PipelineState): PostSpecsState {
  return state.post_specs ?? initialPostSpecs();
}

/**
 * precondition:  none.
 * postcondition: the attempt number about to run (or already in flight) —
 *                1-based, derived from `post_specs.retry_count` (0 on the
 *                very first review, incremented once per retry).
 */
function currentAttempt(postSpecs: PostSpecsState): number {
  return postSpecs.retry_count + 1;
}

function summarizeVerification(postSpecs: PostSpecsState): string {
  const v = postSpecs.verification;
  if (!v) return "";
  const lines = [`gates_passed: ${v.gates_passed}`];
  if (v.changed_symbols.length > 0) {
    lines.push(`changed symbols: ${v.changed_symbols.join(", ")}`);
  }
  return lines.join("\n");
}

function emitReviewSpawn(state: PipelineState, postSpecs: PostSpecsState): HandlerStep {
  const attempt = currentAttempt(postSpecs);
  const worktree = postSpecs.implementation?.worktree_path ?? "";
  const branch = postSpecs.implementation?.branch ?? "";
  const invocationId = reviewInvocationId(attempt);
  return {
    state: { ...state, post_specs: postSpecs },
    action: {
      kind: "spawn_subagents",
      purpose: "review",
      batch_id: invocationId,
      invocations: [
        {
          invocation_id: invocationId,
          subagent_type: "code-reviewer",
          description: `Review the implementation (attempt ${attempt}/${REVIEW_RETRY_CAP})`,
          prompt: buildReviewPrompt({
            feature_description: state.feature_description,
            worktree_path: worktree,
            branch,
            spec_files: state.written_files,
            implementation_summary: postSpecs.implementation?.raw_report ?? "",
            verification_summary: summarizeVerification(postSpecs),
            testing_summary: postSpecs.testing?.raw_report ?? "",
            prior_findings: postSpecs.review?.findings,
          }),
          isolation: "none",
        },
      ],
    },
  };
}

function advanceToPrGate(
  state: PipelineState,
  postSpecs: PostSpecsState,
  review: ReviewState,
  message: string,
  level: "info" | "warn" = "info",
): HandlerStep {
  return {
    state: {
      ...state,
      current_step: "pr_gate",
      post_specs: { ...postSpecs, review },
    },
    action: { kind: "emit_message", message, level },
  };
}

function retryImplementation(
  state: PipelineState,
  postSpecs: PostSpecsState,
  nextRetryCount: number,
  findings: readonly string[],
  message: string,
): HandlerStep {
  return {
    state: {
      ...state,
      current_step: "implementation",
      post_specs: {
        ...postSpecs,
        retry_count: nextRetryCount,
        review: { verdict: "fail", findings: [...findings], attempt: nextRetryCount },
        // The fix invalidates both — they measured the REJECTED code.
        verification: null,
        testing: null,
      },
    },
    action: { kind: "emit_message", message, level: "warn" },
  };
}

function retryReviewer(
  state: PipelineState,
  postSpecs: PostSpecsState,
  nextRetryCount: number,
  message: string,
): HandlerStep {
  return {
    state: {
      ...state,
      current_step: "review",
      post_specs: { ...postSpecs, retry_count: nextRetryCount },
    },
    action: { kind: "emit_message", message, level: "warn" },
  };
}

/**
 * precondition:  a review outcome (FAIL verdict, or reviewer-infrastructure
 *                failure) has just been determined.
 * postcondition: retries (implementation for a FAIL verdict, the reviewer
 *                itself for an infrastructure failure) when
 *                `post_specs.retry_count < REVIEW_RETRY_CAP`; otherwise
 *                degrades to an advisory FAIL visible in `post_specs.review`
 *                and advances to `pr_gate` — never a hard abort.
 */
function handleReviewOutcomeFailure(
  state: PipelineState,
  postSpecs: PostSpecsState,
  message: string,
  mode: "retry_implementation" | "retry_reviewer",
  findings: readonly string[],
): HandlerStep {
  const nextState = appendError(state, message, "upstream_failure");
  const nextRetryCount = postSpecs.retry_count + 1;

  if (postSpecs.retry_count < REVIEW_RETRY_CAP) {
    if (mode === "retry_implementation") {
      return retryImplementation(
        nextState,
        postSpecs,
        nextRetryCount,
        findings,
        `Review FAIL (attempt ${nextRetryCount}/${REVIEW_RETRY_CAP}): retrying implementation with findings.`,
      );
    }
    return retryReviewer(
      nextState,
      postSpecs,
      nextRetryCount,
      `Review attempt ${postSpecs.retry_count + 1} failed to produce a verdict (${message}); retrying review (attempt ${nextRetryCount}/${REVIEW_RETRY_CAP}).`,
    );
  }

  const advisoryFindings =
    mode === "retry_implementation" ? findings : [`Review cap exhausted: ${message}`];
  return advanceToPrGate(
    nextState,
    postSpecs,
    { verdict: "fail", findings: [...advisoryFindings], attempt: currentAttempt(postSpecs) },
    `Review retry cap (${REVIEW_RETRY_CAP}) exhausted; degrading to advisory FAIL, proceeding to the PR gate.`,
    "warn",
  );
}

const VERDICT_FOOTER_RE = /^\s*VERDICT:\s*(PASS|FAIL)\s*$/im;
const FINDINGS_HEADER_RE = /^\s*FINDINGS:\s*$/im;
const FINDING_BULLET_RE = /^-\s+(\S.*)$/;

interface ParsedReviewReport {
  readonly verdict: "pass" | "fail";
  readonly findings: string[];
}

/**
 * precondition:  none — safe on any string.
 * postcondition: returns the parsed {verdict, findings} iff a VERDICT:
 *                footer with value PASS or FAIL is present; null otherwise
 *                (caller treats null as a reviewer-infrastructure failure —
 *                design §4's "reviewer en erreur"). FINDINGS: is optional —
 *                its absence yields an empty findings list, not a parse
 *                failure (a PASS verdict typically omits it).
 */
function parseReviewReport(rawText: string): ParsedReviewReport | null {
  const verdictMatch = VERDICT_FOOTER_RE.exec(rawText);
  if (!verdictMatch?.[1]) return null;

  const findings: string[] = [];
  const findingsHeaderMatch = FINDINGS_HEADER_RE.exec(rawText);
  if (findingsHeaderMatch) {
    const afterHeaderStart = findingsHeaderMatch.index + findingsHeaderMatch[0].length;
    const body = rawText.slice(afterHeaderStart).split("\n");
    for (const line of body) {
      if (line.trim() === "") continue;
      const bulletMatch = FINDING_BULLET_RE.exec(line);
      if (!bulletMatch) break; // end of the FINDINGS: block
      findings.push(bulletMatch[1].trim());
    }
  }

  return { verdict: verdictMatch[1].toLowerCase() as "pass" | "fail", findings };
}

function processReviewResult(
  state: PipelineState,
  postSpecs: PostSpecsState,
  result: Extract<import("../types/actions.js").ActionResult, { kind: "subagent_batch_result" }>,
): HandlerStep {
  const attempt = currentAttempt(postSpecs);
  const invocationId = reviewInvocationId(attempt);
  const response = result.responses.find((r) => r.invocation_id === invocationId);

  if (!response || response.error || !response.raw_text?.trim()) {
    return handleReviewOutcomeFailure(
      state,
      postSpecs,
      `reviewer subagent failed: ${response?.error ?? "no response"}`,
      "retry_reviewer",
      [],
    );
  }

  const parsed = parseReviewReport(response.raw_text);
  if (!parsed) {
    return handleReviewOutcomeFailure(
      state,
      postSpecs,
      "reviewer report did not include a parsable VERDICT: footer",
      "retry_reviewer",
      [],
    );
  }

  if (parsed.verdict === "pass") {
    return advanceToPrGate(
      state,
      postSpecs,
      { verdict: "pass", findings: [], attempt },
      "Review PASSED; proceeding to the PR gate.",
    );
  }

  return handleReviewOutcomeFailure(
    state,
    postSpecs,
    `review FAILED: ${parsed.findings.join("; ") || "no findings given"}`,
    "retry_implementation",
    parsed.findings,
  );
}

export const handleReview: StepHandler = ({ state, result }) => {
  const postSpecs = ensurePostSpecs(state);
  const expectedBatchId = reviewInvocationId(currentAttempt(postSpecs));

  // Result-processing FIRST (Phase 2 git-historian loop-ordering lesson).
  if (result?.kind === "subagent_batch_result" && result.batch_id === expectedBatchId) {
    return processReviewResult(state, postSpecs, result);
  }

  // Idempotency guard AFTER result-processing: only a PASS verdict is a
  // terminal, replay-safe state for this step (a FAIL verdict always
  // transitions current_step away from "review" in the SAME call that
  // determined it — see retryImplementation/advanceToPrGate — so this
  // handler is never re-entered with a stale FAIL verdict still attached to
  // current_step "review").
  if (postSpecs.review?.verdict === "pass") {
    return {
      state: { ...state, current_step: "pr_gate", post_specs: postSpecs },
      action: {
        kind: "emit_message",
        message: "Review already passed; proceeding to the PR gate.",
      },
    };
  }

  return emitReviewSpawn(state, postSpecs);
};
