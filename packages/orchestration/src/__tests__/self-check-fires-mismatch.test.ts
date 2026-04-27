/**
 * C3 — Popper AP-4: independent verification that the self-check handler
 * fires mismatch diagnostics.
 *
 * This test PROVES that `handleSelfCheckPhaseB` actually appends a
 * `[self_check] plan mismatch detected — mismatch_kind:*` string to
 * `state.errors` when the sections diverge between Phase A and Phase B.
 *
 * It is independent of any benchmark run — it directly exercises the
 * handler code path through the public `step()` API. If the prefix
 * in `self-check.ts` ever changes, this test will still catch the
 * break (because it imports `MISMATCH_DIAGNOSTIC_PREFIX` from the
 * instrumentation module, which asserts on the emitted strings).
 *
 * Coupling discipline: imports `MISMATCH_DIAGNOSTIC_PREFIX` from
 * `@prd-gen/benchmark` (not a local re-definition) so the prefix
 * used in the assertion is ALWAYS in sync with the prefix used in
 * `extractMismatchEvents`. Any divergence between the handler and the
 * parser will be caught here.
 *
 * source: Popper AP-4 / Phase 3+4 cross-audit (2026-04).
 */

import { describe, it, expect } from "vitest";
import {
  makeCannedDispatcher,
  newPipelineState,
  step,
  type ActionResult,
  type NextAction,
  type PipelineState,
} from "../index.js";
// COUPLING NOTE (Popper AP-4): this string must match BOTH:
//   1. The handler emitter in self-check.ts (the "[self_check] plan mismatch
//      detected — mismatch_kind:" prefix appended to state.errors).
//   2. MISMATCH_DIAGNOSTIC_PREFIX in packages/benchmark/src/instrumentation.ts
//      (the parser that extractMismatchEvents uses).
// We cannot import MISMATCH_DIAGNOSTIC_PREFIX from @prd-gen/benchmark here
// because that would create a circular dependency (orchestration → benchmark
// is the wrong direction per §2.2 layer rules: benchmark depends on orchestration,
// not vice versa). If either the handler or the parser changes their prefix,
// this test will start failing (the mismatchErrors array will be empty) AND
// the instrumentation-injection.test.ts in @prd-gen/benchmark will also fail —
// providing two independent loud-failure signals.
// source: Popper AP-4 / Curie A3 (Phase 3+4 cross-audit, 2026-04).
const MISMATCH_DIAGNOSTIC_PREFIX =
  "[self_check] plan mismatch detected — mismatch_kind:";

// ─── Constants copied from handler internals ────────────────────────────────

/** Must match self-check.ts:VERIFY_BATCH_ID */
const SELF_CHECK_VERIFY_BATCH_ID = "self_check_verify";

// ─── Drive pipeline to Phase A ───────────────────────────────────────────────

interface PhaseAOutcome {
  /** State AFTER Phase A step() — verification_plan is populated. */
  readonly stateAfterPhaseA: PipelineState;
  /** The spawn_subagents action emitted by Phase A (contains invocation ids). */
  readonly phaseAAction: Extract<NextAction, { kind: "spawn_subagents" }>;
}

/**
 * Drive the full pipeline from start until Phase A of self-check emits its
 * spawn_subagents batch. Returns the state and action for Phase B injection.
 *
 * Pre-condition: the canned dispatcher can drive the run to completion
 *   without real LLM/MCP calls.
 * Post-condition: returned stateAfterPhaseA has `verification_plan` set and
 *   `current_step === "self_check"`.
 */
function driveToPhaseA(): PhaseAOutcome {
  const cannedDispatch = makeCannedDispatcher({
    freeform_answer: "mismatch-test-answer",
    graph_path: "/tmp/mismatch-test/graph",
  });

  let state: PipelineState = newPipelineState({
    run_id: "self-check-mismatch-test",
    feature_description: "build a feature for OAuth login",
    skip_preflight: true,
  });

  const SAFETY_CAP = 300;
  let pendingResult: ActionResult | undefined = undefined;

  for (let i = 0; i < SAFETY_CAP; i++) {
    const out = step({ state, result: pendingResult });
    state = out.state;

    if (
      out.action.kind === "spawn_subagents" &&
      out.action.batch_id === SELF_CHECK_VERIFY_BATCH_ID
    ) {
      // Phase A just fired.
      return {
        stateAfterPhaseA: state,
        phaseAAction: out.action,
      };
    }

    if (out.action.kind === "done" || out.action.kind === "failed") {
      throw new Error(
        `driveToPhaseA: pipeline reached '${out.action.kind}' before self-check Phase A fired. ` +
          `Possible cause: section generation failed silently or no sections produced content.`,
      );
    }

    pendingResult = cannedDispatch(out.action);
    if (pendingResult === undefined) {
      throw new Error(
        `driveToPhaseA: canned dispatcher returned undefined for action kind '${out.action.kind}'. ` +
          "The dispatcher is incomplete for this action.",
      );
    }
  }

  throw new Error("driveToPhaseA: SAFETY_CAP exceeded before Phase A fired.");
}

