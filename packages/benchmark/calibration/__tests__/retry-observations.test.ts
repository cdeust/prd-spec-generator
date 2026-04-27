/**
 * Tests for retry-observations.ts (Phase 4.2 ablation arm instrumentation).
 *
 * Postconditions under test:
 *   1. All 6 required fields are populated on every extracted observation.
 *   2. Ground-truth preservation: a synthetic state with known attempt counts
 *      produces exactly the expected observation set (replay invariant).
 *   3. AP-5 injection: a synthetic retry with a known ablation arm assignment
 *      round-trips correctly through extract → audit-log → parsed JSON.
 *   4. attempt=1 always has prior_violations_count=0 and prior_violations_used=false.
 *   5. extractRetryObservations returns [] for a state with no attempted sections.
 *   6. appendRetryObservationLog writes valid JSON to the target path.
 *
 * source: test-engineer Move 1 — assertions trace to named postconditions
 * in retry-observations.ts contract header and PHASE_4_PLAN.md §4.2.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractRetryObservations,
  appendRetryObservationLog,
  type RetryAttemptObservation,
  type RetryArm,
} from "../retry-observations.js";
import type { PipelineState } from "@prd-gen/orchestration";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Minimal PipelineState fixture. Only fields read by extractRetryObservations
 * are populated; the rest use their Zod defaults.
 *
 * source: state.ts PipelineStateSchema — run_id and sections are the only
 * fields read by extractRetryObservations.
 */
function makeState(
  runId: string,
  sections: PipelineState["sections"],
): PipelineState {
  const now = new Date().toISOString();
  return {
    run_id: runId,
    current_step: "section_generation",
    prd_context: "trial",
    feature_description: "synthetic test feature",
    codebase_path: null,
    codebase_graph_path: null,
    codebase_output_dir: null,
    codebase_indexed: false,
    preflight_status: "skipped",
    sections,
    clarifications: [],
    proceed_signal: true,
    started_at: now,
    updated_at: now,
    errors: [],
    error_kinds: [],
    written_files: [],
    verification_plan: null,
    strategy_executions: [],
  };
}

function makeSection(
  sectionType: PipelineState["sections"][number]["section_type"],
  attempt: number,
  status: PipelineState["sections"][number]["status"],
  lastViolations: string[] = [],
): PipelineState["sections"][number] {
  return {
    section_type: sectionType,
    status,
    attempt,
    violation_count: lastViolations.length,
    last_violations: lastViolations,
  };
}

// ─── Test 1: all 6 fields populated ──────────────────────────────────────────

describe("extractRetryObservations — all 6 fields populated", () => {
  it("every observation has all 6 required fields non-null/undefined", () => {
    const state = makeState("run-all-fields", [
      makeSection("overview", 2, "passed", ["[HOR-1] missing heading"]),
      makeSection("goals", 1, "passed", []),
    ]);

    const obs = extractRetryObservations(state, "with_prior_violations");

    // Postcondition: total observations = sum of attempt counts.
    expect(obs.length).toBe(3); // overview: 2 attempts, goals: 1 attempt

    for (const o of obs) {
      // Postcondition: all 6 required fields.
      expect(o.attempt).toBeDefined();
      expect(typeof o.attempt).toBe("number");
      expect(o.prior_violations_count).toBeDefined();
      expect(typeof o.prior_violations_count).toBe("number");
      expect(o.prior_violations_used).toBeDefined();
      expect(typeof o.prior_violations_used).toBe("boolean");
      expect(o.arm).toBeDefined();
      expect(["with_prior_violations", "without_prior_violations"]).toContain(
        o.arm,
      );
      expect(o.retry_outcome).toBeDefined();
      expect(["passed", "failed_terminal", "failed_pending_retry"]).toContain(
        o.retry_outcome,
      );
      expect(o.section_type).toBeDefined();
      expect(o.run_id).toBe("run-all-fields");
    }
  });
});

// ─── Test 2: ground-truth preservation (replay invariant) ────────────────────

