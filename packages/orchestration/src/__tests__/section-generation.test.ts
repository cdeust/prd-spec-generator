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
  PipelineStateSchema,
  SectionStatusSchema,
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

// ─── D1.B: SectionStatus.attempt_log Zod round-trip ────────────────────────

describe("SectionStatusSchema — attempt_log Zod round-trip (Wave D1.B)", () => {
  it("defaults attempt_log to [] when field is absent (backward compat)", () => {
    // Precondition: raw object has no attempt_log field (pre-D1.B state snapshot).
    // Postcondition: Zod parse fills it with [].
    const raw = {
      section_type: "overview",
      status: "passed",
      attempt: 1,
      violation_count: 0,
      last_violations: [],
    };
    const parsed = SectionStatusSchema.parse(raw);
    expect(parsed.attempt_log).toEqual([]);
  });

  it("round-trips attempt_log with entries correctly", () => {
    // Precondition: raw object has attempt_log entries.
    // Postcondition: parse → serialize → parse produces identical values.
    const raw = {
      section_type: "goals",
      status: "failed",
      attempt: 2,
      violation_count: 1,
      last_violations: ["[HOR-1] missing heading"],
      attempt_log: [
        { attempt: 1, violations_fed: [] },
        { attempt: 2, violations_fed: ["[HOR-1] missing heading"] },
      ],
    };
    const parsed = SectionStatusSchema.parse(raw);
    expect(parsed.attempt_log.length).toBe(2);
    expect(parsed.attempt_log[0]!.attempt).toBe(1);
    expect(parsed.attempt_log[0]!.violations_fed).toEqual([]);
    expect(parsed.attempt_log[1]!.attempt).toBe(2);
    expect(parsed.attempt_log[1]!.violations_fed).toEqual(["[HOR-1] missing heading"]);

    // Serialize and re-parse to verify round-trip stability.
    const serialized = JSON.stringify(parsed);
    const reparsed = SectionStatusSchema.parse(JSON.parse(serialized));
    expect(reparsed.attempt_log).toEqual(parsed.attempt_log);
  });
});

// ─── D1.B: attempt_log accumulation in validateAndAdvance ───────────────────

describe("section-generation — attempt_log accumulation (Wave D1.B)", () => {
  /**
   * Drive the pipeline to the first failed-validation state for a given section
   * so we can inspect attempt_log entries after validateAndAdvance runs.
   * Returns the state immediately after the first draftResult is processed.
   */
  function driveToFirstDraftResult(runId: string): {
    state: PipelineState;
    firstSectionType: string;
  } {
    const cannedDispatch = makeCannedDispatcher({
      freeform_answer: "ok",
      graph_path: "/tmp/attempt-log-test/graph",
    });

    let state: PipelineState = newPipelineState({
      run_id: runId,
      feature_description: "Test feature for attempt_log",
      skip_preflight: true,
    });

    const SAFETY_CAP = 300;
    let pendingResult: ActionResult | undefined = undefined;

    for (let i = 0; i < SAFETY_CAP; i++) {
      const out = step({ state, result: pendingResult });
      state = out.state;

      if (out.action.kind === "done" || out.action.kind === "failed") {
        throw new Error(`Pipeline reached ${out.action.kind} before first draft.`);
      }

      // After a section reaches generating (attempt > 0), the next step()
      // with a subagent_batch_result calls validateAndAdvance.
      const firstSection = state.sections.find((s) => s.status !== "pending");
      if (
        firstSection &&
        (firstSection.status === "passed" ||
          firstSection.status === "failed" ||
          firstSection.status === "generating") &&
        firstSection.attempt > 0 &&
        firstSection.attempt_log.length > 0
      ) {
        return {
          state,
          firstSectionType: firstSection.section_type,
        };
      }

      pendingResult = cannedDispatch(out.action);
    }
    throw new Error(`Did not reach first draft result within ${SAFETY_CAP} steps.`);
  }

  it("attempt_log is populated after validateAndAdvance runs (attempt 1 entry recorded)", () => {
    const { state, firstSectionType } = driveToFirstDraftResult("test-attempt-log-acc");
    const section = state.sections.find((s) => s.section_type === firstSectionType)!;

    // Postcondition (D1.B): attempt_log has at least 1 entry after the first
    // validateAndAdvance call.
    expect(section.attempt_log.length).toBeGreaterThanOrEqual(1);
    // Postcondition: attempt 1 entry has violations_fed=[] (no prior violations).
    const entry = section.attempt_log.find((e) => e.attempt === 1);
    expect(entry).toBeDefined();
    expect(entry!.violations_fed).toEqual([]);
  });
});

// ─── D1.C: retry_policy injection seam ──────────────────────────────────────

describe("PipelineStateSchema — retry_policy seam (Wave D1.C)", () => {
  it("defaults retry_policy to null when absent (backward compat)", () => {
    // Precondition: raw PipelineState has no retry_policy field.
    // Postcondition: Zod parse fills it with null.
    const state = newPipelineState({
      run_id: "test-retry-policy-default",
      feature_description: "Test retry_policy default",
    });
    expect(state.retry_policy).toBeNull();
  });

  it("round-trips retry_policy with with_prior_violations arm", () => {
    // Precondition: state has retry_policy with maxAttempts=2, with_prior_violations.
    // Postcondition: Zod parse produces identical values.
    const raw = {
      run_id: "test-retry-policy-with",
      current_step: "section_generation",
      prd_context: null,
      feature_description: "Test",
      codebase_path: null,
      codebase_graph_path: null,
      codebase_output_dir: null,
      codebase_indexed: false,
      preflight_status: null,
      sections: [],
      clarifications: [],
      proceed_signal: false,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      errors: [],
      error_kinds: [],
      written_files: [],
      verification_plan: null,
      strategy_executions: [],
      retry_policy: { maxAttempts: 2, arm: "with_prior_violations" },
    };
    const parsed = PipelineStateSchema.parse(raw);
    expect(parsed.retry_policy).not.toBeNull();
    expect(parsed.retry_policy?.maxAttempts).toBe(2);
    expect(parsed.retry_policy?.arm).toBe("with_prior_violations");
  });

  it("round-trips retry_policy with without_prior_violations arm", () => {
    const raw = {
      run_id: "test-retry-policy-without",
      current_step: "section_generation",
      prd_context: null,
      feature_description: "Test",
      codebase_path: null,
      codebase_graph_path: null,
      codebase_output_dir: null,
      codebase_indexed: false,
      preflight_status: null,
      sections: [],
      clarifications: [],
      proceed_signal: false,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      errors: [],
      error_kinds: [],
      written_files: [],
      verification_plan: null,
      strategy_executions: [],
      retry_policy: { maxAttempts: 1, arm: "without_prior_violations" },
    };
    const parsed = PipelineStateSchema.parse(raw);
    expect(parsed.retry_policy?.arm).toBe("without_prior_violations");
    expect(parsed.retry_policy?.maxAttempts).toBe(1);
  });
});
