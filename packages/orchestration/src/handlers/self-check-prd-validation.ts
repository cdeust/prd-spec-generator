/**
 * Self-check Phase 0 — PRD-vs-graph validation. Extracted from self-check.ts
 * (§4.1 500-line file cap) — this module owns ONE concern: dispatching
 * `validate_prd_against_graph` before the judge phase and folding the result
 * into `PipelineState.prd_validation` / `prd_validated`.
 *
 * self-check.ts's exported handler calls `handlePrdValidation` first and
 * falls through to the judge phase once it settles (success / advisory
 * failure / skip). No other handler imports from here.
 */

import type { ActionResult, NextAction } from "../types/actions.js";
import { appendError, type PipelineState } from "../types/state.js";

const VALIDATE_PRD_CORRELATION_ID = "self_check_validate_prd_against_graph";

/**
 * Locate the exported PRD path in state.written_files. file-export writes the
 * primary PRD as `<base>/01-prd.md`; we match on that suffix so the lookup is
 * resilient to the run-id-derived base prefix.
 *
 * source: file-export.ts buildFileSet — `${base}/01-prd.md` is the canonical
 * combined PRD document.
 */
function exportedPrdPath(state: PipelineState): string | null {
  return state.written_files.find((p) => /(^|\/)01-prd\.md$/.test(p)) ?? null;
}

/**
 * Phase 0 — PRD-vs-graph validation. Runs once, before the judge phase, when
 * a code graph exists. Emits a call_pipeline_tool for
 * `validate_prd_against_graph` with { prd_path, graph_path }; processes the
 * result into state.prd_validation; sets prd_validated for idempotency.
 *
 * Skips gracefully (sets prd_validated, leaves prd_validation null) when there
 * is no graph_path or no exported PRD to validate — preserving the no-codebase
 * behavior exactly.
 *
 * precondition:  current_step === "self_check".
 * postcondition: either a call_pipeline_tool action (prd_validated unchanged,
 *                set by the result branch) OR prd_validated === true with the
 *                handler falling through to the existing judge phase.
 */
export function handlePrdValidation(
  state: PipelineState,
  result: ActionResult | undefined,
):
  | { state: PipelineState; action: NextAction }
  | { state: PipelineState; fallthrough: true } {
  // Result of the validate_prd_against_graph call.
  if (
    result?.kind === "tool_result" &&
    result.correlation_id === VALIDATE_PRD_CORRELATION_ID
  ) {
    if (!result.success) {
      // Validation is advisory — failure must not block self-check. Flag done,
      // record the upstream issue, fall through to the judge phase.
      return {
        state: appendError(
          { ...state, prd_validated: true },
          `validate_prd_against_graph failed: ${result.error ?? "unknown"}; continuing without graph validation`,
          "upstream_failure",
        ),
        fallthrough: true,
      };
    }
    const report = (result.data ?? {}) as Record<string, unknown>;
    return {
      state: { ...state, prd_validation: report, prd_validated: true },
      fallthrough: true,
    };
  }

  // Already validated (or skipped) → fall through to the judge phase.
  if (state.prd_validated) {
    return { state, fallthrough: true };
  }

  const graphPath = state.codebase_graph_path;
  const prdPath = exportedPrdPath(state);

  // No graph or no exported PRD → skip gracefully and fall through.
  if (!graphPath || !prdPath) {
    return { state: { ...state, prd_validated: true }, fallthrough: true };
  }

  // Emit the validation call. prd_validated stays false until the result.
  // affected_symbols_path is attached when file-export produced the
  // stage-5.affected_symbols.json sidecar (Move: contract-first extraction
  // beats regex fallback — source: stages/stage-6.md §4.2/§6.1). Omitted
  // (not sent as null/empty string) when absent, so AP's own "path missing
  // → regex fallback" branch fires exactly as designed.
  return {
    state,
    action: {
      kind: "call_pipeline_tool",
      tool_name: "validate_prd_against_graph",
      arguments: {
        prd_path: prdPath,
        graph_path: graphPath,
        ...(state.affected_symbols_path
          ? { affected_symbols_path: state.affected_symbols_path }
          : {}),
      },
      correlation_id: VALIDATE_PRD_CORRELATION_ID,
    },
  };
}
