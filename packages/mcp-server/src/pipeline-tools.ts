/**
 * Pipeline-tool registration — orchestrator + verification.
 *
 * Adds the new MCP tools that drive the full PRD workflow:
 *
 *   start_pipeline     — initialize a pipeline run, return first NextAction
 *   submit_action_result  — feed an ActionResult to the reducer, return next action
 *   get_pipeline_state — read current state by run_id
 *   plan_section_verification    — emit JudgeRequest[] for a section
 *   plan_document_verification   — emit JudgeRequest[] across all sections
 *   conclude_verification        — aggregate JudgeVerdict[] → VerificationReport
 *
 * The host (Claude Code) drives the loop: call start, execute the action,
 * call submit_action_result with the result, repeat until `done`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  newPipelineState,
  step,
  InMemoryRunStore,
  ActionResultSchema,
  type PipelineState,
  type ActionResult,
} from "@prd-gen/orchestration";
import {
  planSectionVerification,
  planDocumentVerification,
  concludeSection,
  concludeDocument,
  type ConcludeOptions,
} from "@prd-gen/verification";
import {
  SectionTypeSchema,
  JudgeVerdictSchema,
  tryCreateEvidenceRepository,
  type EvidenceRepository,
} from "@prd-gen/core";
import { EffectivenessTracker } from "@prd-gen/strategy";
import {
  appendObservationLog,
  JUDGE_OBSERVATION_LOG_PATH,
} from "@prd-gen/benchmark";
import {
  getReliabilityRepo,
  getConsensusReliabilityProvider,
} from "./reliability-wiring.js";

const runStore = new InMemoryRunStore();

/**
 * Lazy EvidenceRepository + EffectivenessTracker. Both are optional —
 * better-sqlite3 may be unavailable at runtime. When the repository is
 * absent, drainStrategyExecutions is a no-op and the executions queue
 * is cleared without persistence.
 *
 * source: Phase 4 strategy-wiring (2026-04). The composition root is the
 * only place that performs I/O; orchestration produces the queue,
 * mcp-server drains it.
 */
let _repo: EvidenceRepository | null | undefined = undefined;
let _tracker: EffectivenessTracker | null = null;
function getTracker(): EffectivenessTracker | null {
  if (_repo === undefined) {
    _repo = tryCreateEvidenceRepository();
    if (_repo) _tracker = new EffectivenessTracker(_repo);
  }
  return _tracker;
}

/**
 * Drain `state.strategy_executions` and forward each entry to the
 * EvidenceRepository. Returns the state with the queue cleared.
 *
 * The drain ALWAYS clears the queue, even when no repository is wired —
 * the queue would otherwise grow unbounded across pipeline runs. When the
 * repository IS wired, recordExecution may throw on schema mismatches;
 * we swallow such errors and continue (with a warning logged) because
 * persistence is best-effort feedback, not a correctness gate.
 */
function drainStrategyExecutions(state: PipelineState): PipelineState {
  if (state.strategy_executions.length === 0) return state;
  const tracker = getTracker();
  if (tracker) {
    for (const exec of state.strategy_executions) {
      try {
        tracker.recordExecution({ ...exec, sessionId: state.run_id });
      } catch {
        // Best-effort; persistence failure must not break the pipeline.
      }
    }
  }
  return { ...state, strategy_executions: [] };
}

/**
 * Per-run_id in-flight guard for submit_action_result. The reducer pattern
 * (read state → step → write state) is atomic only under Node.js cooperative
 * scheduling because step() is synchronous and there is no await between get
 * and set. This Set explicitly rejects concurrent submissions for the same
 * run_id, providing defense-in-depth if the runtime ever changes.
 */
const inFlight = new Set<string>();

function generateRunId(): string {
  return (
    "run_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8)
  );
}

function envelope(
  state: PipelineState,
  action: unknown,
  messages: ReadonlyArray<{ text: string; level: "info" | "warn" | "error" }> = [],
) {
  return {
    run_id: state.run_id,
    current_step: state.current_step,
    /** Banners/status lines emitted while advancing to `action`. Display before acting. */
    messages,
    action,
    state_summary: {
      sections: state.sections.map((s) => ({
        section_type: s.section_type,
        status: s.status,
        attempt: s.attempt,
        violation_count: s.violation_count,
      })),
      clarification_rounds: state.clarifications.length,
      errors: state.errors.length,
    },
  };
}

