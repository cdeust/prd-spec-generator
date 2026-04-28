/**
 * Section generation — the core PRD authoring loop.
 *
 * State machine PER section:
 *   pending     → emit call_cortex_tool (recall section-specific context)
 *                 status := retrieving
 *   retrieving  → on tool_result: emit spawn_subagents (engineer drafts section)
 *                 status := generating
 *   generating  → on subagent_batch_result: store content, run validation
 *                 in-process, status := passed | retrying | failed
 *   retrying    → emit spawn_subagents with violations as additional context
 *                 status := generating, attempt++
 *   passed      → advance to next section
 *   failed      → log, advance to next section anyway (don't block)
 *
 * When all sections are passed/failed → transition to jira_generation.
 */

import type { StepHandler } from "../runner.js";
import type { ActionResult, HandlerAction } from "../types/actions.js";
import {
  appendError,
  type PipelineState,
  type SectionStatus,
} from "../types/state.js";
import { validateSection } from "@prd-gen/validation";
import {
  SECTION_DISPLAY_NAMES,
  CAPABILITIES,
  type PRDContext,
  type SectionType,
} from "@prd-gen/core";
import { buildSectionPrompt } from "@prd-gen/meta-prompting";
import {
  selectStrategy,
  type StrategyAssignment,
  type ExecutionResult,
} from "@prd-gen/strategy";
import { SECTIONS_BY_CONTEXT, SECTION_RECALL_TEMPLATES } from "../section-plan.js";

/**
 * Maximum draft attempts per section before marking it failed and moving on.
 *
 * Exported so the benchmark layer can import the single authoritative value
 * instead of maintaining a mirror constant (Wave D1.A).
 *
 * source: docs/PHASE_4_PLAN.md §4.2 retry budget; provisional anchor pending
 * the Schoenfeld N=823 ablation study (Wave D + future calibration runs).
 * Current value (1 initial + 2 retries = 3) was chosen based on engineering
 * judgment; the calibrated replacement is injected at runtime via
 * state.retry_policy.maxAttempts (see D1.C).
 */
// source: docs/PHASE_4_PLAN.md §4.2 retry budget; provisional anchor pending
// the Schoenfeld N=823 ablation study (Wave D + future calibration runs).
export const MAX_ATTEMPTS = 3;

import { SECTION_GENERATE_INV_PREFIX as GENERATE_PREFIX } from "./protocol-ids.js";

const RETRIEVE_PREFIX = "section_retrieve_";

function correlationFor(prefix: string, sectionType: string): string {
  return `${prefix}${sectionType}`;
}

function ensureSectionsInitialized(state: PipelineState): PipelineState {
  if (state.sections.length > 0 || !state.prd_context) return state;
  const planned = SECTIONS_BY_CONTEXT[state.prd_context];
  // Enforce the maxSections cap: 11 (the limit baked into CAPABILITIES) is
  // larger than any single context plan, so this is effectively a no-op
  // for normal use, but stays here as a defense if SECTIONS_BY_CONTEXT
  // ever grows. source: CAPABILITIES (core/src/domain/capabilities.ts).
  const cap = CAPABILITIES.maxSections;
  const allowed = planned.slice(0, cap);
  const sections: SectionStatus[] = allowed.map((section_type) => ({
    section_type,
    status: "pending",
    attempt: 0,
    violation_count: 0,
    last_violations: [],
    attempt_log: [],
  }));
  return { ...state, sections };
}

function findActiveSection(state: PipelineState): SectionStatus | undefined {
  return state.sections.find(
    (s) => s.status !== "passed" && s.status !== "failed",
  );
}

function replaceSection(
  state: PipelineState,
  next: SectionStatus,
): PipelineState {
  return {
    ...state,
    sections: state.sections.map((s) =>
      s.section_type === next.section_type ? next : s,
    ),
  };
}

