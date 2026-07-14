/**
 * `post_impl_verification` — POST-implementation verification sequence
 * (design-phases-3-5.md §1, §3, §5, PR 3c). Four sequential
 * `call_pipeline_tool` round trips, in order:
 *
 *   1. `index_codebase`(worktree)   → produces the "after" graph
 *   2. `detect_changes`             → maps the diff to changed symbols
 *   3. `verify_semantic_diff`       → regression check, before vs. after graph
 *   4. `check_security_gates`       → consumes call 2's changed_symbols
 *
 * Tool contracts (source of truth: automatised-pipeline/src/tool_schemas.rs,
 * verified against automatised-pipeline/src/main.rs + src/git_diff.rs +
 * src/security_gates.rs, 2026-07-14):
 *   index_codebase (tool_schemas.rs:220 index_codebase_schema):
 *     inputs required: { path, output_dir }
 *     output:          { graph_path, ... } (main.rs do_index_codebase)
 *   detect_changes (tool_schemas.rs:689 detect_changes_schema):
 *     inputs required: { graph_path }; optional diff_text OR
 *                       codebase_path(+base_ref/head_ref)
 *     output:          { symbols_affected: [{qualified_name, change_type,
 *                        ...}], ... } (main.rs do_detect_changes,
 *                        git_diff.rs ChangedSymbol)
 *   verify_semantic_diff (tool_schemas.rs:671 verify_semantic_diff_schema):
 *     inputs required: { before_graph_path, after_graph_path }
 *   check_security_gates (tool_schemas.rs:653 check_security_gates_schema):
 *     inputs required: { graph_path, changed_symbols }
 *     output:          { gates_passed: bool, ... } (main.rs:3788,
 *                        security_gates.rs SecurityReport.gates_passed)
 *
 * `index_codebase` (not `analyze_codebase`) is used for call 1, per design §1:
 * "`index_codebase` (3a) is re-invoked once more in `post_impl_verification`
 * ... this is not a new tool, it is a second call to the already-wired one."
 * `verify_semantic_diff`/`check_security_gates` only need node/edge presence
 * to diff/match against, not the community/process clustering
 * `analyze_codebase` additionally computes.
 *
 * Result opaque passthrough: every AP payload is stored as
 * `z.record(z.string(), z.unknown())` (PostSpecsStateSchema convention,
 * matching `codebase_grounding`/`prd_validation`) — orchestration never
 * parses AP response shapes, EXCEPT the two fields this handler's own
 * contract with `testing`/`review` depends on:
 *   - `detect_changes.data.symbols_affected[].qualified_name` → extracted
 *     into `verification.changed_symbols` (call 4's required argument).
 *   - `check_security_gates.data.gates_passed` → extracted into
 *     `verification.gates_passed` (the boolean `review` gates on).
 *
 * Failure policy (design §4, "post_impl_verification" row): ANY of the 4
 * calls failing DEGRADES — record the failure via appendError
 * ("upstream_failure"), keep `gates_passed` at its fail-closed default
 * (false), and continue to `testing`/`review` with the failure surfaced.
 * Call 1 (`index_codebase`) failing is a special case: calls 2-4 all require
 * the "after" graph_path it produces, so a call-1 failure degrades the
 * WHOLE sequence (marks `step: "done"` immediately, skipping calls 2-4
 * rather than emitting 3 more calls guaranteed to fail for lack of a
 * graph_path) — still fail-closed on `gates_passed`, still reaches
 * `testing`.
 *
 * No-op condition (design §4, "no codebase" row): no `state.codebase_graph_path`
 * (nothing to diff against) or no `state.post_specs.implementation.worktree_path`
 * (implementation aborted before recording a worktree — see
 * implementation.ts's failure policy) → skip cleanly (emit_message,
 * `verification.step = "done"`), advance to `testing` — mirrors
 * `pre_impl_grounding`'s skip pattern.
 *
 * PR 4a reachability: `implementation` (PR 4a) is the only handler that
 * transitions `current_step` here, once it has recorded a parsed
 * branch/worktree_path. This handler is ALSO still unit-tested directly via
 * `current_step: "post_impl_verification"` injection (no change there).
 *
 * PR 4b wiring: `testing`/`review` now exist, so every path through this
 * sequence (success, degrade, or no-op) advances to `testing` — there is
 * nothing left to verify structurally once the 4-call sequence has settled;
 * `testing`/`review` run regardless of `gates_passed`, per design §4.
 *
 * Loop-guard placement (Phase 2 git-historian lesson, restated in design §3
 * and pre-impl-grounding.ts): result-processing for the CURRENT cursor step
 * is evaluated FIRST, before any "already done"/no-op guard, so a replayed
 * result is never dropped and the cursor never re-issues a call whose result
 * already arrived.
 *
 * §4.2 note: the top-level handler is a thin dispatcher over per-step
 * result-processors (process*Result) and per-step call-emitters (emit*Call) —
 * each under the 50-line function cap; the dispatcher itself only routes on
 * `verification.step` / `result.correlation_id`.
 */

