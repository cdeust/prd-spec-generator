import { describe, expect, it } from "vitest";
import { newPipelineState, step } from "../index.js";
import type { PipelineState } from "../index.js";

/** Must match self-check/remember-phase.ts:REMEMBER_CORRELATION_ID. */
const REMEMBER_CORRELATION_ID = "self_check_remember";

/**
 * self_check's finalize() hands off to the Cortex `remember` round trip
 * (Phase 1b) before `done` — resolve it so this file's terminal-state
 * assertions still reach `complete`/`done`.
 */
function resolveRemember(out: ReturnType<typeof step>) {
  expect(out.action.kind).toBe("call_cortex_tool");
  if (out.action.kind !== "call_cortex_tool") return out;
  expect(out.action.correlation_id).toBe(REMEMBER_CORRELATION_ID);
  return step({
    state: out.state,
    result: {
      kind: "tool_result",
      correlation_id: out.action.correlation_id,
      success: true,
      data: {},
    },
  });
}

function stateAtFileExport(): PipelineState {
  const s = newPipelineState({
    run_id: "test_export_001",
    feature_description: "x",
  });
  return {
    ...s,
    current_step: "file_export",
    prd_context: "feature",
    sections: [
      {
        section_type: "overview",
        status: "passed",
        attempt: 1,
        violation_count: 0,
        last_violations: [],
        content: "Overview content",
      },
    ],
  };
}

describe("file_export handler", () => {
  it("emits the first write_file when no files are written yet", () => {
    const out = step({ state: stateAtFileExport() });
    expect(out.action.kind).toBe("write_file");
    if (out.action.kind === "write_file") {
      expect(out.action.path).toMatch(/01-prd\.md$/);
    }
  });

  it("appends the path to written_files on file_written result", () => {
    const s = stateAtFileExport();
    const next = step({
      state: s,
      result: {
        kind: "file_written",
        path: "prd-output/test_exp/01-prd.md",
        bytes: 100,
      },
    });
    expect(next.state.written_files).toContain("prd-output/test_exp/01-prd.md");
  });

  it("does not double-record a file that was already recorded", () => {
    const s: PipelineState = {
      ...stateAtFileExport(),
      written_files: ["prd-output/test_exp/01-prd.md"],
    };
    const next = step({
      state: s,
      result: {
        kind: "file_written",
        path: "prd-output/test_exp/01-prd.md",
        bytes: 100,
      },
    });
    const occurrences = next.state.written_files.filter(
      (p) => p === "prd-output/test_exp/01-prd.md",
    ).length;
    expect(occurrences).toBe(1);
  });

  it("logs an error when an unexpected result kind arrives", () => {
    const s = stateAtFileExport();
    const next = step({
      state: s,
      result: {
        kind: "tool_result",
        correlation_id: "wrong",
        success: true,
        data: {},
      },
    });
    expect(
      next.state.errors.some((e) => e.includes("[file_export] unexpected")),
    ).toBe(true);
    // Pipeline does not advance — re-issues the write.
    expect(next.action.kind).toBe("write_file");
  });

  it("transitions through self_check after all 9 files are written", () => {
    const s: PipelineState = {
      ...stateAtFileExport(),
      written_files: [
        "prd-output/test_exp/01-prd.md",
        "prd-output/test_exp/02-data-model.md",
        "prd-output/test_exp/03-api-spec.md",
        "prd-output/test_exp/04-security.md",
        "prd-output/test_exp/05-testing.md",
        "prd-output/test_exp/06-deployment.md",
        "prd-output/test_exp/07-jira-tickets.md",
        "prd-output/test_exp/08-source-code.md",
        "prd-output/test_exp/09-test-code.md",
      ],
    };
    const issued = step({ state: s });
    // After all files written, file_export coalesces emit_message → self_check
    // → finalize → remember (Phase C, Phase 1b) → done. Zero-claim sections
    // produce a `done` action with empty verification distribution.
    const out = resolveRemember(issued);
    expect(out.state.current_step).toBe("complete");
    expect(out.action.kind).toBe("done");
  });
});

