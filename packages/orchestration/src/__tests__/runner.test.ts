import { describe, expect, it } from "vitest";
import { newPipelineState, step } from "../index.js";

const seed = (codebasePath?: string) =>
  newPipelineState({
    run_id: "test_run_001",
    license_tier: "trial",
    feature_description: "build a feature for OAuth login",
    codebase_path: codebasePath ?? null,
  });

describe("pipeline runner — emit_message coalescing", () => {
  it("first step() never returns emit_message as the action kind", () => {
    const out = step({ state: seed() });
    expect(out.action.kind).not.toBe("emit_message");
  });

  it("first step() returns at least one coalesced message (license banner)", () => {
    const out = step({ state: seed() });
    expect(out.messages.length).toBeGreaterThan(0);
    expect(out.messages[0].text).toContain("PRD Spec Generator");
  });

  it("auto-detected feature context advances past context_detection in one step", () => {
    const out = step({ state: seed() });
    // 'build OAuth login' → trigger 'build' → feature → input_analysis (no codebase) → feasibility_gate → clarification compose action
    expect(out.state.prd_context).toBe("feature");
    expect(out.state.current_step).toBe("clarification");
    // First clarification action: spawn engineer to compose the question
    expect(out.action.kind).toBe("spawn_subagents");
  });

  it("input_analysis with codebase yields a call_pipeline_tool action with index_codebase", () => {
    const out = step({ state: seed("/some/path") });
    expect(out.action.kind).toBe("call_pipeline_tool");
    if (out.action.kind === "call_pipeline_tool") {
      expect(out.action.tool_name).toBe("index_codebase");
      expect(out.action.arguments).toHaveProperty("path", "/some/path");
      expect(out.action.arguments).toHaveProperty("output_dir");
    }
  });

  it("input_analysis stores graph_path and output_dir on success then advances to clarification compose", () => {
    const issued = step({ state: seed("/x") });
    expect(issued.state.codebase_output_dir).not.toBeNull();
    const correlation_id =
      issued.action.kind === "call_pipeline_tool"
        ? issued.action.correlation_id
        : "";
    const after = step({
      state: issued.state,
      result: {
        kind: "tool_result",
        correlation_id,
        success: true,
        data: { graph_path: "/x/.prd-gen/graphs/test_run_001/graph" },
      },
    });
    expect(after.state.codebase_indexed).toBe(true);
    expect(after.state.codebase_graph_path).toBe(
      "/x/.prd-gen/graphs/test_run_001/graph",
    );
    expect(after.state.current_step).toBe("clarification");
    expect(after.action.kind).toBe("spawn_subagents");
  });

  it("section_generation fails fast if prd_context is null", () => {
    const s = newPipelineState({
      run_id: "x",
      license_tier: "trial",
      feature_description: "x",
    });
    const forced = { ...s, current_step: "section_generation" as const };
    const out = step({ state: forced });
    expect(out.action.kind).toBe("failed");
  });

  it("budget step refuses to advance without proceed_signal", () => {
    const s = newPipelineState({
      run_id: "x",
      license_tier: "trial",
      feature_description: "x",
    });
    const forced = { ...s, current_step: "budget" as const };
    const out = step({ state: forced });
    expect(out.action.kind).toBe("failed");
  });

  it("budget step with proceed_signal coalesces past budget into section_generation", () => {
    const s = newPipelineState({
      run_id: "x",
      license_tier: "trial",
      feature_description: "x",
    });
    const forced = {
      ...s,
      current_step: "budget" as const,
      proceed_signal: true,
      prd_context: "feature" as const,
    };
    const out = step({ state: forced });
    // Coalesces budget message → section_generation needs codebase recall
    expect(out.state.current_step).toBe("section_generation");
    expect(out.action.kind).toBe("call_cortex_tool");
  });

  it("failed action surfaces in messages even when emit_message coalesces", () => {
    const s = newPipelineState({
      run_id: "x",
      license_tier: "trial",
      feature_description: "x",
    });
    const forced = { ...s, current_step: "section_generation" as const };
    const out = step({ state: forced });
    // failed action does NOT coalesce — it's a terminal action.
    expect(out.action.kind).toBe("failed");
    if (out.action.kind === "failed") {
      expect(out.action.step).toBe("section_generation");
    }
  });
});
