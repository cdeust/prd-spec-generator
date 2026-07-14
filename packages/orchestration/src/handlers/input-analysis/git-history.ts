/**
 * Phase 2 (git-historian, 2026-07-14) — the git-historian investigation gate
 * for input-analysis.ts.
 *
 * Extracted to keep input-analysis.ts ≤500 LOC (coding-standards §4.1),
 * mirroring section-generation.ts's extraction of
 * ./section-generation/validate-and-advance.ts for the same reason.
 *
 * Once `prd_input_prepared` settles (success OR advisory failure), and only
 * when `state.codebase_path` is set, input-analysis.ts routes through
 * `completeCodebaseAnalysis` (this module) instead of advancing to
 * feasibility_gate directly, so every completion path (success, advisory
 * prepare_prd_input failure, or no-feature-text skip) uniformly waits on the
 * git-historian investigation. Placed AFTER code-graph grounding rather than
 * before or in parallel with global recall / analyze_codebase, because a
 * single host round trip can only carry one action (runner.ts step()
 * contract) and the investigation prompt is scoped with a grounding hint
 * (matched-symbol / impacted-community count) derived from
 * `state.codebase_grounding` when available — a real (if modest) benefit
 * unavailable if git-historian ran earlier.
 *
 * source: Phase 2 (2026-07-14) — git-historian stage.
 */

import { appendError, type PipelineState } from "../../types/state.js";
import type { ActionResult, HandlerAction } from "../../types/actions.js";
import { buildGitHistoryPrompt } from "@prd-gen/meta-prompting";
import { GIT_HISTORY_INV_ID } from "../protocol-ids.js";

/** Single-invocation batch — one constant covers both batch_id and invocation_id (see protocol-ids.ts). */
const GIT_HISTORY_BATCH_ID = GIT_HISTORY_INV_ID;

/**
 * Defensive char cap for the git-historian report, in case the subagent's
 * output exceeds the ≤400-word instruction in buildGitHistoryPrompt. Uses
 * the same chars/token derivation basis as cortex-recall-summary.ts's
 * RECALL_RESULT_TRUNCATE_CHARS (800 chars ≈ 200 tokens ⇒ 4 chars/token):
 * 400 words × ~0.75 tokens/word (common English tokenizer heuristic) ≈ 533
 * tokens ⇒ 533 × 4 ≈ 2,132 chars; rounded up to 2,400 for headroom.
 * source: same derivation basis as cortex-recall-summary.ts.
 */
const GIT_HISTORY_TRUNCATE_CHARS = 2_400;
const GIT_HISTORY_TRUNCATION_MARKER = "...";

function truncateGitHistoryReport(text: string): string {
  return text.length > GIT_HISTORY_TRUNCATE_CHARS
    ? text.slice(0, GIT_HISTORY_TRUNCATE_CHARS) + GIT_HISTORY_TRUNCATION_MARKER
    : text;
}

/**
 * Derive a compact scope hint for the git-historian prompt from the AP
 * code-graph grounding, when present. Tolerates the same
 * possibly-`prd_context`-wrapped shape as section-generation.ts's
 * normalizeGrounding (state.codebase_grounding is a pure passthrough of the
 * AP response — see input-analysis.ts's module doc). Returns "" when no
 * usable evidence exists, matching renderGroundingBlock's "emit nothing"
 * convention.
 */
function summarizeGroundingForGitHistory(
  raw: Record<string, unknown> | null,
): string {
  if (!raw) return "";
  const nested = (raw as { prd_context?: unknown }).prd_context;
  const grounding = (
    nested && typeof nested === "object" ? nested : raw
  ) as { matched_symbols?: unknown[]; impacted_communities?: unknown[] };
  const symbolCount = Array.isArray(grounding.matched_symbols)
    ? grounding.matched_symbols.length
    : 0;
  const communityCount = Array.isArray(grounding.impacted_communities)
    ? grounding.impacted_communities.length
    : 0;
  if (symbolCount === 0 && communityCount === 0) return "";
  const communityNoun = communityCount === 1 ? "community" : "communities";
  return `Code-graph grounding found ${symbolCount} matched symbol(s) across ${communityCount} impacted ${communityNoun}.`;
}

/**
 * Emit the git-historian investigation spawn.
 *
 * precondition:  state.codebase_path is set (callers gate on this — see
 *                completeCodebaseAnalysis); state.git_history_done === false.
 * postcondition: a spawn_subagents action for
 *                zetetic-team-subagents:git-historian, batch/invocation id
 *                GIT_HISTORY_BATCH_ID, leaving git_history_done false
 *                (the corresponding subagent_batch_result sets it).
 */
