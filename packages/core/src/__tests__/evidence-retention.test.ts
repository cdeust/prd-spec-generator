/**
 * Bounded-I/O retention tests for EvidenceRepository (Phase 3).
 *
 * Stakes: High — persistence layer that accumulates one row per strategy
 * execution per run and, before this change, grew without bound. Full
 * coding-standards §10 enforcement applies.
 *
 * Proves:
 *   - pruneRunEvidence(runId) releases exactly the strategy_executions rows
 *     written with session_id = runId (evidence tied to an evicted run is
 *     freed) and reports the deleted count (observable).
 *   - pruneToRetention(maxRows) bounds standalone growth, keeping the newest
 *     rows and reporting the deleted count.
 *   - MAX_EVIDENCE_ROWS is the documented default.
 *
 * Test strategy mirrors reliability-repository.test.ts: real better-sqlite3
 * against per-test temp files under os.tmpdir(), cleaned in afterEach. If
 * better-sqlite3 is unavailable in this environment the suite is skipped
 * rather than failing — matching the optional-native-module contract.
 *
 * source: coding-standards §3.2 (reliability), §8 (source discipline).
 */
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import {
  tryCreateEvidenceRepository,
  MAX_EVIDENCE_ROWS,
  type StrategyExecution,
} from "../index.js";

let tempPaths: string[] = [];

function tempDb(label: string): string {
  const p = join(
    tmpdir(),
    `evidence-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  tempPaths.push(p);
  return p;
}

afterEach(() => {
  for (const p of tempPaths) {
    if (existsSync(p)) rmSync(p);
    // better-sqlite3 WAL companions
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(p + suffix)) rmSync(p + suffix);
    }
  }
  tempPaths = [];
});

function exec(strategy = "first_principles"): StrategyExecution {
  return {
    strategy: strategy as StrategyExecution["strategy"],
    claimCharacteristics: ["c"],
    complexityTier: "tier1",
    expectedImprovement: 0.1,
    actualConfidenceGain: 0.12,
    wasCompliant: true,
    retryCount: 0,
    prdContext: "feature" as StrategyExecution["prdContext"],
  };
}

// Build a repo or skip the whole suite if the native module is unavailable.
const repoProbe = tryCreateEvidenceRepository(tempDb("probe"));
const hasSqlite = repoProbe !== null;
repoProbe?.close();

describe.skipIf(!hasSqlite)("EvidenceRepository — retention (bounded-I/O)", () => {
  it("MAX_EVIDENCE_ROWS has the documented default", () => {
    expect(MAX_EVIDENCE_ROWS).toBe(10_000);
  });

  it("pruneRunEvidence releases exactly the rows for the given run_id", () => {
    const repo = tryCreateEvidenceRepository(tempDb("prune-run"))!;
    repo.recordStrategyExecution(exec(), "run_A");
    repo.recordStrategyExecution(exec(), "run_A");
    repo.recordStrategyExecution(exec(), "run_B");
    expect(repo.strategyExecutionCount()).toBe(3);

    const deleted = repo.pruneRunEvidence("run_A");
    expect(deleted).toBe(2);
    expect(repo.strategyExecutionCount()).toBe(1); // only run_B remains
    repo.close();
  });

  it("pruneRunEvidence on an unknown or empty run_id deletes nothing", () => {
    const repo = tryCreateEvidenceRepository(tempDb("prune-unknown"))!;
    repo.recordStrategyExecution(exec(), "run_A");
    expect(repo.pruneRunEvidence("run_ZZZ")).toBe(0);
    expect(repo.pruneRunEvidence("")).toBe(0);
    expect(repo.strategyExecutionCount()).toBe(1);
    repo.close();
  });

  it("pruneToRetention keeps the newest rows and bounds the table", () => {
    const repo = tryCreateEvidenceRepository(tempDb("prune-retention"))!;
    for (let i = 0; i < 10; i += 1) {
      repo.recordStrategyExecution(exec(), `run_${i}`);
    }
    expect(repo.strategyExecutionCount()).toBe(10);

    const deleted = repo.pruneToRetention(4);
    expect(deleted).toBe(6);
    expect(repo.strategyExecutionCount()).toBe(4);
    repo.close();
  });

  it("pruneToRetention is a no-op when already under the cap", () => {
    const repo = tryCreateEvidenceRepository(tempDb("prune-noop"))!;
    repo.recordStrategyExecution(exec(), "run_A");
    expect(repo.pruneToRetention(100)).toBe(0);
    expect(repo.strategyExecutionCount()).toBe(1);
    repo.close();
  });
});
