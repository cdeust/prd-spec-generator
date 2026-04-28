/**
 * Tests for ablation-comparison.ts (Wave D B2).
 *
 * Uses synthetic JSONL fixtures to verify:
 *   - computeAblationComparison groups by arm and computes pass_rate correctly.
 *   - computeReliabilityComparison reads the observation log and returns a report.
 *   - computeKpiGateComparison reads the gate-blocked log and returns a report.
 *   - All three return inconclusive_underpowered on small samples.
 *   - All three throw when the held-out seal is missing (B3 enforcement — see
 *     ablation-comparison-seal.test.ts for the explicit throw tests).
 *
 * source: Wave D B2 / B3 remediation.
 * source: PHASE_4_PLAN.md §4.1, §4.2, §4.5 (AP-3 falsification).
 */

import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  computeAblationComparison,
  computeReliabilityComparison,
  computeKpiGateComparison,
} from "../ablation-comparison.js";
import { getRetryArmForRun, isControlArmRun } from "../calibration-seams.js";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = join(tmpdir(), "ablation-test-" + randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Synthetic judge observation log entry. */
function makeObsEntry(overrides: {
  run_id: string;
  judge_verdict: boolean;
  ground_truth: boolean;
}): string {
  return JSON.stringify({
    run_id: overrides.run_id,
    judge_id: { kind: "genius", name: "feynman" },
    claim_id: "claim_" + randomUUID(),
    claim_type: "factual",
    ground_truth: overrides.ground_truth,
    judge_verdict: overrides.judge_verdict,
    timestamp: new Date().toISOString(),
    schema_version: 1,
  });
}

/** Synthetic gate-blocked log entry. */
function makeGateEntry(overrides: { run_id: string; fired: boolean }): string {
  return JSON.stringify({
    run_id: overrides.run_id,
    gate_id: "structural_error_count_max",
    fired: overrides.fired,
    timestamp: new Date().toISOString(),
    schema_version: 1,
  });
}

/** Write a sealed MaxAttemptsHeldoutLock (v1). */
function writeSealedMaxAttemptsLock(dir: string, runIds: string[]): string {
  const sorted = [...runIds].sort();
  const hash = createHash("sha256").update(sorted.join("\n")).digest("hex");
  const lock = {
    schema_version: 1,
    rng_seed: 42,
    partition_hash: hash,
    partition_size: runIds.length,
    sealed_at: new Date(Date.now() - 1000).toISOString(),
  };
  const lockPath = join(dir, "maxattempts-heldout.lock.json");
  writeFileSync(lockPath, JSON.stringify(lock));
  return lockPath;
}

/** Write a sealed ReliabilityHeldoutLock (v2). */
function writeSealedReliabilityLock(dir: string): string {
  const lock = {
    schema_version: 2,
    seed: "test-seed-42",
    partition_size: 4,
    sealed_at: new Date(Date.now() - 1000).toISOString(),
    external_grounding_breakdown: { schema: 1, math: 1, code: 1, spec: 1 },
    external_grounding_total: 4,
    external_grounding_schema_version: 1,
    claim_set_hash: "test-hash",
  };
  const lockPath = join(dir, "heldout-partition.lock.json");
  writeFileSync(lockPath, JSON.stringify(lock));
  return lockPath;
}

/** Write a sealed KpiGatesHeldoutLock (v1). */
function writeSealedKpiGatesLock(dir: string, runIds: string[]): string {
  const sorted = [...runIds].sort();
  const hash = createHash("sha256").update(sorted.join("\n")).digest("hex");
  const lock = {
    schema_version: 1,
    rng_seed: 42,
    partition_hash: hash,
    partition_size: runIds.length,
    sealed_at: new Date(Date.now() - 1000).toISOString(),
  };
  const lockPath = join(dir, "kpigates-heldout.lock.json");
  writeFileSync(lockPath, JSON.stringify(lock));
  return lockPath;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// ─── computeAblationComparison tests ─────────────────────────────────────────

describe("computeAblationComparison (B2.1)", () => {
  it("returns inconclusive_underpowered on small sample with sealed lock", () => {
    const dir = tmpDir();
    dirs.push(dir);

    // Need at least 1 run_id to satisfy partition_size > 0 in the lock.
    // Use a single observation to produce n < 30 → inconclusive.
    const run_id = "run_ablation_small_sample";
    const logPath = join(dir, "obs.jsonl");
    writeFileSync(logPath, makeObsEntry({ run_id, judge_verdict: true, ground_truth: false }) + "\n");

    const lockPath = writeSealedMaxAttemptsLock(dir, [run_id]);
    const report = computeAblationComparison(logPath, lockPath);

    expect(report.schema_version).toBe(1);
    expect(report.recommendation).toBe("inconclusive_underpowered");
  });

  it("groups observations by arm and computes pass_rate", () => {
    const dir = tmpDir();
    dirs.push(dir);

    // Pick run_ids deterministically in each arm.
    // getRetryArmForRun is deterministic — find 3 run_ids for each arm.
    const withIds: string[] = [];
    const withoutIds: string[] = [];
    for (let i = 0; withIds.length < 3 || withoutIds.length < 3; i++) {
      const id = `run_ablation_fixture_${i}`;
      const arm = getRetryArmForRun(id);
      if (arm === "with_prior_violations" && withIds.length < 3) withIds.push(id);
      if (arm === "without_prior_violations" && withoutIds.length < 3) withoutIds.push(id);
    }

    // Write 3 correct (judgeCorrect=true) for "with" arm, 3 wrong for "without".
    const lines: string[] = [];
    for (const id of withIds) {
      // judgeCorrect = judge_verdict !== ground_truth
      lines.push(makeObsEntry({ run_id: id, judge_verdict: true, ground_truth: false }));
    }
    for (const id of withoutIds) {
      lines.push(makeObsEntry({ run_id: id, judge_verdict: false, ground_truth: false }));
    }

    const logPath = join(dir, "obs.jsonl");
    writeFileSync(logPath, lines.join("\n") + "\n");

    const allIds = [...withIds, ...withoutIds];
    const lockPath = writeSealedMaxAttemptsLock(dir, allIds);
    const report = computeAblationComparison(logPath, lockPath);

    expect(report.schema_version).toBe(1);
    expect(report.arms.with.n).toBe(3);
    expect(report.arms.without.n).toBe(3);
    // with arm: all correct → pass_rate = 1.0
    expect(report.arms.with.pass_rate).toBe(1.0);
    // without arm: all wrong → pass_rate = 0.0
    expect(report.arms.without.pass_rate).toBe(0.0);
    // Small sample (< 30) → inconclusive regardless of delta
    expect(report.recommendation).toBe("inconclusive_underpowered");
  });
});

// ─── computeReliabilityComparison tests ──────────────────────────────────────

describe("computeReliabilityComparison (B2.2)", () => {
  it("returns inconclusive_underpowered on empty log", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const logPath = join(dir, "obs.jsonl");
    writeFileSync(logPath, "");
    const lockPath = writeSealedReliabilityLock(dir);

    const report = computeReliabilityComparison(logPath, lockPath);
    expect(report.schema_version).toBe(1);
    expect(report.recommendation).toBe("inconclusive_underpowered");
    expect(report.calibrated.n).toBe(0);
    expect(report.prior_only.n).toBe(0);
  });

  it("reads observation entries and produces a valid report", () => {
    const dir = tmpDir();
    dirs.push(dir);

    // 4 entries, all correct (judge_verdict !== ground_truth).
    const lines = Array.from({ length: 4 }, (_, i) =>
      makeObsEntry({
        run_id: `run_rel_${i}`,
        judge_verdict: true,
        ground_truth: false,
      }),
    );
    const logPath = join(dir, "obs.jsonl");
    writeFileSync(logPath, lines.join("\n") + "\n");
    const lockPath = writeSealedReliabilityLock(dir);

    const report = computeReliabilityComparison(logPath, lockPath);
    expect(report.calibrated.n).toBe(4);
    expect(report.prior_only.n).toBe(4);
    expect(report.calibrated.pass_rate).toBe(1.0);
    expect(report.recommendation).toBe("inconclusive_underpowered"); // n < 30
  });
});

// ─── computeKpiGateComparison tests ──────────────────────────────────────────

describe("computeKpiGateComparison (B2.3)", () => {
  it("returns inconclusive_underpowered when lock is unsealed template", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const logPath = join(dir, "gate-blocked.jsonl");
    writeFileSync(logPath, "");
    // Write unsealed template lock.
    const lock = {
      schema_version: 1,
      rng_seed: null,
      partition_hash: null,
      partition_size: null,
      sealed_at: null,
    };
    const lockPath = join(dir, "kpigates-heldout.lock.json");
    writeFileSync(lockPath, JSON.stringify(lock));

    const report = computeKpiGateComparison(logPath, lockPath);
    expect(report.schema_version).toBe(1);
    expect(report.recommendation).toBe("inconclusive_underpowered");
  });

  it("groups by control vs treatment arm and computes fire rates", () => {
    const dir = tmpDir();
    dirs.push(dir);

    // 2 run_ids in each arm.
    const controlIds: string[] = [];
    const treatmentIds: string[] = [];
    for (let i = 0; controlIds.length < 2 || treatmentIds.length < 2; i++) {
      const id = `run_kpi_fixture_${i}`;
      if (isControlArmRun(id) && controlIds.length < 2) controlIds.push(id);
      if (!isControlArmRun(id) && treatmentIds.length < 2) treatmentIds.push(id);
    }

    const lines: string[] = [];
    for (const id of controlIds) {
      lines.push(makeGateEntry({ run_id: id, fired: false })); // gate passed
    }
    for (const id of treatmentIds) {
      lines.push(makeGateEntry({ run_id: id, fired: true })); // gate fired
    }

    const logPath = join(dir, "gate-blocked.jsonl");
    writeFileSync(logPath, lines.join("\n") + "\n");

    const allIds = [...controlIds, ...treatmentIds];
    const lockPath = writeSealedKpiGatesLock(dir, allIds);

    const report = computeKpiGateComparison(logPath, lockPath);
    expect(report.schema_version).toBe(1);
    expect(report.control.n).toBe(2);
    expect(report.treatment.n).toBe(2);
    // control: gate not fired → pass_rate = 1.0
    expect(report.control.pass_rate).toBe(1.0);
    // treatment: gate fired → pass_rate = 0.0
    expect(report.treatment.pass_rate).toBe(0.0);
    // Small sample → inconclusive
    expect(report.recommendation).toBe("inconclusive_underpowered");
  });
});
