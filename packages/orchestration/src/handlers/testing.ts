/**
 * `testing` — the test-engineer spawn (design-phases-3-5.md §3, PR 4b).
 *
 * One `spawn_subagents` (purpose "test" — additive enum value, see
 * actions.ts SpawnSubagentsActionSchema), `subagent_type: "test-engineer"`,
 * `isolation: "none"` — NO second worktree. The test-engineer works on the
 * SAME branch/worktree `implementation` already recorded
 * (`post_specs.implementation.worktree_path` / `.branch`), exactly as the
 * mission's own instruction: "il travaille sur la MÊME branche/worktree que
 * l'implémentation."
 *
 * `post_impl_verification` always transitions here once its 4-call sequence
 * settles (success or degrade) — there is nothing left to verify structurally
 * once the sequence has run; testing/review run regardless (design §4).
 *
 * Report contract: `TestingStateSchema` (design §2.1) stores only
 * `{ raw_report }` — no machine-readable footer. `review` (not this
 * handler) is the one that assesses pass/fail from the report's prose.
 *
 * Failure policy (design §4, "testing" row): a test-engineer subagent
 * error/empty response DEGRADES — recorded via `appendError
 * ("upstream_failure")`, `post_specs.testing.raw_report` is set to a
 * descriptive failure marker (so `review`'s prompt sees THAT testing failed,
 * not silence), and the run ALWAYS advances to `review` — never an abort.
 * This mirrors design §4's explicit instruction: "Échec test-engineer →
 * surfacé à la revue comme finding, pas d'abort."
 *
 * Loop-guard placement (Phase 2 git-historian lesson, restated throughout
 * this loop's handlers): result-processing for the current batch is
 * evaluated FIRST, before the "already recorded" idempotency guard.
 *
 * source: design-phases-3-5.md §3, §4, §5 PR 4b.
 */

import type { HandlerAction } from "../types/actions.js";
import type { StepHandler } from "../runner.js";
import { appendError, type PipelineState } from "../types/state.js";
import {
  initialPostSpecs,
  type PostSpecsState,
  type TestingState,
} from "../types/state/post-specs-state.js";
import { buildTestingPrompt } from "@prd-gen/meta-prompting";
import { TESTING_INV_ID } from "./protocol-ids.js";

/** Single-invocation batch — mirrors IMPLEMENTATION_BATCH_ID's convention. */
export const TESTING_BATCH_ID = TESTING_INV_ID;

type HandlerStep = { state: PipelineState; action: HandlerAction };

function ensurePostSpecs(state: PipelineState): PostSpecsState {
  return state.post_specs ?? initialPostSpecs();
}

/**
 * Defensive char cap for the stored raw_report — same derivation basis as
 * implementation.ts's RAW_REPORT_TRUNCATE_CHARS (design mission: "même
 * truncation que 4a").
 * source: same derivation basis as implementation.ts:RAW_REPORT_TRUNCATE_CHARS.
 */
const RAW_REPORT_TRUNCATE_CHARS = 4_000;
const RAW_REPORT_TRUNCATION_MARKER = "...";

function truncateRawReport(text: string): string {
  return text.length > RAW_REPORT_TRUNCATE_CHARS
    ? text.slice(0, RAW_REPORT_TRUNCATE_CHARS) + RAW_REPORT_TRUNCATION_MARKER
    : text;
}

/**
 * precondition:  none.
 * postcondition: a short "gates_passed=<bool>" line plus, when present, the
 *                verify_semantic_diff status — a compact summary for the
 *                test-engineer's prompt. "" when post_specs.verification is
 *                null (post_impl_verification never ran — cannot happen on
 *                the current step graph, but defensive for direct-inject
 *                tests).
 */
function summarizeVerification(postSpecs: PostSpecsState): string {
  const v = postSpecs.verification;
  if (!v) return "";
  const lines = [`gates_passed: ${v.gates_passed}`];
  if (v.changed_symbols.length > 0) {
    lines.push(`changed symbols: ${v.changed_symbols.join(", ")}`);
  }
  return lines.join("\n");
}

function emitTestingSpawn(state: PipelineState, postSpecs: PostSpecsState): HandlerStep {
  const worktree = postSpecs.implementation?.worktree_path ?? "";
  const branch = postSpecs.implementation?.branch ?? "";
  return {
    state: { ...state, post_specs: postSpecs },
    action: {
      kind: "spawn_subagents",
      purpose: "test",
      batch_id: TESTING_BATCH_ID,
      invocations: [
        {
          invocation_id: TESTING_INV_ID,
          subagent_type: "test-engineer",
          description: "Write and run tests for the implemented change",
          prompt: buildTestingPrompt({
            feature_description: state.feature_description,
            worktree_path: worktree,
            branch,
            spec_files: state.written_files,
            implementation_summary: postSpecs.implementation?.raw_report ?? "",
            verification_summary: summarizeVerification(postSpecs),
          }),
          isolation: "none",
        },
      ],
    },
  };
}

function advanceToReview(
  state: PipelineState,
  postSpecs: PostSpecsState,
  testing: TestingState,
  message: string,
  level: "info" | "warn" = "info",
): HandlerStep {
  return {
    state: {
      ...state,
      current_step: "review",
      post_specs: { ...postSpecs, testing },
    },
    action: { kind: "emit_message", message, level },
  };
}

function processTestingResult(
  state: PipelineState,
  postSpecs: PostSpecsState,
  result: Extract<import("../types/actions.js").ActionResult, { kind: "subagent_batch_result" }>,
): HandlerStep {
  const response = result.responses.find((r) => r.invocation_id === TESTING_INV_ID);

  if (!response || response.error || !response.raw_text?.trim()) {
    const nextState = appendError(
      state,
      `testing subagent failed: ${response?.error ?? "no response"}; degrading — surfaced to review as a finding`,
      "upstream_failure",
    );
    const testing: TestingState = {
      raw_report: `[TEST-ENGINEER FAILURE] ${response?.error ?? "no response"}`,
    };
    return advanceToReview(
      nextState,
      postSpecs,
      testing,
      "Testing subagent failed; proceeding to review with a degraded testing report.",
      "warn",
    );
  }

  const testing: TestingState = {
    raw_report: truncateRawReport(response.raw_text.trim()),
  };
  return advanceToReview(state, postSpecs, testing, "Testing complete; proceeding to review.");
}

export const handleTesting: StepHandler = ({ state, result }) => {
  const postSpecs = ensurePostSpecs(state);

  // Result-processing FIRST (Phase 2 git-historian loop-ordering lesson).
  if (result?.kind === "subagent_batch_result" && result.batch_id === TESTING_BATCH_ID) {
    return processTestingResult(state, postSpecs, result);
  }

  // Idempotency guard AFTER result-processing: a replay after
  // post_specs.testing is already set skips straight to review without
  // re-spawning the test-engineer.
  if (postSpecs.testing) {
    return {
      state: { ...state, current_step: "review", post_specs: postSpecs },
      action: {
        kind: "emit_message",
        message: "Testing already recorded; proceeding to review.",
      },
    };
  }

  return emitTestingSpawn(state, postSpecs);
};