describe("extractRetryObservations — ground-truth preservation", () => {
  it("single-attempt passed section produces exactly one observation", () => {
    const state = makeState("run-single-attempt", [
      makeSection("overview", 1, "passed"),
    ]);

    const obs = extractRetryObservations(state, "with_prior_violations");

    expect(obs.length).toBe(1);
    expect(obs[0]!.attempt).toBe(1);
    expect(obs[0]!.section_type).toBe("overview");
    expect(obs[0]!.run_id).toBe("run-single-attempt");
    expect(obs[0]!.retry_outcome).toBe("passed");
    // Postcondition: attempt 1 has no prior violations.
    expect(obs[0]!.prior_violations_count).toBe(0);
    expect(obs[0]!.prior_violations_used).toBe(false);
  });

  it("three-attempt failed section produces 3 observations with correct outcomes", () => {
    const state = makeState("run-max-attempts", [
      makeSection("goals", 3, "failed", ["[HOR-2] missing bullet", "[HOR-3] wrong format"]),
    ]);

    const obs = extractRetryObservations(state, "with_prior_violations");

    expect(obs.length).toBe(3);

    // Attempt 1: no violations yet, pending retry.
    const a1 = obs.find((o) => o.attempt === 1)!;
    expect(a1.prior_violations_count).toBe(0);
    expect(a1.prior_violations_used).toBe(false);
    expect(a1.retry_outcome).toBe("failed_pending_retry");

    // Attempt 2: violations from attempt 1 would be fed (but we only have
    // the final last_violations; earlier ones are 0 per the GAP note).
    const a2 = obs.find((o) => o.attempt === 2)!;
    expect(a2.prior_violations_used).toBe(true); // with_prior_violations arm
    expect(["failed_pending_retry", "failed_terminal"]).toContain(
      a2.retry_outcome,
    );

    // Attempt 3 (terminal): violations count from last_violations.
    const a3 = obs.find((o) => o.attempt === 3)!;
    expect(a3.retry_outcome).toBe("failed_terminal");
    expect(a3.prior_violations_count).toBe(2); // last_violations.length
    expect(a3.prior_violations_used).toBe(true);
  });

  it("state with no sections returns empty array", () => {
    const state = makeState("run-no-sections", []);
    const obs = extractRetryObservations(state, "with_prior_violations");
    expect(obs.length).toBe(0);
  });

  it("section with attempt=0 (never started) is excluded", () => {
    const state = makeState("run-pending-section", [
      makeSection("overview", 0, "pending"),
      makeSection("goals", 1, "passed"),
    ]);

    const obs = extractRetryObservations(state, "with_prior_violations");
    // Only goals has attempt=1; overview with attempt=0 is excluded.
    expect(obs.length).toBe(1);
    expect(obs[0]!.section_type).toBe("goals");
  });

  it("run_id is correctly propagated to all observations from a multi-section state", () => {
    const state = makeState("run-id-propagation", [
      makeSection("overview", 1, "passed"),
      makeSection("goals", 2, "failed", ["[HOR-1] something"]),
    ]);

    const obs = extractRetryObservations(state, "with_prior_violations");
    expect(obs.length).toBe(3);
    for (const o of obs) {
      expect(o.run_id).toBe("run-id-propagation");
    }
  });
});

// ─── Test 3: AP-5 injection — ablation arm round-trip ────────────────────────

