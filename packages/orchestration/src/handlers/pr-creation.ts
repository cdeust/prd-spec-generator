/**
 * `pr_creation` — the branch-push + `gh pr create` spawn (design-phases-3-5.md
 * §3, PR 5). Reached ONLY after a human explicitly approved the push at
 * `pr_gate` (pr-gate.ts) — this step never runs unsolicited.
 *
 * One `spawn_subagents` (purpose "pr" — additive enum value, see actions.ts
 * SpawnSubagentsActionSchema), `subagent_type: "engineer"`, `isolation:
 * "none"` — the SAME branch/worktree `implementation` recorded, no second
 * worktree (design §3: "same branch/worktree, isolation:none").
 *
 * No new action kind: `run_command` was explicitly refused (design §3,
 * §7.2 "reflection for control flow" default-refuse) in favor of the
 * uniform "ask an agent, get text back" `spawn_subagents` contract, whose
 * tool calls are logged per-turn — a materially smaller, more reviewable
 * surface than letting a pure reducer's emitted string drive an arbitrary
 * host subprocess.
 *
 * Report contract: the prompt (buildPrCreationPrompt, @prd-gen/meta-prompting)
 * instructs the engineer to push and open a PR, then end its response with a
 * machine-readable `PR_URL:` footer. This handler owns BOTH sides of that
 * contract (prompt + parser), same pattern as implementation.ts's
 * BRANCH:/WORKTREE: footer and review.ts's VERDICT:/FINDINGS: footer.
 *
 * Failure policy (design §4, "pr_creation" row): a subagent error/empty
 * response, OR a response with no parsable `PR_URL:` footer (push/`gh pr
 * create` failed silently, or the subagent forgot the footer) — BOTH
 * DEGRADE: `appendError("upstream_failure")`, `post_specs.pr = {pushed:
 * false, url:null}`. `finalize` is still reached — never a hard abort
 * (mirrors every other stage in this loop's "jamais de blocage de
 * finalize/remember/done").
 *
 * Loop-guard placement (Phase 2 git-historian lesson, restated throughout
 * this loop's handlers): result-processing for the current batch is
 * evaluated FIRST, before the "already recorded" idempotency guard. Unlike
 * `pr_gate` (which has NO idempotency shortcut — see pr-gate.ts's module
 * doc), this step's own "already recorded" guard is safe: `pr_creation` is
 * reached at most once per `pr_gate` "yes" decision, and a replay after
 * `post_specs.pr` is already set (success OR degrade) must not re-spawn.
 *
 * source: design-phases-3-5.md §3, §4, §5 PR 5.
 */

import type { HandlerAction } from "../types/actions.js";
import type { StepHandler } from "../runner.js";
import { appendError, type PipelineState } from "../types/state.js";
import {
  initialPostSpecs,
  type PostSpecsState,
  type PrState,
} from "../types/state/post-specs-state.js";
import { buildPrCreationPrompt } from "@prd-gen/meta-prompting";
import { PR_CREATION_INV_ID } from "./protocol-ids.js";

/** Single-invocation batch — mirrors IMPLEMENTATION_BATCH_ID's convention. */
export const PR_CREATION_BATCH_ID = PR_CREATION_INV_ID;

type HandlerStep = { state: PipelineState; action: HandlerAction };

function ensurePostSpecs(state: PipelineState): PostSpecsState {
  return state.post_specs ?? initialPostSpecs();
}

/**
 * precondition:  none.
 * postcondition: a compact multi-line summary of the review verdict for the
 *                PR-creation prompt (mirrors review.ts's
 *                summarizeVerification helper shape). "" when no review
 *                verdict was recorded (cannot happen on the current step
 *                graph — pr_creation is only reached via pr_gate, which is
 *                only reached from review — but defensive for direct-inject
 *                tests).
 */
function summarizeReview(postSpecs: PostSpecsState): string {
  const r = postSpecs.review;
  if (!r) return "";
  const lines = [`verdict: ${r.verdict}`];
  if (r.findings.length > 0) {
    lines.push(`findings: ${r.findings.join("; ")}`);
  }
  return lines.join("\n");
}