import type { HandlerAction } from "../types/actions.js";
import type { StepHandler } from "../runner.js";
import { appendError, type PipelineState } from "../types/state.js";
import {
  initialPostSpecs,
  initialVerification,
  type PostSpecsState,
  type VerificationState,
} from "../types/state/post-specs-state.js";
import {
  POST_IMPL_INDEX_CODEBASE_CORRELATION_ID,
  POST_IMPL_DETECT_CHANGES_CORRELATION_ID,
  POST_IMPL_VERIFY_SEMANTIC_DIFF_CORRELATION_ID,
  POST_IMPL_CHECK_SECURITY_GATES_CORRELATION_ID,
} from "./protocol-ids.js";

type HandlerStep = { state: PipelineState; action: HandlerAction };

function ensurePostSpecs(state: PipelineState): PostSpecsState {
  return state.post_specs ?? initialPostSpecs();
}

function ensureVerification(postSpecs: PostSpecsState): VerificationState {
  return postSpecs.verification ?? initialVerification();
}

/**
 * precondition:  none — safe on any post_specs.
 * postcondition: the worktree path implementation wrote code into, or null
 *                when no `implementation` step has run (always true until
 *                PR 4a is wired).
 */
function worktreePath(postSpecs: PostSpecsState): string | null {
  return postSpecs.implementation?.worktree_path ?? null;
}

/**
 * precondition:  none.
 * postcondition: returns the deduplicated list of qualified names from a
 *                `detect_changes` result's `symbols_affected` array. Empty
 *                when the field is absent/malformed (defensive against an
 *                opaque AP payload the type system cannot narrow) rather
 *                than throwing — an unusable shape degrades to "no changed
 *                symbols" the same way a detect_changes call failure would.
 */
function extractChangedSymbols(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const symbolsAffected = (data as Record<string, unknown>).symbols_affected;
  if (!Array.isArray(symbolsAffected)) return [];
  const names = symbolsAffected
    .map((entry) =>
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>).qualified_name
        : undefined,
    )
    .filter((n): n is string => typeof n === "string");
  return Array.from(new Set(names));
}

/**
 * precondition:  none.
 * postcondition: true iff `data.gates_passed === true` (strict boolean
 *                check — any other shape/type fails closed to false,
 *                matching design §4's "fail-closed on the boolean").
 */
function extractGatesPassed(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  return (data as Record<string, unknown>).gates_passed === true;
}

function asRecord(data: unknown): Record<string, unknown> {
  return (data ?? {}) as Record<string, unknown>;
}

function advanceToTesting(
  state: PipelineState,
  postSpecs: PostSpecsState,
  verification: VerificationState,
  message: string,
): HandlerStep {
  return {
    state: {
      ...state,
      current_step: "testing",
      post_specs: { ...postSpecs, verification: { ...verification, step: "done" } },
    },
    action: { kind: "emit_message", message, level: "info" },
  };
}

function withVerification(
  state: PipelineState,
  postSpecs: PostSpecsState,
  verification: VerificationState,
  message: string,
): HandlerStep {
  return {
    state: { ...state, post_specs: { ...postSpecs, verification } },
    action: { kind: "emit_message", message },
  };
}

function deriveVerificationOutputDir(worktree: string, runId: string): string {
  // Mirrors input-analysis.ts's deriveOutputDir convention
  // (<codebase_path>/.prd-gen/graphs/<run_id>/), suffixed "-post-impl" so the
  // "after" graph never collides with the pre-implementation graph an
  // earlier run may have produced under the SAME run_id (both graphs can be
  // live simultaneously — verify_semantic_diff needs both).
  return `${worktree}/.prd-gen/graphs/${runId}-post-impl`;
}

// ─── Result processors (one per cursor step) ────────────────────────────────

function processIndexCodebaseResult(
  state: PipelineState,
  postSpecs: PostSpecsState,
  verification: VerificationState,
  result: Extract<import("../types/actions.js").ActionResult, { kind: "tool_result" }>,
): HandlerStep {
  if (!result.success) {
    // Calls 2-4 all require the after-graph this call was meant to produce;
    // degrading the WHOLE sequence avoids 3 more calls guaranteed to fail
    // for lack of a graph_path.
    const nextState = appendError(
      state,
      `index_codebase (post-impl) failed: ${result.error ?? "unknown"}; skipping post-impl verification`,
      "upstream_failure",
    );
    return advanceToTesting(
      nextState,
      postSpecs,
      { ...verification, after_graph_path: null, gates_passed: false },
      "Post-implementation verification degraded: could not index the implementation worktree.",
    );
  }
  const afterGraphPath = asRecord(result.data).graph_path as string | undefined;
  const nextVerification: VerificationState = {
    ...verification,
    step: "detect_changes",
    after_graph_path: afterGraphPath ?? null,
  };
  return withVerification(state, postSpecs, nextVerification, "Post-implementation graph indexed.");
}

