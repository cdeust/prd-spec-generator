/**
 * Pipeline-execution KPIs.
 *
 * Whereas runner.ts measures static document quality (HOR pass rate, cross-ref
 * integrity), this module measures DYNAMIC pipeline behaviour by driving the
 * stateless reducer end-to-end with canned host responses.
 *
 * KPIs surfaced:
 *   - iteration_count:        host-visible step() calls per full run
 *   - wall_time_ms:           elapsed time for the run (canned-only; production
 *                             wall time is dominated by LLM latency, not the
 *                             reducer; treat this as a code-layer cost gate)
 *   - section_pass_rate:      passed sections / planned sections (DERIVED;
 *                             redundant with section_fail_count + planned)
 *   - section_fail_count:     absolute failed sections (catches silent drift)
 *   - section_fail_ids:       categorical identity of failed sections
 *   - mean_section_attempts:  average attempts per section (1.0 = first try)
 *   - error_count:            state.errors.length at completion
 *   - structural_error_count: error_count - section_fail_count (code-layer bugs
 *                             separate from validator strictness)
 *   - judge_dispatch_count:   claims_evaluated extracted from done summary
 *                             (regex-parsed; brittle — needs typed field)
 *   - distribution_pass_rate: judge PASS verdicts / total verdicts
 *                             (canned dispatcher returns 100% PASS by design;
 *                             this gate is suspended on the canned path)
 *
 * source: Phase 3 cross-audit consensus (2026-04) — popper AP-2/4, fermi K1-K5,
 *         shannon S1-S8, curie A1-A9, code-reviewer B1-B3, test-engineer TE1-TE8,
 *         deming, laplace, fisher.
 */

import { performance } from "node:perf_hooks";
import {
  makeCannedDispatcher,
  newPipelineState,
  step,
  type ActionResult,
  type NextAction,
  type PipelineState,
  type StepOutput,
} from "@prd-gen/orchestration";
import type { SectionType } from "@prd-gen/core";

export interface PipelineKpiInput {
  readonly run_id: string;
  readonly license_tier: PipelineState["license_tier"];
  readonly feature_description: string;
  readonly codebase_path?: string;
  /**
   * Host-side dispatcher. The benchmark runs against canned responses by
   * default; pass a custom dispatcher to drive against a real ecosystem.
   */
  readonly craftResult?: (action: NextAction) => ActionResult | undefined;
  /** Defense against runaway loops. Default 200. */
  readonly safety_cap?: number;
}

export interface PipelineKpis {
  readonly run_id: string;
  readonly final_action_kind: NextAction["kind"];
  readonly current_step: PipelineState["current_step"];
  readonly iteration_count: number;
  readonly wall_time_ms: number;
  readonly section_pass_rate: number;
  readonly section_fail_count: number;
  readonly section_fail_ids: ReadonlyArray<SectionType>;
  readonly mean_section_attempts: number;
  readonly error_count: number;
  readonly structural_error_count: number;
  readonly judge_dispatch_count: number;
  readonly distribution_pass_rate: number;
  readonly written_files_count: number;
  readonly safety_cap_hit: boolean;
}

/**
 * source: provisional heuristic; equals the K=200 study size in Phase 4.3 by
 * convention. Tune from production telemetry once we observe iteration depth.
 */
const DEFAULT_SAFETY_CAP = 200;

// ─── measurePipeline (orchestration) ─────────────────────────────────────────

/**
 * Run one pipeline scenario and return KPIs. Pure: no filesystem effects, no
 * MCP calls (unless caller provides a craftResult that has side effects).
 *
 * The function is decomposed into three named helpers to satisfy the §4.2
 * 50-line cap and to make each concern individually testable.
 */
export function measurePipeline(input: PipelineKpiInput): PipelineKpis {
  const cap = input.safety_cap ?? DEFAULT_SAFETY_CAP;
  const dispatch = input.craftResult ?? defaultBenchmarkDispatcher;
  const seed = newPipelineState({
    run_id: input.run_id,
    license_tier: input.license_tier,
    feature_description: input.feature_description,
    codebase_path: input.codebase_path,
  });

  const t0 = performance.now();
  const loop = runPipelineLoop(seed, dispatch, cap);
  const wall_time_ms = performance.now() - t0;

  const sectionKpis = extractSectionKpis(loop.state);
  const summaryKpis = parseSummaryKpis(loop.lastOutput?.action);

  // Direct count of structural errors. Pre-fix this was derived as
  // `error_count - section_fail_count`, which assumed 1-to-1
  // correspondence between section failures and error entries. Now read
  // straight from the `error_kinds` parallel array tagged at every
  // appendError() call site (cross-audit curie H-2, Phase 3+4, 2026-04).
  const structural_error_count = loop.state.error_kinds.filter(
    (k) => k === "structural",
  ).length;

  return {
    run_id: input.run_id,
    final_action_kind: loop.lastOutput?.action.kind ?? "failed",
    current_step: loop.state.current_step,
    // source: test-engineer TE1, code-reviewer fix. Cap-exhaustion path: i
    // is incremented past the last iteration before the loop test fails, so
    // the count is `cap`, not `cap + 1`. Break path: i is the break index;
    // count is `i + 1`. Same for the `pendingResult === undefined` exit
    // (which the new code reports as a distinct exit reason).
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
  };
}

