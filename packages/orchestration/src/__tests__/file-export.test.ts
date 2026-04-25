import { describe, expect, it } from "vitest";
import { newPipelineState, step } from "../index.js";
import type { PipelineState } from "../index.js";

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
    const out = step({ state: s });
    // After all files written, file_export coalesces emit_message → self_check
    // → finalize → done. Empty sections produce a `done` action with empty
    // verification distribution.
    expect(out.state.current_step).toBe("complete");
    expect(out.action.kind).toBe("done");
  });
});
