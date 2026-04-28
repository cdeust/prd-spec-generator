/**
 * End-to-end test — E3.E full calibration → seal → comparison pipeline.
 *
 * Runs computeAblationComparison + computeKpiGateComparison against the
 * COMMITTED sealed lock files and synthetic observation logs. Confirms:
 *
 *   1. With an empty observation log + sealed §4.2 lock containing run_ids
 *      that don't appear in the log → seal-mismatch behavior is correctly
 *      handled (verify throws BEFORE the comparison reads any data).
 *   2. With synthetic observations whose run_ids match the sealed §4.2
 *      partition → comparison returns inconclusive_underpowered cleanly
 *      (paired bootstrap is still stub).
 *   3. With an empty/missing gate-blocked log + sealed §4.5 lock →
 *      computeKpiGateComparison returns inconclusive_underpowered with n=0
 *      for both arms (no crash).
 *
 * source: docs/PHASE_4_PLAN.md §4.2 / §4.5 AP-3 falsification
 * source: ablation-comparison.ts computeAblationComparison / computeKpiGateComparison
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  computeAblationComparison,
  computeKpiGateComparison,
} from "../ablation-comparison.js";

// Reproduce runner's Mulberry32 + run_id generation.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

function generateRunIds(prefix: string, seed: number, k: number): string[] {
  const rng = mulberry32(seed);
  const ids: string[] = [];
  for (let i = 0; i < k; i++) {
    const id = `${prefix}-${i}-${Math.floor(rng() * 0xffffffff)
      .toString(16)
      .padStart(8, "0")}`;
    ids.push(id);
  }
  return ids;
}

function partition8020(allIds: readonly string[], seed: number): string[] {
  const rng = mulberry32(seed);
  const arr = [...allIds];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.floor(arr.length * 0.2));
}

const PRE_REGISTERED_SEED_45 = 0x4_05_c3;
const PRE_REGISTERED_SEED_42 = 4_020_704;
const K = 100;
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(TEST_DIR, "..", "data"); // packages/benchmark/calibration/data

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "e3e-pipeline-"));
});

afterAll(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
});

// ─── E3.E.1 — §4.2 ablation pipeline accepts the sealed partition ─────────
describe("E3.E — full pipeline §4.2 ablation comparison", () => {
  it("returns inconclusive_underpowered for synthetic observations matching the seal", () => {
    // Generate the held-out partition the seal covers.
    const allRunIds = generateRunIds("phase45-calib", PRE_REGISTERED_SEED_45, K);
    const heldout = partition8020(allRunIds, PRE_REGISTERED_SEED_42);

    // Synthetic JSONL log: one entry per held-out run_id, alternating verdict.
    const logPath = join(tmpDir, "synthetic-observations.jsonl");
    const lines = heldout.map((run_id, i) => ({
      run_id,
      judge_id: { kind: "model", name: "test-judge" },
      claim_id: `c-${i}`,
      claim_type: "schema",
      ground_truth: i % 2 === 0,
      judge_verdict: i % 3 === 0,
      timestamp: new Date().toISOString(),
      schema_version: 1,
    }));
    writeFileSync(
      logPath,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8",
    );

    const lockPath = join(DATA_DIR, "maxattempts-heldout.lock.json");
    const report = computeAblationComparison(logPath, lockPath);

    // The bootstrap is still stubbed → recommendation falls back to CI heuristic
    // or inconclusive_underpowered. With only 20 observations split across two
    // arms, n < 30 per arm → inconclusive by the heuristic.
    expect(report.schema_version).toBe(1);
    expect(report.recommendation).toBe("inconclusive_underpowered");
    expect(report.difference.ci95_paired_bootstrap).toBeNull();
    expect(report.arms.with.n + report.arms.without.n).toBe(heldout.length);
  });

  it("throws when synthetic observations have run_ids OUTSIDE the seal", () => {
    const logPath = join(tmpDir, "wrong-runids.jsonl");
    const lines = ["foo-1", "foo-2", "foo-3"].map((run_id, i) => ({
      run_id,
      judge_id: { kind: "model", name: "test-judge" },
      claim_id: `c-${i}`,
      claim_type: "schema",
      ground_truth: false,
      judge_verdict: true,
      timestamp: new Date().toISOString(),
      schema_version: 1,
    }));
    writeFileSync(
      logPath,
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8",
    );
    const lockPath = join(DATA_DIR, "maxattempts-heldout.lock.json");
    expect(() => computeAblationComparison(logPath, lockPath)).toThrow(
      /partition hash mismatch/,
    );
  });
});

// ─── E3.E.2 — §4.5 KPI gate pipeline with empty log ───────────────────────
describe("E3.E — full pipeline §4.5 KPI gate comparison (empty log)", () => {
  it("returns inconclusive_underpowered with n=0 when no gate-blocked log exists", () => {
    const lockPath = join(DATA_DIR, "kpigates-heldout.lock.json");
    const missingLogPath = join(tmpDir, "no-such-gate-log.jsonl");
    const report = computeKpiGateComparison(missingLogPath, lockPath);

    expect(report.schema_version).toBe(1);
    expect(report.recommendation).toBe("inconclusive_underpowered");
    expect(report.control.n).toBe(0);
    expect(report.treatment.n).toBe(0);
    expect(report.difference.delta).toBe(0);
    expect(report.difference.ci95_paired_bootstrap).toBeNull();
  });
});
