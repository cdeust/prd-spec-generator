/**
 * Supplementary tests for extractJudgeObservations mapping behaviour.
 *
 * Split from observations.test.ts per coding-standards §4.1 (500-line limit).
 * Contains:
 *   - M1/AP-4: missing claim_type throws (instead of silently defaulting)
 *   - Verdict-to-boolean mapping
 *   - Ground-truth derivation from golden set
 *   - flushObservations — data directory creation
 *
 * source: coding-standards §4.1 size limit; B-residual M1/M3 remediation.
 */

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  extractJudgeObservations,
  flushObservations,
  type JudgeObservation,
  type GoldenSet,
  type ReliabilityRepository,
} from "../observations.js";
import type { JudgeVerdict } from "@prd-gen/core";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeVerdict(overrides: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    judge: { kind: "genius", name: "feynman" },
    claim_id: "FR-001",
    verdict: "PASS",
    rationale: "synthetic",
    caveats: [],
    confidence: 0.9,
    ...overrides,
  };
}

class RecordingRepository implements ReliabilityRepository {
  readonly recorded: JudgeObservation[] = [];
  recordObservation(obs: JudgeObservation): void {
    this.recorded.push(obs);
  }
}

function readQueueLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ─── M1 / AP-4: missing claim_type throws instead of silently defaulting ──────

describe("extractJudgeObservations — missing claim_type throws (AP-4)", () => {
  it("throws when claim_id is absent from claimTypes map", () => {
    // Precondition: verdict has a claim_id that is not in the claimTypes map.
    // Postcondition: Error thrown containing the missing claim_id in the message.
    const verdict = makeVerdict({ claim_id: "MISSING-CLAIM" });
    const emptyClaimTypes = new Map<string, "correctness">();
    const goldenSet: GoldenSet = new Map();

    expect(() =>
      extractJudgeObservations("run-m1", [verdict], emptyClaimTypes, goldenSet),
    ).toThrow(/extractJudgeObservations.*missing claim_type.*MISSING-CLAIM/);
  });

  it("does not throw when all claim_ids are present in claimTypes map", () => {
    // Postcondition: no error when claimTypes is fully populated.
    const verdict = makeVerdict({ claim_id: "FR-001" });
    const claimTypes = new Map([["FR-001", "correctness" as const]]);
    const goldenSet: GoldenSet = new Map();

    expect(() =>
      extractJudgeObservations("run-m1-ok", [verdict], claimTypes, goldenSet),
    ).not.toThrow();
  });
});

// ─── Verdict-to-boolean mapping ───────────────────────────────────────────────

describe("extractJudgeObservations — verdict boolean mapping", () => {
  it("maps PASS verdict to judge_verdict=true", () => {
    const verdict = makeVerdict({ verdict: "PASS", claim_id: "X" });
    const claimTypes = new Map([["X", "correctness" as const]]);
    const obs = extractJudgeObservations("r", [verdict], claimTypes, new Map());
    expect(obs[0].judge_verdict).toBe(true);
  });

  it("maps SPEC-COMPLETE verdict to judge_verdict=true", () => {
    const verdict = makeVerdict({ verdict: "SPEC-COMPLETE", claim_id: "X" });
    const claimTypes = new Map([["X", "correctness" as const]]);
    const obs = extractJudgeObservations("r", [verdict], claimTypes, new Map());
    expect(obs[0].judge_verdict).toBe(true);
  });

  it("maps FAIL verdict to judge_verdict=false", () => {
    const verdict = makeVerdict({ verdict: "FAIL", claim_id: "X" });
    const claimTypes = new Map([["X", "correctness" as const]]);
    const obs = extractJudgeObservations("r", [verdict], claimTypes, new Map());
    expect(obs[0].judge_verdict).toBe(false);
  });

  it("maps INCONCLUSIVE verdict to judge_verdict=false", () => {
    const verdict = makeVerdict({ verdict: "INCONCLUSIVE", claim_id: "X" });
    const claimTypes = new Map([["X", "correctness" as const]]);
    const obs = extractJudgeObservations("r", [verdict], claimTypes, new Map());
    expect(obs[0].judge_verdict).toBe(false);
  });

  it("maps NEEDS-RUNTIME verdict to judge_verdict=false", () => {
    const verdict = makeVerdict({ verdict: "NEEDS-RUNTIME", claim_id: "X" });
    const claimTypes = new Map([["X", "correctness" as const]]);
    const obs = extractJudgeObservations("r", [verdict], claimTypes, new Map());
    expect(obs[0].judge_verdict).toBe(false);
  });
});

// ─── Ground-truth derivation from golden set ─────────────────────────────────

describe("extractJudgeObservations — ground_truth derivation", () => {
  it("assigns true ground_truth when claim_id is in golden set as true", () => {
    const verdict = makeVerdict({ claim_id: "FR-001" });
    const claimTypes = new Map([["FR-001", "correctness" as const]]);
    const goldenSet: GoldenSet = new Map([["FR-001", true]]);

    const obs = extractJudgeObservations("r", [verdict], claimTypes, goldenSet);
    expect(obs[0].ground_truth).toBe(true);
  });

  it("assigns false ground_truth when claim_id is in golden set as false", () => {
    const verdict = makeVerdict({ claim_id: "FR-002" });
    const claimTypes = new Map([["FR-002", "correctness" as const]]);
    const goldenSet: GoldenSet = new Map([["FR-002", false]]);

    const obs = extractJudgeObservations("r", [verdict], claimTypes, goldenSet);
    expect(obs[0].ground_truth).toBe(false);
  });

  it("assigns unknown ground_truth when claim_id is not in golden set", () => {
    const verdict = makeVerdict({ claim_id: "FR-003" });
    const claimTypes = new Map([["FR-003", "correctness" as const]]);
    const goldenSet: GoldenSet = new Map(); // empty

    const obs = extractJudgeObservations("r", [verdict], claimTypes, goldenSet);
    expect(obs[0].ground_truth).toBe("unknown");
  });
});

// ─── Queue file is created if data directory is absent ────────────────────────

describe("flushObservations — data directory creation", () => {
  it("creates the data directory if it does not exist before appending", () => {
    const repo = new RecordingRepository();
    const rootDir = join(tmpdir(), `obs-newdir-${randomUUID()}`);
    const queuePath = join(rootDir, "sub", "data", "pending-observations.jsonl");

    const obs: JudgeObservation = {
      run_id: "run-dir",
      judge_id: { kind: "genius", name: "feynman" },
      claim_id: "FR-001",
      claim_type: "correctness",
      judge_verdict: true,
      judge_confidence: 0.9,
      ground_truth: "unknown",
    };

    flushObservations([obs], repo, queuePath);

    expect(existsSync(queuePath)).toBe(true);
    const lines = readQueueLines(queuePath);
    expect(lines.length).toBe(1);

    rmSync(rootDir, { recursive: true, force: true });
  });
});
