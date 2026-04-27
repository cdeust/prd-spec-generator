/**
 * Unit tests for section-generation handler's cortex_recall_empty_count tracking.
 *
 * Verifies that the section-generation handler increments cortex_recall_empty_count
 * exactly once per empty-recall path (when recall tool returns no usable content).
 *
 * source: Curie A4 silent-suppression failure mode (Phase 3+4 cross-audit, 2026-04).
 *         The counter is the only way to detect if the recall tool is returning
 *         empty results across the pipeline without post-hoc log parsing.
 */

import { describe, it, expect } from "vitest";
import { step, newPipelineState, type PipelineState } from "../index.js";

describe("section-generation — cortex_recall_empty_count", () => {
  it("increments counter on empty recall (data is null)", () => {
    let state = newPipelineState({
      run_id: "test-recall-empty",
      feature_description: "Test feature",
    });

    // Initialize sections (step will auto-init if not present).
    const out1 = step({ state, result: undefined });
    state = out1.state;

    // Drive until we emit a recall action.
    let recallEmitted = false;
    let recallCorrelationId = "";
    while (state.current_step !== "done" && !recallEmitted) {
      if (out1.action.kind === "call_cortex_tool") {
        recallCorrelationId = out1.action.correlation_id;
        recallEmitted = true;
        break;
      }
      const next = step({ state, result: undefined });
      state = next.state;
      if (next.action.kind === "call_cortex_tool") {
        recallCorrelationId = next.action.correlation_id;
        recallEmitted = true;
        break;
      }
    }

    if (!recallEmitted) {
      throw new Error("Expected recall action to be emitted");
    }

    // Counter should start at 0.
    expect(state.cortex_recall_empty_count).toBe(0);

    // Send empty recall result.
    const emptyResult = {
      kind: "tool_result" as const,
      correlation_id: recallCorrelationId,
      data: null, // Empty recall
    };

    const out2 = step({ state, result: emptyResult });
    state = out2.state;

    // Counter should be incremented to 1.
    expect(state.cortex_recall_empty_count).toBe(1);
  });

  it("does NOT increment counter on non-empty recall", () => {
    let state = newPipelineState({
      run_id: "test-recall-with-content",
      feature_description: "Test feature",
    });

    const out1 = step({ state, result: undefined });
    state = out1.state;

    let recallEmitted = false;
    let recallCorrelationId = "";
    if (out1.action.kind === "call_cortex_tool") {
      recallCorrelationId = out1.action.correlation_id;
      recallEmitted = true;
    }

    if (!recallEmitted) {
      throw new Error("Expected recall action to be emitted");
    }

    expect(state.cortex_recall_empty_count).toBe(0);

    // Send non-empty recall result.
    const nonEmptyResult = {
      kind: "tool_result" as const,
      correlation_id: recallCorrelationId,
      data: {
        results: [
          { content: "Relevant prior context from memory" },
        ],
      },
    };

    const out2 = step({ state, result: nonEmptyResult });
    state = out2.state;

    // Counter should remain 0 on non-empty recall.
    expect(state.cortex_recall_empty_count).toBe(0);
  });
});