function summarizeVerification(postSpecs: PostSpecsState): string {
  const v = postSpecs.verification;
  if (!v) return "";
  return `gates_passed: ${v.gates_passed}`;
}

function emitPrCreationSpawn(state: PipelineState, postSpecs: PostSpecsState): HandlerStep {
  const worktree = postSpecs.implementation?.worktree_path ?? "";
  const branch = postSpecs.implementation?.branch ?? "";
  return {
    state: { ...state, post_specs: postSpecs },
    action: {
      kind: "spawn_subagents",
      purpose: "pr",
      batch_id: PR_CREATION_BATCH_ID,
      invocations: [
        {
          invocation_id: PR_CREATION_INV_ID,
          subagent_type: "engineer",
          description: "Push the branch and open a pull request",
          prompt: buildPrCreationPrompt({
            feature_description: state.feature_description,
            worktree_path: worktree,
            branch,
            spec_files: state.written_files,
            implementation_summary: postSpecs.implementation?.raw_report ?? "",
            verification_summary: summarizeVerification(postSpecs),
            testing_summary: postSpecs.testing?.raw_report ?? "",
            review_summary: summarizeReview(postSpecs),
          }),
          isolation: "none",
        },
      ],
    },
  };
}

function degradeToFinalize(
  state: PipelineState,
  postSpecs: PostSpecsState,
  message: string,
): HandlerStep {
  const pr: PrState = { pushed: false, url: null };
  return {
    state: appendError(
      { ...state, current_step: "finalize", post_specs: { ...postSpecs, pr } },
      message,
      "upstream_failure",
    ),
    action: { kind: "emit_message", message, level: "warn" },
  };
}

const PR_URL_FOOTER_RE = /^\s*PR_URL:\s*(\S+)\s*$/im;

/**
 * precondition:  none — safe on any string.
 * postcondition: returns the parsed PR URL iff a `PR_URL:` footer with a
 *                non-empty value is present; null otherwise (caller treats
 *                null as "push/gh pr create failed or the footer was
 *                omitted" — design §4's "footer absent → degrade").
 */
function parsePrCreationReport(rawText: string): string | null {
  const match = PR_URL_FOOTER_RE.exec(rawText);
  return match?.[1] ?? null;
}

function processPrCreationResult(
  state: PipelineState,
  postSpecs: PostSpecsState,
  result: Extract<import("../types/actions.js").ActionResult, { kind: "subagent_batch_result" }>,
): HandlerStep {
  const response = result.responses.find((r) => r.invocation_id === PR_CREATION_INV_ID);

  if (!response || response.error || !response.raw_text?.trim()) {
    return degradeToFinalize(
      state,
      postSpecs,
      `pr_creation subagent failed: ${response?.error ?? "no response"}; degrading — proceeding to finalize without a PR`,
    );
  }

  const url = parsePrCreationReport(response.raw_text);
  if (!url) {
    return degradeToFinalize(
      state,
      postSpecs,
      "pr_creation subagent report did not include a parsable PR_URL: footer; degrading — proceeding to finalize without a PR",
    );
  }

  const pr: PrState = { pushed: true, url };
  return {
    state: {
      ...state,
      current_step: "finalize",
      post_specs: { ...postSpecs, pr },
    },
    action: {
      kind: "emit_message",
      message: `Pull request opened: ${url}`,
    },
  };
}

export const handlePrCreation: StepHandler = ({ state, result }) => {
  const postSpecs = ensurePostSpecs(state);

  // Result-processing FIRST (Phase 2 git-historian loop-ordering lesson).
  if (result?.kind === "subagent_batch_result" && result.batch_id === PR_CREATION_BATCH_ID) {
    return processPrCreationResult(state, postSpecs, result);
  }

  // Idempotency guard AFTER result-processing: a replay after
  // post_specs.pr is already recorded (success OR degrade) must not
  // re-spawn — safe here (unlike pr_gate) because pr_creation is only ever
  // reached via an explicit pr_gate "yes" decision.
  if (postSpecs.pr) {
    return {
      state: { ...state, current_step: "finalize", post_specs: postSpecs },
      action: {
        kind: "emit_message",
        message: "PR outcome already recorded; proceeding to finalize.",
      },
    };
  }

  return emitPrCreationSpawn(state, postSpecs);
};