function recallAction(
  feature: string,
  sectionType: SectionType,
): HandlerAction {
  const template = SECTION_RECALL_TEMPLATES[sectionType];
  const query = template.replace("{feature}", feature);
  return {
    kind: "call_cortex_tool",
    tool_name: "recall",
    /**
     * source: provisional heuristic. 8 results × ~500 tokens/memory ≈ 4K
     * tokens of retrieval context per section, which fits comfortably
     * inside the per-section retrieval budget computed by
     * mcp-server/context-budget.ts (~2-5K depending on section weight).
     * The proper fix is to read `cortexMaxResults` from the budget
     * allocation in PipelineState — tracked under HIGH-3 follow-through;
     * Phase 4.5 wires the budget into the state. Cross-audit code-reviewer
     * H6 (Phase 3+4, 2026-04).
     */
    arguments: { query, max_results: 8 },
    correlation_id: correlationFor(RETRIEVE_PREFIX, sectionType),
  };
}

function draftAction(
  state: PipelineState,
  section: SectionStatus,
  recall_summary: string,
  prior_violations: readonly string[],
): HandlerAction {
  const display = SECTION_DISPLAY_NAMES[section.section_type];
  if (!state.prd_context) {
    throw new Error(`section-generation reached without prd_context`);
  }

  const prompt = buildSectionPrompt({
    section_type: section.section_type,
    feature_description: state.feature_description,
    prd_context: state.prd_context,
    recall_summary,
    clarification_qa: state.clarifications
      .filter((c): c is typeof c & { answer: string } => Boolean(c.answer))
      .map((c) => ({ question: c.question, answer: c.answer })),
    prior_violations: [...prior_violations],
    attempt: section.attempt,
    // Phase 4 strategy-wiring (2026-04): pass the persisted assignment
    // so every retry uses the SAME strategies the selector chose at the
    // pending → retrieving transition.
    strategy_assignment: section.strategy_assignment,
  });

  return {
    kind: "spawn_subagents",
    purpose: "draft",
    batch_id: correlationFor(GENERATE_PREFIX, section.section_type),
    invocations: [
      {
        invocation_id: correlationFor(GENERATE_PREFIX, section.section_type),
        subagent_type: "zetetic-team-subagents:engineer",
        description: `Draft section: ${display}`,
        prompt,
        isolation: "none",
      },
    ],
  };
}

/**
 * Failed-precondition early return when prd_context is null.
 */
function failNoPrdContext(state: PipelineState) {
  return {
    state: appendError(
      state,
      "[section_generation] prd_context is null",
      "structural", // upstream pipeline bug — context_detection should have set this
    ),
    action: {
      kind: "failed" as const,
      reason: "section_generation reached without prd_context",
      step: "section_generation" as const,
    },
  };
}

/**
 * No more sections to process → advance to jira_generation.
 */
function advanceToJira(init: PipelineState) {
  return {
    state: { ...init, current_step: "jira_generation" as const },
    action: {
      kind: "emit_message" as const,
      message: "All sections processed. Generating JIRA tickets.",
    },
  };
}

/**
 * Build ExecutionResult entries for a section's terminal transition.
 * Returns ONE entry per required strategy (and per optional strategy when
 * required is empty), so the EvidenceRepository's per-strategy attribution
 * is correct. Pushed to state.strategy_executions; the composition root
 * drains the queue after each step and forwards entries to
 * EffectivenessTracker.
 *
 * Precondition: `active.status` is `"passed"` or `"failed"`. Enforced
 * structurally — non-terminal callers receive [] back, surfacing the
 * misuse rather than silently recording an in-flight section as if it
 * were terminal (cross-audit dijkstra H1, Phase 4 wiring, 2026-04).
 *
 * Attribution: the rendered prompt instructs the engineer to apply ALL
 * required strategies. The previous design recorded only `required[0]`,
 * causing the feedback loop to systematically over-weight the first
 * strategy and remain blind to required[1..n] (cross-audit feynman
 * CRIT-2). Emitting one ExecutionResult per required strategy makes
 * the per-strategy reliability accumulation correct.
 *
 * Outcome encoding:
 *   wasCompliant = `passed`
 *   actualConfidenceGain = passed
 *     ? assignment.expectedImprovement   (full credit on success)
 *     : 0                                 (no credit on failure)
 *   retryCount = max(0, attempt - 1)     (separate causal channel)
 *
 * Decoupling actualConfidenceGain from retry count fixes the prior bug
 * (cross-audit feynman HIGH-1) where a strategy that consistently rescued
 * sections on attempt 2 was scored as underperforming. Retry burden is
 * captured in retryCount and surfaced separately to the EvidenceRepository
 * for Phase 4.1 calibration; it does not contaminate the gain metric.
 */
