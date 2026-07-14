/**
 * `post_impl_verification` — POST-implementation verification sequence
 * (design-phases-3-5.md §1, §3, §4, §5, PR 3c wiring, PR 4a reachability).
 *
 * Proves:
 *   1. No `codebase_graph_path` or no `implementation.worktree_path` → skips
 *      cleanly, advances to `finalize` (no call_pipeline_tool).
 *   2. Nominal sequence: exactly 4 call_pipeline_tool round trips, in order
 *      (index_codebase → detect_changes → verify_semantic_diff →
 *      check_security_gates), each with the exact argument shape the AP tool
 *      schema requires.
 *   3. `detect_changes`'s `symbols_affected[].qualified_name` is extracted
 *      into `verification.changed_symbols`, which `check_security_gates`'s
 *      call then carries as its `changed_symbols` argument.
 *   4. `check_security_gates`'s `gates_passed` is extracted into
 *      `verification.gates_passed`.
 *   5. A failure at each of the 4 calls DEGRADES: gates_passed stays
 *      fail-closed (false), an upstream_failure error is appended, and the
 *      run still reaches `finalize` (index_codebase failure short-circuits
 *      calls 2-4; the other 3 failures degrade in place and continue the
 *      sequence).
 *   6. This handler is registered AND (as of PR 4a) reachable via a full
 *      smoke run: `implementation_gate` → `pre_impl_grounding` →
 *      `implementation` → `post_impl_verification` → `finalize`. A full
 *      smoke run through the "Implement" branch with a nominal engineer
 *      report DOES emit index_codebase/detect_changes/verify_semantic_diff/
 *      check_security_gates and DOES set current_step to
 *      "post_impl_verification" along the way.
 *
 * source: design-phases-3-5.md §1, §3, §4, §5.
 */

import { describe, expect, it } from "vitest";
import {
  makeCannedDispatcher,
  newPipelineState,
  step,
  type ActionResult,
  type PipelineState,
} from "../index.js";

const IDX_CID = "post_impl_verification_index_codebase";
const DETECT_CID = "post_impl_verification_detect_changes";
const DIFF_CID = "post_impl_verification_verify_semantic_diff";
const GATES_CID = "post_impl_verification_check_security_gates";

function stateAtVerification(opts: {
  graphPath?: string | null;
  worktreePath?: string | null;
  branch?: string;
}): PipelineState {
  const s = newPipelineState({
    run_id: "post_impl_001",
    feature_description: "OAuth login",
  });
  return {
    ...s,
    current_step: "post_impl_verification",
    codebase_graph_path: opts.graphPath ?? null,
    // Every dead-end this handler reaches advances to `finalize`, which
    // throws if `pending_completion` is null (handleFinalize's own
    // precondition) — set it so degrade/skip paths reach `done` instead of
    // masking the assertion under finalize's thrown-exception "structural"
    // error (mirrors implementation-gate.test.ts's stateAtGate fixture).
    pending_completion: {
      summary: "Self-check complete. 3/3 sections passed.",
      artifacts: ["overview: passed"],
    },
    post_specs: {
      decision: "implement",
      impact_queries: { done: true, index: 0, results: [] },
      implementation:
        opts.worktreePath === null
          ? null
          : {
              branch: opts.branch ?? "feat/x",
              worktree_path: opts.worktreePath ?? "/tmp/worktree",
              changed_files: [],
              raw_report: "engineer report",
            },
      verification: null,
      testing: null,
      review: null,
      pr: null,
      retry_count: 0,
    },
  };
}

describe("post_impl_verification — clean skip conditions", () => {
  it("no codebase_graph_path → skips to finalize without a call_pipeline_tool", () => {
    const out = step({
      state: stateAtVerification({ graphPath: null, worktreePath: "/tmp/worktree" }),
    });
    expect(out.action.kind).not.toBe("call_pipeline_tool");
    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.verification?.step).toBe("done");
  });

  it("no implementation.worktree_path (implementation not wired / not run) → skips even with a graph", () => {
    const out = step({
      state: stateAtVerification({ graphPath: "/g/before", worktreePath: null }),
    });
    expect(out.action.kind).not.toBe("call_pipeline_tool");
    expect(out.state.current_step).toBe("finalize");
  });
});

