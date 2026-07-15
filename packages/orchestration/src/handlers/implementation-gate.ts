/**
 * `implementation_gate` — the human gate between the PRD deliverables
 * (self_check) and the post-specs implementation loop.
 *
 * self_check's finalize() has already computed `state.pending_completion`
 * and advanced here (design-phases-3-5.md §2.2). This handler's ONLY job is
 * to ask "Implement" vs "PRD only" and route:
 *   - "prd_only" → `finalize` directly. This is TODAY'S EXACT BEHAVIOR
 *     (self_check used to emit remember/done itself) — zero regression is
 *     the acceptance criterion for this branch (design §5, PR 3b).
 *   - "implement" → `pre_impl_grounding`, which (in PR 3b) dead-ends back
 *     to `finalize` once grounding is gathered/skipped — the `implementation`
 *     step itself is not wired until PR 4a.
 *
 * precondition:  state.pending_completion !== null (set by self_check's
 *                finalize() before advancing here).
 *
 * VERIFICATION-REPORT EXPORT (root-cause note, 2026-07-15): self-check's
 * verification results (section statuses+violations, judge-verdict
 * distribution, prd_graph_validation) were computed but never written to a
 * file — only carried in the transient `pending_completion`/`done` payload
 * (e2e run_mrlqa0aj_u2rh15). The natural fix is "self_check exports its own
 * report", but self-check.ts is owned by a separate concurrent change and is
 * out of scope here. `implementation_gate` is the FIRST step reached once
 * `pending_completion` is set (see precondition above), so — before ever
 * asking the "Implement / PRD only" question — it writes
 * `10-verification-report.md` via the SAME write_file protocol file_export
 * uses (one write_file per entry, `file_written` result required to
 * advance). The report's CONTENT logic lives in file-export.ts
 * (buildVerificationReportFile) — this module only sequences the write,
 * consistent with file-export.ts owning every PRD-deliverable export.
 *
 * source: design-phases-3-5.md §2.2, §3 "implementation_gate".
 */

import type { StepHandler } from "../runner.js";
import { type PipelineState } from "../types/state.js";
import { initialPostSpecs, type PostSpecsState } from "../types/state/post-specs-state.js";
import { IMPLEMENTATION_GATE_QUESTION_ID } from "./protocol-ids.js";
import { buildVerificationReportFile, VERIFICATION_REPORT_FILENAME } from "./file-export.js";

function ensurePostSpecs(state: PipelineState): PostSpecsState {
  return state.post_specs ?? initialPostSpecs();
}

function hasVerificationReport(state: PipelineState): boolean {
  return state.written_files.some((p) => p.endsWith(VERIFICATION_REPORT_FILENAME));
}

/**
 * precondition:  none.
 * postcondition: returns the updated state (report path appended to
 *                written_files when a matching file_written result was fed
 *                in) unchanged otherwise.
 */
function recordReportWrite(state: PipelineState, result: import("../types/actions.js").ActionResult | undefined): PipelineState {
  if (
    result?.kind === "file_written" &&
    result.path.endsWith(VERIFICATION_REPORT_FILENAME) &&
    !state.written_files.includes(result.path)
  ) {
    return { ...state, written_files: [...state.written_files, result.path] };
  }
  return state;
}

/**
 * precondition:  `result` is the user_answer for IMPLEMENTATION_GATE_QUESTION_ID.
 * postcondition: returns "implement" iff the selected option's label
 *                (or freeform text) mentions "implement"; "prd_only"
 *                otherwise — including on an unrecognized/empty answer,
 *                which fails CLOSED to the zero-risk PRD-only path rather
 *                than silently spawning an engineer.
 */
function decisionFromAnswer(
  result: Extract<import("../types/actions.js").ActionResult, { kind: "user_answer" }>,
): "implement" | "prd_only" {
  const chosen = (result.selected[0] ?? result.freeform ?? "").toLowerCase();
  return chosen.includes("implement") ? "implement" : "prd_only";
}

export const handleImplementationGate: StepHandler = ({ state, result }) => {
  const stateAfterReportWrite = recordReportWrite(state, result);

  // First entry (or replay before the file_written result arrives): emit the
  // verification-report write before ever asking the decision question.
  // Skips gracefully (falls through to ask_user) when no report can be
  // derived — see buildVerificationReportFile's postcondition.
  if (result?.kind !== "file_written" && !hasVerificationReport(stateAfterReportWrite)) {
    const reportFile = buildVerificationReportFile(stateAfterReportWrite);
    if (reportFile) {
      return {
        state: { ...stateAfterReportWrite, post_specs: ensurePostSpecs(stateAfterReportWrite) },
        action: {
          kind: "write_file",
          path: reportFile.path,
          content: reportFile.content(),
        },
      };
    }
  }

  if (
    result?.kind === "user_answer" &&
    result.question_id === IMPLEMENTATION_GATE_QUESTION_ID
  ) {
    const decision = decisionFromAnswer(result);
    const postSpecs: PostSpecsState = { ...ensurePostSpecs(stateAfterReportWrite), decision };

    if (decision === "prd_only") {
      return {
        state: { ...stateAfterReportWrite, post_specs: postSpecs, current_step: "finalize" },
        action: {
          kind: "emit_message",
          message: "PRD-only run selected. Skipping implementation.",
        },
      };
    }
    return {
      state: { ...stateAfterReportWrite, post_specs: postSpecs, current_step: "pre_impl_grounding" },
      action: {
        kind: "emit_message",
        message: "Implementation selected. Gathering pre-implementation blast-radius grounding.",
      },
    };
  }

  return {
    state: { ...stateAfterReportWrite, post_specs: ensurePostSpecs(stateAfterReportWrite) },
    action: {
      kind: "ask_user",
      question_id: IMPLEMENTATION_GATE_QUESTION_ID,
      header: "Proceed to implementation?",
      description:
        "The PRD/specs are ready. Implement the change now (spawns an engineer, runs tests and review, opens a PR after a human gate), or stop here with PRD-only deliverables (today's behavior)?",
      options: [
        {
          label: "PRD only",
          description: "Stop here. No code changes — today's default behavior.",
        },
        {
          label: "Implement",
          description: "Spawn an engineer to implement, test, review, and (after a further gate) open a PR.",
        },
      ],
      multi_select: false,
    },
  };
};
