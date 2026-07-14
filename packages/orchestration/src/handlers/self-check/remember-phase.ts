/**
 * Self-check Phase C — Cortex `remember`, run once per pipeline, immediately
 * before the terminal `done` action.
 *
 * Phase A/B (self-check.ts) compute the final summary/artifacts/verification
 * from the multi-judge verdicts and store it in `state.pending_completion`
 * rather than returning `done` directly — the reducer needs a host round
 * trip to run `remember`, and the verdicts that produced the summary are not
 * recoverable on the next step() call (verification_plan is cleared during
 * Phase B; the batch_result is not persisted). Storing the already-computed
 * payload is the seam: this module either (a) emits the remember call, or
 * (b) once its result comes back (or `run_remembered` is already true on
 * replay), reconstructs the exact `done` action from `pending_completion`.
 *
 * A `remember` failure is best-effort and MUST NOT block completion — the
 * run has already produced its deliverables; recording that fact durably in
 * Cortex is a bonus, not a precondition, mirroring the per-section recall's
 * degrade-gracefully contract in section-generation.ts.
 *
 * source: Phase 1b (2026-07-14) — Cortex memory-loop closure. No `remember`
 * call site existed anywhere in the pipeline before this (cortex-client.ts
 * exposed the method; nothing invoked it).
 */

import { appendError, type PipelineState } from "../../types/state.js";
import type { ActionResult, HandlerAction, NextAction } from "../../types/actions.js";

export const REMEMBER_CORRELATION_ID = "self_check_remember";

type PendingCompletion = NonNullable<PipelineState["pending_completion"]>;

/**
 * source: prd-gen convention — every other call_cortex_tool[recall] site
 * (section-generation.ts, input-analysis.ts Phase 1a) tags its origin via
 * the correlation_id alone; `remember` additionally accepts `tags` +
 * `source` per the Cortex MCP `remember` tool contract, so this is the
 * first call site in the pipeline to populate them. Tags mirror the
 * existing recall query vocabulary (feature/PRD-run) rather than inventing
 * a new taxonomy.
 */
const REMEMBER_TAGS: readonly string[] = ["prd-gen", "prd-run"];
const REMEMBER_SOURCE = "prd-gen:self_check";

/**
 * precondition:  `pending` is state.pending_completion, non-null.
 * postcondition: returns a self-contained fact string — readable without
 *                this run's context — naming the feature, PRD context type,
 *                section/ticket counts, self-check/judge verdicts (via
 *                `pending.summary`, already human-readable), and every
 *                exported file path (state.written_files) as verifiable
 *                references.
 */
function buildRememberContent(
  state: PipelineState,
  pending: PendingCompletion,
): string {
  const sectionsTotal = state.sections.filter(
    (s) => s.section_type !== "jira_tickets",
  ).length;
  const hasJiraTickets = state.sections.some(
    (s) => s.section_type === "jira_tickets" && s.content,
  );
  const exportedFiles = state.written_files.length
    ? state.written_files.join("\n  - ")
    : "(none written)";

  return [
    `PRD run complete: "${state.feature_description}"`,
    `PRD context: ${state.prd_context ?? "unknown"}`,
    `Sections: ${sectionsTotal} planned. JIRA tickets generated: ${hasJiraTickets ? "yes" : "no"}.`,
    "",
    pending.summary,
    "",
    `Exported files (verifiable references):`,
    `  - ${exportedFiles}`,
  ].join("\n");
}

function rememberAction(
  state: PipelineState,
  pending: PendingCompletion,
): HandlerAction {
  return {
    kind: "call_cortex_tool",
    tool_name: "remember",
    arguments: {
      content: buildRememberContent(state, pending),
      tags: REMEMBER_TAGS,
      source: REMEMBER_SOURCE,
    },
    correlation_id: REMEMBER_CORRELATION_ID,
  };
}

function doneAction(pending: PendingCompletion): NextAction {
  return {
    kind: "done",
    summary: pending.summary,
    artifacts: pending.artifacts,
    verification: pending.verification,
  };
}

/**
 * Called by Phase A/B once the final summary/artifacts/verification are
 * computed. Either emits `remember` (first entry, or replay before the
 * result arrives) or — once `run_remembered` is already true, which only
 * happens via `handleRememberPhase` below on a subsequent step() — returns
 * `done` directly. Phase A/B always call this with `run_remembered` false
 * (remember has not run yet for a fresh completion), so in practice this
 * emits `remember` on first entry.
 */
export function emitRememberOrDone(
  state: PipelineState,
  pending: PendingCompletion,
): { state: PipelineState; action: HandlerAction } {
  if (state.run_remembered) {
    return {
      state: { ...state, current_step: "complete", pending_completion: null },
      action: doneAction(pending),
    };
  }
  return {
    state: { ...state, pending_completion: pending },
    action: rememberAction(state, pending),
  };
}

/**
 * Entry point when `state.pending_completion` is already set — routes the
 * remember tool_result (or re-issues the call on replay) and returns the
 * terminal `done` action once processed.
 *
 * precondition:  state.pending_completion !== null.
 * postcondition: state.run_remembered === true AND the returned action is
 *                `done` (remember failure is recorded via appendError but
 *                never blocks completion).
 */
export function handleRememberPhase(
  state: PipelineState,
  result: ActionResult | undefined,
): { state: PipelineState; action: HandlerAction } {
  const pending = state.pending_completion;
  if (!pending) {
    throw new Error(
      "handleRememberPhase reached with pending_completion === null",
    );
  }

  if (
    result?.kind === "tool_result" &&
    result.correlation_id === REMEMBER_CORRELATION_ID
  ) {
    const nextState: PipelineState = result.success
      ? { ...state, run_remembered: true }
      : appendError(
          { ...state, run_remembered: true },
          `remember failed: ${result.error ?? "unknown"}; run summary was not persisted to Cortex`,
          "upstream_failure",
        );
    return emitRememberOrDone(nextState, pending);
  }

  // Not yet dispatched (or replay before the result arrives) — (re)issue.
  return { state, action: rememberAction(state, pending) };
}
