/**
 * input_analysis Phase 2 — git-historian investigation.
 *
 * Proves:
 *   1. When codebase_path is set, once prd_input_prepared settles (success
 *      OR advisory failure), input_analysis emits spawn_subagents for
 *      zetetic-team-subagents:git-historian BEFORE advancing to
 *      feasibility_gate.
 *   2. A successful investigation stores git_history_summary (truncated
 *      defensively) and sets git_history_done, then advances.
 *   3. A subagent error, or an empty/missing raw_text response, is tolerated:
 *      git_history_summary = "" (covers the "not a git repository" case,
 *      which the SUBAGENT determines and reports as prose — this pure
 *      reducer never inspects the filesystem itself), an upstream_failure
 *      error is recorded, git_history_done is set, and the run proceeds.
 *   4. When codebase_path is absent, git-historian NEVER fires — the run
 *      proceeds straight through input_analysis with git_history_done left
 *      false and git_history_summary left null.
 *   5. Replay (git_history_done already true) skips straight to
 *      feasibility_gate — the investigation fires exactly once per run.
 *
 * source: Phase 2 (2026-07-14) — git-historian stage.
 */

import { describe, expect, it } from "vitest";
import { newPipelineState, step, type PipelineState } from "../index.js";

/** Must match protocol-ids.ts:GIT_HISTORY_INV_ID (batch_id AND invocation_id). */
const GIT_HISTORY_INV_ID = "input_analysis_git_history";

function stateReadyForGitHistory(codebasePath: string): PipelineState {
  const s = newPipelineState({
    run_id: "git_history_001",
    feature_description: "build OAuth login",
    codebase_path: codebasePath,
    skip_preflight: true,
  });
  // Position state as if global recall, gitignore write, analyze_codebase,
  // and prepare_prd_input have all already resolved this run — the ONLY
  // remaining gate before feasibility_gate is git-historian.
  return {
    ...s,
    current_step: "input_analysis",
    prd_context: "feature",
    global_recall_done: true,
    codebase_gitignore_written: true,
    codebase_indexed: true,
    codebase_graph_path: "/tmp/git-history-fixture/graph",
    codebase_output_dir: "/tmp/git-history-fixture/graphs/git_history_001",
    prd_input_prepared: true,
  };
}

describe("input_analysis Phase 2 — git-historian (nominal)", () => {
  it("emits spawn_subagents for git-historian once prd_input_prepared settles, before feasibility_gate", () => {
    const s = stateReadyForGitHistory("/tmp/git-history-fixture");
    const out = step({ state: s });

    expect(out.action.kind).toBe("spawn_subagents");
    if (out.action.kind !== "spawn_subagents") return;
    expect(out.action.batch_id).toBe(GIT_HISTORY_INV_ID);
    expect(out.action.invocations).toHaveLength(1);
    expect(out.action.invocations[0].invocation_id).toBe(GIT_HISTORY_INV_ID);
    expect(out.action.invocations[0].subagent_type).toBe(
      "zetetic-team-subagents:git-historian",
    );
    // Observability-only label (SpawnSubagentsActionSchema doc) — must be
    // one of the schema's three enumerated values.
    expect(out.action.purpose).toBe("review");
    expect(out.action.invocations[0].prompt).toContain(
      "/tmp/git-history-fixture",
    );
    expect(out.action.invocations[0].prompt).toContain("build OAuth login");
    expect(out.state.git_history_done).toBe(false);
    expect(out.state.current_step).toBe("input_analysis");
  });

  it("successful investigation stores the report and advances to feasibility_gate", () => {
    const issued = step({ state: stateReadyForGitHistory("/tmp/git-history-2") });
    const batch_id =
      issued.action.kind === "spawn_subagents" ? issued.action.batch_id : "";
    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [
          {
            invocation_id: GIT_HISTORY_INV_ID,
            raw_text:
              "Commit a1b2c3d introduced the auth module; no prior attempts found.",
          },
        ],
      },
    });

    expect(out.state.git_history_done).toBe(true);
    expect(out.state.git_history_summary).toBe(
      "Commit a1b2c3d introduced the auth module; no prior attempts found.",
    );
    expect(out.state.current_step).toBe("clarification");
    expect(out.action.kind).toBe("spawn_subagents"); // clarification's compose spawn
    expect(out.state.errors.length).toBe(0);
  });

  it("defensively truncates an oversized report (GIT_HISTORY_TRUNCATE_CHARS)", () => {
    const issued = step({ state: stateReadyForGitHistory("/tmp/git-history-3") });
    const batch_id =
      issued.action.kind === "spawn_subagents" ? issued.action.batch_id : "";
    const oversized = "x".repeat(5_000);
    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [{ invocation_id: GIT_HISTORY_INV_ID, raw_text: oversized }],
      },
    });

    expect(out.state.git_history_summary!.length).toBeLessThan(5_000);
    expect(out.state.git_history_summary!.endsWith("...")).toBe(true);
    expect(out.state.git_history_done).toBe(true);
  });

  it("replay (git_history_done already true) skips straight to feasibility_gate", () => {
    const s: PipelineState = {
      ...stateReadyForGitHistory("/tmp/git-history-4"),
      git_history_done: true,
      git_history_summary: "prior report",
    };
    const out = step({ state: s });
    expect(out.state.current_step).toBe("clarification");
  });
});

