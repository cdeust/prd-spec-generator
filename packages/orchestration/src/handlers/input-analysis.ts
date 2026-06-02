/**
 * Input analysis — call automatised-pipeline `index_codebase`, then
 * `prepare_prd_input` (FEATURE MODE) to ground the feature on the code graph.
 *
 * Tool contracts (source of truth: ai-automatised-pipeline/src/tool_schemas.rs):
 *   index_codebase:
 *     inputs:  { path, output_dir, language? }
 *     output:  { graph_path }                ← graph tools take this
 *   prepare_prd_input (feature mode — no finding_id):
 *     inputs:  { feature_description, output_dir, graph_path }
 *     output:  prd_context { matched_symbols, impacted_communities,
 *                            impacted_processes, graph_stats, mode:"feature" }
 *
 * Two sequential host-driven calls, each following the established reducer
 * protocol (emit call_pipeline_tool → host runs it → result fed back via
 * tool_result → handler processes result.data):
 *   1. index_codebase          → sets codebase_graph_path / codebase_indexed
 *   2. prepare_prd_input        → sets codebase_grounding / prd_input_prepared
 * Only after BOTH complete does the step advance to feasibility_gate.
 *
 * The output_dir is derived from run_id so retries are idempotent and runs
 * do not collide. We write under <codebase_path>/.prd-gen/graphs/<run_id>/
 * by default; a real deployment may want to override via env var.
 */

import { join } from "node:path";
import type { StepHandler } from "../runner.js";
import { appendError, type PipelineState } from "../types/state.js";
import type { HandlerAction } from "../types/actions.js";

const CORRELATION_ID = "input_analysis_index";
const PREPARE_CORRELATION_ID = "input_analysis_prepare_prd_input";

function deriveOutputDir(codebasePath: string, runId: string): string {
  return join(codebasePath, ".prd-gen", "graphs", runId);
}

/**
 * Emit the `prepare_prd_input` (feature-mode) grounding call, OR skip it
 * gracefully and advance when grounding is impossible.
 *
 * precondition:  state.codebase_indexed && state.codebase_graph_path set;
 *                state.prd_input_prepared === false.
 * postcondition: either (a) a call_pipeline_tool[prepare_prd_input] action
 *                with { feature_description, output_dir, graph_path }, leaving
 *                prd_input_prepared false (result will set it); or (b) when
 *                there is no usable feature_description, prd_input_prepared is
 *                set true and current_step advances to feasibility_gate with
 *                grounding left null — preserving the no-grounding behavior.
 */
function emitPrepare(state: PipelineState): {
  state: PipelineState;
  action: HandlerAction;
} {
  const featureDescription = state.feature_description.trim();
  const graphPath = state.codebase_graph_path;

  // No feature text to ground, or graph missing → skip grounding, advance.
  // (graphPath is non-null by precondition; the guard keeps the type narrow.)
  if (!featureDescription || !graphPath) {
    return {
      state: {
        ...state,
        prd_input_prepared: true,
        current_step: "feasibility_gate",
      },
      action: {
        kind: "emit_message",
        message:
          "No feature description to ground; skipping code-graph grounding.",
      },
    };
  }

  const outputDir =
    state.codebase_output_dir ??
    deriveOutputDir(state.codebase_path!, state.run_id);

  return {
    state: { ...state, codebase_output_dir: outputDir },
    action: {
      kind: "call_pipeline_tool",
      tool_name: "prepare_prd_input",
      // Feature mode: no finding_id. AP grounds the free text on the graph.
      arguments: {
        feature_description: featureDescription,
        output_dir: outputDir,
        graph_path: graphPath,
      },
      correlation_id: PREPARE_CORRELATION_ID,
    },
  };
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

  // Both phases done (index + grounding) → move on. Guard placed BEFORE the
  // result-routing blocks so a replayed terminal state advances idempotently
  // without re-issuing either call.
  if (
    state.codebase_indexed &&
    state.codebase_graph_path &&
    state.prd_input_prepared
  ) {
    return {
      state: { ...state, current_step: "feasibility_gate" },
      action: {
        kind: "emit_message",
        message: `Codebase analysis ready (graph: ${state.codebase_graph_path}).`,
      },
    };
  }

  // Result of a prepare_prd_input (feature-mode grounding) call. Process its
  // result.data, store the grounding, set the idempotency flag, and advance.
  if (
    result?.kind === "tool_result" &&
    result.correlation_id === PREPARE_CORRELATION_ID
  ) {
    if (!result.success) {
      // Grounding is best-effort: the PRD can still be generated without it.
      // Treat AP failure as an upstream issue, flag prepared so we do not loop,
      // and advance rather than failing the whole pipeline.
      return {
        state: {
          ...appendError(
            state,
            `prepare_prd_input failed: ${result.error ?? "unknown"}; continuing without code-graph grounding`,
            "upstream_failure",
          ),
          prd_input_prepared: true,
          current_step: "feasibility_gate",
        },
        action: {
          kind: "emit_message",
          message:
            "Code-graph grounding unavailable; proceeding without it.",
          level: "warn",
        },
      };
    }
    // AP feature mode wraps the grounding in `prd_context`; tolerate a flat
    // payload too (the orchestration layer does not parse the shape further).
    const data = (result.data ?? {}) as {
      prd_context?: Record<string, unknown>;
    };
    const grounding: Record<string, unknown> =
      data.prd_context ?? (result.data as Record<string, unknown>) ?? {};
    return {
      state: {
        ...state,
        codebase_grounding: grounding,
        prd_input_prepared: true,
        current_step: "feasibility_gate",
      },
      action: {
        kind: "emit_message",
        message: "Feature grounded on code graph.",
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
    // Indexed — do NOT advance yet. Record the graph, then fall through to the
    // prepare_prd_input emission below (state.codebase_graph_path is now set,
    // state.prd_input_prepared is still false).
    return emitPrepare({
      ...state,
      codebase_indexed: true,
      codebase_graph_path: graphPath,
    });
  }

  // Index already done but grounding not yet prepared (e.g. fresh entry with a
  // pre-indexed codebase, or replay after the index step). Emit prepare.
  if (
    state.codebase_indexed &&
    state.codebase_graph_path &&
    !state.prd_input_prepared
  ) {
    return emitPrepare(state);
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
