/**
 * Production-mode dispatcher: delegates LLM-driven actions through an
 * `AgentInvoker` instead of returning canned responses.
 *
 * Wave F (sub-stream F2) — companion to {@link makeCannedDispatcher}. The
 * canned dispatcher is the deterministic synthetic baseline used for
 * Wave E §4.5 calibration; the production dispatcher is the on-ramp for
 * the FOLLOW-UP K=100 production batch that promotes the gates currently
 * tagged `hold_provisional` (`wall_time_ms_max`, `cortex_recall_empty_count_max`).
 *
 * Design contract:
 *
 *   - LLM-driven actions (`spawn_subagents`, the `recall` arm of
 *     `call_cortex_tool`) are delegated to an injected
 *     {@link AgentInvoker}. Production wires this to the host's real
 *     subagent surface; tests/pilot wire it to a stub.
 *
 *   - Non-LLM actions (`ask_user`, `index_codebase` arm of pipeline tools,
 *     `write_file`) reuse the canned helpers, because their behaviour is
 *     deterministic by construction — they do not consume LLM tokens or
 *     introduce real-world latency that the calibration cares about.
 *
 *   - Terminal actions (`done`, `failed`) return undefined to match the
 *     existing dispatcher contract consumed by `runPipelineLoop` in
 *     `packages/benchmark/src/pipeline-kpis.ts`.
 *
 * Layer contract (§2.2): orchestration-internal. Imports only from
 * `./types/actions.js` and the existing `./canned-dispatcher.js`. No
 * dependency on `@prd-gen/ecosystem-adapters` or `@prd-gen/benchmark`.
 *
 * source: Wave F2 brief — production-mode calibration runner.
 */

import type { ActionResult, NextAction } from "./types/actions.js";
import {
  makeCannedDispatcher,
  type CannedDispatcherOptions,
} from "./canned-dispatcher.js";

// ─── AgentInvoker contract ──────────────────────────────────────────────────

/**
 * One subagent invocation request. Mirrors the structure produced inside the
 * `spawn_subagents` action — `invocation_id` carries the routing prefix that
 * the host uses to choose the subagent template.
 */
export interface AgentInvocationRequest {
  readonly invocation_id: string;
  /** Batch-level observability label (judge|draft|review). */
  readonly purpose: string;
  /** Routing token; the host uses this to select a subagent template. */
  readonly subagent_type: string;
  readonly prompt: string;
}

/** One subagent response — `raw_text` is the agent's freeform reply. */
export interface AgentInvocationResponse {
  readonly invocation_id: string;
  readonly raw_text: string;
}

/**
 * Cortex-recall request. Mirrors the {tool_name: "recall", input: …} arm of
 * `call_cortex_tool`. Production cortex returns hits; the canned dispatcher
 * returns an empty array (which is why `cortex_recall_empty_count` is high
 * on the canned baseline).
 */
export interface CortexRecallRequest {
  readonly correlation_id: string;
  readonly query: string;
}

