/**
 * Bounded-I/O contract tests for PrdInputBundleSchema (Phase 1c).
 *
 * Proves: unbounded fields parsed from ai-architect-mcp-codebase cannot blow the
 * Claude Code 100,000-char MCP response budget — they are rejected with a
 * ZodError (observable), never silently truncated.
 */
import { describe, expect, it } from "vitest";
import { PrdInputBundleSchema, PRD_INPUT_BUNDLE_BUDGET } from "../index.js";

function wellFormedBundle() {
  return {
    finding: { id: "F1", title: "x" },
    matched_symbols: [{ fqn: "a::b", file: "a.ts", line: 1 }],
    impacted_communities: [{ id: "c1" }],
    impacted_processes: [{ id: "p1" }],
    graph_stats: { nodes: 10, edges: 20 },
  };
}

describe("PrdInputBundleSchema — bounded-I/O", () => {
  it("accepts a well-formed, small bundle", () => {
    expect(() => PrdInputBundleSchema.parse(wellFormedBundle())).not.toThrow();
  });

  it("rejects matched_symbols over the element cap with a ZodError", () => {
    const over = PRD_INPUT_BUNDLE_BUDGET.MATCHED_SYMBOLS_MAX + 1;
    const bundle = {
      ...wellFormedBundle(),
      // tiny elements so the element-count cap (not the char cap) trips first
      matched_symbols: Array.from({ length: over }, (_, i) => ({ i })),
    };
    const result = PrdInputBundleSchema.safeParse(bundle);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "matched_symbols")).toBe(
        true,
      );
    }
  });

  it("rejects a single oversized finding via the char budget", () => {
    const bundle = {
      ...wellFormedBundle(),
      // one giant string field — element count is irrelevant, char cap must trip
      finding: { blob: "x".repeat(PRD_INPUT_BUNDLE_BUDGET.FINDING_BUDGET_CHARS + 10) },
    };
    const result = PrdInputBundleSchema.safeParse(bundle);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "finding")).toBe(true);
    }
  });

  it("rejects an array whose few elements exceed the char budget", () => {
    // Under the element cap, but each element is huge → char budget must trip.
    const huge = "y".repeat(
      Math.ceil(PRD_INPUT_BUNDLE_BUDGET.IMPACTED_COMMUNITIES_MAX > 0 ? 30_000 : 0),
    );
    const bundle = {
      ...wellFormedBundle(),
      impacted_communities: [{ blob: huge }, { blob: huge }],
    };
    const result = PrdInputBundleSchema.safeParse(bundle);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === "impacted_communities"),
      ).toBe(true);
    }
  });

  it("budget constants are derived from the 100,000-char cap", () => {
    expect(PRD_INPUT_BUNDLE_BUDGET.BUNDLE_BUDGET_CHARS).toBe(100_000);
    // element caps = floor(per-array-budget / 200-char floor)
    expect(PRD_INPUT_BUNDLE_BUDGET.MATCHED_SYMBOLS_MAX).toBe(150);
    expect(PRD_INPUT_BUNDLE_BUDGET.IMPACTED_COMMUNITIES_MAX).toBe(100);
    expect(PRD_INPUT_BUNDLE_BUDGET.IMPACTED_PROCESSES_MAX).toBe(100);
  });
});
