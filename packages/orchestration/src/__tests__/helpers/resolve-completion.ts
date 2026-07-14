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
 */

import { expect } from "vitest";
import { step } from "../../index.js";

const IMPLEMENTATION_GATE_QUESTION_ID = "implementation_gate";
const REMEMBER_CORRELATION_ID = "self_check_remember";

type StepOutput = ReturnType<typeof step>;

/**
 * precondition:  `out.action.kind === "ask_user"` with
 *                `question_id === IMPLEMENTATION_GATE_QUESTION_ID` (the
 *                state just fell through self_check's finalize()).
 * postcondition: answers "PRD only" and returns the next step() output —
 *                today's zero-regression path (design §5, PR 3b acceptance
 *                criterion).
 */
export function resolveImplementationGatePrdOnly(out: StepOutput): StepOutput {
  expect(out.action.kind).toBe("ask_user");
  if (out.action.kind !== "ask_user") return out;
  expect(out.action.question_id).toBe(IMPLEMENTATION_GATE_QUESTION_ID);
  return step({
    state: out.state,
    result: {
      kind: "user_answer",
      question_id: out.action.question_id,
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
 * precondition:  `out.action.kind` is either "ask_user" (gate not yet
 *                answered) or "call_cortex_tool" (gate already resolved,
 *                e.g. state was hand-constructed past it).
 */
export function resolveRemember(out: StepOutput): StepOutput {
  const afterGate =
    out.action.kind === "ask_user" ? resolveImplementationGatePrdOnly(out) : out;

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