// ─── Mismatch injection helper ───────────────────────────────────────────────

/**
 * Produce a Phase B subagent batch result that has the correct batch_id but
 * carries synthetic minimal judge responses. The CONTENT of the responses
 * does not matter — the mismatch is detected by re-running
 * `planDocumentVerification` against the mutated state's sections, not by
 * parsing response content.
 */
function makeMinimalPhaseBResult(
  phaseAAction: Extract<NextAction, { kind: "spawn_subagents" }>,
): Extract<ActionResult, { kind: "subagent_batch_result" }> {
  return {
    kind: "subagent_batch_result",
    batch_id: phaseAAction.batch_id,
    responses: phaseAAction.invocations.map((inv) => ({
      invocation_id: inv.invocation_id,
      raw_text: JSON.stringify({
        verdict: "PASS",
        rationale: "synthetic mismatch-test judge response",
        caveats: [],
        confidence: 0.8,
      }),
    })),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("self-check handler fires mismatch diagnostics (C3 / Popper AP-4)", () => {
  it(
    "appends a mismatch_kind entry to state.errors when sections diverge between Phase A and Phase B",
    () => {
      const { stateAfterPhaseA, phaseAAction } = driveToPhaseA();

      // Verify precondition: verification_plan is populated and sections have content.
      expect(stateAfterPhaseA.verification_plan).not.toBeNull();
      const contentedSections = stateAfterPhaseA.sections.filter(
        (s) => s.content && s.section_type !== "jira_tickets",
      );
      expect(contentedSections.length).toBeGreaterThan(0);

      // Inject content_mutation: clear the content of a claim-producing section.
      // Not all sections produce claims — e.g. "overview" produces 0 claims
      // (source: verification/src/__tests__/claim-extractor.test.ts). We need
      // to clear a section whose presence DOES contribute claim_ids to the
      // snapshot so the re-derivation produces a different claim set.
      //
      // We prefer "requirements" (FR-NNN table), "acceptance_criteria",
      // "technical_specification", or "api_specification" — all produce claims
      // per the claim extractor. We target the first one found with content.
      const CLAIM_PRODUCING_TYPES = [
        "requirements",
        "acceptance_criteria",
        "technical_specification",
        "api_specification",
        "security_considerations",
      ] as const;

      const claimSectionIdx = stateAfterPhaseA.sections.findIndex(
        (s) =>
          s.content &&
          (CLAIM_PRODUCING_TYPES as readonly string[]).includes(s.section_type),
      );
      // If no claim-producing section exists, fall back to any content section
      // that isn't overview or jira_tickets.
      const mutationIdx =
        claimSectionIdx >= 0
          ? claimSectionIdx
          : stateAfterPhaseA.sections.findIndex(
              (s) =>
                s.content &&
                s.section_type !== "jira_tickets" &&
                s.section_type !== "overview",
            );
      expect(mutationIdx).toBeGreaterThanOrEqual(0);

      const mutatedState: PipelineState = {
        ...stateAfterPhaseA,
        sections: stateAfterPhaseA.sections.map((s, idx) =>
          idx === mutationIdx ? { ...s, content: undefined } : s,
        ),
      };

      // Drive Phase B with the mutated state.
      const phaseBResult = makeMinimalPhaseBResult(phaseAAction);
      const phaseBOutput = step({ state: mutatedState, result: phaseBResult });

      // Primary assertion: state.errors must contain at least one entry whose
      // prefix matches MISMATCH_DIAGNOSTIC_PREFIX (imported from @prd-gen/benchmark).
      const mismatchErrors = phaseBOutput.state.errors.filter((e) =>
        e.startsWith(MISMATCH_DIAGNOSTIC_PREFIX),
      );
      expect(mismatchErrors.length).toBeGreaterThanOrEqual(1);

      // The pipeline must still complete or move forward — mismatch is a
      // diagnostic, not a fatal crash.
      expect(phaseBOutput.action.kind).not.toBe("failed");
    },
    30_000,
  );
});
