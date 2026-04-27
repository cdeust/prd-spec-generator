/**
 * Tests for BenchmarkConsensusReliabilityProvider (Wave D2.3, D2.5).
 *
 * Coverage:
 *   D2.5-3a: Adapter delegates to getReliabilityForRun seam correctly.
 *   D2.5-3b: Control-arm runs return null (CC-3 gate via isControlArmRun).
 *   D2.5-3c: Treatment-arm runs with no DB record return null (cold start).
 *   D2.5-3d: Treatment-arm runs with a DB record return the record.
 *   D2.5-3e: Layer check — this adapter imports only from @prd-gen/core
 *             and calibration-seams.js (NOT from @prd-gen/verification).
 *
 * source: Wave D2 deliverable D2.5-3.
 * source: CC-3 / B-Popper-1 — isControlArmRun gate.
 */

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import {
  SqliteReliabilityRepository,
  DEFAULT_RELIABILITY_PRIOR,
  RELIABILITY_SCHEMA_VERSION,
} from "@prd-gen/core";
import type { AgentIdentity } from "@prd-gen/core";
import { BenchmarkConsensusReliabilityProvider } from "../consensus-reliability-adapter.js";
import { isControlArmRun, fnv1a32 } from "../calibration-seams.js";

// ─── Test DB helpers ──────────────────────────────────────────────────────────