function processDetectChangesResult(
  state: PipelineState,
  postSpecs: PostSpecsState,
  verification: VerificationState,
  result: Extract<import("../types/actions.js").ActionResult, { kind: "tool_result" }>,
): HandlerStep {
  let nextState = state;
  let changedSymbols: string[] = [];
  let detectChangesData: Record<string, unknown> | null = null;
  if (result.success) {
    detectChangesData = asRecord(result.data);
    changedSymbols = extractChangedSymbols(result.data);
  } else {
    nextState = appendError(
      nextState,
      `detect_changes failed: ${result.error ?? "unknown"}; continuing with no changed_symbols`,
      "upstream_failure",
    );
  }
  const nextVerification: VerificationState = {
    ...verification,
    step: "verify_semantic_diff",
    detect_changes: detectChangesData,
    changed_symbols: changedSymbols,
  };
  return withVerification(nextState, postSpecs, nextVerification, "Change detection complete.");
}

function processVerifySemanticDiffResult(
  state: PipelineState,
  postSpecs: PostSpecsState,
  verification: VerificationState,
  result: Extract<import("../types/actions.js").ActionResult, { kind: "tool_result" }>,
): HandlerStep {
  let nextState = state;
  let verifyDiffData: Record<string, unknown> | null = null;
  if (result.success) {
    verifyDiffData = asRecord(result.data);
  } else {
    nextState = appendError(
      nextState,
      `verify_semantic_diff failed: ${result.error ?? "unknown"}; continuing without regression data`,
      "upstream_failure",
    );
  }
  const nextVerification: VerificationState = {
    ...verification,
    step: "check_security_gates",
    verify_semantic_diff: verifyDiffData,
  };
  return withVerification(nextState, postSpecs, nextVerification, "Semantic-diff verification complete.");
}

function processCheckSecurityGatesResult(
  state: PipelineState,
  postSpecs: PostSpecsState,
  verification: VerificationState,
  result: Extract<import("../types/actions.js").ActionResult, { kind: "tool_result" }>,
): HandlerStep {
  let nextState = state;
  let securityGatesData: Record<string, unknown> | null = null;
  let gatesPassed = false;
  if (result.success) {
    securityGatesData = asRecord(result.data);
    gatesPassed = extractGatesPassed(result.data);
  } else {
    nextState = appendError(
      nextState,
      `check_security_gates failed: ${result.error ?? "unknown"}; gates_passed defaults to false (fail-closed)`,
      "upstream_failure",
    );
  }
  const nextVerification: VerificationState = {
    ...verification,
    check_security_gates: securityGatesData,
    gates_passed: gatesPassed,
  };
  return advanceToTesting(
    nextState,
    postSpecs,
    nextVerification,
    `Post-implementation verification complete: gates_passed=${gatesPassed}.`,
  );
}

/**
 * precondition:  `result` is a tool_result whose correlation_id matches the
 *                current `verification.step`'s expected call.
 * postcondition: routes to the matching processor, or null when no
 *                (step, correlation_id) pair matches — the caller falls
 *                through to call-emission.
 */
function processResult(
  state: PipelineState,
  postSpecs: PostSpecsState,
  verification: VerificationState,
  result: Extract<import("../types/actions.js").ActionResult, { kind: "tool_result" }>,
): HandlerStep | null {
  if (
    verification.step === "index_codebase" &&
    result.correlation_id === POST_IMPL_INDEX_CODEBASE_CORRELATION_ID
  ) {
    return processIndexCodebaseResult(state, postSpecs, verification, result);
  }
  if (
    verification.step === "detect_changes" &&
    result.correlation_id === POST_IMPL_DETECT_CHANGES_CORRELATION_ID
  ) {
    return processDetectChangesResult(state, postSpecs, verification, result);
  }
  if (
    verification.step === "verify_semantic_diff" &&
    result.correlation_id === POST_IMPL_VERIFY_SEMANTIC_DIFF_CORRELATION_ID
  ) {
    return processVerifySemanticDiffResult(state, postSpecs, verification, result);
  }
  if (
    verification.step === "check_security_gates" &&
    result.correlation_id === POST_IMPL_CHECK_SECURITY_GATES_CORRELATION_ID
  ) {
    return processCheckSecurityGatesResult(state, postSpecs, verification, result);
  }
  return null;
}