describe("post_impl_verification — nominal 4-call sequence", () => {
  it("emits index_codebase → detect_changes → verify_semantic_diff → check_security_gates, in order, then finalize", () => {
    let state = stateAtVerification({
      graphPath: "/g/before",
      worktreePath: "/tmp/wt",
      branch: "feat/oauth",
    });

    // Call 1: index_codebase
    const step1 = step({ state });
    expect(step1.action.kind).toBe("call_pipeline_tool");
    if (step1.action.kind !== "call_pipeline_tool") return;
    expect(step1.action.tool_name).toBe("index_codebase");
    expect(step1.action.arguments.path).toBe("/tmp/wt");
    expect(step1.action.arguments.output_dir).toBe(
      "/tmp/wt/.prd-gen/graphs/post_impl_001-post-impl",
    );
    expect(step1.action.correlation_id).toBe(IDX_CID);
    state = step1.state;

    const step2 = step({
      state,
      result: {
        kind: "tool_result",
        correlation_id: IDX_CID,
        success: true,
        data: { graph_path: "/g/after", symbols_indexed: 10, files_parsed: 3, duration_ms: 5 },
      },
    });
    expect(state.current_step).toBe("post_impl_verification");
    expect(step2.state.post_specs?.verification?.after_graph_path).toBe("/g/after");

    // Call 2: detect_changes
    expect(step2.action.kind).toBe("call_pipeline_tool");
    if (step2.action.kind !== "call_pipeline_tool") return;
    expect(step2.action.tool_name).toBe("detect_changes");
    expect(step2.action.arguments).toEqual({
      graph_path: "/g/after",
      codebase_path: "/tmp/wt",
      head_ref: "feat/oauth",
    });
    expect(step2.action.correlation_id).toBe(DETECT_CID);
    state = step2.state;

    const step3 = step({
      state,
      result: {
        kind: "tool_result",
        correlation_id: DETECT_CID,
        success: true,
        data: {
          symbols_affected: [
            { qualified_name: "src/auth.ts::login", change_type: "modified" },
            { qualified_name: "src/auth.ts::login", change_type: "modified" }, // dup
            { qualified_name: "src/auth.ts::logout", change_type: "added" },
          ],
        },
      },
    });
    expect(step3.state.post_specs?.verification?.changed_symbols).toEqual([
      "src/auth.ts::login",
      "src/auth.ts::logout",
    ]);

    // Call 3: verify_semantic_diff
    expect(step3.action.kind).toBe("call_pipeline_tool");
    if (step3.action.kind !== "call_pipeline_tool") return;
    expect(step3.action.tool_name).toBe("verify_semantic_diff");
    expect(step3.action.arguments).toEqual({
      before_graph_path: "/g/before",
      after_graph_path: "/g/after",
    });
    expect(step3.action.correlation_id).toBe(DIFF_CID);
    state = step3.state;

    const step4 = step({
      state,
      result: {
        kind: "tool_result",
        correlation_id: DIFF_CID,
        success: true,
        data: { regression_score: 0.2, status: "clean" },
      },
    });

    // Call 4: check_security_gates
    expect(step4.action.kind).toBe("call_pipeline_tool");
    if (step4.action.kind !== "call_pipeline_tool") return;
    expect(step4.action.tool_name).toBe("check_security_gates");
    expect(step4.action.arguments).toEqual({
      graph_path: "/g/after",
      changed_symbols: ["src/auth.ts::login", "src/auth.ts::logout"],
    });
    expect(step4.action.correlation_id).toBe(GATES_CID);
    state = step4.state;

    const finalOut = step({
      state,
      result: {
        kind: "tool_result",
        correlation_id: GATES_CID,
        success: true,
        data: { gates_passed: true, flags: [] },
      },
    });

    expect(finalOut.state.current_step).toBe("finalize");
    expect(finalOut.state.post_specs?.verification?.step).toBe("done");
    expect(finalOut.state.post_specs?.verification?.gates_passed).toBe(true);
    expect(finalOut.state.post_specs?.verification?.check_security_gates).toEqual({
      gates_passed: true,
      flags: [],
    });
    expect(finalOut.action.kind).not.toBe("call_pipeline_tool");
  });
});

