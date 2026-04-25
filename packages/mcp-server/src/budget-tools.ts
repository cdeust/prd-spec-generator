/**
 * Context-budget + retrieval-feedback tools.
 *
 * Extracted from index.ts to keep the composition root below the
 * 500-line cap (rules/coding-standards.md §4.1).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  HardOutputRuleViolationSchema,
  type PRDContext,
} from "@prd-gen/core";
import {
  calculateContextBudget,
  SECTION_RECALL_TEMPLATES,
} from "./context-budget.js";
import { mapFailuresToRetrievals } from "./failure-mapper.js";

export function registerBudgetTools(server: McpServer): void {
  server.tool(
    "coordinate_context_budget",
    "Calculate token budget allocation for PRD generation. Returns per-section retrieval limits for Cortex recall, generation budgets, and section-specific query templates. Call this BEFORE starting section generation.",
    {
      prd_context: z
        .enum(["proposal", "feature", "bug", "incident", "poc", "mvp", "release", "cicd"])
        .describe("The PRD context type"),
      completed_sections: z
        .array(z.string())
        .default([])
        .describe("Section types already generated"),
      context_window_size: z
        .number()
        .int()
        .default(200000)
        .describe("Total context window size in tokens"),
    },
    async ({ prd_context, completed_sections, context_window_size }) => {
      const budget = calculateContextBudget(
        prd_context as PRDContext,
        completed_sections,
        context_window_size,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { budget, recallTemplates: SECTION_RECALL_TEMPLATES },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "map_failure_to_retrieval",
    "When validate_prd_section returns violations, call this to get corrective Cortex recall queries. Closes the validation→retrieval feedback loop so retries use better context.",
    {
      // Validate at the MCP boundary using the canonical domain schema
      // (HardOutputRuleViolationSchema). Pre-fix this used a hand-written
      // loose schema and an `as any` cast at the call site, defeating the
      // type system at the layer boundary (cross-audit code-reviewer C3 +
      // dijkstra §3.2, Phase 3+4, 2026-04).
      violations: z
        .array(HardOutputRuleViolationSchema)
        .describe("Violations from validate_prd_section"),
    },
    async ({ violations }) => {
      // No cast required: Zod has already parsed violations into the exact
      // shape mapFailuresToRetrievals expects.
      const result = mapFailuresToRetrievals(violations);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