export function registerPipelineTools(server: McpServer): void {
  // ─── start_pipeline ─────────────────────────────────────────────────────

  server.tool(
    "start_pipeline",
    "Initialize a new PRD pipeline run. Returns run_id and the first NextAction the host must execute.",
    {
      feature_description: z
        .string()
        .describe("What the PRD is about — passed to all prompts"),
      codebase_path: z
        .string()
        .optional()
        .describe("Absolute path to the codebase. Triggers index_codebase via automatised-pipeline."),
      skip_preflight: z
        .boolean()
        .optional()
        .describe(
          "If true, skip the preflight step that probes Cortex (and ai-architect when codebase_path is set). Default false. Use only when you accept degraded section generation without persistent memory recall.",
        ),
    },
    async ({ feature_description, codebase_path, skip_preflight }) => {
      const run_id = generateRunId();
      const initial = newPipelineState({
        run_id,
        feature_description,
        codebase_path: codebase_path ?? null,
        skip_preflight: skip_preflight ?? false,
      });
      const { state, action, messages } = step({ state: initial });
      // Drain BEFORE persist — same invariant as submit_action_result.
      // The first step is currently `banner` which produces no
      // strategy_executions, but the invariant "every persisted state has
      // an empty queue" must hold at every storage boundary or the queue
      // grows silently when future handlers move toward the entry point
      // (cross-audit feynman CRIT-1 + dijkstra H2, Phase 4 wiring, 2026-04).
      const drained = drainStrategyExecutions(state);
      runStore.set(drained);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(envelope(drained, action, messages), null, 2),
          },
        ],
      };
    },
  );

  // ─── submit_action_result ──────────────────────────────────────────────────

  server.tool(
    "submit_action_result",
    "Feed an ActionResult to the pipeline runner; receive the next NextAction.",
    {
      run_id: z.string(),
      // Use the canonical ActionResultSchema directly. Pre-fix this duplicated
      // the discriminated union inline; adding a new ActionResult kind would
      // have required updating both the canonical schema in orchestration AND
      // this inline copy with no compile-time enforcement of synchrony
      // (cross-audit feynman HIGH-1, Phase 3+4 follow-up, 2026-04).
      result: ActionResultSchema,
    },
    async ({ run_id, result }) => {
      if (inFlight.has(run_id)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `concurrent submission rejected for run_id ${run_id}`,
              }),
            },
          ],
          isError: true,
        };
      }
      inFlight.add(run_id);
      try {
        const current = runStore.get(run_id);
        if (!current) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: `unknown run_id: ${run_id}` }),
              },
            ],
            isError: true,
          };
        }
        const out = step({ state: current, result });
        // Drain strategy_executions BEFORE writing state — keeps the
        // queue from accumulating on disk if the runStore is later
        // backed by persistent storage. drainStrategyExecutions is a
        // no-op when the queue is empty.
        const drained = drainStrategyExecutions(out.state);
        runStore.set(drained);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                envelope(drained, out.action, out.messages),
                null,
                2,
              ),
            },
          ],
        };
      } finally {
        inFlight.delete(run_id);
      }
    },
  );

  // ─── get_pipeline_state ─────────────────────────────────────────────────

  server.tool(
    "get_pipeline_state",
    "Read the current pipeline state by run_id.",
    {
      run_id: z.string(),
      format: z.enum(["full", "summary"]).default("summary"),
    },
    async ({ run_id, format }) => {
      const state = runStore.get(run_id);
      if (!state) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `unknown run_id: ${run_id}` }),
            },
          ],
          isError: true,
        };
      }
      const body =
        format === "full"
          ? JSON.stringify(state, null, 2)
          : JSON.stringify(envelope(state, null), null, 2);
      return { content: [{ type: "text" as const, text: body }] };
    },
  );

  // ─── plan_section_verification ─────────────────────────────────────────────

  server.tool(
    "plan_section_verification",
    "Extract claims from a PRD section and select judges. Returns JudgeRequest[] the host must execute via Agent tool in parallel.",
    {
      section_type: SectionTypeSchema,
      content: z.string(),
      codebase_excerpts: z.array(z.string()).default([]),
      memory_excerpts: z.array(z.string()).default([]),
    },
    async ({ section_type, content, codebase_excerpts, memory_excerpts }) => {
      const plan = planSectionVerification(section_type, content, {
        codebase_excerpts,
        memory_excerpts,
        include_prd_excerpt: true,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(plan, null, 2),
          },
        ],
      };
    },
  );

  // ─── plan_document_verification ────────────────────────────────────────────

  server.tool(
    "plan_document_verification",
    "Same as plan_section_verification but across all sections of a document.",
    {
      sections: z
        .array(
          z.object({
            type: SectionTypeSchema,
            content: z.string(),
          }),
        )
        .min(1),
      codebase_excerpts: z.array(z.string()).default([]),
      memory_excerpts: z.array(z.string()).default([]),
    },
    async ({ sections, codebase_excerpts, memory_excerpts }) => {
      const plan = planDocumentVerification(sections, {
        codebase_excerpts,
        memory_excerpts,
        include_prd_excerpt: true,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(plan, null, 2),
          },
        ],
      };
    },
  );

  // ─── conclude_verification ─────────────────────────────────────────────────

  server.tool(
    "conclude_verification",
    "Aggregate JudgeVerdict[] from spawned subagents into a VerificationReport (consensus + dissent).",
    {
      scope: z.enum(["section", "document"]).default("section"),
      section_type: SectionTypeSchema.optional(),
      verdicts: z.array(JudgeVerdictSchema),
      consensus_strategy: z
        .enum(["weighted_average", "bayesian"])
        .default("weighted_average"),
      run_id: z
        .string()
        .optional()
        .describe(
          "Pipeline run_id — required for calibrated Bayesian reliability weights " +
          "(CC-3 control-arm seam uses this to partition treatment vs control runs). " +
          "When absent, falls back to Beta(7,3) prior for all judges.",
        ),
      claim_types: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Map of claim_id → claim_type. When provided, enables per-(judge × claim_type) " +
          "reliability lookup. Omit to fall back to per-agent scalar priors. " +
          "Source: derive from plan_section_verification / plan_document_verification response: " +
          "{ [req.claim.claim_id]: req.claim.claim_type } for each entry in judge_requests[]. " +
          "TODO(Wave-E): auto-populate from plan state when server-side session context is available.",
        ),
    },
    async ({ scope, section_type, verdicts, consensus_strategy, run_id, claim_types }) => {
      // Wire calibrated reliability for treatment-arm runs.
      // When the repo is unavailable (better-sqlite3 not loaded) or no run_id
      // is provided, options.reliabilityProvider is undefined and the engine
      // falls back to the Beta(7,3) prior — identical to pre-Wave-D behaviour.
      const reliabilityRepo = getReliabilityRepo();
      const reliabilityProvider = getConsensusReliabilityProvider();

      const claimTypesMap = claim_types !== undefined
        ? new Map(Object.entries(claim_types) as [string, string][])
        : undefined;

      // Build the observation flusher (D2.B).
      // Called once per (judge × claim) after consensus resolves each claim.
      // Ground truth = consensus majority (annotator-circularity path;
      // Wave E external oracles will break this circularity).
      // FAILS_ON: DB write error (swallowed — best-effort observation recording).
      const onObservation = reliabilityRepo !== null && claimTypesMap !== undefined
        ? (obs: Parameters<NonNullable<ConcludeOptions["onObservation"]>>[0]) => {
            try {
              // 1. Write to the Beta-posterior SQLite store.
              reliabilityRepo.recordObservation(
                obs.judge,
                obs.claimType,
                obs.observation,
              );
              // 2. Emit to the JSONL audit log (best-effort; non-blocking).
              //    Annotator-circularity path: judge_verdict derived from
              //    consensus majority. Wave E will provide oracle verdicts.
              // judge_verdict = true ↔ judge's verdict is PASS-class.
              // When gt=PASS: judgeWasCorrect=true ↔ judge said PASS (judge_verdict=true).
              // When gt=FAIL: judgeWasCorrect=true ↔ judge said FAIL (judge_verdict=false).
              const judgeVerdictIsPass = !obs.observation.groundTruthIsFail
                ? obs.observation.judgeWasCorrect
                : !obs.observation.judgeWasCorrect;
              appendObservationLog(
                {
                  run_id: run_id ?? "unknown",
                  judge_id: { kind: obs.judge.kind, name: obs.judge.name },
                  claim_id: obs.claim_id,
                  claim_type: obs.claimType,
                  judge_verdict: judgeVerdictIsPass,
                  judge_confidence: 0, // confidence not surfaced here; Wave E will thread it
                  ground_truth: obs.observation.groundTruthIsFail,
                },
                JUDGE_OBSERVATION_LOG_PATH,
              );
            } catch {
              // Best-effort: observation persistence must not break the pipeline.
              // FAILS_ON: DB write error or filesystem unavailable.
            }
          }
        : undefined;

      const concludeOpts: ConcludeOptions = {
        strategy: consensus_strategy,
        reliabilityProvider: reliabilityProvider ?? undefined,
        runId: run_id,
        claimTypes: claimTypesMap as ReadonlyMap<string, import("@prd-gen/core").Claim["claim_type"]> | undefined,
        onObservation,
      };

      const report =
        scope === "document"
          ? concludeDocument(verdicts, concludeOpts)
          : concludeSection(section_type ?? "overview", verdicts, concludeOpts);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    },
  );
}
