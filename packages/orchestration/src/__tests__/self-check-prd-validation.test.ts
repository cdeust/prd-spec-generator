/**
 * Self-check Phase 0 — PRD-vs-graph validation emission + merge.
 *
 * Proves the refactor of self-check.ts:
 *   1. When a code graph exists and the PRD was exported, self_check emits a
 *      call_pipeline_tool[validate_prd_against_graph] BEFORE the judge phase.
 *   2. The tool_result is merged into the existing `done.verification` surface
 *      under `prd_graph_validation` (no new top-level shape).
 *   3. With no codebase_graph_path, NO AP call is emitted (backward-compatible)
 *      and `done.verification` has no prd_graph_validation field.
 *
 * Drives the handler directly through the public step() API from a state
 * positioned at current_step === "self_check" with files already written —
 * the same position the runner reaches after file_export.
 *
 * source: AP validate_prd_against_graph contract (shipped 2026-06).
 */

import { describe, it, expect } from "vitest";
import { newPipelineState, step, type PipelineState } from "../index.js";

/** Must match self-check.ts:VALIDATE_PRD_CORRELATION_ID. */
const VALIDATE_PRD_CORRELATION_ID = "self_check_validate_prd_against_graph";

function stateAtSelfCheck(opts: {
  graphPath: string | null;
  prdPath?: string;
}): PipelineState {
  const s = newPipelineState({
    run_id: "selfcheck_validate_001",
    feature_description: "OAuth login",
  });
  const prdPath = opts.prdPath ?? "prd-output/selfchec/01-prd.md";
  return {
    ...s,
    current_step: "self_check",
    prd_context: "feature",
    codebase_graph_path: opts.graphPath,
    // Empty sections → judge phase short-circuits to finalize (done) on the
    // fast path, so the test isolates the validation phase.
    sections: [],
    written_files: [prdPath, "prd-output/selfchec/02-data-model.md"],
  };
}

describe("self-check PRD-vs-graph validation (Phase 0)", () => {
  it("emits validate_prd_against_graph with the exported PRD path + graph_path", () => {
    const s = stateAtSelfCheck({ graphPath: "/g/graph" });
    const out = step({ state: s });

    expect(out.action.kind).toBe("call_pipeline_tool");
    if (out.action.kind === "call_pipeline_tool") {
      expect(out.action.tool_name).toBe("validate_prd_against_graph");
      expect(out.action.correlation_id).toBe(VALIDATE_PRD_CORRELATION_ID);
      expect(out.action.arguments).toHaveProperty(
        "prd_path",
        "prd-output/selfchec/01-prd.md",
      );
      expect(out.action.arguments).toHaveProperty("graph_path", "/g/graph");
      // finding is optional in the new contract — must NOT be sent.
      expect(out.action.arguments).not.toHaveProperty("finding");
      expect(out.action.arguments).not.toHaveProperty("finding_id");
    }
    // Not yet validated — the flag flips only on the result.
    expect(out.state.prd_validated).toBe(false);
  });

  it("merges the validation report into done.verification.prd_graph_validation", () => {
    const issued = step({ state: stateAtSelfCheck({ graphPath: "/g/graph" }) });
    const cid =
      issued.action.kind === "call_pipeline_tool"
        ? issued.action.correlation_id
        : "";
    const report = {
      hallucinated_symbols: ["Foo.bar"],
      community_inconsistencies: [],
      unverified_impact_claims: [],
      verdict: "warn",
    };
    const after = step({
      state: issued.state,
      result: {
        kind: "tool_result",
        correlation_id: cid,
        success: true,
        data: report,
      },
    });

    expect(after.state.prd_validated).toBe(true);
    expect(after.state.prd_validation).toEqual(report);
    // Empty sections → judge phase short-circuits to done.
    expect(after.action.kind).toBe("done");
    if (after.action.kind === "done") {
      expect(after.action.verification?.prd_graph_validation).toEqual(report);
    }
  });

  it("validation failure is advisory — self-check still completes, no report attached", () => {
    const issued = step({ state: stateAtSelfCheck({ graphPath: "/g/graph" }) });
    const cid =
      issued.action.kind === "call_pipeline_tool"
        ? issued.action.correlation_id
        : "";
    const after = step({
      state: issued.state,
      result: {
        kind: "tool_result",
        correlation_id: cid,
        success: false,
        data: null,
        error: "graph not found",
      },
    });

    expect(after.state.prd_validated).toBe(true);
    expect(after.state.prd_validation).toBeNull();
    expect(after.action.kind).toBe("done");
    if (after.action.kind === "done") {
      expect(after.action.verification?.prd_graph_validation).toBeUndefined();
    }
    expect(
      after.state.errors.some((e) =>
        e.includes("validate_prd_against_graph failed"),
      ),
    ).toBe(true);
  });

  it("no graph_path → no AP call, no prd_graph_validation (backward-compatible)", () => {
    const s = stateAtSelfCheck({ graphPath: null });
    const out = step({ state: s });

    // Skips straight past validation into the judge phase → done.
    expect(out.action.kind).toBe("done");
    if (out.action.kind === "done") {
      expect(out.action.verification?.prd_graph_validation).toBeUndefined();
    }
    expect(out.state.prd_validated).toBe(true);
    expect(out.state.prd_validation).toBeNull();
  });
});

describe("self-check — affected_symbols_path argument (stage-6.md §4.2/§6.1)", () => {
  it("attaches affected_symbols_path when file-export produced the sidecar", () => {
    const s: PipelineState = {
      ...stateAtSelfCheck({ graphPath: "/g/graph" }),
      affected_symbols_path:
        "prd-output/selfchec/stage-5.affected_symbols.json",
    };
    const out = step({ state: s });

    expect(out.action.kind).toBe("call_pipeline_tool");
    if (out.action.kind === "call_pipeline_tool") {
      expect(out.action.arguments).toHaveProperty(
        "affected_symbols_path",
        "prd-output/selfchec/stage-5.affected_symbols.json",
      );
    }
  });

  it("omits affected_symbols_path when no sidecar was exported (lets AP's regex fallback fire)", () => {
    const s: PipelineState = {
      ...stateAtSelfCheck({ graphPath: "/g/graph" }),
      affected_symbols_path: null,
    };
    const out = step({ state: s });

    expect(out.action.kind).toBe("call_pipeline_tool");
    if (out.action.kind === "call_pipeline_tool") {
      expect(out.action.arguments).not.toHaveProperty("affected_symbols_path");
    }
  });
});