function buildExecutionResults(
  active: SectionStatus,
  prdContext: PRDContext,
  passed: boolean,
): readonly ExecutionResult[] {
  // Precondition: terminal status only.
  if (active.status !== "passed" && active.status !== "failed") return [];
  const assignment = active.strategy_assignment;
  if (!assignment) return [];

  // Attribution: one entry per required strategy. If no required strategies
  // were chosen, fall back to the optional[0] (next-best signal we have).
  const strategies =
    assignment.required.length > 0
      ? assignment.required
      : assignment.optional[0]
        ? [assignment.optional[0]]
        : [];
  if (strategies.length === 0) return [];

  const attempts = Math.max(1, active.attempt);
  const actualConfidenceGain = passed ? assignment.expectedImprovement : 0;
  const retryCount = Math.max(0, attempts - 1);

  return strategies.map((strategy) => ({
    strategy,
    assignment,
    actualConfidenceGain,
    wasCompliant: passed,
    retryCount,
    prdContext,
  }));
}

/**
 * Select a strategy assignment for the section based on its claim signal.
 * The "claim" the strategy engine analyzes is `<section_display_name>: <feature>`
 * — the strongest signal we have at the orchestration layer for what kind
 * of reasoning the section requires (e.g. `acceptance_criteria` triggers
 * `verification_oriented` characteristics; `technical_specification`
 * triggers `architecture_design`; `risks` triggers `exploration`).
 *
 * source: Phase 4 strategy-wiring (2026-04). The selection is per-section
 * and stored on SectionStatus so retries reuse the same assignment.
 */
function chooseStrategyForSection(
  state: PipelineState,
  section_type: SectionType,
): StrategyAssignment {
  const display = SECTION_DISPLAY_NAMES[section_type];
  return selectStrategy({
    claim: `${display}: ${state.feature_description}`,
    context: section_type,
    hasCodebase: state.codebase_indexed,
  });
}

/**
 * pending → retrieving: kick off the Cortex recall for the active section.
 *
 * Strategy assignment is materialized here (once per section) so retries
 * downstream reuse the SAME assignment. The chosen strategies travel with
 * the section state and feed `buildSectionPrompt` for every draft attempt.
 */
function startRetrieving(init: PipelineState, active: SectionStatus) {
  const assignment =
    active.strategy_assignment ?? chooseStrategyForSection(init, active.section_type);
  const next = {
    ...active,
    status: "retrieving" as const,
    strategy_assignment: assignment,
  };
  return {
    state: replaceSection(init, next),
    action: recallAction(init.feature_description, active.section_type),
  };
}

/**
 * retrieving → generating: recall returned; spawn the engineer to draft.
 */
function advanceFromRecall(
  init: PipelineState,
  active: SectionStatus,
  data: unknown,
) {
  const recallSummary = summarizeRecall(data);
  // Track empty recalls so the KPI surface can surface recall-efficacy
  // without post-hoc parsing. An empty summary means either the Cortex
  // memory store has no relevant entries yet (cold start) or the recall
  // tool returned an error-shaped response (upstream failure).
  const emptyRecall = recallSummary.length === 0;
  const next = {
    ...active,
    status: "generating" as const,
    attempt: active.attempt + 1,
  };
  const stateWithRecall = emptyRecall
    ? {
        ...init,
        cortex_recall_empty_count: init.cortex_recall_empty_count + 1,
      }
    : init;
  const updated = replaceSection(stateWithRecall, next);
  return {
    state: updated,
    action: draftAction(updated, next, recallSummary, active.last_violations),
  };
}