describe("input_analysis Phase 2 — git-historian (not a git repo / empty report)", () => {
  it("subagent reports 'not a git repository' as prose — treated as a normal (non-empty) summary", () => {
    // The handler is a pure reducer with no filesystem/git access — it never
    // determines "is this a git repo" itself. That determination is entirely
    // the subagent's; when it reports so in prose, the handler stores it
    // like any other report and proceeds without failing the run.
    const issued = step({ state: stateReadyForGitHistory("/tmp/not-a-repo") });
    const batch_id =
      issued.action.kind === "spawn_subagents" ? issued.action.batch_id : "";
    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [
          {
            invocation_id: GIT_HISTORY_INV_ID,
            raw_text: "/tmp/not-a-repo is not inside a git repository.",
          },
        ],
      },
    });

    expect(out.state.git_history_done).toBe(true);
    expect(out.state.git_history_summary).toBe(
      "/tmp/not-a-repo is not inside a git repository.",
    );
    expect(out.state.errors.length).toBe(0);
    expect(out.state.current_step).toBe("clarification");
  });

  it("empty/missing raw_text is tolerated: summary '', upstream_failure recorded, run proceeds", () => {
    const issued = step({ state: stateReadyForGitHistory("/tmp/git-history-5") });
    const batch_id =
      issued.action.kind === "spawn_subagents" ? issued.action.batch_id : "";
    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [{ invocation_id: GIT_HISTORY_INV_ID, raw_text: "" }],
      },
    });

    expect(out.state.git_history_done).toBe(true);
    expect(out.state.git_history_summary).toBe("");
    expect(
      out.state.errors.some((e) => e.includes("git-historian investigation failed")),
    ).toBe(true);
    expect(out.state.error_kinds[out.state.errors.length - 1]).toBe(
      "upstream_failure",
    );
    expect(out.action.kind).not.toBe("failed");
    expect(out.state.current_step).toBe("clarification");
  });
});

describe("input_analysis Phase 2 — git-historian (subagent failure)", () => {
  it("explicit subagent error: records upstream_failure, still proceeds, never blocks the run", () => {
    const issued = step({ state: stateReadyForGitHistory("/tmp/git-history-6") });
    const batch_id =
      issued.action.kind === "spawn_subagents" ? issued.action.batch_id : "";
    const out = step({
      state: issued.state,
      result: {
        kind: "subagent_batch_result",
        batch_id,
        responses: [
          { invocation_id: GIT_HISTORY_INV_ID, error: "subagent crashed" },
        ],
      },
    });

    expect(out.state.git_history_done).toBe(true);
    expect(out.state.git_history_summary).toBe("");
    expect(
      out.state.errors.some((e) => e.includes("subagent crashed")),
    ).toBe(true);
    expect(out.state.error_kinds[out.state.errors.length - 1]).toBe(
      "upstream_failure",
    );
    expect(out.action.kind).not.toBe("failed");
    expect(out.state.current_step).toBe("clarification");
  });
});

describe("input_analysis Phase 2 — git-historian (no codebase_path)", () => {
  it("never fires when codebase_path is absent — run proceeds without any git-historian round trip", () => {
    const s = newPipelineState({
      run_id: "git_history_no_codebase",
      feature_description: "build OAuth login",
      codebase_path: null,
      skip_preflight: true,
    });
    const positioned: PipelineState = {
      ...s,
      current_step: "input_analysis",
      prd_context: "feature",
      global_recall_done: true,
    };
    const out = step({ state: positioned });

    expect(out.state.git_history_done).toBe(false);
    expect(out.state.git_history_summary).toBeNull();
    // No codebase → input_analysis skips straight through to
    // feasibility_gate → clarification's first substantive action, exactly
    // as it did before Phase 2 (no git-historian round trip is inserted).
    expect(out.state.current_step).toBe("clarification");
    expect(out.action.kind).not.toBe("failed");
  });
});
