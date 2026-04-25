import type { StepHandler } from "../runner.js";

/**
 * Budget step is in-process. Validates the proceed-signal invariant set by
 * clarification (a clean exit) before transitioning to section generation.
 *
 * The actual token budget calculation lives in mcp-server/context-budget.ts
 * and is exposed to the host via the standalone `coordinate_context_budget`
 * MCP tool. The host should call it BEFORE submitting the result that
 * advances out of the clarification step if it wants the numbers in its own
 * context window.
 */
export const handleBudget: StepHandler = ({ state }) => {
  if (!state.proceed_signal) {
    return {
      state,
      action: {
        kind: "failed",
        reason:
          "budget step reached without proceed_signal — clarification did not exit cleanly",
        step: "budget",
      },
    };
  }

  return {
    state: { ...state, current_step: "section_generation" },
    action: {
      kind: "emit_message",
      message: "Budget allocated. Starting section generation.",
    },
  };
};
