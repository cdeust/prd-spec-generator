/**
 * `implementation_gate` — the human gate between self_check's PRD
 * deliverables and the post-specs implementation loop.
 *
 * Proves:
 *   1. On entry (no result), emits ask_user(question_id="implementation_gate")
 *      with exactly the "PRD only" / "Implement" options.
 *   2. Answering "PRD only" advances straight to `finalize`, preserving
 *      `state.pending_completion` untouched — today's exact behavior (zero
 *      regression is the acceptance criterion for this branch,
 *      design-phases-3-5.md §5, PR 3b).
 *   3. Answering "Implement" advances to `pre_impl_grounding` instead.
 *   4. An unrecognized/empty answer fails CLOSED to "prd_only" rather than
 *      silently spawning an engineer.
 *
 * source: design-phases-3-5.md §2.2, §3 "implementation_gate".
 */

import { describe, expect, it } from "vitest";
import { newPipelineState, step, type PipelineState } from "../index.js";

/** Must match handlers/protocol-ids.ts:IMPLEMENTATION_GATE_QUESTION_ID. */
const IMPLEMENTATION_GATE_QUESTION_ID = "implementation_gate";

function stateAtGate(): PipelineState {
  const s = newPipelineState({
    run_id: "impl_gate_001",
    feature_description: "OAuth login for the mobile app",
  });
  return {
    ...s,
    current_step: "implementation_gate",
    pending_completion: {
      summary: "Self-check complete. 3/3 sections passed.",
      artifacts: ["overview: passed"],
    },
  };
}

describe("implementation_gate — ask_user", () => {
  it("emits ask_user with exactly PRD-only/Implement options on entry", () => {
    const out = step({ state: stateAtGate() });

    expect(out.action.kind).toBe("ask_user");
    if (out.action.kind !== "ask_user") return;
    expect(out.action.question_id).toBe(IMPLEMENTATION_GATE_QUESTION_ID);
    expect(out.action.options).not.toBeNull();
    const labels = out.action.options?.map((o) => o.label) ?? [];
    expect(labels).toContain("PRD only");
    expect(labels).toContain("Implement");
    expect(labels.length).toBe(2);

    // pending_completion carried forward untouched.
    expect(out.state.pending_completion).not.toBeNull();
    expect(out.state.current_step).toBe("implementation_gate");
  });
});

describe("implementation_gate — PRD only branch (zero regression)", () => {
  it('advances straight to finalize, decision="prd_only", pending_completion untouched', () => {
    const seed = stateAtGate();
    const out = step({
      state: seed,
      result: {
        kind: "user_answer",
        question_id: IMPLEMENTATION_GATE_QUESTION_ID,
        selected: ["PRD only"],
      },
    });

    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.decision).toBe("prd_only");
    // The exact payload finalize() computed is unmodified.
    expect(out.state.pending_completion).toEqual(seed.pending_completion);
    // pre_impl_grounding never runs on this branch.
    expect(out.action.kind).not.toBe("call_pipeline_tool");
  });
});

describe("implementation_gate — Implement branch", () => {
  it('routes through pre_impl_grounding, decision="implement"', () => {
    const out = step({
      state: stateAtGate(),
      result: {
        kind: "user_answer",
        question_id: IMPLEMENTATION_GATE_QUESTION_ID,
        selected: ["Implement"],
      },
    });

    expect(out.state.post_specs?.decision).toBe("implement");
    // Coalesces into pre_impl_grounding, which (no graph/no affected-symbols
    // sidecar in this fixture) immediately dead-ends to finalize — see
    // pre-impl-grounding.test.ts for the grounding loop itself when a graph
    // and claims ARE present.
    expect(out.state.current_step).toBe("finalize");
    expect(out.state.post_specs?.impact_queries.done).toBe(true);
  });
});

describe("implementation_gate — unrecognized answer fails closed", () => {
  it("freeform text with neither label falls back to prd_only", () => {
    const out = step({
      state: stateAtGate(),
      result: {
        kind: "user_answer",
        question_id: IMPLEMENTATION_GATE_QUESTION_ID,
        selected: [],
        freeform: "maybe later",
      },
    });

    expect(out.state.post_specs?.decision).toBe("prd_only");
    expect(out.state.current_step).toBe("finalize");
  });
});
