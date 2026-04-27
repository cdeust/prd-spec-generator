/**
 * Phase 4.5 — KPI gate tuning, synthetic +20% regression test.
 *
 * Two pre-registered falsifier arms (docs/PHASE_4_PLAN.md §4.5):
 *
 *   POSITIVE arm — synthetic regression must FIRE the gate:
 *     1. Take the canned baseline (`measurePipeline` with the default
 *        canned dispatcher).
 *     2. Apply a synthetic +20% perturbation to ONE KPI at a time
 *        (inject artificial wall_time, fail random sections, etc.).
 *     3. Confirm the corresponding gate fires under
 *        evaluateGates(perturbed, /is_canned=true/).
 *
 *   NEGATIVE arm — ±5% noise must NOT fire any gate:
 *     1. Take the canned baseline UNPERTURBED.
 *     2. Apply ±5% multiplicative noise to numeric KPIs.
 *     3. Confirm `evaluateGates(noisy, true)` returns no violations.
 *
 * Both arms are CURRENTLY skipped (`it.skip`) because:
 *   - The calibrated per-machine-class wall_time_ms gate (Phase 4.5)
 *     does not yet exist; the K≥100 calibration runs against the frozen
 *     Wave-B baseline have not been run.
 *   - Several gates (iteration_count_max, distribution_pass_rate_max,
 *     mean_section_attempts_max) are still provisional heuristics and
 *     have NOT been recalibrated against the frozen-baseline distribution.
 *
 * The test SHAPE is locked here so when 4.5 finalisation lands, only the
 * `it.skip` → `it` flip and the gate-set parameterisation are needed.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 PRE-REGISTRATION → "Falsifiability".
 * source: C3 deliverable, Phase 4 Wave C.
 */

import { describe, it, expect } from "vitest";
import {
  measurePipeline,
  evaluateGates,
  KPI_GATES,
  type PipelineKpis,
} from "../../src/pipeline-kpis.js";

/** Apply +20% multiplicative perturbation to a numeric KPI. */
function perturbPositive<K extends keyof PipelineKpis>(
  kpis: PipelineKpis,
  metric: K,
): PipelineKpis {
  const cur = kpis[metric];
  if (typeof cur !== "number") {
    throw new Error(`perturbPositive: ${String(metric)} is not numeric`);
  }
  return { ...kpis, [metric]: cur * 1.2 };
}

/**
 * Apply ±5% noise to a numeric KPI. Deterministic per-call (no RNG) so the
 * test is reproducible — alternates +5% and -5% across calls would also
 * work, but we use a fixed +5% here (worst case for a max-gate is the
 * positive direction).
 */
function noise5pct<K extends keyof PipelineKpis>(
  kpis: PipelineKpis,
  metric: K,
): PipelineKpis {
  const cur = kpis[metric];
  if (typeof cur !== "number") {
    throw new Error(`noise5pct: ${String(metric)} is not numeric`);
  }
  return { ...kpis, [metric]: cur * 1.05 };
}

describe("Phase 4.5 — KPI gate tuning regression test (synthetic)", () => {
  // POSITIVE ARM — +20% perturbation must fire the corresponding gate.
  // SKIPPED until 4.5 publishes calibrated thresholds; the test asserts
  // gate FIRING relative to the calibrated baseline distribution, which
  // does not exist yet (provisional heuristics may pass a +20% perturbation
  // by accident if their headroom > 20%).
  it.skip("synthetic +20% wall_time_ms regression fires the gate", () => {
    const baseline = measurePipeline({
      run_id: "phase4_5-pos-walltime",
      feature_description: "synthetic regression baseline",
    });
    const perturbed = perturbPositive(baseline, "wall_time_ms");
    const report = evaluateGates(perturbed, /* is_canned */ true);
    expect(
      report.violations.some((v) => v.metric === "wall_time_ms_max"),
    ).toBe(true);
  });

  it.skip("synthetic +20% iteration_count regression fires the gate", () => {
    const baseline = measurePipeline({
      run_id: "phase4_5-pos-iter",
      feature_description: "synthetic regression baseline",
    });
    const perturbed = perturbPositive(baseline, "iteration_count");
    const report = evaluateGates(perturbed, /* is_canned */ true);
    expect(
      report.violations.some((v) => v.metric === "iteration_count_max"),
    ).toBe(true);
  });

  it.skip("synthetic +20% mean_section_attempts regression fires the gate", () => {
    const baseline = measurePipeline({
      run_id: "phase4_5-pos-mean-attempts",
      feature_description: "synthetic regression baseline",
    });
    const perturbed = perturbPositive(baseline, "mean_section_attempts");
    const report = evaluateGates(perturbed, /* is_canned */ true);
    expect(
      report.violations.some(
        (v) => v.metric === "mean_section_attempts_max",
      ),
    ).toBe(true);
  });

  // NEGATIVE ARM — ±5% noise must not fire any gate. Skipped because the
  // baseline gates are provisional and may already be tight enough that
  // +5% noise on, e.g., wall_time_ms tips over a too-tight gate. Once
  // calibrated, the false-positive rate must be ≤ (1 - confidence level).
  it.skip("baseline + 5% noise on wall_time_ms does not fire any gate", () => {
    const baseline = measurePipeline({
      run_id: "phase4_5-neg-walltime",
      feature_description: "synthetic regression baseline",
    });
    const noisy = noise5pct(baseline, "wall_time_ms");
    const report = evaluateGates(noisy, /* is_canned */ true);
    expect(report.violations).toEqual([]);
  });

  it.skip("baseline + 5% noise on iteration_count does not fire any gate", () => {
    const baseline = measurePipeline({
      run_id: "phase4_5-neg-iter",
      feature_description: "synthetic regression baseline",
    });
    const noisy = noise5pct(baseline, "iteration_count");
    const report = evaluateGates(noisy, /* is_canned */ true);
    expect(report.violations).toEqual([]);
  });

  // SHAPE-LOCK: this test runs unconditionally to make sure the
  // gate-key surface + perturbation helpers continue to compile.
  // It does NOT exercise the 4.5 falsifier semantics — it merely guards
  // against silent type drift on KPI_GATES.
  it("perturbation helpers compile against KPI_GATES surface", () => {
    const synthetic: PipelineKpis = {
      run_id: "synthetic",
      final_action_kind: "done",
      current_step: "done",
      iteration_count: 50,
      wall_time_ms: 100,
      section_pass_rate: 1,
      section_fail_count: 0,
      section_fail_ids: [],
      mean_section_attempts: 1.5,
      error_count: 0,
      structural_error_count: 0,
      judge_dispatch_count: 0,
      distribution_pass_rate: 1,
      written_files_count: 0,
      safety_cap_hit: false,
      mismatch_fired: false,
      mismatch_kinds: [],
      cortex_recall_empty_count: 0,
    };
    const perturbed = perturbPositive(synthetic, "wall_time_ms");
    expect(perturbed.wall_time_ms).toBeCloseTo(120, 5);
    // Sanity: the symbol KPI_GATES is reachable so the test asserts
    // against the same surface a future un-skipped run will use.
    expect(typeof KPI_GATES.wall_time_ms_max).toBe("number");
  });
});