/**
 * generating → validation: subagent returned; either pass / retry / fail.
 */
function processDraft(
  init: PipelineState,
  active: SectionStatus,
  result: Extract<ActionResult, { kind: "subagent_batch_result" }>,
) {
  const draft = collectDraftText(result, active.section_type);
  if (!draft) {
    return failSection(init, active, "Subagent returned empty draft");
  }
  return validateAndAdvance(init, active, draft);
}

/**
 * Stalled (no matching result kind/correlation) — re-issue the appropriate
 * action so the host has another chance to fulfill it.
 */
function reissueStalled(init: PipelineState, active: SectionStatus) {
  if (active.status === "retrieving") {
    return {
      state: init,
      action: recallAction(init.feature_description, active.section_type),
    };
  }
  return {
    state: init,
    action: draftAction(init, active, "", active.last_violations),
  };
}

export const handleSectionGeneration: StepHandler = ({ state, result }) => {
  if (!state.prd_context) {
    return failNoPrdContext(state);
  }

  const init = ensureSectionsInitialized(state);
  const active = findActiveSection(init);

  if (!active) {
    return advanceToJira(init);
  }

  if (active.status === "pending") {
    return startRetrieving(init, active);
  }

  if (
    active.status === "retrieving" &&
    result?.kind === "tool_result" &&
    result.correlation_id ===
      correlationFor(RETRIEVE_PREFIX, active.section_type)
  ) {
    return advanceFromRecall(init, active, result.data);
  }

  if (
    active.status === "generating" &&
    result?.kind === "subagent_batch_result" &&
    result.batch_id === correlationFor(GENERATE_PREFIX, active.section_type)
  ) {
    return processDraft(init, active, result);
  }

  return reissueStalled(init, active);
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * source: provisional heuristic.
 *  - RECALL_MAX_RESULTS_INCLUDED = 8 mirrors the request-side max_results
 *    in recallAction (8). They are kept in lockstep on purpose: requesting
 *    more would inflate Cortex cost; including more would inflate the
 *    prompt budget without the request asking for them.
 *  - RECALL_RESULT_TRUNCATE_CHARS = 800 caps each excerpt's prompt
 *    contribution to ~200 tokens. 8 × 200 = ~1.6K tokens of recall
 *    context per section — comfortably below the per-section retrieval
 *    budget computed in mcp-server/context-budget.ts.
 * Cross-audit code-reviewer M8 (Phase 3+4, 2026-04). Phase 4.5 will
 * thread the budget allocation through PipelineState so these are
 * computed, not hardcoded.
 */
const RECALL_MAX_RESULTS_INCLUDED = 8;
const RECALL_RESULT_TRUNCATE_CHARS = 800;
const RECALL_TRUNCATION_MARKER = "...";

function summarizeRecall(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return "";
  return (results as Array<{ content?: string }>)
    .slice(0, RECALL_MAX_RESULTS_INCLUDED)
    .map((r) => r.content)
    .filter((c): c is string => typeof c === "string" && c.length > 0)
    .map((c) =>
      c.length > RECALL_RESULT_TRUNCATE_CHARS
        ? c.slice(0, RECALL_RESULT_TRUNCATE_CHARS) + RECALL_TRUNCATION_MARKER
        : c,
    )
    .join("\n---\n");
}

function collectDraftText(
  result: Extract<ActionResult, { kind: "subagent_batch_result" }>,
  sectionType: SectionType,
): string | null {
  const expectedId = correlationFor(GENERATE_PREFIX, sectionType);
  const response = result.responses.find((r) => r.invocation_id === expectedId);
  if (!response) return null;
  if (response.error) return null;
  return response.raw_text?.trim() ?? null;
}

/**
 * Validate a freshly-generated section draft and emit the next action.
 *
 * Precondition:  active.status === "generating".
 * Precondition:  active.attempt ∈ [1, MAX_ATTEMPTS]. The first attempt is
 *                counted at the retrieving→generating transition, so the
 *                first call to validateAndAdvance has active.attempt = 1.
 * Postcondition: exactly one of three outcomes is produced:
 *                 (a) validation succeeded (violations=[]) → status="passed",
 *                     attempt unchanged, content set.
 *                 (b) validation failed AND active.attempt >= MAX_ATTEMPTS →
 *                     status="failed", error appended to state.errors.
 *                 (c) validation failed AND active.attempt < MAX_ATTEMPTS →
 *                     status="generating", attempt = active.attempt + 1
 *                     (STRICT increase — termination argument).
 * Invariant:    `attempt` is the loop variant; it strictly increases on
 *               every retry; MAX_ATTEMPTS bounds total attempts at 3
 *               (initial attempt 1, retries at 2 and 3, fail at 3).
 *               If this contract breaks, section_generation does not
 *               terminate.
 *
 * source: dijkstra cross-audit H2 (Phase 3+4, 2026-04).
 */
function validateAndAdvance(
  state: PipelineState,
  active: SectionStatus,
  draft: string,
): { state: PipelineState; action: HandlerAction } {
  const report = validateSection(draft, active.section_type);
  const violations = report.violations.map(
    (v) => `[${v.rule}] ${v.message}`,
  );

  // Record which violations were fed into this attempt BEFORE branching on
  // outcome. `active.last_violations` is the violations list that was passed
  // to the engineer subagent for THIS attempt (set in the previous attempt's
  // retry branch, or [] for attempt 1). Writing to attempt_log here ensures
  // the benchmark extraction reads an observed value, not an inferred one
  // (Curie A2: instrumentation must observe behavior — closes TODO(C1) in
  // retry-observations.ts).
  //
  // ADR (Wave D1.B, 2026-04-27): attempt_log is written in validateAndAdvance
  // rather than at draftAction time because validateAndAdvance is the single
  // point at which we know both (a) the attempt number and (b) the violations
  // that were consumed. draftAction receives `prior_violations` but does not
  // own section state — keeping the log-write here preserves SRP (§1.1).
  const attemptLogEntry = {
    attempt: active.attempt,
    violations_fed: [...active.last_violations],
  };
  // Backward compat: `attempt_log` may be absent on state snapshots predating
  // Wave D1.B (e.g. hand-constructed test fixtures or in-flight states).
  // `?? []` ensures spread never throws on undefined.
  const activeWithLog: SectionStatus = {
    ...active,
    attempt_log: [...(active.attempt_log ?? []), attemptLogEntry],
  };

  if (violations.length === 0) {
    const next: SectionStatus = {
      ...activeWithLog,
      status: "passed",
      content: draft,
      violation_count: 0,
      last_violations: [],
    };
    let stateWithSection = replaceSection(state, next);
    // Phase 4 strategy-wiring (2026-04): record the execution outcome.
    // PRD context is non-null at this point because the handler's first
    // guard already returned `failed` if it were null. One ExecutionResult
    // per required strategy is appended (cross-audit feynman CRIT-2 fix).
    if (state.prd_context) {
      const execs = buildExecutionResults(
        next,
        state.prd_context,
        true,
      );
      if (execs.length > 0) {
        stateWithSection = {
          ...stateWithSection,
          strategy_executions: [...stateWithSection.strategy_executions, ...execs],
        };
      }
    }
    return {
      state: stateWithSection,
      action: {
        kind: "emit_message",
        message: `✓ ${SECTION_DISPLAY_NAMES[active.section_type]} passed validation (attempt ${active.attempt}).`,
      },
    };
  }

  // Read the effective max-attempts from the injected retry policy (D1.C).
  // Falls back to the exported baseline constant when state.retry_policy is
  // absent — backward-compat with states predating Wave D1.C.
  const effectiveMaxAttempts =
    state.retry_policy?.maxAttempts ?? MAX_ATTEMPTS;

  if (activeWithLog.attempt >= effectiveMaxAttempts) {
    return failSection(
      state,
      activeWithLog,
      `Failed validation after ${effectiveMaxAttempts} attempts. Violations: ${violations.join("; ")}`,
      draft,
      violations,
    );
  }

  // Retry: increment attempt and re-draft with violations as feedback.
  // attempt is the loop variant — it MUST increase here, not only on the
  // retrieving→generating transition, otherwise the bound check at the top
  // of validateAndAdvance is unreachable and the loop never terminates.
  //
  // D1.C ablation arm: branch on state.retry_policy.arm to determine which
  // violations to feed into the next attempt's prompt. The branch is here
  // (at the call site that constructs prior_violations), NOT inside
  // buildSectionPrompt — preserving DIP (§1.5): the prompt builder has no
  // awareness of the ablation infrastructure. The arm is read from state
  // so the reducer stays pure (no direct benchmark imports, §2.2).
  //
  // ADR (Wave D1.C, 2026-04-27): violations_for_next_attempt is stored as
  // next.last_violations so the attempt_log entry for the NEXT attempt
  // observes the same value that was passed to draftAction. This makes
  // violations_fed in attempt_log a direct observation (Curie A2) not an
  // inference.
  const arm = state.retry_policy?.arm ?? "with_prior_violations";
  const violationsForNextAttempt =
    arm === "without_prior_violations" ? [] : [...violations];

  const next: SectionStatus = {
    ...activeWithLog,
    status: "generating",
    content: draft,
    attempt: activeWithLog.attempt + 1,
    violation_count: violations.length,
    last_violations: violationsForNextAttempt,
  };
  // Pass the UPDATED state (with `next` already replacing `active`) to
  // draftAction so any future read of state.sections sees the bumped
  // attempt count instead of the stale active section. Pre-fix this
  // passed `state` directly; the bug was latent (draftAction does not
  // currently read sections) but would activate the moment draftAction
  // is changed to read prior_violations from state.sections rather than
  // the explicit parameter (cross-audit dijkstra M3, Phase 3+4 follow-up,
  // 2026-04).
  const updatedState = replaceSection(state, next);
  return {
    state: updatedState,
    action: draftAction(updatedState, next, "", violationsForNextAttempt),
  };
}

function failSection(
  state: PipelineState,
  active: SectionStatus,
  reason: string,
  draft?: string,
  violations: readonly string[] = [],
): { state: PipelineState; action: HandlerAction } {
  const next: SectionStatus = {
    ...active,
    status: "failed",
    content: draft ?? active.content,
    violation_count: violations.length || active.violation_count,
    last_violations: [...violations],
  };
  // failSection produces exactly one "section_failure" error per failed
  // section. This is the canonical 1-to-1 contract that pipeline-kpis.ts
  // relies on. If a future change appends ≠1 errors per section failure,
  // the structural_error_count direct count remains correct (it counts
  // tags, not derives) but the section_fail_count denominator no longer
  // matches — flag the divergence as a separate audit.
  const stateWithSection = replaceSection(state, next);
  let stateWithError = appendError(
    stateWithSection,
    `[section_generation:${active.section_type}] ${reason}`,
    "section_failure",
  );
  // Phase 4 strategy-wiring (2026-04): record the failure for the
  // EvidenceRepository feedback loop. wasCompliant=false signals to the
  // selector that this strategy underperformed for this claim shape.
  // One entry per required strategy (cross-audit feynman CRIT-2 fix).
  if (state.prd_context) {
    const execs = buildExecutionResults(
      next,
      state.prd_context,
      false,
    );
    if (execs.length > 0) {
      stateWithError = {
        ...stateWithError,
        strategy_executions: [...stateWithError.strategy_executions, ...execs],
      };
    }
  }
  return {
    state: stateWithError,
    action: {
      kind: "emit_message",
      level: "warn",
      message: `✗ ${SECTION_DISPLAY_NAMES[active.section_type]}: ${reason}`,
    },
  };
}