export interface CortexRecallHit {
  readonly content: string;
  readonly score?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface CortexRecallResponse {
  readonly results: ReadonlyArray<CortexRecallHit>;
  readonly total: number;
}

/**
 * Production agent invoker. Pure interface so:
 *   - production wires it to the host's real subagent surface
 *     (Claude Code Agent tool, queued via `HostQueueSubagentClient`); and
 *   - tests + pilot runs wire it to a stub that simulates latency and
 *     non-empty cortex recalls without paying LLM tokens.
 *
 * Both methods are async — the canned dispatcher synchronously returns a
 * pre-baked answer; the production dispatcher MUST await real I/O. The
 * caller (the pipeline loop) must therefore consume an async dispatcher.
 */
export interface AgentInvoker {
  invokeSubagentBatch(
    requests: ReadonlyArray<AgentInvocationRequest>,
  ): Promise<ReadonlyArray<AgentInvocationResponse>>;
  invokeCortexRecall(
    request: CortexRecallRequest,
  ): Promise<CortexRecallResponse>;
}

// ─── Async dispatcher type ──────────────────────────────────────────────────

/**
 * Async variant of {@link CannedDispatcher}. The pipeline loop's existing
 * synchronous dispatcher type is kept intact for the canned path; the
 * production runner uses {@link runProductionPipelineLoop} which awaits.
 */
export type ProductionDispatcher = (
  action: NextAction,
) => Promise<ActionResult | undefined>;

// ─── Configuration ──────────────────────────────────────────────────────────

export interface ProductionDispatcherOptions {
  readonly agentInvoker: AgentInvoker;
  /**
   * Options applied to the underlying canned dispatcher used for non-LLM
   * actions (ask_user, index_codebase, write_file). Defaults match the
   * benchmark's existing canned setup so the production-mode pilot's
   * non-LLM behaviour is identical to the canned baseline.
   */
  readonly cannedOptions?: CannedDispatcherOptions;
}

// ─── Implementation ─────────────────────────────────────────────────────────

/**
 * Build a production dispatcher. Returns an async function: every caller
 * must `await` the result before feeding it back to `step({ ..., result })`.
 *
 * Precondition: `opts.agentInvoker` is non-null.
 * Postcondition: the returned dispatcher resolves with `undefined` for
 *   terminal actions (`done`, `failed`); resolves with an `ActionResult`
 *   for every other action kind enumerated in `NextAction`.
 */
export function makeProductionDispatcher(
  opts: ProductionDispatcherOptions,
): ProductionDispatcher {
  if (opts.agentInvoker == null) {
    throw new Error("makeProductionDispatcher: agentInvoker is required");
  }
  const fallback = makeCannedDispatcher(opts.cannedOptions ?? {});
  const invoker = opts.agentInvoker;

  return async function dispatch(
    action: NextAction,
  ): Promise<ActionResult | undefined> {
    switch (action.kind) {
      case "spawn_subagents": {
        const requests = action.invocations.map((inv) => ({
          invocation_id: inv.invocation_id,
          purpose: action.purpose,
          subagent_type: inv.subagent_type,
          prompt: inv.prompt,
        }));
        const responses = await invoker.invokeSubagentBatch(requests);
        return {
          kind: "subagent_batch_result",
          batch_id: action.batch_id,
          responses: responses.map((r) => ({
            invocation_id: r.invocation_id,
            raw_text: r.raw_text,
          })),
        };
      }
      case "call_cortex_tool": {
        if (action.tool_name === "recall") {
          // Recall input shape matches Cortex MCP `recall` tool contract:
          //   { query: string, ... } — extract the query field if present.
          const args = (action.arguments ?? {}) as { query?: unknown };
          const query =
            typeof args.query === "string" ? args.query : "";
          const recall = await invoker.invokeCortexRecall({
            correlation_id: action.correlation_id,
            query,
          });
          return {
            kind: "tool_result",
            correlation_id: action.correlation_id,
            success: true,
            data: { results: recall.results, total: recall.total },
          };
        }
        // Non-recall cortex tools (e.g. remember) don't drive
        // cortex_recall_empty_count; defer to canned for now.
        return fallback(action);
      }
      // Non-LLM actions — deterministic, no LLM cost, no production latency
      // contribution worth simulating. Reuse the canned implementation.
      case "ask_user":
      case "call_pipeline_tool":
      case "write_file":
        return fallback(action);
      case "done":
      case "failed":
        return undefined;
      default: {
        const _exhaustive: never = action;
        throw new Error(
          `productionDispatcher: unhandled action.kind=${(action as NextAction).kind}. ` +
            `Add a case to the dispatch switch.`,
        );
      }
    }
  };
}

// ─── Stub invoker (pilot + tests) ───────────────────────────────────────────

export interface StubAgentInvokerOptions {
  /**
   * Synthetic per-invocation latency floor (milliseconds). Default 500.
   * source: Wave F2 brief — pilot must observe wall_time_ms in the
   *   10000-100000ms range, which means each subagent call must take
   *   ≥500ms to realistically simulate production behaviour.
   */
  readonly latencyMinMs?: number;
  /**
   * Synthetic per-invocation latency ceiling (milliseconds). Default 2000.
   */
  readonly latencyMaxMs?: number;
  /**
   * Probability that a cortex recall returns ≥1 hit (warm-cortex
   * simulation). Default 0.7 — meaning ~30% of recalls remain empty,
   * which lines up with realistic warm-but-imperfect production caches.
   * source: Wave F2 brief — production cortex is "warmer" than the
   *   canned baseline (which returns 100% empty).
   */
  readonly warmCortexHitProbability?: number;
  /**
   * Deterministic RNG. Default `Math.random`. Tests inject a seeded PRNG
   * so the pilot is reproducible.
   */
  readonly rng?: () => number;
  /**
   * Sleep function. Default uses `setTimeout`-based promise. Tests can
   * inject a no-op to exercise the dispatch logic without burning seconds.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Synthetic raw_text supplier. Default returns a one-line stub; the
   * canned dispatcher's section drafts (which include FR/AC tables that
   * the claim extractor recognises) are NOT reused here because the
   * pilot's purpose is calibration of latency + recall, not section quality.
   * source: Wave F2 brief.
   */
  readonly rawTextFor?: (request: AgentInvocationRequest) => string;
}

const DEFAULT_LATENCY_MIN_MS = 500;
const DEFAULT_LATENCY_MAX_MS = 2000;
const DEFAULT_WARM_HIT_PROB = 0.7;

const realSleep: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Test/pilot stub for {@link AgentInvoker}. Simulates production-shape
 * latency and warm-cortex behaviour without invoking any real LLM.
 *
 * source: Wave F2.C — pilot stub for the production-mode calibration runner.
 */
export function makeStubAgentInvoker(
  opts: StubAgentInvokerOptions = {},
): AgentInvoker {
  const latencyMin = opts.latencyMinMs ?? DEFAULT_LATENCY_MIN_MS;
  const latencyMax = opts.latencyMaxMs ?? DEFAULT_LATENCY_MAX_MS;
  const warmHitProb = opts.warmCortexHitProbability ?? DEFAULT_WARM_HIT_PROB;
  const rng = opts.rng ?? Math.random;
  const sleep = opts.sleep ?? realSleep;
  const rawTextFor =
    opts.rawTextFor ??
    ((req: AgentInvocationRequest) =>
      `stub-response for invocation_id=${req.invocation_id}`);

  function pickLatency(): number {
    return latencyMin + Math.floor(rng() * Math.max(1, latencyMax - latencyMin));
  }

  return {
    async invokeSubagentBatch(requests) {
      // Simulate the host fanning out N subagents in parallel: total
      // wall-time is the MAX latency, not the sum.
      const ms = pickLatency();
      await sleep(ms);
      return requests.map((r) => ({
        invocation_id: r.invocation_id,
        raw_text: rawTextFor(r),
      }));
    },
    async invokeCortexRecall(request) {
      await sleep(Math.max(10, Math.floor(pickLatency() / 5)));
      const hit = rng() < warmHitProb;
      if (!hit) {
        return { results: [], total: 0 };
      }
      return {
        results: [
          {
            content: `stub-recall-hit for query="${request.query.slice(0, 80)}"`,
            score: 0.5 + rng() * 0.5,
          },
        ],
        total: 1,
      };
    },
  };
}