interface LoopOutcome {
  readonly state: PipelineState;
  readonly lastOutput: StepOutput | null;
  /** Number of step() calls actually executed (NOT the for-loop index). */
  readonly iterations: number;
  readonly safety_cap_hit: boolean;
}

function runPipelineLoop(
  seed: PipelineState,
  dispatch: (action: NextAction) => ActionResult | undefined,
  cap: number,
): LoopOutcome {
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

    pendingResult = dispatch(out.action);
    if (pendingResult === undefined) {
      // Dispatcher refused to handle the action — abort cleanly.
      return { state, lastOutput, iterations, safety_cap_hit: false };
    }
  }

  // Exited via cap exhaustion.
  return { state, lastOutput, iterations: cap, safety_cap_hit: true };
}

interface SectionKpis {
  readonly pass_rate: number;
  readonly fail_count: number;
  readonly fail_ids: ReadonlyArray<SectionType>;
  readonly mean_attempts: number;
}

function extractSectionKpis(state: PipelineState): SectionKpis {
  // Exclude the synthetic jira_tickets bucket from the denominator — it is
  // appended by handleJiraGeneration outside the section-generation loop.
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
  /**
   * True iff the typed verification field was present on the done action.
   * Callers can use this to distinguish "judge phase ran with zero claims"
   * (claims_evaluated=0, has_verification=true) from "judge phase did not
   * run / not a done action" (claims_evaluated=0, has_verification=false).
   * Without this distinction, downstream gates cannot tell whether to
   * suspend distribution_pass_rate_max for being uninstrumented.
   */
  readonly has_verification: boolean;
}

/**
 * Read the verification summary off the typed `done.verification` field.
 *
 * source: cross-audit consensus closure (Phase 3+4, 2026-04). Replaces the
 * previous regex-against-prose parser. The typed field is populated by
 * self-check.ts:finalize; tests covering both populated and absent paths
 * live in pipeline-kpis.test.ts.
 *
 * Postcondition: claims_evaluated >= 0; distribution_pass_rate ∈ [0, 1].
 */
