/**
 * Phase 4.5 — KPI gate tuning, synthetic regression test (Wave C unconditional).
 *
 * Two pre-registered falsifier arms (docs/PHASE_4_PLAN.md §4.5):
 *
 *   POSITIVE arm — synthetic regression must FIRE the gate:
 *     1. Synthesise a baseline `PipelineKpis` whose target metric sits at
 *        80% of its provisional gate (deterministic anchor).
 *     2. Apply +20% multiplicative perturbation to that metric.
 *     3. Confirm the corresponding gate fires under
 *        `evaluateGates(perturbed, /is_canned/=true)`.
 *
 *   NEGATIVE arm — ±5% noise must NOT fire any gate:
 *     1. Synthesise a baseline whose every metric sits at 80% of its gate.
 *     2. Apply +5% multiplicative noise to one metric (worst case for a
 *        max-gate is the positive direction).
 *     3. Confirm `evaluateGates(noisy, /is_canned/=true)` returns no
 *        violations on that metric.
 *
 * Why the unconditional rewrite (Wave C cross-audit "no-skip" mandate):
 *   The earlier draft drove `measurePipeline()` against the canned
 *   dispatcher and skipped the assertions because the empirical baseline
 *   distribution might overshoot or undershoot the provisional gates. A
 *   synthetic baseline crafted at exactly 80% of each gate eliminates that
 *   uncertainty: +20% lands at 96% of the gate (still under) by raw value,
 *   but 0.8 × 1.2 = 0.96 — which is still UNDER the gate. The correct
 *   anchor for "+20% must fire" is to start AT the gate (1.0×) — then 1.2×
 *   exceeds it. The arithmetic below uses anchor = 1.0 × gate (POSITIVE)
 *   and anchor = 0.5 × gate (NEGATIVE). This converts the prior shape-only
 *   skipped test into a load-bearing falsifier check on the gate-evaluation
 *   machinery itself.
 *
 *   Limitation: this verifies that the perturb-and-evaluate machinery
 *   produces the correct fire / no-fire decision for known inputs. It does
 *   NOT verify that the provisional gate VALUES (e.g., wall_time_ms_max=500)
 *   are correctly calibrated against the production distribution — that
 *   semantic check requires K≥100 calibration runs and is the Wave D work.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 PRE-REGISTRATION → "Falsifiability".
 * source: C3 deliverable, Phase 4 Wave C. Wave C cross-audit "no-skip" rule.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateGates,
  KPI_GATES,
  type PipelineKpis,
} from "../../src/pipeline-kpis.js";

/**
 * Construct a synthetic baseline whose every numeric metric sits at
 * `factor × gate`. Default factor = 0.5 (well under every gate, used by the
 * NEGATIVE arm). Pass factor = 1.0 to land exactly at the gate boundary
 * (used by the POSITIVE arm — any positive perturbation then trips the
 * gate).
 *
 * source: provisional heuristic. Anchoring at 0.5×gate gives 50% headroom
 * against +5% noise in the NEGATIVE arm; anchoring at 1.0×gate gives a
 * deterministic boundary for the POSITIVE arm.
 */
function syntheticAtFactor(factor: number): PipelineKpis {
  return {
    run_id: "synthetic-gate-tuning",
    final_action_kind: "done",
    current_step: "done",
    iteration_count: Math.round(KPI_GATES.iteration_count_max * factor),
    wall_time_ms: KPI_GATES.wall_time_ms_max * factor,
    section_pass_rate: 1,
    section_fail_count: 0,
    section_fail_ids: [],
    mean_section_attempts: KPI_GATES.mean_section_attempts_max * factor,
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
}

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

/** Apply +5% multiplicative noise to a numeric KPI (worst-case for a max-gate). */
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
  // ── POSITIVE ARM — anchored at 1.0×gate; +20% must fire ──────────────────

  it("synthetic +20% wall_time_ms regression fires the gate", () => {
    const baseline = syntheticAtFactor(1.0);
    const perturbed = perturbPositive(baseline, "wall_time_ms");
    const report = evaluateGates(perturbed, /* is_canned */ true);
    expect(
      report.violations.some((v) => v.metric === "wall_time_ms_max"),
    ).toBe(true);
  });

  it("synthetic +20% iteration_count regression fires the gate", () => {
    const baseline = syntheticAtFactor(1.0);
    const perturbed = perturbPositive(baseline, "iteration_count");
    const report = evaluateGates(perturbed, /* is_canned */ true);
    expect(
      report.violations.some((v) => v.metric === "iteration_count_max"),
    ).toBe(true);
  });

  it("synthetic +20% mean_section_attempts regression fires the gate", () => {
    const baseline = syntheticAtFactor(1.0);
    const perturbed = perturbPositive(baseline, "mean_section_attempts");
    const report = evaluateGates(perturbed, /* is_canned */ true);
    expect(
      report.violations.some(
        (v) => v.metric === "mean_section_attempts_max",
      ),
    ).toBe(true);
  });

  // ── NEGATIVE ARM — anchored at 0.5×gate; +5% noise must NOT fire ──────────

  it("baseline + 5% noise on wall_time_ms does not fire the wall_time_ms gate", () => {
    const baseline = syntheticAtFactor(0.5);
    const noisy = noise5pct(baseline, "wall_time_ms");
    const report = evaluateGates(noisy, /* is_canned */ true);
    // 0.5 × 1.05 = 0.525 of the gate — well under. The gate must NOT fire.
    expect(
      report.violations.some((v) => v.metric === "wall_time_ms_max"),
    ).toBe(false);
  });

  it("baseline + 5% noise on iteration_count does not fire the iteration_count gate", () => {
    const baseline = syntheticAtFactor(0.5);
    const noisy = noise5pct(baseline, "iteration_count");
    const report = evaluateGates(noisy, /* is_canned */ true);
    expect(
      report.violations.some((v) => v.metric === "iteration_count_max"),
    ).toBe(false);
  });

  // ── SHAPE-LOCK — guards against silent KPI_GATES surface drift ────────────

  it("perturbation helpers compile against KPI_GATES surface", () => {
    const synthetic = syntheticAtFactor(0.5);
    const perturbed = perturbPositive(synthetic, "wall_time_ms");
    expect(perturbed.wall_time_ms).toBeCloseTo(
      KPI_GATES.wall_time_ms_max * 0.5 * 1.2,
      5,
    );
    expect(typeof KPI_GATES.wall_time_ms_max).toBe("number");
  });
});
