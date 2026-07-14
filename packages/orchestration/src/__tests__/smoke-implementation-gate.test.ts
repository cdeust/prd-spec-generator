/**
 * End-to-end smoke coverage for the PR 3b post-specs gate
 * (design-phases-3-5.md §2, §5).
 *
 * Separate from smoke.test.ts (already at the file-size cap) — single
 * concern: prove a full pipeline run traverses BOTH branches of
 * `implementation_gate` end to end (not just the single-step injections in
 * implementation-gate.test.ts / pre-impl-grounding.test.ts).
 *
 * Proves:
 *   1. "PRD only" (today's canned-dispatcher default): reaches `done` with
 *      current_step === "complete", never emits a get_impact
 *      call_pipeline_tool (pre_impl_grounding never runs).
 *   2. "Implement" with a codebase + an affected-symbols claim: reaches
 *      `done`, DOES emit get_impact call_pipeline_tool(s) for the claimed
 *      symbol(s), and still completes (PR 3b's grounding dead-end still
 *      converges to finalize/done — no `implementation` step is wired yet).
 */

import { describe, expect, it } from "vitest";
import {
  defaultFakeSectionDraft,
  makeCannedDispatcher,
  newPipelineState,
  step,
  type ActionResult,
  type NextAction,
  type PipelineState,
} from "../index.js";

const SAFETY_CAP = 200;

/**
 * technical_specification draft carrying an affected-symbols claim, so
 * pre_impl_grounding (when reached) has a symbol to query.
 */
function draftWithAffectedSymbols(section_type: string): string {
  if (section_type !== "technical_specification") {
    return defaultFakeSectionDraft(section_type);
  }
  return [
    defaultFakeSectionDraft(section_type),
    "",
    "<!-- AFFECTED_SYMBOLS_JSON -->",
    "```json",
    JSON.stringify({
      affected_symbols: [
        { qualified_name: "src/auth.ts::login", change_kind: "modify" },
      ],
    }),
    "```",
  ].join("\n");
}

function runSmoke(
  seed: Readonly<PipelineState>,
  dispatch: (action: NextAction) => ActionResult | undefined,
) {
  let state: PipelineState = seed;
  let pendingResult: ActionResult | undefined = undefined;
  const observedToolNames: string[] = [];

  for (let i = 0; i < SAFETY_CAP; i++) {
    const out = step({ state, result: pendingResult });
    state = out.state;
    if (out.action.kind === "call_pipeline_tool") {
      observedToolNames.push(out.action.tool_name);
    }
    if (out.action.kind === "done" || out.action.kind === "failed") {
      return { finalAction: out.action, finalState: state, observedToolNames };
    }
    pendingResult = dispatch(out.action);
    if (pendingResult === undefined) {
      throw new Error(`Harness produced no result for action.kind=${out.action.kind}`);
    }
  }
  throw new Error(`Smoke run exceeded safety cap (${SAFETY_CAP} iterations)`);
}

describe("implementation_gate — PRD-only smoke path (zero regression)", () => {
  it("reaches done without ever emitting get_impact", () => {
    const dispatch = makeCannedDispatcher({
      freeform_answer: "smoke-gate-answer",
      graph_path: "/tmp/smoke-gate/.prd-gen/graphs/smoke/graph",
      implementation_gate_answer: "PRD only",
    });
    const seed = newPipelineState({
      run_id: "smoke_gate_prd_only",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/smoke-gate",
    });

    const result = runSmoke(seed, dispatch);

    expect(result.finalAction.kind).toBe("done");
    expect(result.finalState.current_step).toBe("complete");
    expect(result.finalState.post_specs?.decision).toBe("prd_only");
    expect(result.observedToolNames).not.toContain("get_impact");
  });
});

describe("implementation_gate — Implement smoke path (dead-ended gate, PR 3b)", () => {
  it("emits get_impact for the claimed symbol, still reaches done", () => {
    const dispatch = makeCannedDispatcher({
      freeform_answer: "smoke-gate-answer",
      graph_path: "/tmp/smoke-gate-impl/.prd-gen/graphs/smoke/graph",
      implementation_gate_answer: "Implement",
      fake_section_draft: draftWithAffectedSymbols,
    });
    const seed = newPipelineState({
      run_id: "smoke_gate_implement",
      feature_description: "build a feature for OAuth login",
      codebase_path: "/tmp/smoke-gate-impl",
    });

    const result = runSmoke(seed, dispatch);

    expect(result.finalAction.kind).toBe("done");
    expect(result.finalState.current_step).toBe("complete");
    expect(result.finalState.post_specs?.decision).toBe("implement");
    expect(result.observedToolNames).toContain("get_impact");
    expect(result.finalState.post_specs?.impact_queries.done).toBe(true);
    expect(
      result.finalState.post_specs?.impact_queries.results.some(
        (r) => r.qualified_name === "src/auth.ts::login" && r.success,
      ),
    ).toBe(true);
  });
});