function parseSummaryKpis(action: NextAction | undefined): SummaryKpis {
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

// ─── Default canned dispatcher ───────────────────────────────────────────────

/**
 * Default canned-response dispatcher for the benchmark surface. Built from
 * the shared makeCannedDispatcher so behaviour is identical to the smoke
 * harness (apart from the labels that callers can pin via options).
 *
 * source: code-reviewer B1 (Phase 3 cross-audit, 2026-04). Pre-extraction the
 * dispatch logic was duplicated across smoke.test.ts and this module with
 * subtle behavioural drift (different freeform text, missing JIRA path,
 * inconsistent exhaustiveness checks). Three-use rule met (smoke + KPI +
 * planned integration tests) so the abstraction is now justified.
 */
const defaultBenchmarkDispatcher = makeCannedDispatcher({
  freeform_answer: "benchmark-answer",
  graph_path: "/tmp/benchmark/graph",
});

// ─── KPI gates (load-bearing thresholds) ─────────────────────────────────────

/**
 * Quality-gate threshold per KPI. A run that falls below any gate is marked
 * regressed.
 *
 * IMPORTANT: every threshold here is provisional. Phase 4.5 will calibrate
 * these from K≥100 production-shaped runs (per fermi K5 / fisher 4.5 /
 * curie R6) and replace the heuristic with a measured P95 anchored to a
 * frozen baseline.
 *
 * Until then, each gate has a `// source: provisional heuristic` comment so a
 * reader cannot mistake the value for measured data.
 */
export const KPI_GATES = {
  /**
   * source: provisional heuristic. Smoke baseline = 62 iterations on
   * trial+codebase; cap is 100 (~60% headroom). dijkstra cross-audit derived
   * a structural max of 9 emit_message hops; the substantive-action count
   * builds on that. Phase 4.5 will replace with measured P95 + 1σ.
   */
  iteration_count_max: 100,
  /**
   * source: provisional heuristic. Mac M-series canned-run baseline ≈ 5ms,
   * with 100× margin to cover CI startup + locale variance. The previous
   * 5000ms value mistook 5ms × 1000 = 5000 (not 5ms × 10 = 50). The 500ms
   * gate retains 100× headroom while still failing on a 100× regression.
   * Phase 4.5 will replace with measured P95 per machine class.
   */
  wall_time_ms_max: 500,
  /**
   * source: provisional heuristic. Smoke baseline (canned content) shows 5
   * specific sections fail because canned drafts cannot satisfy stricter
   * validators. Gate is set at the baseline so any *increase* surfaces; the
   * known-failing-baseline assertion in smoke.test.ts catches identity
   * drift. Phase 4.5 will tighten once canned content is enriched.
   */
  section_fail_count_max: 5,
  /**
   * source: provisional heuristic. distribution_suspicious fires at ≥1.0 PASS
   * rate (verification/orchestrator.ts). This gate at 0.95 catches the 95%+
   * confirmatory-bias warning band. NOTE: the canned dispatcher returns 100%
   * PASS, so this gate ALWAYS fires on the canned path; the gate is
   * meaningful only on real-ecosystem runs with mixed verdicts. Tests on
   * canned input must set distribution_pass_rate threshold to 1.0 or skip
   * this gate. Phase 4.5 will calibrate the gate against known-good vs
   * known-bad PRDs to set a defensible threshold.
   */
  distribution_pass_rate_max: 0.95,
  /**
   * source: provisional heuristic. error_count ≥ section_fail_count
   * mechanically (each failed section appends one error). Gate at 5 matches
   * section_fail_count_max. Phase 4.5 will split into structural_error_count
   * (gate: 0) + section-failure errors (gate: matches section_fail_count_max).
   */
  error_count_max: 5,
  /**
   * source: derived. safety_cap_hit means a runaway loop was caught; this is
   * always a defect. No tuning required.
   */
  safety_cap_hit_allowed: false,
  /**
   * source: provisional heuristic. mean_section_attempts of 1.0 means every
   * section passes first try; 3.0 means every section needs all retries.
   * Canned baseline measures 1.91 (5 of 11 trial sections exhaust 3
   * attempts because canned drafts cannot satisfy stricter validators).
   * Gate at 2.5 catches a regression where retry rate climbs above 2 per
   * section while accepting the canned-baseline floor. Phase 4.2 will
   * calibrate against the pass-rate-by-attempt distribution from real
   * LLM content (where mean should be near 1.0–1.2).
   */
  mean_section_attempts_max: 2.5,
  /**
   * source: derived. Any structural error (handler bug, code-layer fault) is
   * a defect. No tuning required.
   */
  structural_error_count_max: 0,
} as const;

export interface KpiGateReport {
  readonly passed: boolean;
  readonly violations: ReadonlyArray<{
    metric: keyof typeof KPI_GATES;
    actual: number | boolean;
    threshold: number | boolean;
  }>;
}

/**
 * Evaluate KPIs against the provisional gates.
 *
 * The `is_canned_dispatcher` parameter suspends the distribution_pass_rate
 * gate on canned-response runs — popper AP-2 / fermi K4 / shannon S4 / curie
 * A6 cross-audit found the gate fires unconditionally on canned PASS verdicts.
 * Real-ecosystem runs should pass `false` (or omit) to enable the gate.
 */
export function evaluateGates(
  kpis: PipelineKpis,
  is_canned_dispatcher = false,
): KpiGateReport {
  const violations: Array<{
    metric: keyof typeof KPI_GATES;
    actual: number | boolean;
    threshold: number | boolean;
  }> = [];

  // Numeric gates as a dispatch table. Each entry pairs a metric key with
  // its actual value; gate suspension predicates (per dijkstra H3 + the
  // canned-dispatcher distribution gate) are encoded as `enabled` flags.
  const numericGates: ReadonlyArray<{
    metric: keyof typeof KPI_GATES;
    actual: number;
    enabled: boolean;
  }> = [
    { metric: "iteration_count_max", actual: kpis.iteration_count, enabled: true },
    { metric: "wall_time_ms_max", actual: kpis.wall_time_ms, enabled: true },
    { metric: "section_fail_count_max", actual: kpis.section_fail_count, enabled: true },
    { metric: "distribution_pass_rate_max", actual: kpis.distribution_pass_rate, enabled: !is_canned_dispatcher },
    { metric: "error_count_max", actual: kpis.error_count, enabled: true },
    // Skip mean_section_attempts on cap-hit (dijkstra H3): pending sections
    // (attempt=0) deflate the unconditional mean and render the gate
    // uninformative; safety_cap_hit_allowed already fires on cap-hit.
    { metric: "mean_section_attempts_max", actual: kpis.mean_section_attempts, enabled: !kpis.safety_cap_hit },
    { metric: "structural_error_count_max", actual: kpis.structural_error_count, enabled: true },
  ];

  for (const g of numericGates) {
    if (!g.enabled) continue;
    const threshold = KPI_GATES[g.metric] as number;
    if (g.actual > threshold) {
      violations.push({ metric: g.metric, actual: g.actual, threshold });
    }
  }

  // Boolean gate (separate from numerics — the comparison is not >).
  if (kpis.safety_cap_hit && !KPI_GATES.safety_cap_hit_allowed) {
    violations.push({
      metric: "safety_cap_hit_allowed",
      actual: kpis.safety_cap_hit,
      threshold: KPI_GATES.safety_cap_hit_allowed,
    });
  }

  return { passed: violations.length === 0, violations };
}
