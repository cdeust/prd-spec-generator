/**
 * Async sibling of `measurePipeline` — drives the stateless reducer with a
 * dispatcher that returns Promises. Used by the production-mode calibration
 * runner (Wave F2).
 *
 * The synchronous `measurePipeline` is unchanged; production dispatchers
 * cannot be expressed synchronously because real subagent calls (and
 * Cortex MCP recall) are inherently async.
 *
 * Layer contract (§2.2): identical to `pipeline-kpis.ts` — orchestration +
 * core type re-exports + this package's instrumentation. No filesystem or
 * network I/O in this module; the caller's dispatcher owns I/O.
 *
 * source: Wave F2 brief — production-mode runner consumes async dispatch.
 */

import { performance } from "node:perf_hooks";
import {
  newPipelineState,
  step,
  type ActionResult,
  type NextAction,
  type PipelineState,
  type StepOutput,
} from "@prd-gen/orchestration";
import type { PipelineKpis, PipelineKpiInput } from "./pipeline-kpis.js";
import { extractMismatchEvents } from "./instrumentation.js";

const DEFAULT_SAFETY_CAP = 200;

/**
 * Async dispatcher contract — mirror of the sync craftResult, but Promise-bearing.
 */
export type AsyncDispatch = (
  action: NextAction,
) => Promise<ActionResult | undefined>;

export interface AsyncPipelineKpiInput
  extends Omit<PipelineKpiInput, "craftResult"> {
  readonly dispatch: AsyncDispatch;
}

/**
 * Async equivalent of {@link measurePipeline}. Same KPI envelope; the only
 * behavioural difference is the loop awaits the dispatcher.
 *
 * Precondition: input.dispatch is non-null.
 * Postcondition: returns a {@link PipelineKpis} record whose
 *   `wall_time_ms` includes the awaited latency of every dispatch call.
 */
export async function measurePipelineAsync(
  input: AsyncPipelineKpiInput,
): Promise<PipelineKpis> {
  if (input.dispatch == null) {
    throw new Error("measurePipelineAsync: dispatch is required");
  }
  const cap = input.safety_cap ?? DEFAULT_SAFETY_CAP;
  const seed = newPipelineState({
    run_id: input.run_id,
    feature_description: input.feature_description,
    codebase_path: input.codebase_path,
  });

  const t0 = performance.now();
  const loop = await runAsyncPipelineLoop(seed, input.dispatch, cap);
  const wall_time_ms = performance.now() - t0;

  const sectionKpis = extractAsyncSectionKpis(loop.state);
  const summaryKpis = parseAsyncSummaryKpis(loop.lastOutput?.action);
  const structural_error_count = loop.state.error_kinds.filter(
    (k) => k === "structural",
  ).length;
  const mismatchExtraction = extractMismatchEvents(loop.state);

  return {
    run_id: input.run_id,
    final_action_kind: loop.lastOutput?.action.kind ?? "failed",
    current_step: loop.state.current_step,
    iteration_count: loop.safety_cap_hit ? cap : loop.iterations,
    wall_time_ms,
    section_pass_rate: sectionKpis.pass_rate,
    section_fail_count: sectionKpis.fail_count,
    section_fail_ids: sectionKpis.fail_ids,
    mean_section_attempts: sectionKpis.mean_attempts,
    error_count: loop.state.errors.length,
    structural_error_count,
    judge_dispatch_count: summaryKpis.claims_evaluated,
    distribution_pass_rate: summaryKpis.distribution_pass_rate,
    written_files_count: loop.state.written_files.length,
    safety_cap_hit: loop.safety_cap_hit,
    mismatch_fired: mismatchExtraction.fired,
    mismatch_kinds: mismatchExtraction.distinctKinds,
    cortex_recall_empty_count: loop.state.cortex_recall_empty_count,
  };
}

interface LoopOutcome {
  readonly state: PipelineState;
  readonly lastOutput: StepOutput | null;
  readonly iterations: number;
  readonly safety_cap_hit: boolean;
}

async function runAsyncPipelineLoop(
  seed: PipelineState,
  dispatch: AsyncDispatch,
  cap: number,
): Promise<LoopOutcome> {
  let state: PipelineState = seed;
  let pendingResult: ActionResult | undefined = undefined;
  let lastOutput: StepOutput | null = null;
  let iterations = 0;

  for (let i = 0; i < cap; i++) {
    const out = step({ state, result: pendingResult });
    lastOutput = out;
    state = out.state;
    iterations = i + 1;

    if (out.action.kind === "done" || out.action.kind === "failed") {
      return { state, lastOutput, iterations, safety_cap_hit: false };
    }

    pendingResult = await dispatch(out.action);
    if (pendingResult === undefined) {
      return { state, lastOutput, iterations, safety_cap_hit: false };
    }
  }

  return { state, lastOutput, iterations: cap, safety_cap_hit: true };
}

// Section-KPI helpers duplicate the (private) sync versions in pipeline-kpis.ts.
// Justified by §2.2: the sync helpers are not exported, and re-exporting them
// would broaden pipeline-kpis.ts's public surface for one async sibling.
// The two implementations are mechanically identical and exercised by the
// async-runner round-trip test.

interface SectionKpis {
  readonly pass_rate: number;
  readonly fail_count: number;
  readonly fail_ids: ReadonlyArray<PipelineKpis["section_fail_ids"][number]>;
  readonly mean_attempts: number;
}

function extractAsyncSectionKpis(state: PipelineState): SectionKpis {
  const sections = state.sections.filter(
    (s) => s.section_type !== "jira_tickets",
  );
  const passed = sections.filter((s) => s.status === "passed").length;
  const failed = sections.filter((s) => s.status === "failed");
  const planned = sections.length;
  return {
    pass_rate: planned > 0 ? passed / planned : 0,
    fail_count: failed.length,
    fail_ids: failed.map((s) => s.section_type),
    mean_attempts:
      planned > 0
        ? sections.reduce((sum, s) => sum + s.attempt, 0) / planned
        : 0,
  };
}

interface SummaryKpis {
  readonly claims_evaluated: number;
  readonly distribution_pass_rate: number;
  readonly has_verification: boolean;
}

function parseAsyncSummaryKpis(action: NextAction | undefined): SummaryKpis {
  if (action?.kind !== "done" || !action.verification) {
    return {
      claims_evaluated: 0,
      distribution_pass_rate: 0,
      has_verification: false,
    };
  }
  const v = action.verification;
  const claims = v.claims_evaluated;
  const passVotes = v.distribution.PASS ?? 0;
  return {
    claims_evaluated: claims,
    distribution_pass_rate: claims > 0 ? passVotes / claims : 0,
    has_verification: true,
  };
}
