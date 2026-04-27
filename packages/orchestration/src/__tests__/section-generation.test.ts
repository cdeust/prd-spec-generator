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
import {
  step,
  newPipelineState,
  makeCannedDispatcher,
  type PipelineState,
  type ActionResult,
} from "../index.js";

/**
 * Drive a fresh pipeline forward (using the canned dispatcher to satisfy
 * pre-section steps) until the section_generation handler emits a
 * `call_cortex_tool` action whose correlation_id starts with
 * `section_retrieve_`. Returns the state right after the action emission
 * along with the action's correlation_id, so the caller can inject either
 * an empty or non-empty recall result into `step()` and observe the
 * `cortex_recall_empty_count` delta.
 *
 * source: Curie A4 silent-suppression failure mode (Phase 3+4 cross-audit).
 */
function driveToSectionRecall(runId: string): {
  state: PipelineState;
  correlationId: string;
} {
  const cannedDispatch = makeCannedDispatcher({
    freeform_answer: "ok",
    graph_path: "/tmp/recall-empty-test/graph",
  });

  let state: PipelineState = newPipelineState({
    run_id: runId,
    feature_description: "Test feature for cortex_recall_empty_count",
    skip_preflight: true,
  });

  // source: provisional heuristic — healthy runs reach section_generation
  // recall within ~30 step() calls; 300 is a generous upper bound matching
  // self-check-fires-mismatch.test.ts.
  const SAFETY_CAP = 300;
  let pendingResult: ActionResult | undefined = undefined;

  for (let i = 0; i < SAFETY_CAP; i++) {
    const out = step({ state, result: pendingResult });
    state = out.state;
    if (
      out.action.kind === "call_cortex_tool" &&
      out.action.correlation_id.startsWith("section_retrieve_")
    ) {
      return { state, correlationId: out.action.correlation_id };
    }
    if (out.action.kind === "done" || out.action.kind === "failed") {
      throw new Error(
        `driveToSectionRecall: pipeline reached '${out.action.kind}' before section recall fired.`,
      );
    }
    pendingResult = cannedDispatch(out.action);
  }
  throw new Error(
    `driveToSectionRecall: did not reach section recall within ${SAFETY_CAP} steps.`,
  );
}

describe("section-generation — cortex_recall_empty_count", () => {
  it("increments counter on empty recall (data is null)", () => {
    const { state: stateBefore, correlationId } = driveToSectionRecall(
      "test-recall-empty",
    );

    expect(stateBefore.cortex_recall_empty_count).toBe(0);

    // Empty result — `success: true` (tool ran but returned nothing) is
    // exactly the Curie A4 silent-suppression failure mode this test guards.
    // The increment also fires on `success: false` (upstream failure) per
    // the same code path.
    const emptyResult: ActionResult = {
      kind: "tool_result",
      correlation_id: correlationId,
      success: true,
      data: null,
    };

    const out = step({ state: stateBefore, result: emptyResult });
    expect(out.state.cortex_recall_empty_count).toBe(1);
  });

  it("does NOT increment counter on non-empty recall", () => {
    const { state: stateBefore, correlationId } = driveToSectionRecall(
      "test-recall-with-content",
    );

    expect(stateBefore.cortex_recall_empty_count).toBe(0);

    const nonEmptyResult: ActionResult = {
      kind: "tool_result",
      correlation_id: correlationId,
      success: true,
      data: {
        results: [
          { content: "Relevant prior context from memory" },
        ],
      },
    };

    const out = step({ state: stateBefore, result: nonEmptyResult });
    expect(out.state.cortex_recall_empty_count).toBe(0);
  });
});
