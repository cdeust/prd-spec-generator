/**
 * Input analysis — call automatised-pipeline `index_codebase`.
 *
 * Tool contract (source of truth: ai-automatised-pipeline/src/tool_schemas.rs):
 *   inputs: { path: string, output_dir: string, language?: string }
 *   output: { graph_path: string, ... }    ← subsequent graph tools take graph_path
 *
 * The output_dir is derived from run_id so retries are idempotent and runs
 * do not collide. We write under <codebase_path>/.prd-gen/graphs/<run_id>/
 * by default; a real deployment may want to override via env var.
 */

import { join } from "node:path";
import type { StepHandler } from "../runner.js";
import { appendError } from "../types/state.js";

const CORRELATION_ID = "input_analysis_index";

function deriveOutputDir(codebasePath: string, runId: string): string {
  return join(codebasePath, ".prd-gen", "graphs", runId);
}

export const handleInputAnalysis: StepHandler = ({ state, result }) => {
  // No codebase → skip indexing entirely.
  if (!state.codebase_path) {
    return {
      state: { ...state, current_step: "feasibility_gate" },
      action: {
        kind: "emit_message",
        message: "No codebase provided. Skipping codebase analysis.",
      },
    };
  }

  // Already indexed → move on.
  if (state.codebase_indexed && state.codebase_graph_path) {
    return {
      state: { ...state, current_step: "feasibility_gate" },
      action: {
        kind: "emit_message",
        message: `Codebase indexed (graph: ${state.codebase_graph_path}).`,
      },
    };
  }

  // Result of an index_codebase call.
  if (result?.kind === "tool_result" && result.correlation_id === CORRELATION_ID) {
    if (!result.success) {
      return {
        state: appendError(
          state,
          `index_codebase failed: ${result.error ?? "unknown"}`,
          // External tool failure — the pipeline gives up but it's not a
          // handler bug. Cross-audit curie H1 (Phase 3+4 follow-up).
          "upstream_failure",
        ),
        action: {
          kind: "failed",
          reason: `index_codebase failed: ${result.error ?? "unknown"}`,
          step: "input_analysis",
        },
      };
    }
    const data = (result.data ?? {}) as { graph_path?: string };
    const graphPath = data.graph_path ?? null;
    if (!graphPath) {
      return {
        state: appendError(
          state,
          `index_codebase succeeded but returned no graph_path`,
          // The upstream tool advertised success but violated its own
          // contract. From the orchestration layer's perspective this
          // is the SAME class as the explicit-failure case above —
          // a tool we can't act on. Tag it as upstream_failure so the
          // structural gate doesn't conflate this with a handler bug.
          "upstream_failure",
        ),
        action: {
          kind: "failed",
          reason: "index_codebase returned no graph_path",
          step: "input_analysis",
        },
      };
    }
    return {
      state: {
        ...state,
        codebase_indexed: true,
        codebase_graph_path: graphPath,
        current_step: "feasibility_gate",
      },
      action: {
        kind: "emit_message",
        message: `Codebase indexed (graph: ${graphPath}).`,
      },
    };
  }

  // Trigger the indexing call. Compute output_dir if not yet set so it
  // survives retries.
  const outputDir =
    state.codebase_output_dir ??
    deriveOutputDir(state.codebase_path, state.run_id);

  return {
    state: { ...state, codebase_output_dir: outputDir },
    action: {
      kind: "call_pipeline_tool",
      tool_name: "index_codebase",
      arguments: {
        path: state.codebase_path,
        output_dir: outputDir,
        language: "auto",
      },
      correlation_id: CORRELATION_ID,
    },
  };
};
