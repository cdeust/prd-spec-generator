import type { StepHandler } from "../runner.js";
import { CAPABILITIES } from "@prd-gen/core";

/**
 * First step of the pipeline — emits the welcome banner with the run ID
 * and feature description, then advances to context detection.
 *
 * This step formerly gated capabilities behind a license tier (free /
 * trial / licensed) carried over from the Swift port. The TS rewrite has
 * no licensing model, so the step is purely informational.
 *
 * source: license-tier removal, 2026-04.
 */
export const handleBanner: StepHandler = ({ state }) => {
  const message = [
    "PRD Spec Generator",
    `Run ID: ${state.run_id}`,
    `Allowed strategies: ${CAPABILITIES.allowedStrategies.length}`,
    `Allowed PRD contexts: ${CAPABILITIES.allowedContextTypes.length}`,
    "",
    `Feature: ${state.feature_description}`,
    state.codebase_path
      ? `Codebase: ${state.codebase_path}`
      : "Codebase: (none provided)",
  ].join("\n");

  return {
    state: { ...state, current_step: "preflight" },
    action: {
      kind: "emit_message",
      message,
      level: "info",
    },
  };
};