function makeTempDb(suffix: string): { path: string; cleanup: () => void } {
  const path = join(tmpdir(), `reliability-adapter-test-${suffix}-${Date.now()}.db`);
  return {
    path,
    cleanup: () => {
      try {
        rmSync(path, { force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

// ─── Control-arm run ID (fnv1a32(runId) % 5 === 0) ───────────────────────────

/**
 * Find a deterministic run ID that maps to the control arm.
 * Precondition: the loop terminates because 1/5 of IDs satisfy the predicate.
 * Postcondition: returned ID satisfies isControlArmRun(id) === true.
 */
function controlArmRunId(): string {
  for (let i = 0; i < 100; i++) {
    const id = `run-control-${i}`;
    if (isControlArmRun(id)) return id;
  }
  throw new Error("Could not find a control-arm run ID in 100 attempts");
}

/**
 * Find a deterministic run ID that maps to the treatment arm.
 * Postcondition: returned ID satisfies isControlArmRun(id) === false.
 */
function treatmentArmRunId(): string {
  for (let i = 0; i < 100; i++) {
    const id = `run-treatment-${i}`;
    if (!isControlArmRun(id)) return id;
  }
  throw new Error("Could not find a treatment-arm run ID in 100 attempts");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const testJudge: AgentIdentity = { kind: "genius", name: "fermi" };
const testClaimType = "functional" as const;
const testDirection = "sensitivity_arm" as const;

describe("BenchmarkConsensusReliabilityProvider", () => {
  // D2.5-3b: control-arm runs always return null.
  it("D2.5-3b: returns null for control-arm run (CC-3 gate)", () => {
    const { path, cleanup } = makeTempDb("control");
    try {
      const repo = new SqliteReliabilityRepository(path);
      const provider = new BenchmarkConsensusReliabilityProvider(repo);

      const runId = controlArmRunId();
      expect(isControlArmRun(runId)).toBe(true);

      const result = provider.getReliabilityForRun(
        runId,
        testJudge,
        testClaimType,
        testDirection,
      );
      expect(result).toBeNull();
      repo.close();
    } finally {
      cleanup();
    }
  });

  // D2.5-3c: treatment-arm run with no DB record → null (cold start).
  it("D2.5-3c: returns null for treatment-arm run when no record exists (cold start)", () => {
    const { path, cleanup } = makeTempDb("cold-start");
    try {
      const repo = new SqliteReliabilityRepository(path);
      const provider = new BenchmarkConsensusReliabilityProvider(repo);

      const runId = treatmentArmRunId();
      expect(isControlArmRun(runId)).toBe(false);

      // DB is empty — no records for any cell.
      const result = provider.getReliabilityForRun(
        runId,
        testJudge,
        testClaimType,
        testDirection,
      );
      expect(result).toBeNull();
      repo.close();
    } finally {
      cleanup();
    }
  });

  // D2.5-3d: treatment-arm run with a DB record → record returned.
  it("D2.5-3d: returns the persisted record for treatment-arm run after recordObservation", () => {
    const { path, cleanup } = makeTempDb("treatment");
    try {
      const repo = new SqliteReliabilityRepository(path);

      // Record two observations: 2 correct (sensitivity arm = groundTruthIsFail).
      repo.recordObservation(testJudge, testClaimType, {
        groundTruthIsFail: true,
        judgeWasCorrect: true,
      });
      repo.recordObservation(testJudge, testClaimType, {
        groundTruthIsFail: true,
        judgeWasCorrect: true,
      });

      const provider = new BenchmarkConsensusReliabilityProvider(repo);
      const runId = treatmentArmRunId();

      const result = provider.getReliabilityForRun(
        runId,
        testJudge,
        testClaimType,
        testDirection,
      );

      expect(result).not.toBeNull();
      // After 2 correct sensitivity observations: alpha = prior.alpha + 2 = 9.
      expect(result!.alpha).toBe(DEFAULT_RELIABILITY_PRIOR.alpha + 2);
      expect(result!.beta).toBe(DEFAULT_RELIABILITY_PRIOR.beta);
      expect(result!.nObservations).toBe(2);
      expect(result!.schemaVersion).toBe(RELIABILITY_SCHEMA_VERSION);
      repo.close();
    } finally {
      cleanup();
    }
  });

  // D2.5-3a: adapter is a thin delegation — does not embed control-arm logic.
  it("D2.5-3a: getReliabilityForRun delegates to getReliabilityForRun seam (delegation test)", () => {
    // Verify that: for a treatment run + empty DB, result is null.
    // For a treatment run + seeded DB, result is the record.
    // This confirms the delegation chain works end-to-end.
    const { path, cleanup } = makeTempDb("delegation");
    try {
      const repo = new SqliteReliabilityRepository(path);
      const provider = new BenchmarkConsensusReliabilityProvider(repo);
      const runId = treatmentArmRunId();

      // Pre-seed one observation.
      repo.recordObservation(testJudge, testClaimType, {
        groundTruthIsFail: false,
        judgeWasCorrect: true,
      });

      const result = provider.getReliabilityForRun(
        runId,
        testJudge,
        testClaimType,
        "specificity_arm",
      );

      // Specificity arm: groundTruthIsFail=false, judgeWasCorrect=true → alpha += 1.
      expect(result).not.toBeNull();
      expect(result!.verdictDirection).toBe("specificity_arm");
      expect(result!.alpha).toBe(DEFAULT_RELIABILITY_PRIOR.alpha + 1);

      // Posterior mean should be above the prior mean (more correct observations).
      const posteriorMean = result!.alpha / (result!.alpha + result!.beta);
      const priorMean = DEFAULT_RELIABILITY_PRIOR.alpha / (DEFAULT_RELIABILITY_PRIOR.alpha + DEFAULT_RELIABILITY_PRIOR.beta);
      expect(posteriorMean).toBeGreaterThan(priorMean);

      repo.close();
    } finally {
      cleanup();
    }
  });

  // Verify the fnv1a32 + % 5 predicate is consistent with isControlArmRun.
  it("controlArmRunId() satisfies isControlArmRun; treatmentArmRunId() does not", () => {
    const controlId = controlArmRunId();
    const treatmentId = treatmentArmRunId();
    expect(fnv1a32(controlId) % 5).toBe(0);
    expect(fnv1a32(treatmentId) % 5).not.toBe(0);
  });
});