describe("file_export handler — stage-5.affected_symbols.json sidecar", () => {
  const AFFECTED_SYMBOLS_BLOCK = [
    "## Technical Specification",
    "",
    "We use ports-and-adapters architecture.",
    "",
    "<!-- AFFECTED_SYMBOLS_JSON -->",
    "```json",
    JSON.stringify({
      affected_symbols: [
        {
          qualified_name: "src/main.rs::handle_tool_call",
          change_kind: "modify",
          rationale: "add retry logic",
        },
      ],
    }),
    "```",
  ].join("\n");

  function stateWithTechSpec(content: string): PipelineState {
    const s = stateAtFileExport();
    return {
      ...s,
      sections: [
        ...s.sections,
        {
          section_type: "technical_specification",
          status: "passed",
          attempt: 1,
          violation_count: 0,
          last_violations: [],
          content,
        },
      ],
    };
  }

  it("emits the sidecar as a 10th file when the technical_specification section carries claims", () => {
    const s: PipelineState = {
      ...stateWithTechSpec(AFFECTED_SYMBOLS_BLOCK),
      written_files: [
        "prd-output/test_exp/01-prd.md",
        "prd-output/test_exp/02-data-model.md",
        "prd-output/test_exp/03-api-spec.md",
        "prd-output/test_exp/04-security.md",
        "prd-output/test_exp/05-testing.md",
        "prd-output/test_exp/06-deployment.md",
        "prd-output/test_exp/07-jira-tickets.md",
        "prd-output/test_exp/08-source-code.md",
        "prd-output/test_exp/09-test-code.md",
      ],
    };
    const out = step({ state: s });
    expect(out.action.kind).toBe("write_file");
    if (out.action.kind === "write_file") {
      expect(out.action.path).toBe(
        "prd-output/test_exp/stage-5.affected_symbols.json",
      );
      const parsed = JSON.parse(out.action.content);
      expect(parsed.affected_symbols).toEqual([
        {
          qualified_name: "src/main.rs::handle_tool_call",
          change_kind: "modify",
          rationale: "add retry logic",
        },
      ]);
    }
  });

  it("does NOT emit a sidecar when the section carries no affected_symbols block (stays at 9 files)", () => {
    const s = stateAtFileExport(); // only "overview", no technical_specification block
    const out = step({ state: s });
    // Drain every write until self_check — the sidecar path must never appear.
    let current = s;
    let action = out.action;
    const written: string[] = [];
    for (let i = 0; i < 15 && action.kind === "write_file"; i++) {
      written.push(action.path);
      const next = step({
        state: current,
        result: { kind: "file_written", path: action.path, bytes: 1 },
      });
      current = next.state;
      action = next.action;
    }
    expect(written).toHaveLength(9);
    expect(
      written.some((p) => p.endsWith("stage-5.affected_symbols.json")),
    ).toBe(false);
    expect(current.affected_symbols_path).toBeNull();
  });

  it("records affected_symbols_path in state once the sidecar is written", () => {
    const s: PipelineState = {
      ...stateWithTechSpec(AFFECTED_SYMBOLS_BLOCK),
      written_files: [
        "prd-output/test_exp/01-prd.md",
        "prd-output/test_exp/02-data-model.md",
        "prd-output/test_exp/03-api-spec.md",
        "prd-output/test_exp/04-security.md",
        "prd-output/test_exp/05-testing.md",
        "prd-output/test_exp/06-deployment.md",
        "prd-output/test_exp/07-jira-tickets.md",
        "prd-output/test_exp/08-source-code.md",
        "prd-output/test_exp/09-test-code.md",
        "prd-output/test_exp/stage-5.affected_symbols.json",
      ],
    };
    const out = step({ state: s });
    expect(out.state.affected_symbols_path).toBe(
      "prd-output/test_exp/stage-5.affected_symbols.json",
    );
    expect(out.state.current_step).toBe("self_check");
  });

  it("strips the affected-symbols block from the human-readable 01-prd.md content", () => {
    const s = stateWithTechSpec(AFFECTED_SYMBOLS_BLOCK);
    const out = step({ state: s });
    expect(out.action.kind).toBe("write_file");
    if (out.action.kind === "write_file" && out.action.path.endsWith("01-prd.md")) {
      expect(out.action.content).not.toContain("AFFECTED_SYMBOLS_JSON");
      expect(out.action.content).not.toContain("affected_symbols");
      expect(out.action.content).toContain(
        "We use ports-and-adapters architecture.",
      );
    }
  });
});