// ─── Call emitters (one per cursor step) ────────────────────────────────────

function emitIndexCodebaseCall(
  state: PipelineState,
  postSpecs: PostSpecsState,
  verification: VerificationState,
  worktree: string,
): HandlerStep {
  return {
    state: { ...state, post_specs: { ...postSpecs, verification } },
    action: {
      kind: "call_pipeline_tool",
      tool_name: "index_codebase",
      arguments: {
        path: worktree,
        output_dir: deriveVerificationOutputDir(worktree, state.run_id),
      },
      correlation_id: POST_IMPL_INDEX_CODEBASE_CORRELATION_ID,
    },
  };
}

function emitDetectChangesCall(
  state: PipelineState,
  postSpecs: PostSpecsState,
  verification: VerificationState,
  worktree: string,
): HandlerStep {
  const args: Record<string, unknown> = {
    graph_path: verification.after_graph_path,
    codebase_path: worktree,
  };
  if (postSpecs.implementation?.branch) {
    args.head_ref = postSpecs.implementation.branch;
  }
  return {
    state: { ...state, post_specs: { ...postSpecs, verification } },
    action: {
      kind: "call_pipeline_tool",
      tool_name: "detect_changes",
      arguments: args,
      correlation_id: POST_IMPL_DETECT_CHANGES_CORRELATION_ID,
    },
  };
}

function emitVerifySemanticDiffCall(
  state: PipelineState,
  postSpecs: PostSpecsState,
  verification: VerificationState,
  beforeGraphPath: string,
): HandlerStep {
  return {
    state: { ...state, post_specs: { ...postSpecs, verification } },
    action: {
      kind: "call_pipeline_tool",
      tool_name: "verify_semantic_diff",
      arguments: {
        before_graph_path: beforeGraphPath,
        after_graph_path: verification.after_graph_path,
      },
      correlation_id: POST_IMPL_VERIFY_SEMANTIC_DIFF_CORRELATION_ID,
    },
  };
}

function emitCheckSecurityGatesCall(
  state: PipelineState,
  postSpecs: PostSpecsState,
  verification: VerificationState,
): HandlerStep {
  return {
    state: { ...state, post_specs: { ...postSpecs, verification } },
    action: {
      kind: "call_pipeline_tool",
      tool_name: "check_security_gates",
      arguments: {
        graph_path: verification.after_graph_path,
        changed_symbols: verification.changed_symbols,
      },
      correlation_id: POST_IMPL_CHECK_SECURITY_GATES_CORRELATION_ID,
    },
  };
}

/**
 * precondition:  `beforeGraphPath`/`worktree` are non-null (caller's no-op
 *                guard already ran).
 * postcondition: the call_pipeline_tool action for the current
 *                `verification.step`, or the finalize dead-end for "done".
 */
function emitCallForStep(
  state: PipelineState,
  postSpecs: PostSpecsState,
  verification: VerificationState,
  worktree: string,
  beforeGraphPath: string,
): HandlerStep {
  switch (verification.step) {
    case "index_codebase":
      return emitIndexCodebaseCall(state, postSpecs, verification, worktree);
    case "detect_changes":
      return emitDetectChangesCall(state, postSpecs, verification, worktree);
    case "verify_semantic_diff":
      return emitVerifySemanticDiffCall(state, postSpecs, verification, beforeGraphPath);
    case "check_security_gates":
      return emitCheckSecurityGatesCall(state, postSpecs, verification);
    case "done":
      return advanceToTesting(
        state,
        postSpecs,
        verification,
        `Post-implementation verification complete: gates_passed=${verification.gates_passed}.`,
      );
  }
}

export const handlePostImplVerification: StepHandler = ({ state, result }) => {
  const postSpecs = ensurePostSpecs(state);
  const verification = ensureVerification(postSpecs);
  const worktree = worktreePath(postSpecs);
  const beforeGraphPath = state.codebase_graph_path;

  // Result-processing FIRST (Phase 2 git-historian loop-ordering lesson;
  // restated in pre-impl-grounding.ts and design §3).
  if (result?.kind === "tool_result") {
    const processed = processResult(state, postSpecs, verification, result);
    if (processed) return processed;
  }

  // No-op: no "before" graph, or no implementation worktree (PR 4a not
  // wired — always true on the current step graph) → skip cleanly.
  if (!beforeGraphPath || !worktree) {
    return advanceToTesting(
      state,
      postSpecs,
      verification,
      "No implementation worktree available; skipping post-implementation verification.",
    );
  }

  return emitCallForStep(state, postSpecs, verification, worktree, beforeGraphPath);
};