function emitGitHistorySpawn(state: PipelineState): {
  state: PipelineState;
  action: HandlerAction;
} {
  return {
    state,
    action: {
      kind: "spawn_subagents",
      // Purpose is an observability label only (SpawnSubagentsActionSchema
      // doc — host dispatch MUST NOT branch on it); the enum is
      // judge|draft|review. git-historian investigates and reports, closest
      // to "review" (auditing history) among the three — it neither drafts
      // PRD content nor renders a verdict on a claim.
      purpose: "review",
      batch_id: GIT_HISTORY_BATCH_ID,
      invocations: [
        {
          invocation_id: GIT_HISTORY_INV_ID,
          subagent_type: "zetetic-team-subagents:git-historian",
          description: "Investigate git history for the feature's zone",
          prompt: buildGitHistoryPrompt({
            feature_description: state.feature_description,
            codebase_path: state.codebase_path!,
            grounding_summary: summarizeGroundingForGitHistory(
              state.codebase_grounding,
            ),
          }),
          isolation: "none",
        },
      ],
    },
  };
}

/**
 * Shared completion seam for input-analysis.ts's handleCodebaseAnalysis:
 * once codebase_indexed + codebase_graph_path + prd_input_prepared are all
 * set, every call site routes through here instead of advancing directly, so
 * the git-historian gate applies uniformly regardless of which branch
 * (success, advisory prepare_prd_input failure, or no-feature-text skip) got
 * there first.
 *
 * precondition:  state.codebase_indexed && state.codebase_graph_path &&
 *                state.prd_input_prepared (callers ensure this before
 *                calling).
 * postcondition: when state.git_history_done, advances to feasibility_gate
 *                with `advanceMessage`; otherwise emits the git-historian
 *                spawn (leaving current_step at input_analysis).
 */
export function completeCodebaseAnalysis(
  state: PipelineState,
  advanceMessage: string,
  advanceLevel: "info" | "warn" = "info",
): { state: PipelineState; action: HandlerAction } {
  if (state.git_history_done) {
    return {
      state: { ...state, current_step: "feasibility_gate" },
      action: { kind: "emit_message", message: advanceMessage, level: advanceLevel },
    };
  }
  return emitGitHistorySpawn(state);
}

/**
 * precondition:  none — safe to call with any ActionResult.
 * postcondition: true iff `result` is the subagent_batch_result for THIS
 *                run's git-historian spawn (matched by batch_id).
 */
export function isGitHistoryResult(
  result: ActionResult | undefined,
): result is Extract<ActionResult, { kind: "subagent_batch_result" }> {
  return (
    result?.kind === "subagent_batch_result" &&
    result.batch_id === GIT_HISTORY_BATCH_ID
  );
}

/**
 * Process the git-historian subagent_batch_result. MUST be called BEFORE
 * `completeCodebaseAnalysis`'s state-only "both phases done" guard in the
 * caller — that guard fires whenever codebase_indexed/graph_path/
 * prd_input_prepared are already true (which they are by the time this
 * spawn's result comes back) and does not itself inspect `result`; calling
 * this first ensures a returning subagent_batch_result is consumed exactly
 * once rather than being ignored while the guard re-emits the same spawn
 * forever.
 *
 * precondition:  isGitHistoryResult(result) === true.
 * postcondition: git_history_summary set (truncated report, or "" on
 *                failure/empty response) and git_history_done === true;
 *                routes through completeCodebaseAnalysis to advance.
 *                A failure/empty response is tolerated (this covers the
 *                "not a git repository" case, which the SUBAGENT determines
 *                and reports as prose — this pure reducer never inspects
 *                the filesystem itself) — it is recorded as an
 *                upstream_failure error but never blocks the run.
 */
export function handleGitHistoryResult(
  state: PipelineState,
  result: Extract<ActionResult, { kind: "subagent_batch_result" }>,
): { state: PipelineState; action: HandlerAction } {
  const response = result.responses.find(
    (r) => r.invocation_id === GIT_HISTORY_INV_ID,
  );
  if (!response || response.error || !response.raw_text?.trim()) {
    const withError = appendError(
      { ...state, git_history_summary: "", git_history_done: true },
      `git-historian investigation failed: ${response?.error ?? "no response"}; continuing without git history context`,
      "upstream_failure",
    );
    return completeCodebaseAnalysis(
      withError,
      "Git history investigation unavailable; proceeding without it.",
      "warn",
    );
  }
  const summary = truncateGitHistoryReport(response.raw_text.trim());
  return completeCodebaseAnalysis(
    { ...state, git_history_summary: summary, git_history_done: true },
    "Git history context gathered.",
  );
}
