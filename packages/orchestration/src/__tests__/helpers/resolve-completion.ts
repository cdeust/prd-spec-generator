/**
 * Shared test helper: drive a state that just reached `self_check`'s
 * finalize() (pending_completion set, current_step === "implementation_gate")
 * all the way to the terminal `done` action.
 *
 * PR 3b (design-phases-3-5.md §2.2) inserted the `implementation_gate` /
 * `pre_impl_grounding` / `finalize` steps between self_check and completion.
 * Three call sites (file-export.test.ts, self-check-prd-validation.test.ts,
 * handler-injection.test.ts) previously carried their own private
 * `resolveRemember` copy that expected finalize() to emit
 * `call_cortex_tool[remember]` directly. Extracted here once ALL THREE need
 * the same two-hop fix (ask_user(implementation_gate) → "PRD only" →
 * call_cortex_tool[remember]) — meets the three-concrete-uses bar for
 * extraction (coding-standards.md §3.3).
 *
 * Must match:
 *   - handlers/protocol-ids.ts:IMPLEMENTATION_GATE_QUESTION_ID
 *   - handlers/finalize.ts:REMEMBER_CORRELATION_ID
 *   - handlers/file-export.ts:VERIFICATION_REPORT_FILENAME
 */

import { expect } from "vitest";
import { step } from "../../index.js";

const IMPLEMENTATION_GATE_QUESTION_ID = "implementation_gate";
const REMEMBER_CORRELATION_ID = "self_check_remember";
const VERIFICATION_REPORT_FILENAME = "10-verification-report.md";

type StepOutput = ReturnType<typeof step>;

/**
 * precondition:  `out.action.kind === "write_file"` with a path ending in
 *                VERIFICATION_REPORT_FILENAME — `implementation_gate`'s
 *                first-entry write (see implementation-gate.ts module doc).
 * postcondition: feeds back `file_written` and returns the next step()
 *                output (today: the "Implement / PRD only" ask_user).
 */
function resolveVerificationReportWrite(out: StepOutput): StepOutput {
  if (
    out.action.kind !== "write_file" ||
    !out.action.path.endsWith(VERIFICATION_REPORT_FILENAME)
  ) {
    return out;
  }
  return step({
    state: out.state,
    result: { kind: "file_written", path: out.action.path, bytes: out.action.content.length },
  });
}

/**
 * precondition:  `out.action.kind === "ask_user"` with
 *                `question_id === IMPLEMENTATION_GATE_QUESTION_ID` (the
 *                state just fell through self_check's finalize()), OR
 *                `out.action.kind === "write_file"` for the verification
 *                report that `implementation_gate` writes before ever
 *                asking (see resolveVerificationReportWrite).
 * postcondition: answers "PRD only" and returns the next step() output —
 *                today's zero-regression path (design §5, PR 3b acceptance
 *                criterion).
 */
export function resolveImplementationGatePrdOnly(out: StepOutput): StepOutput {
  const afterReport = resolveVerificationReportWrite(out);
  expect(afterReport.action.kind).toBe("ask_user");
  if (afterReport.action.kind !== "ask_user") return afterReport;
  expect(afterReport.action.question_id).toBe(IMPLEMENTATION_GATE_QUESTION_ID);
  return step({
    state: afterReport.state,
    result: {
      kind: "user_answer",
      question_id: afterReport.action.question_id,
      selected: ["PRD only"],
    },
  });
}

/**
 * Full terminal-completion resolver for tests written against the
 * pre-PR-3b "finalize() emits remember directly" behaviour: answers the
 * implementation_gate with "PRD only" (if reached) then resolves the
 * `remember` round trip, returning the final `done`/`failed` StepOutput.
 *
 * precondition:  `out.action.kind` is "write_file" (verification-report
 *                write pending), "ask_user" (gate not yet answered), or
 *                "call_cortex_tool" (gate already resolved, e.g. state was
 *                hand-constructed past it).
 */
export function resolveRemember(out: StepOutput): StepOutput {
  const afterReport = resolveVerificationReportWrite(out);
  const afterGate =
    afterReport.action.kind === "ask_user"
      ? resolveImplementationGatePrdOnly(afterReport)
      : afterReport;

  expect(afterGate.action.kind).toBe("call_cortex_tool");
  if (afterGate.action.kind !== "call_cortex_tool") return afterGate;
  expect(afterGate.action.correlation_id).toBe(REMEMBER_CORRELATION_ID);
  return step({
    state: afterGate.state,
    result: {
      kind: "tool_result",
      correlation_id: afterGate.action.correlation_id,
      success: true,
      data: {},
    },
  });
}