describe("extractRetryObservations — AP-5 ablation arm round-trip", () => {
  it("with_prior_violations arm: attempt≥2 has prior_violations_used=true", () => {
    const arm: RetryArm = "with_prior_violations";
    const state = makeState("run-ap5-with", [
      makeSection("overview", 2, "passed", ["[HOR-1] violation"]),
    ]);

    const obs = extractRetryObservations(state, arm);
    const attempt2 = obs.find((o) => o.attempt === 2)!;
    expect(attempt2.arm).toBe("with_prior_violations");
    expect(attempt2.prior_violations_used).toBe(true);
  });

  it("without_prior_violations arm: all attempts have prior_violations_used=false", () => {
    const arm: RetryArm = "without_prior_violations";
    const state = makeState("run-ap5-without", [
      makeSection("overview", 3, "failed", ["[HOR-1] violation"]),
    ]);

    const obs = extractRetryObservations(state, arm);
    expect(obs.length).toBe(3);
    for (const o of obs) {
      expect(o.arm).toBe("without_prior_violations");
      expect(o.prior_violations_used).toBe(false);
    }
  });

  it("observations produced by extract round-trip through JSON.parse correctly", () => {
    const arm: RetryArm = "with_prior_violations";
    const state = makeState("run-ap5-roundtrip", [
      makeSection("goals", 2, "passed", ["[HOR-3] missing heading"]),
    ]);

    const obs = extractRetryObservations(state, arm);
    for (const o of obs) {
      const serialized = JSON.stringify(o);
      const parsed = JSON.parse(serialized) as RetryAttemptObservation;
      expect(parsed.attempt).toBe(o.attempt);
      expect(parsed.prior_violations_count).toBe(o.prior_violations_count);
      expect(parsed.prior_violations_used).toBe(o.prior_violations_used);
      expect(parsed.arm).toBe(o.arm);
      expect(parsed.retry_outcome).toBe(o.retry_outcome);
      expect(parsed.section_type).toBe(o.section_type);
      expect(parsed.run_id).toBe(o.run_id);
    }
  });
});

// ─── Test 4: appendRetryObservationLog ───────────────────────────────────────

describe("appendRetryObservationLog", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `retry-obs-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    logPath = join(tmpDir, "retry-observation-log.jsonl");
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("writes a valid JSON line to the specified path", () => {
    const obs: RetryAttemptObservation = {
      attempt: 1,
      prior_violations_count: 0,
      prior_violations_used: false,
      arm: "with_prior_violations",
      retry_outcome: "passed",
      section_type: "overview",
      run_id: "run-audit-log-test",
    };

    appendRetryObservationLog(obs, logPath);

    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as RetryAttemptObservation;
    expect(parsed.run_id).toBe("run-audit-log-test");
    expect(parsed.attempt).toBe(1);
    expect(parsed.retry_outcome).toBe("passed");
  });

  it("appends without truncating — second write adds a second line", () => {
    const obs1: RetryAttemptObservation = {
      attempt: 1,
      prior_violations_count: 0,
      prior_violations_used: false,
      arm: "with_prior_violations",
      retry_outcome: "failed_pending_retry",
      section_type: "goals",
      run_id: "run-append-test",
    };
    const obs2: RetryAttemptObservation = {
      attempt: 2,
      prior_violations_count: 1,
      prior_violations_used: true,
      arm: "with_prior_violations",
      retry_outcome: "passed",
      section_type: "goals",
      run_id: "run-append-test",
    };

    appendRetryObservationLog(obs1, logPath);
    appendRetryObservationLog(obs2, logPath);

    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    const p1 = JSON.parse(lines[0]!) as RetryAttemptObservation;
    const p2 = JSON.parse(lines[1]!) as RetryAttemptObservation;
    expect(p1.attempt).toBe(1);
    expect(p2.attempt).toBe(2);
    // Postcondition: first line was not modified by the second write.
    expect(p1.retry_outcome).toBe("failed_pending_retry");
  });

  it("creates the parent directory if it does not exist", () => {
    const nestedPath = join(tmpDir, "nested", "dir", "log.jsonl");
    const obs: RetryAttemptObservation = {
      attempt: 1,
      prior_violations_count: 0,
      prior_violations_used: false,
      arm: "without_prior_violations",
      retry_outcome: "passed",
      section_type: "requirements",
      run_id: "run-mkdir-test",
    };

    // Postcondition: no error thrown even though directory doesn't exist.
    expect(() => appendRetryObservationLog(obs, nestedPath)).not.toThrow();
    expect(existsSync(nestedPath)).toBe(true);
  });
});
