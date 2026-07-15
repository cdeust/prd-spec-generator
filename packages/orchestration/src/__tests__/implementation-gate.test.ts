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
 *   3. Answering "Implement" advances to `pre_impl_grounding`, then coalesces
 *      through to `implementation` (PR 4a wiring).
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
  it('routes through pre_impl_grounding into implementation, decision="implement"', () => {
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
    // sidecar in this fixture) immediately advances to implementation (see
    // pre-impl-grounding.test.ts for the grounding loop itself when a graph
    // and claims ARE present); implementation then emits a SUBSTANTIVE
    // spawn_subagents action, which stops the coalescing chain.
    expect(out.state.current_step).toBe("implementation");
    expect(out.state.post_specs?.impact_queries.done).toBe(true);
    expect(out.action.kind).toBe("spawn_subagents");
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

/**
 * A run directory is derivable (state.written_files carries 01-prd.md) —
 * this is the case buildVerificationReportFile actually produces a file for.
 * stateAtGate() alone (no written_files) exercises the graceful degrade
 * already proven by the "ask_user on entry" test above.
 *
 * Module-scope (not nested inside a describe): shared by both the
 * report-content describe block and the write-protocol describe block below
 * (split to keep each describe under coding-standards.md §4.2's 50-line
 * function cap — craftsmanship-checker.sh FUNCTION_TOO_LONG).
 */
function stateAtGateWithExportedPrd(): PipelineState {
  const base = stateAtGate();
  return {
    ...base,
    written_files: ["prd-output/impl_gate_001/01-prd.md"],
    sections: [
      {
        section_type: "overview",
        status: "passed",
        attempt: 1,
        violation_count: 2,
        last_violations: ["missing acceptance criteria"],
        content: "Overview content",
      },
    ],
    pending_completion: {
      summary: "Self-check complete.",
      artifacts: ["overview: passed"],
      verification: {
        claims_evaluated: 2,
        distribution: { PASS: 1, FAIL: 1 },
        distribution_suspicious: false,
        prd_graph_validation: { hallucinated_symbols: [] },
      },
    },
  };
}

describe("implementation_gate — verification-report export (root-cause fix)", () => {
  it("writes 10-verification-report.md BEFORE asking the implementation decision", () => {
    const out = step({ state: stateAtGateWithExportedPrd() });
    expect(out.action.kind).toBe("write_file");
    if (out.action.kind !== "write_file") return;
    expect(out.action.path).toBe(
      "prd-output/impl_gate_001/10-verification-report.md",
    );
    expect(out.action.content).toContain("# Verification Report");
    expect(out.action.content).toContain("Overview");
    expect(out.action.content).toContain("missing acceptance criteria");
    expect(out.action.content).toContain("Claims evaluated: 2");
    expect(out.action.content).toContain("PASS: 1");
    expect(out.action.content).toContain("hallucinated_symbols");
    // No fabricated per-claim verdicts — the honest gap notice, since
    // pending_completion.verification.judge_verdicts is not populated.
    expect(out.action.content).toContain(
      "Per-claim judge verdicts are not present",
    );
  });
});

/**
 * stateAtGateWithExportedPrd() with 2 populated judge_verdicts — module scope
 * so the describe block below stays under the §4.2 50-line function cap.
 */
function stateAtGateWithJudgeVerdicts(): PipelineState {
  return {
    ...stateAtGateWithExportedPrd(),
    pending_completion: {
      summary: "Self-check complete.",
      artifacts: ["overview: passed"],
      verification: {
        claims_evaluated: 2,
        distribution: { PASS: 1, FAIL: 1 },
        distribution_suspicious: false,
        judge_verdicts: [
          {
            judge: { kind: "genius", name: "dijkstra" },
            claim_id: "FR-001",
            verdict: "PASS",
            rationale: "Requirement is fully specified and testable.",
            caveats: [],
            confidence: 0.9,
          },
          {
            judge: { kind: "genius", name: "popper" },
            claim_id: "FR-002",
            verdict: "FAIL",
            rationale: "No falsifiable acceptance criterion given.",
            caveats: ["ambiguous_scope"],
            confidence: 0.6,
          },
        ],
      },
    },
  };
}

describe("implementation_gate — verification-report per-claim judge verdicts (follow-up, e2e run_mrlqa0aj_u2rh15)", () => {
  it("renders real per-claim verdict rows when judge_verdicts is populated", () => {
    const out = step({ state: stateAtGateWithJudgeVerdicts() });
    expect(out.action.kind).toBe("write_file");
    if (out.action.kind !== "write_file") return;

    // Real verdict rows replace the honest gap notice.
    expect(out.action.content).not.toContain(
      "Per-claim judge verdicts are not present",
    );
    expect(out.action.content).toContain("| Claim ID | Judge | Model | Verdict |");
    expect(out.action.content).toContain("FR-001");
    expect(out.action.content).toContain("PASS");
    expect(out.action.content).toContain("dijkstra");
    expect(out.action.content).toContain("FR-002");
    expect(out.action.content).toContain("FAIL");
    expect(out.action.content).toContain("popper");
    expect(out.action.content).toContain(
      "No falsifiable acceptance criterion given.",
    );
  });
});

describe("implementation_gate — verification-report write protocol", () => {
  it("records the report path and proceeds to ask_user once file_written arrives", () => {
    const seed = stateAtGateWithExportedPrd();
    const written = step({ state: seed });
    expect(written.action.kind).toBe("write_file");
    if (written.action.kind !== "write_file") return;

    const next = step({
      state: written.state,
      result: {
        kind: "file_written",
        path: written.action.path,
        bytes: written.action.content.length,
      },
    });
    expect(next.state.written_files).toContain(
      "prd-output/impl_gate_001/10-verification-report.md",
    );
    expect(next.action.kind).toBe("ask_user");
    if (next.action.kind === "ask_user") {
      expect(next.action.question_id).toBe(IMPLEMENTATION_GATE_QUESTION_ID);
    }
  });

  it("never re-writes the report once written_files already carries it", () => {
    const seed: PipelineState = {
      ...stateAtGateWithExportedPrd(),
      written_files: [
        "prd-output/impl_gate_001/01-prd.md",
        "prd-output/impl_gate_001/10-verification-report.md",
      ],
    };
    const out = step({ state: seed });
    expect(out.action.kind).toBe("ask_user");
  });
});
