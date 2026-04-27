// Re-export core domain types consumed by the benchmark layer.
// The benchmark must depend on orchestration, not directly on core (§2.2).
// source: B3 layer-compliance fix — Wave C integration.
export { type SectionType, SectionTypeSchema } from "@prd-gen/core";

// Types
export {
  PipelineStepSchema,
  SectionStatusSchema,
  ClarificationTurnSchema,
  PipelineStateSchema,
  newPipelineState,
  touch,
  appendError,
  type PipelineStep,
  type SectionStatus,
  type ClarificationTurn,
  type PipelineState,
} from "./types/state.js";

export {
  AskUserActionSchema,
  CallPipelineToolActionSchema,
  CallCortexToolActionSchema,
  SpawnSubagentsActionSchema,
  WriteFileActionSchema,
  EmitMessageActionSchema,
  DoneActionSchema,
  FailedActionSchema,
  NextActionSchema,
  UserAnswerSchema,
  ToolResultSchema,
  SubagentBatchResultSchema,
  FileWrittenSchema,
  ActionResultSchema,
  type AskUserAction,
  type CallPipelineToolAction,
  type CallCortexToolAction,
  type SpawnSubagentsAction,
  type WriteFileAction,
  type EmitMessageAction,
  type DoneAction,
  type FailedAction,
  type NextAction,
  type UserAnswer,
  type ToolResult,
  type SubagentBatchResult,
  type FileWritten,
  type ActionResult,
} from "./types/actions.js";

// Section plan
export {
  SECTIONS_BY_CONTEXT,
  SECTION_RECALL_TEMPLATES,
} from "./section-plan.js";

// Runner
export { step, type StepInput, type StepOutput, type StepHandler } from "./runner.js";

// Run store
export { InMemoryRunStore, type RunStore } from "./run-store.js";

// Section-generation constants (exported for benchmark layer — benchmark → orchestration direction per §2.2)
export { MAX_ATTEMPTS } from "./handlers/section-generation.js";

// Canned dispatcher (test/benchmark utility — not for production host wiring)
export {
  makeCannedDispatcher,
  defaultFakeSectionDraft,
  type CannedDispatcher,
  type CannedDispatcherOptions,
} from "./canned-dispatcher.js";
