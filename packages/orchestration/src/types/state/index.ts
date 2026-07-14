/**
 * Runner state — externalized so the host (Claude Code) can persist it
 * across MCP tool calls without re-injecting it into context every time.
 *
 * The pipeline tools (start_pipeline, submit_action_result,
 * get_pipeline_state) are the canonical entry surface; this is the
 * single authoritative state shape.
 *
 * Split by concern (Phase 3a refactor, §4.1 500-line file cap):
 *   pipeline-step.ts      — PipelineStepSchema
 *   bounded-io.ts          — MAX_RESPONSE_CHARS / MAX_CLARIFICATION_TURNS / MAX_PIPELINE_ERRORS
 *   section-status.ts      — SectionStatusSchema
 *   verification-plan.ts   — VerificationPlanSnapshotSchema
 *   core-state.ts           — ClarificationTurnSchema, PipelineStateSchema, PipelineState
 *   helpers.ts              — touch / appendError / newPipelineState
 * This barrel re-exports the full public surface so existing call sites keep
 * importing from "./types/state.js" (or "../types/state.js") unchanged.
 */

export * from "./pipeline-step.js";
export * from "./bounded-io.js";
export * from "./section-status.js";
export * from "./verification-plan.js";
export * from "./core-state.js";
export * from "./helpers.js";
