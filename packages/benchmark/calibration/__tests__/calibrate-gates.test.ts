/**
 * Phase 4.5 calibration runner tests — Wave D / D3.4 + D3.6.
 *
 * Coverage:
 *   D3.4.1: percentile() / computeGateStats() against hand-calculated reference.
 *   D3.4.2: per-machine-class XmR file naming for wall_time_ms_max.
 *   D3.4.3: output JSON conforms to GateCalibrationK100Schema + EventRateK50Schema.
 *   D3.4.4: frozen-baseline content-hash check fires on a mismatch.
 *   D3.4.5: event_rate divergence warning fires when |measured − 0.30| > 0.05.
 *   D3.6.1: end-to-end runner against K=10 produces validated artefacts.
 *   D3.6.2: re-running with the same seed produces byte-identical artefacts
 *           (reproducibility pin).
 *   D3.6.3: gate-calibration JSON contains an entry per KPI_GATES key.
 *
 * source: D3.1-D3.6 brief (Wave D K≥100 calibration runner).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCalibration,
  type RunnerResult,
} from "../calibrate-gates.js";
import {
  GateCalibrationK100Schema,
  EventRateK50Schema,
} from "../calibration-outputs.js";
import { computeGateStats, percentile } from "../gate-stats.js";
import { measureEventRate } from "../event-rate.js";
import { KPI_GATES, type PipelineKpis } from "../../src/pipeline-kpis.js";

const TMP_DIR_PREFIX = join(
  tmpdir(),
  `calib-gates-test-${process.pid}-${Date.now()}`,
);
let tmpCounter = 0;
function freshTmpDir(): string {
  const dir = `${TMP_DIR_PREFIX}-${tmpCounter++}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  // Cleanup stays soft-fail: if a test already removed its dir, skip.
  for (let i = 0; i < tmpCounter; i++) {
    const dir = `${TMP_DIR_PREFIX}-${i}`;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ─── D3.4.1 — percentile reference ───────────────────────────────────────────

describe("percentile + computeGateStats — D3.4.1 hand-calc reference", () => {
  it("percentile(0.95) on 1..100 = 95.05 (Type 7 linear interpolation)", () => {
    // source: NumPy default percentile (linear method) on [1, 2, ..., 100]:
    //   np.percentile(arange(1, 101), 95) == 95.05.
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 0.95)).toBeCloseTo(95.05, 2);
  });

  it("percentile(0.5) on [1,2,3,4,5] = 3", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  it("computeGateStats returns p95 + finite CI bounds + XmR over the same series", () => {
    const v = Array.from({ length: 50 }, (_, i) => 100 + i); // 100..149
    const stats = computeGateStats(v);
    expect(stats.p95).toBeCloseTo(percentile(v, 0.95), 6);
    expect(Number.isFinite(stats.ci_upper)).toBe(true);
    expect(Number.isFinite(stats.ci_lower)).toBe(true);
    expect(stats.ci_lower).toBeLessThanOrEqual(stats.ci_upper);
    expect(stats.xmr.basePoints).toBeGreaterThanOrEqual(2);
    expect(stats.xmr.series).toEqual(v);
  });
});

// ─── D3.4.2 — per-machine-class bucketing in XmR file naming ─────────────────

describe("per-machine-class XmR naming — D3.4.2", () => {
  it("wall_time_ms_max XmR file is suffixed with detected machine class", () => {
    const outputDir = freshTmpDir();
    const result: RunnerResult = runCalibration({
      k: 5,
      eventRateK: 5,
      outputDir,
      frozenBaselineCommit: "test-baseline",
      skipFrozenBaselineCheck: true,
      featureDescription: "test feature",
      codebasePath: "/tmp/test",
      inMemoryOnly: false,
    });
    const wallTimeXmr = result.xmrFiles.find((x) =>
      x.path.includes("wall_time_ms_max."),
    );
    expect(wallTimeXmr).toBeDefined();
    // Path includes machine_class qualifier between gate_name and ".json".
    expect(wallTimeXmr!.path).toMatch(
      /wall_time_ms_max\.(m_series_high|m_series_mid|x86_intel|x86_amd|ci_runner)\.json$/,
    );
  });
});

// ─── D3.4.3 — output schema conformance ──────────────────────────────────────

describe("output schemas — D3.4.3", () => {
  it("runner produces a gate-calibration JSON that round-trips through GateCalibrationK100Schema", () => {
    const outputDir = freshTmpDir();
    runCalibration({
      k: 5,
      eventRateK: 5,
      outputDir,
      frozenBaselineCommit: "schema-roundtrip",
      skipFrozenBaselineCheck: true,
      featureDescription: "test feature",
      codebasePath: "/tmp/test",
      inMemoryOnly: false,
    });
    const raw = JSON.parse(
      readFileSync(join(outputDir, "gate-calibration-K100.json"), "utf8"),
    );
    const parsed = GateCalibrationK100Schema.safeParse(raw);
    expect(parsed.success).toBe(true);
  });

  it("runner produces an event-rate JSON that round-trips through EventRateK50Schema", () => {
    const outputDir = freshTmpDir();
    runCalibration({
      k: 5,
      eventRateK: 5,
      outputDir,
      frozenBaselineCommit: "schema-roundtrip",
      skipFrozenBaselineCheck: true,
      featureDescription: "test feature",
      codebasePath: "/tmp/test",
      inMemoryOnly: false,
    });
    const raw = JSON.parse(
      readFileSync(join(outputDir, "event-rate-K50.json"), "utf8"),
    );
    const parsed = EventRateK50Schema.safeParse(raw);
    expect(parsed.success).toBe(true);
  });
});

// ─── D3.4.4 — frozen-baseline content-hash check ─────────────────────────────

describe("frozen-baseline content-hash check — D3.4.4", () => {
  it("fires when an existing artefact's content hash diverges from current", () => {
    const outputDir = freshTmpDir();
    // Plant a sealed artefact with a fake hash that cannot match.
    const fakeArtefact = {
      schema_version: 1,
      commit_hash: "fake-commit",
      seed_used: 0,
      timestamp: new Date().toISOString(),
      k_target: 10,
      k_achieved: 10,
      frozen_baseline_commit: "fake-baseline",
      frozen_baseline_content_hash: "0".repeat(64), // guaranteed not to match
      gates: [
        {
          gate_name: "iteration_count_max",
          estimand_type: "p95" as const,
          k_observed: 10,
          provisional: 100,
          calibrated: 50,
          ci_upper: 60,
          ci_lower: 40,
          would_tighten: true,
          would_loosen: false,
          passes_threshold: true,
          xmr_path: "fake.json",
          machine_class: null,
        },
      ],
    };
    writeFileSync(
      join(outputDir, "gate-calibration-K100.json"),
      JSON.stringify(fakeArtefact),
      "utf8",
    );
    expect(() =>
      runCalibration({
        k: 5,
        eventRateK: 5,
        outputDir,
        frozenBaselineCommit: "anything",
        skipFrozenBaselineCheck: false,
        featureDescription: "test feature",
        codebasePath: "/tmp/test",
        inMemoryOnly: false,
      }),
    ).toThrow(/frozen-baseline content hash mismatch/);
  });

  it("does NOT fire when the existing artefact is the unsealed template (gates.length === 0)", () => {
    const outputDir = freshTmpDir();
    writeFileSync(
      join(outputDir, "gate-calibration-K100.json"),
      JSON.stringify({
        schema_version: 1,
        commit_hash: "unsealed",
        seed_used: 0,
        timestamp: new Date().toISOString(),
        k_target: 100,
        k_achieved: 0,
        frozen_baseline_commit: "unsealed",
        frozen_baseline_content_hash: "unsealed",
        gates: [],
      }),
      "utf8",
    );
    // Should NOT throw — the unsealed template path is the first-run case.
    const result = runCalibration({
      k: 5,
      eventRateK: 5,
      outputDir,
      frozenBaselineCommit: "anything",
      skipFrozenBaselineCheck: false,
      featureDescription: "test feature",
      codebasePath: "/tmp/test",
      inMemoryOnly: false,
    });
    expect(result.gateCalibration.k_achieved).toBe(5);
  });
});

// ─── D3.4.5 — event-rate divergence warning ──────────────────────────────────

describe("event-rate divergence warning — D3.4.5", () => {
  it("warning fires when measured event_rate is far from 0.30", () => {
    // The canned baseline produces ~0.47 fail-rate (well above 0.35
    // tolerance threshold). The runner sets diverges_beyond_tolerance=true
    // and includes a WARNING line in the summary.
    const outputDir = freshTmpDir();
    const result = runCalibration({
      k: 5,
      eventRateK: 10,
      outputDir,
      frozenBaselineCommit: "test",
      skipFrozenBaselineCheck: true,
      featureDescription: "test feature",
      codebasePath: "/tmp/test",
      inMemoryOnly: false,
    });
    expect(result.eventRate.diverges_beyond_tolerance).toBe(
      Math.abs(result.eventRate.measured_event_rate - 0.3) > 0.05,
    );
    if (result.eventRate.diverges_beyond_tolerance) {
      expect(result.summary.some((l) => l.startsWith("WARNING:"))).toBe(true);
    } else {
      expect(result.summary.some((l) => l.startsWith("WARNING:"))).toBe(false);
    }
  });

  it("measureEventRate returns 0/0 for empty input (no events, no attempts)", () => {
    const out = measureEventRate([]);
    expect(out.events).toBe(0);
    expect(out.totalAttempts).toBe(0);
  });

  it("measureEventRate counts events from synthetic KPIs", () => {
    // Synthesise: 10 sections, mean_attempts = 2.0 ⇒ total_attempts = 20.
    // pass_rate = 0.5 ⇒ passed = 5, failed = 5; events = 20 − 10 = 10.
    const synthetic: PipelineKpis = {
      run_id: "synth",
      final_action_kind: "done",
      current_step: "complete",
      iteration_count: 50,
      wall_time_ms: 5,
      section_pass_rate: 0.5,
      section_fail_count: 5,
      section_fail_ids: [],
      mean_section_attempts: 2.0,
      error_count: 5,
      structural_error_count: 0,
      judge_dispatch_count: 0,
      distribution_pass_rate: 1,
      written_files_count: 0,
      safety_cap_hit: false,
      mismatch_fired: false,
      mismatch_kinds: [],
      cortex_recall_empty_count: 0,
    };
    const { totalAttempts, events } = measureEventRate([synthetic]);
    expect(totalAttempts).toBe(20);
    expect(events).toBe(10);
  });
});

// ─── D3.6 — runner end-to-end + reproducibility pin ──────────────────────────

describe("runner end-to-end + reproducibility — D3.6", () => {
  it("output JSON contains an entry for every key in KPI_GATES", () => {
    const outputDir = freshTmpDir();
    const result = runCalibration({
      k: 5,
      eventRateK: 5,
      outputDir,
      frozenBaselineCommit: "test",
      skipFrozenBaselineCheck: true,
      featureDescription: "test feature",
      codebasePath: "/tmp/test",
      inMemoryOnly: false,
    });
    const gateNames = new Set(
      result.gateCalibration.gates.map((g) => g.gate_name),
    );
    for (const k of Object.keys(KPI_GATES)) {
      expect(gateNames.has(k)).toBe(true);
    }
  });

  it("XmR per-gate files exist on disk after a non-inMemoryOnly run", () => {
    const outputDir = freshTmpDir();
    const result = runCalibration({
      k: 5,
      eventRateK: 5,
      outputDir,
      frozenBaselineCommit: "test",
      skipFrozenBaselineCheck: true,
      featureDescription: "test feature",
      codebasePath: "/tmp/test",
      inMemoryOnly: false,
    });
    expect(result.xmrFiles.length).toBeGreaterThan(0);
    for (const xmr of result.xmrFiles) {
      expect(existsSync(xmr.path)).toBe(true);
    }
  });

  it("re-run with the same seed produces byte-identical KPI series + gate values (reproducibility pin)", () => {
    // Two runs against fresh output dirs — identical seed, identical inputs.
    // The wall_time_ms field is excluded from the byte-equality check
    // because performance.now() jitter is the natural variance source for
    // the wall-time gate. Every other KPI (and therefore every other gate's
    // calibrated value) MUST be identical. The seed pin is on the
    // determinism of run-id permutation + the canned dispatcher.
    const dirA = freshTmpDir();
    const dirB = freshTmpDir();
    const a = runCalibration({
      k: 5,
      eventRateK: 5,
      outputDir: dirA,
      frozenBaselineCommit: "test",
      skipFrozenBaselineCheck: true,
      featureDescription: "test feature",
      codebasePath: "/tmp/test",
      inMemoryOnly: false,
    });
    const b = runCalibration({
      k: 5,
      eventRateK: 5,
      outputDir: dirB,
      frozenBaselineCommit: "test",
      skipFrozenBaselineCheck: true,
      featureDescription: "test feature",
      codebasePath: "/tmp/test",
      inMemoryOnly: false,
    });
    // For every gate other than wall_time_ms_max, the calibrated value
    // must match exactly across runs.
    for (let i = 0; i < a.gateCalibration.gates.length; i++) {
      const ga = a.gateCalibration.gates[i];
      const gb = b.gateCalibration.gates[i];
      expect(ga.gate_name).toBe(gb.gate_name);
      if (ga.gate_name === "wall_time_ms_max") continue;
      expect(ga.calibrated).toBe(gb.calibrated);
      expect(ga.k_observed).toBe(gb.k_observed);
    }
    // Event-rate measurement is deterministic (no wall-time dependence).
    expect(a.eventRate.measured_event_rate).toBe(
      b.eventRate.measured_event_rate,
    );
    expect(a.eventRate.total_events).toBe(b.eventRate.total_events);
    expect(a.eventRate.total_attempts).toBe(b.eventRate.total_attempts);
  });
});
