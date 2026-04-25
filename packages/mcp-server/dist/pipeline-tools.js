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
import { z } from "zod";
import { newPipelineState, step, InMemoryRunStore, ActionResultSchema, } from "@prd-gen/orchestration";
import { planSectionVerification, planDocumentVerification, concludeSection, concludeDocument, } from "@prd-gen/verification";
import { SectionTypeSchema, JudgeVerdictSchema, tryCreateEvidenceRepository, } from "@prd-gen/core";
import { EffectivenessTracker } from "@prd-gen/strategy";
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
let _repo = undefined;
let _tracker = null;
function getTracker() {
    if (_repo === undefined) {
        _repo = tryCreateEvidenceRepository();
        if (_repo)
            _tracker = new EffectivenessTracker(_repo);
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
function drainStrategyExecutions(state) {
    if (state.strategy_executions.length === 0)
        return state;
    const tracker = getTracker();
    if (tracker) {
        for (const exec of state.strategy_executions) {
            try {
                tracker.recordExecution({ ...exec, sessionId: state.run_id });
            }
            catch {
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
const inFlight = new Set();
function generateRunId() {
    return ("run_" +
        Date.now().toString(36) +
        "_" +
        Math.random().toString(36).slice(2, 8));
}
function envelope(state, action, messages = []) {
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
export function registerPipelineTools(server) {
    // ─── start_pipeline ─────────────────────────────────────────────────────
    server.tool("start_pipeline", "Initialize a new PRD pipeline run. Returns run_id and the first NextAction the host must execute.", {
        feature_description: z
            .string()
            .describe("What the PRD is about — passed to all prompts"),
        codebase_path: z
            .string()
            .optional()
            .describe("Absolute path to the codebase. Triggers index_codebase via automatised-pipeline."),
    }, async ({ feature_description, codebase_path }) => {
        const run_id = generateRunId();
        const initial = newPipelineState({
            run_id,
            feature_description,
            codebase_path: codebase_path ?? null,
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
                    type: "text",
                    text: JSON.stringify(envelope(drained, action, messages), null, 2),
                },
            ],
        };
    });
    // ─── submit_action_result ──────────────────────────────────────────────────
    server.tool("submit_action_result", "Feed an ActionResult to the pipeline runner; receive the next NextAction.", {
        run_id: z.string(),
        // Use the canonical ActionResultSchema directly. Pre-fix this duplicated
        // the discriminated union inline; adding a new ActionResult kind would
        // have required updating both the canonical schema in orchestration AND
        // this inline copy with no compile-time enforcement of synchrony
        // (cross-audit feynman HIGH-1, Phase 3+4 follow-up, 2026-04).
        result: ActionResultSchema,
    }, async ({ run_id, result }) => {
        if (inFlight.has(run_id)) {
            return {
                content: [
                    {
                        type: "text",
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
                            type: "text",
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
                        type: "text",
                        text: JSON.stringify(envelope(drained, out.action, out.messages), null, 2),
                    },
                ],
            };
        }
        finally {
            inFlight.delete(run_id);
        }
    });
    // ─── get_pipeline_state ─────────────────────────────────────────────────
    server.tool("get_pipeline_state", "Read the current pipeline state by run_id.", {
        run_id: z.string(),
        format: z.enum(["full", "summary"]).default("summary"),
    }, async ({ run_id, format }) => {
        const state = runStore.get(run_id);
        if (!state) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ error: `unknown run_id: ${run_id}` }),
                    },
                ],
                isError: true,
            };
        }
        const body = format === "full"
            ? JSON.stringify(state, null, 2)
            : JSON.stringify(envelope(state, null), null, 2);
        return { content: [{ type: "text", text: body }] };
    });
    // ─── plan_section_verification ─────────────────────────────────────────────
    server.tool("plan_section_verification", "Extract claims from a PRD section and select judges. Returns JudgeRequest[] the host must execute via Agent tool in parallel.", {
        section_type: SectionTypeSchema,
        content: z.string(),
        codebase_excerpts: z.array(z.string()).default([]),
        memory_excerpts: z.array(z.string()).default([]),
    }, async ({ section_type, content, codebase_excerpts, memory_excerpts }) => {
        const plan = planSectionVerification(section_type, content, {
            codebase_excerpts,
            memory_excerpts,
            include_prd_excerpt: true,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(plan, null, 2),
                },
            ],
        };
    });
    // ─── plan_document_verification ────────────────────────────────────────────
    server.tool("plan_document_verification", "Same as plan_section_verification but across all sections of a document.", {
        sections: z
            .array(z.object({
            type: SectionTypeSchema,
            content: z.string(),
        }))
            .min(1),
        codebase_excerpts: z.array(z.string()).default([]),
        memory_excerpts: z.array(z.string()).default([]),
    }, async ({ sections, codebase_excerpts, memory_excerpts }) => {
        const plan = planDocumentVerification(sections, {
            codebase_excerpts,
            memory_excerpts,
            include_prd_excerpt: true,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(plan, null, 2),
                },
            ],
        };
    });
    // ─── conclude_verification ─────────────────────────────────────────────────
    server.tool("conclude_verification", "Aggregate JudgeVerdict[] from spawned subagents into a VerificationReport (consensus + dissent).", {
        scope: z.enum(["section", "document"]).default("section"),
        section_type: SectionTypeSchema.optional(),
        verdicts: z.array(JudgeVerdictSchema),
        consensus_strategy: z
            .enum(["weighted_average", "bayesian"])
            .default("weighted_average"),
    }, async ({ scope, section_type, verdicts, consensus_strategy }) => {
        const report = scope === "document"
            ? concludeDocument(verdicts, { strategy: consensus_strategy })
            : concludeSection(section_type ?? "overview", verdicts, {
                strategy: consensus_strategy,
            });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(report, null, 2),
                },
            ],
        };
    });
}
//# sourceMappingURL=pipeline-tools.js.map