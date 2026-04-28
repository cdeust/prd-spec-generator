/**
 * B3 — Held-out seal enforcement tests for ablation comparison functions.
 *
 * Verifies that each comparison function THROWS when called with a missing
 * or null-template lock file, enforcing the Popper AP-5 mechanical seal
 * requirement at the production call sites.
 *
 * source: Wave D B3 remediation — Popper AP-5 mechanical enforcement.
 * source: PHASE_4_PLAN.md §4.1, §4.2, §4.5.
 */

import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  computeAblationComparison,
  computeReliabilityComparison,
  computeKpiGateComparison,
} from "../ablation-comparison.js";

function tmpDir(): string {
  const dir = join(tmpdir(), "seal-test-" + randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write one valid observation entry to a JSONL file. */
function writeSingleObs(logPath: string, run_id: string): void {
  const entry = JSON.stringify({
    run_id,
    judge_id: { kind: "genius", name: "feynman" },
    claim_id: "claim_001",
    claim_type: "factual",
    ground_truth: false,
    judge_verdict: true,
    timestamp: new Date().toISOString(),
    schema_version: 1,
  });
  writeFileSync(logPath, entry + "\n");
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

// ─── B3 seal enforcement: computeAblationComparison ──────────────────────────

describe("computeAblationComparison — seal enforcement (B3)", () => {
  it("throws when MaxAttempts lock file is missing", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const logPath = join(dir, "obs.jsonl");
    writeSingleObs(logPath, "run_no_lock");
    const missingLock = join(dir, "missing.lock.json");

    // Precondition: lock file does not exist → verifyMaxAttemptsHeldoutSeal throws.
    expect(() => computeAblationComparison(logPath, missingLock)).toThrow(
      /lock file missing/i,
    );
  });

  it("throws when MaxAttempts lock is unsealed (null fields)", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const logPath = join(dir, "obs.jsonl");
    writeSingleObs(logPath, "run_unsealed");
    const lockPath = join(dir, "maxattempts-heldout.lock.json");
    writeFileSync(
      lockPath,
      JSON.stringify({
        schema_version: 1,
        rng_seed: null,
        partition_hash: null,
        partition_size: null,
        sealed_at: null,
      }),
    );

    // Precondition: unsealed template → verifyMaxAttemptsHeldoutSeal throws.
    expect(() => computeAblationComparison(logPath, lockPath)).toThrow(
      /unsealed template/i,
    );
  });
});

// ─── B3 seal enforcement: computeReliabilityComparison ───────────────────────

describe("computeReliabilityComparison — seal enforcement (B3)", () => {
  it("throws when Reliability lock file is missing", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const logPath = join(dir, "obs.jsonl");
    writeSingleObs(logPath, "run_rel_no_lock");
    const missingLock = join(dir, "missing.lock.json");

    // Precondition: lock file missing → verifyReliabilityHeldoutSeal throws.
    expect(() => computeReliabilityComparison(logPath, missingLock)).toThrow(
      /lock file not found/i,
    );
  });

  it("throws when Reliability lock fails schema validation", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const logPath = join(dir, "obs.jsonl");
    writeSingleObs(logPath, "run_rel_bad_schema");
    const lockPath = join(dir, "heldout-partition.lock.json");
    writeFileSync(lockPath, JSON.stringify({ schema_version: 99, bad: "data" }));

    // Precondition: wrong schema_version → verifyReliabilityHeldoutSeal throws.
    expect(() => computeReliabilityComparison(logPath, lockPath)).toThrow(
      /schema validation/i,
    );
  });
});

// ─── B3 seal enforcement: computeKpiGateComparison ───────────────────────────

describe("computeKpiGateComparison — seal enforcement (B3)", () => {
  it("throws when KpiGates lock file is missing", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const logPath = join(dir, "gate-blocked.jsonl");
    writeFileSync(logPath, "");
    const missingLock = join(dir, "missing.lock.json");

    // Precondition: lock file missing → verifyKpiGatesHeldoutSeal throws.
    expect(() => computeKpiGateComparison(logPath, missingLock)).toThrow(
      /lock file not found/i,
    );
  });

  it("returns inconclusive when KpiGates lock has null fields (unsealed template)", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const logPath = join(dir, "gate-blocked.jsonl");
    writeFileSync(logPath, "");
    const lockPath = join(dir, "kpigates-heldout.lock.json");
    writeFileSync(
      lockPath,
      JSON.stringify({
        schema_version: 1,
        rng_seed: null,
        partition_hash: null,
        partition_size: null,
        sealed_at: null,
      }),
    );

    // KpiGates seal allows null fields (template state). Returns inconclusive.
    const report = computeKpiGateComparison(logPath, lockPath);
    expect(report.recommendation).toBe("inconclusive_underpowered");
  });
});
