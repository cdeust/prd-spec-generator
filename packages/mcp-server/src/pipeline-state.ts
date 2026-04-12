import type { PRDContext, SectionType, LicenseTier } from "@prd-gen/core";

/**
 * Pipeline state tracker — Beer's S3 fix.
 * Externalizes pipeline state from Claude's context window.
 *
 * Without this, Claude holds the entire 9-step pipeline state
 * in its context, consuming tokens that should go to generation.
 * With this, Claude calls get_pipeline_state to know where it is
 * and update_pipeline_state to record progress.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type PipelineStep =
  | "license_gate"
  | "context_detection"
  | "input_analysis"
  | "feasibility_gate"
  | "clarification"
  | "section_generation"
  | "jira_generation"
  | "file_export"
  | "self_check"
  | "complete";

export interface SectionStatus {
  sectionType: SectionType;
  status: "pending" | "generating" | "validating" | "passed" | "failed" | "retrying";
  attempt: number;
  violationCount: number;
  lastViolations: string[];
}

export interface PipelineState {
  /** Unique ID for this PRD generation run */
  runId: string;
  /** Current pipeline step */
  currentStep: PipelineStep;
  /** PRD context type */
  prdContext: PRDContext | null;
  /** License tier */
  licenseTier: LicenseTier;
  /** Feature/task being PRD'd */
  featureDescription: string;
  /** Codebase path (if provided) */
  codebasePath: string | null;
  /** Whether codebase is indexed in Cortex */
  codebaseIndexed: boolean;
  /** Per-section generation status */
  sections: SectionStatus[];
  /** Clarification rounds completed */
  clarificationRounds: number;
  /** Total tokens consumed (estimated) */
  tokensConsumed: number;
  /** Timestamps */
  startedAt: string;
  updatedAt: string;
  /** Errors encountered */
  errors: string[];
}

// ─── State Management ────────────────────────────────────────────────────────

// In-memory state — one active pipeline per server instance.
// This is intentional: MCP servers are per-session, so one state is correct.
let currentState: PipelineState | null = null;

export function initializePipeline(
  licenseTier: LicenseTier,
  featureDescription: string,
  codebasePath?: string,
): PipelineState {
  currentState = {
    runId: crypto.randomUUID(),
    currentStep: "license_gate",
    prdContext: null,
    licenseTier,
    featureDescription,
    codebasePath: codebasePath ?? null,
    codebaseIndexed: false,
    sections: [],
    clarificationRounds: 0,
    tokensConsumed: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    errors: [],
  };
  return currentState;
}

export function getPipelineState(): PipelineState | null {
  return currentState;
}

export function updatePipelineState(
  updates: Partial<Pick<
    PipelineState,
    | "currentStep"
    | "prdContext"
    | "codebaseIndexed"
    | "clarificationRounds"
    | "tokensConsumed"
    | "featureDescription"
  >>,
): PipelineState | null {
  if (!currentState) return null;

  if (updates.currentStep !== undefined) currentState.currentStep = updates.currentStep;
  if (updates.prdContext !== undefined) currentState.prdContext = updates.prdContext;
  if (updates.codebaseIndexed !== undefined) currentState.codebaseIndexed = updates.codebaseIndexed;
  if (updates.clarificationRounds !== undefined) currentState.clarificationRounds = updates.clarificationRounds;
  if (updates.tokensConsumed !== undefined) currentState.tokensConsumed = updates.tokensConsumed;
  if (updates.featureDescription !== undefined) currentState.featureDescription = updates.featureDescription;

  currentState.updatedAt = new Date().toISOString();
  return currentState;
}

export function updateSectionStatus(
  sectionType: SectionType,
  status: SectionStatus["status"],
  violationCount?: number,
  lastViolations?: string[],
): PipelineState | null {
  if (!currentState) return null;

  let section = currentState.sections.find((s) => s.sectionType === sectionType);
  if (!section) {
    section = {
      sectionType,
      status: "pending",
      attempt: 0,
      violationCount: 0,
      lastViolations: [],
    };
    currentState.sections.push(section);
  }

  section.status = status;
  if (status === "generating" || status === "retrying") {
    section.attempt++;
  }
  if (violationCount !== undefined) section.violationCount = violationCount;
  if (lastViolations !== undefined) section.lastViolations = lastViolations;

  currentState.updatedAt = new Date().toISOString();
  return currentState;
}

export function addPipelineError(error: string): void {
  if (currentState) {
    currentState.errors.push(`[${new Date().toISOString()}] ${error}`);
    currentState.updatedAt = new Date().toISOString();
  }
}

/**
 * Get a compact summary suitable for injecting into Claude's context.
 * Much smaller than the full state — just what Claude needs to make decisions.
 */
export function getPipelineStateSummary(): string | null {
  if (!currentState) return null;

  const completed = currentState.sections.filter((s) => s.status === "passed").length;
  const failed = currentState.sections.filter((s) => s.status === "failed").length;
  const total = currentState.sections.length;

  const lines = [
    `Run: ${currentState.runId.slice(0, 8)}`,
    `Step: ${currentState.currentStep}`,
    `Context: ${currentState.prdContext ?? "not set"}`,
    `Codebase: ${currentState.codebaseIndexed ? "indexed" : "not indexed"}`,
    `Sections: ${completed}/${total} passed, ${failed} failed`,
    `Clarification rounds: ${currentState.clarificationRounds}`,
    `Tokens consumed: ~${currentState.tokensConsumed}`,
  ];

  if (currentState.errors.length > 0) {
    lines.push(`Errors: ${currentState.errors.length}`);
    lines.push(`  Last: ${currentState.errors[currentState.errors.length - 1]}`);
  }

  return lines.join("\n");
}