describe("post_impl_verification — failure policy per call (degrade, fail-closed)", () => {
  it("index_codebase failure short-circuits calls 2-4, degrades to finalize, gates_passed stays false", () => {
    const seed = stateAtVerification({ graphPath: "/g/before", worktreePath: "/tmp/wt" });
    const issued = step({ state: seed });
    if (issued.action.kind !== "call_pipeline_tool") throw new Error("expected call");

    const out = step({
      state: issued.state,
      result: {
        kind: "tool_result",
        correlation_id: IDX_CID,
        success: false,
        data: null,
        error: "disk full",
      },
    });

    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.verification?.step).toBe("done");
    expect(out.state.post_specs?.verification?.gates_passed).toBe(false);
    expect(out.state.post_specs?.verification?.after_graph_path).toBeNull();
    expect(out.state.errors.some((e) => e.includes("index_codebase (post-impl) failed"))).toBe(
      true,
    );
    expect(out.state.error_kinds[out.state.errors.length - 1]).toBe("upstream_failure");
    expect(out.action.kind).not.toBe("call_pipeline_tool");
  });

  it("detect_changes failure degrades: continues to verify_semantic_diff with empty changed_symbols", () => {
    let state = stateAtVerification({ graphPath: "/g/before", worktreePath: "/tmp/wt" });
    const step1 = step({ state });
    if (step1.action.kind !== "call_pipeline_tool") throw new Error("expected call 1");
    state = step({
      state: step1.state,
      result: {
        kind: "tool_result",
        correlation_id: IDX_CID,
        success: true,
        data: { graph_path: "/g/after" },
      },
    }).state;

    const step2 = step({ state });
    if (step2.action.kind !== "call_pipeline_tool") throw new Error("expected call 2");
    const out = step({
      state: step2.state,
      result: {
        kind: "tool_result",
        correlation_id: DETECT_CID,
        success: false,
        data: null,
        error: "graph not found",
      },
    });

    expect(out.state.post_specs?.verification?.changed_symbols).toEqual([]);
    expect(out.state.post_specs?.verification?.step).toBe("verify_semantic_diff");
    expect(out.state.errors.some((e) => e.includes("detect_changes failed"))).toBe(true);
    expect(out.action.kind).toBe("call_pipeline_tool");
    if (out.action.kind !== "call_pipeline_tool") return;
    expect(out.action.tool_name).toBe("verify_semantic_diff");
  });

  it("verify_semantic_diff failure degrades: continues to check_security_gates", () => {
    let state = stateAtVerification({ graphPath: "/g/before", worktreePath: "/tmp/wt" });
    state = step({
      state: step({ state }).state,
      result: { kind: "tool_result", correlation_id: IDX_CID, success: true, data: { graph_path: "/g/after" } },
    }).state;
    state = step({
      state: step({ state }).state,
      result: { kind: "tool_result", correlation_id: DETECT_CID, success: true, data: { symbols_affected: [] } },
    }).state;

    const step3 = step({ state });
    if (step3.action.kind !== "call_pipeline_tool") throw new Error("expected call 3");
    const out = step({
      state: step3.state,
      result: {
        kind: "tool_result",
        correlation_id: DIFF_CID,
        success: false,
        data: null,
        error: "before graph missing",
      },
    });

    expect(out.state.post_specs?.verification?.step).toBe("check_security_gates");
    expect(out.state.errors.some((e) => e.includes("verify_semantic_diff failed"))).toBe(true);
    expect(out.action.kind).toBe("call_pipeline_tool");
    if (out.action.kind !== "call_pipeline_tool") return;
    expect(out.action.tool_name).toBe("check_security_gates");
  });

  it("check_security_gates failure degrades: gates_passed stays false (fail-closed), reaches finalize", () => {
    let state = stateAtVerification({ graphPath: "/g/before", worktreePath: "/tmp/wt" });
    state = step({
      state: step({ state }).state,
      result: { kind: "tool_result", correlation_id: IDX_CID, success: true, data: { graph_path: "/g/after" } },
    }).state;
    state = step({
      state: step({ state }).state,
      result: { kind: "tool_result", correlation_id: DETECT_CID, success: true, data: { symbols_affected: [] } },
    }).state;
    state = step({
      state: step({ state }).state,
      result: { kind: "tool_result", correlation_id: DIFF_CID, success: true, data: {} },
    }).state;

    const step4 = step({ state });
    if (step4.action.kind !== "call_pipeline_tool") throw new Error("expected call 4");
    const out = step({
      state: step4.state,
      result: {
        kind: "tool_result",
        correlation_id: GATES_CID,
        success: false,
        data: null,
        error: "graph missing",
      },
    });

    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.verification?.step).toBe("done");
    expect(out.state.post_specs?.verification?.gates_passed).toBe(false);
    expect(out.state.errors.some((e) => e.includes("check_security_gates failed"))).toBe(true);
    expect(out.action.kind).not.toBe("call_pipeline_tool");
  });
});

