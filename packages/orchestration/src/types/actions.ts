/**
 * NextAction — the contract between the runner and the host.
 *
 * The runner is a stateless reducer. It cannot itself call MCP tools,
 * spawn subagents, or interact with users. Instead it returns a NextAction
 * envelope describing what the host must do, and waits for an ActionResult
 * to be fed back via the next `step()` call.
 *
 * Two surfaces are exported:
 *
 *   - HandlerActionSchema: what a HANDLER may return (includes emit_message,
 *     which is a request to the runner to coalesce a status message and
 *     re-enter the dispatch).
 *   - NextActionSchema: what STEP() returns to the host (excludes
 *     emit_message — those are coalesced into StepOutput.messages).
 *
 * Discriminated by `kind`. Add a new kind if and only if a step needs an
 * action that no existing kind covers.
 */

import { z } from "zod";
import { PRDContextSchema, SectionTypeSchema, VerdictSchema } from "@prd-gen/core";

// ─── Action 1: ask_user ─────────────────────────────────────────────────────

export const AskUserActionSchema = z.object({
  kind: z.literal("ask_user"),
  /** Identifies the question so the host can map answer → state */
  question_id: z.string(),
  header: z.string().describe("Short prompt header for AskUserQuestion tool"),
  description: z.string().describe("Body explaining what we need from the user"),
  options: z
    .array(
      z.object({
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .min(2)
    .max(4)
    .nullable()
    .describe("Structured options for AskUserQuestion. Null = freeform answer."),
  multi_select: z.boolean().default(false),
});
export type AskUserAction = z.infer<typeof AskUserActionSchema>;

// ─── Action 2: call_pipeline_tool ───────────────────────────────────────────

export const CallPipelineToolActionSchema = z.object({
  kind: z.literal("call_pipeline_tool"),
  tool_name: z.string().describe("automatised-pipeline MCP tool name"),
  arguments: z.record(z.string(), z.unknown()),
  /** Opaque routing token — host echoes it back unchanged on the corresponding tool_result. */
  correlation_id: z.string(),
});
export type CallPipelineToolAction = z.infer<typeof CallPipelineToolActionSchema>;

// ─── Action 3: call_cortex_tool ─────────────────────────────────────────────

export const CallCortexToolActionSchema = z.object({
  kind: z.literal("call_cortex_tool"),
  tool_name: z.string().describe("Cortex MCP tool name"),
  arguments: z.record(z.string(), z.unknown()),
  /** Opaque routing token — host echoes it back unchanged on the corresponding tool_result. */
  correlation_id: z.string(),
});
export type CallCortexToolAction = z.infer<typeof CallCortexToolActionSchema>;

// ─── Action 4: spawn_subagents ──────────────────────────────────────────────

export const SpawnSubagentsActionSchema = z.object({
  kind: z.literal("spawn_subagents"),
  /** Multiple invocations to run IN PARALLEL — host MUST issue them in one message */
  invocations: z.array(
    z.object({
      invocation_id: z.string(),
      subagent_type: z.string(),
      description: z.string(),
      prompt: z.string(),
      isolation: z.enum(["worktree", "none"]).default("none"),
    }),
  ),
  /** Identifies the batch so the runner can route the batch result on submission. */
  batch_id: z.string(),
  /**
   * Observability label only — host dispatch logic MUST NOT branch on this
   * field. It exists so logs and telemetry can attribute batches to a high-
   * level intent (judging vs drafting vs reviewing).
   */
  purpose: z.enum(["judge", "draft", "review"]),
});
export type SpawnSubagentsAction = z.infer<typeof SpawnSubagentsActionSchema>;

// ─── Action 5: write_file ───────────────────────────────────────────────────

export const WriteFileActionSchema = z.object({
  kind: z.literal("write_file"),
  path: z.string(),
  content: z.string(),
});
export type WriteFileAction = z.infer<typeof WriteFileActionSchema>;

// ─── Action 6: emit_message ─────────────────────────────────────────────────

/** Display a message to the user (e.g., banner, summary). No reply expected. */
/**
 * `emit_message` is a HANDLER-only action. The runner coalesces these into
 * StepOutput.messages and never returns one as the host-facing action.
 * `level` defaults to "info" if a handler omits it — enforced by the schema
 * so the runtime is not the only line of defense.
 */
export const EmitMessageActionSchema = z.object({
  kind: z.literal("emit_message"),
  message: z.string(),
  level: z.enum(["info", "warn", "error"]).default("info"),
});
export type EmitMessageAction = z.infer<typeof EmitMessageActionSchema>;

// ─── Action 7: done ─────────────────────────────────────────────────────────

/**
 * Typed verification summary attached to the `done` action.
 *
 * source: cross-audit consensus (popper C1, feynman H2, curie C-2, dijkstra
 * C2, shannon S3, test-engineer C3 — Phase 3+4 cross-audit, 2026-04). The
 * previous design encoded these counts in the prose `summary` string; KPI
 * extractors regex-parsed them with a "KNOWN BRITTLENESS" caveat. Any
 * whitespace change in the producer silently zeroed every downstream metric
 * and survived all mutation tests. Typed fields close the gap.
 *
 * Invariants:
 *   - claims_evaluated = sum(distribution.values())
 *   - claims_evaluated >= 0; every distribution[v] >= 0
 *   - distribution_suspicious is a derived flag based on PASS-rate +
 *     minimum cluster size; see verification/orchestrator.ts:concludeFromVerdicts.
 */
export const VerificationSummarySchema = z.object({
  claims_evaluated: z.number().int().nonnegative(),
  distribution: z.record(VerdictSchema, z.number().int().nonnegative()),
  distribution_suspicious: z.boolean(),
});
export type VerificationSummary = z.infer<typeof VerificationSummarySchema>;

export const DoneActionSchema = z.object({
  kind: z.literal("done"),
  summary: z.string(),
  artifacts: z.array(z.string()).default([]),
  /**
   * Typed verification summary. Optional only because not every `done`
   * emission has run the judge phase (zero-claim short-circuit, malformed
   * input, etc.). When present, KPI extractors and tests MUST read this
   * field — never regex-parse `summary`.
   */
  verification: VerificationSummarySchema.optional(),
});
export type DoneAction = z.infer<typeof DoneActionSchema>;

// ─── Action 8: failed ───────────────────────────────────────────────────────

export const FailedActionSchema = z.object({
  kind: z.literal("failed"),
  reason: z.string(),
  step: z.string(),
});
export type FailedAction = z.infer<typeof FailedActionSchema>;

// ─── Union ──────────────────────────────────────────────────────────────────

/**
 * HandlerAction — what a HANDLER may return from `invoke()`. Includes
 * `emit_message`; the runner consumes these and never lets them escape.
 *
 * Uses `z.input` so handlers can omit fields with schema-level defaults
 * (e.g. `emit_message.level`); Zod normalizes them to the output type at
 * runtime. The runner re-types the action against the parsed shape on use.
 */
export const HandlerActionSchema = z.discriminatedUnion("kind", [
  AskUserActionSchema,
  CallPipelineToolActionSchema,
  CallCortexToolActionSchema,
  SpawnSubagentsActionSchema,
  WriteFileActionSchema,
  EmitMessageActionSchema,
  DoneActionSchema,
  FailedActionSchema,
]);
export type HandlerAction = z.input<typeof HandlerActionSchema>;

/**
 * NextAction — what `step()` returns to the host. The runner guarantees
 * `kind !== "emit_message"`; those are coalesced into StepOutput.messages.
 * Hosts pattern-matching on `action.kind` therefore never need to handle
 * `emit_message` — the type system makes the case unreachable.
 */
export const NextActionSchema = z.discriminatedUnion("kind", [
  AskUserActionSchema,
  CallPipelineToolActionSchema,
  CallCortexToolActionSchema,
  SpawnSubagentsActionSchema,
  WriteFileActionSchema,
  DoneActionSchema,
  FailedActionSchema,
]);
export type NextAction = z.infer<typeof NextActionSchema>;

// ─── ActionResult — fed back into the reducer ───────────────────────────────

export const UserAnswerSchema = z.object({
  kind: z.literal("user_answer"),
  question_id: z.string(),
  selected: z.array(z.string()).default([]),
  freeform: z.string().optional(),
});
export type UserAnswer = z.infer<typeof UserAnswerSchema>;

export const ToolResultSchema = z.object({
  kind: z.literal("tool_result"),
  correlation_id: z.string(),
  success: z.boolean(),
  data: z.unknown(),
  error: z.string().optional(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const SubagentBatchResultSchema = z.object({
  kind: z.literal("subagent_batch_result"),
  batch_id: z.string(),
  responses: z.array(
    z.object({
      invocation_id: z.string(),
      raw_text: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});
export type SubagentBatchResult = z.infer<typeof SubagentBatchResultSchema>;

export const FileWrittenSchema = z.object({
  kind: z.literal("file_written"),
  path: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type FileWritten = z.infer<typeof FileWrittenSchema>;

export const ActionResultSchema = z.discriminatedUnion("kind", [
  UserAnswerSchema,
  ToolResultSchema,
  SubagentBatchResultSchema,
  FileWrittenSchema,
]);
export type ActionResult = z.infer<typeof ActionResultSchema>;