describe("post_impl_verification — idempotence (replay before result arrives)", () => {
  it("re-invoking step() with no new result re-issues the SAME call (same correlation_id)", () => {
    const seed = stateAtVerification({ graphPath: "/g/before", worktreePath: "/tmp/wt" });
    const first = step({ state: seed });
    const replay = step({ state: first.state });

    expect(first.action).toEqual(replay.action);
    expect(replay.state.post_specs?.verification?.step).toBe(
      first.state.post_specs?.verification?.step,
    );
  });
});

describe("post_impl_verification — reachable from the runner graph (PR 4a wiring)", () => {
  /**
   * `implementation` (PR 4a) is now the handler that transitions
   * `current_step` to "post_impl_verification", once it has recorded a
   * parsed branch/worktree_path from the engineer's report. A full smoke
   * run through the "Implement" branch, with a nominal (parsable) canned
   * engineer report, must reach this step and emit all 4 AP tool calls this
   * handler owns.
   */
  it("a full smoke run reaches post_impl_verification and emits index_codebase/detect_changes/verify_semantic_diff/check_security_gates", () => {
    const dispatch = makeCannedDispatcher({
      implementation_gate_answer: "Implement",
      graph_path: "/tmp/smoke-post-impl/.prd-gen/graphs/smoke/graph",
    });
    const seed = newPipelineState({
      run_id: "smoke_post_impl_reachable",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/smoke-post-impl",
    });

    let state: PipelineState = seed;
    let pendingResult: ActionResult | undefined = undefined;
    const observedToolNames: string[] = [];
    const observedSteps: string[] = [];
    const SAFETY_CAP = 200;

    for (let i = 0; i < SAFETY_CAP; i++) {
      const out = step({ state, result: pendingResult });
      state = out.state;
      observedSteps.push(state.current_step);
      if (out.action.kind === "call_pipeline_tool") {
        observedToolNames.push(out.action.tool_name);
      }
      if (out.action.kind === "done" || out.action.kind === "failed") break;
      pendingResult = dispatch(out.action);
      if (pendingResult === undefined) {
        throw new Error(`no canned result for action.kind=${out.action.kind}`);
      }
    }

    expect(observedSteps).toContain("post_impl_verification");
    expect(observedToolNames).toContain("index_codebase");
    expect(observedToolNames).toContain("detect_changes");
    expect(observedToolNames).toContain("verify_semantic_diff");
    expect(observedToolNames).toContain("check_security_gates");
    expect(state.current_step).toBe("complete");
    expect(state.post_specs?.verification?.gates_passed).toBe(true);
  });
});
