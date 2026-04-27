/**
 * Tests for calibration-seams.ts — B-Curie-4, B-Shannon-6, B-Popper-1, M2.
 *
 * Split from observations.test.ts to keep both files under 500 lines
 * (coding-standards §4.1).
 *
 * Coverage:
 *   B-Curie-4: AnnotatorView removes judge_verdict and judge_confidence.
 *   B-Shannon-6: JudgeId structured record round-trips losslessly.
 *   B-Popper-1: isControlArmRun deterministic; getReliabilityForRun seam.
 *   M2 / Popper AP-5: verifyHeldoutPartitionSeal — lock-missing, hash-mismatch,
 *     sealed_at-in-future, and hash-match-passes tests.
 */

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import {
  extractJudgeObservations,
  toAnnotatorView,
  isControlArmRun,
  getReliabilityForRun,
  type JudgeObservation,
  type JudgeId,
  type GoldenSet,
} from "../observations.js";
import { verifyHeldoutPartitionSeal } from "../calibration-seams.js";
import type { JudgeVerdict } from "@prd-gen/core";

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

// ─── B-Curie-4: AnnotatorView — judge_verdict leakage prevention ─────────────

describe("toAnnotatorView — B-Curie-4", () => {
  const fullObs: JudgeObservation = {
    run_id: "run-annotator",
    judge_id: { kind: "genius", name: "feynman" },
    claim_id: "FR-001",
    claim_type: "correctness",
    judge_verdict: true,
    judge_confidence: 0.95,
    ground_truth: true,
  };

  it("toAnnotatorView removes judge_verdict from the returned object", () => {
    const view = toAnnotatorView(fullObs);
    // Runtime check: the property must not exist on the returned object.
    expect("judge_verdict" in view).toBe(false);
  });

  it("toAnnotatorView removes judge_confidence from the returned object", () => {
    const view = toAnnotatorView(fullObs);
    expect("judge_confidence" in view).toBe(false);
  });

  it("toAnnotatorView preserves run_id, judge_id, claim_id, claim_type, ground_truth", () => {
    const view = toAnnotatorView(fullObs);
    expect(view.run_id).toBe("run-annotator");
    expect(view.judge_id).toStrictEqual({ kind: "genius", name: "feynman" });
    expect(view.claim_id).toBe("FR-001");
    expect(view.claim_type).toBe("correctness");
    expect(view.ground_truth).toBe(true);
  });

  it("TypeScript rejects accessing judge_verdict on AnnotatorView (@ts-expect-error)", () => {
    const view = toAnnotatorView(fullObs);
    // @ts-expect-error — AnnotatorView deliberately omits judge_verdict;
    // TypeScript must reject this property access at compile time.
    expect(view.judge_verdict).toBeUndefined();
  });
});

// ─── B-Shannon-6: judge_id structured record — round-trip with colon in name ─

describe("JudgeId structured record — B-Shannon-6", () => {
  it("judge_id round-trips faithfully when name contains ':'", () => {
    // Before fix: judge_id = 'genius:some:colon:name' — splitting on ':' gives
    // ['genius', 'some', 'colon', 'name'], losing the kind/name boundary.
    // After fix: judge_id = { kind: 'genius', name: 'some:colon:name' } — no
    // delimiter encoding; round-trip is lossless for any name string.
    const verdict = makeVerdict({
      judge: { kind: "genius", name: "some:colon:name" },
      claim_id: "FR-COLON",
    });
    const claimTypes = new Map([["FR-COLON", "correctness" as const]]);
    const goldenSet: GoldenSet = new Map();

    const obs = extractJudgeObservations("run-colon", [verdict], claimTypes, goldenSet);
    expect(obs.length).toBe(1);

    const judgeId = obs[0].judge_id as JudgeId;
    expect(judgeId.kind).toBe("genius");
    // The name is preserved exactly — no lossy split on ':'.
    expect(judgeId.name).toBe("some:colon:name");
  });

  it("judge_id round-trips for a name with every printable ASCII delimiter character", () => {
    const specialName = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
    const verdict = makeVerdict({
      judge: { kind: "team", name: specialName },
      claim_id: "FR-ASCII",
    });
    const claimTypes = new Map([["FR-ASCII", "correctness" as const]]);
    const goldenSet: GoldenSet = new Map();

    const obs = extractJudgeObservations("run-ascii", [verdict], claimTypes, goldenSet);
    const judgeId = obs[0].judge_id as JudgeId;
    expect(judgeId.kind).toBe("team");
    expect(judgeId.name).toBe(specialName);
  });
});

// ─── B-Popper-1: control arm seam — isControlArmRun ─────────────────────────

describe("isControlArmRun — B-Popper-1 CC-3 control arm", () => {
  it("is deterministic — same run_id always returns the same value", () => {
    const runId = "deterministic-run-123";
    const first = isControlArmRun(runId);
    const second = isControlArmRun(runId);
    expect(first).toBe(second);
  });

  it("ε ≈ 0.20: approximately 1 in 5 run IDs are assigned to the control arm", () => {
    // Sample 1000 run IDs and verify that ~20% land in the control arm.
    // FNV-1a % 5 === 0 gives exactly 1/5 for a uniform hash distribution.
    let controlCount = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      if (isControlArmRun(`run-${i}`)) controlCount++;
    }
    // Allow ±5% from 20% (tight: we're testing a deterministic function).
    expect(controlCount / N).toBeGreaterThan(0.15);
    expect(controlCount / N).toBeLessThan(0.25);
  });

  it("control arm runs return null from getReliabilityForRun regardless of repository content", () => {
    // A synthetic repository that returns a non-null sentinel.
    const fakeRepo = {
      getReliability: () => ({ alpha: 9, beta: 3 }),
    };

    // Find a run_id that IS a control arm run.
    let controlRunId: string | null = null;
    for (let i = 0; i < 100; i++) {
      const id = `probe-${i}`;
      if (isControlArmRun(id)) {
        controlRunId = id;
        break;
      }
    }
    expect(controlRunId).not.toBeNull();

    const result = getReliabilityForRun(
      controlRunId!,
      { kind: "genius", name: "laplace" },
      "correctness",
      "sensitivity_arm",
      fakeRepo,
    );
    // Control arm must return null regardless of repository content.
    expect(result).toBeNull();
  });

  it("treatment arm runs delegate to the repository", () => {
    const sentinel = { alpha: 9, beta: 3 };
    const fakeRepo = {
      getReliability: () => sentinel,
    };

    // Find a run_id that is NOT a control arm run.
    let treatmentRunId: string | null = null;
    for (let i = 0; i < 100; i++) {
      const id = `treatment-probe-${i}`;
      if (!isControlArmRun(id)) {
        treatmentRunId = id;
        break;
      }
    }
    expect(treatmentRunId).not.toBeNull();

    const result = getReliabilityForRun(
      treatmentRunId!,
      { kind: "genius", name: "laplace" },
      "correctness",
      "sensitivity_arm",
      fakeRepo,
    );
    expect(result).toBe(sentinel);
  });
});

// ─── M2 / Popper AP-5: verifyHeldoutPartitionSeal ───────────────────────────

/**
 * Helper: build a valid HeldoutPartitionLock JSON string.
 * `sealed_at` defaults to one second in the past (valid).
 * `observed_indices` are the claim_ids that will be hashed.
 */
function makeLockJson(
  observed_indices: string[],
  overrides: Record<string, unknown> = {},
): string {
  const sorted = [...observed_indices].sort();
  const partition_hash = createHash("sha256").update(sorted.join("\n")).digest("hex");
  const lock = {
    schema_version: 1,
    rng_seed: 42,
    partition_hash,
    partition_size: observed_indices.length,
    sealed_at: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  };
  return JSON.stringify(lock);
}

function makeTmpDir(): string {
  const dir = join(tmpdir(), `seal-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("verifyHeldoutPartitionSeal — M2 / Popper AP-5", () => {
  it("throws when lock file is missing", () => {
    const lockPath = join(tmpdir(), `nonexistent-${randomUUID()}.lock.json`);
    expect(() =>
      verifyHeldoutPartitionSeal(["C1", "C2"], lockPath),
    ).toThrow(/lock file missing/);
  });

  it("throws when partition_hash does not match observed indices", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "lock.json");
    // Lock is sealed for ["C1", "C2"] but we pass ["C1", "C3"].
    writeFileSync(lockPath, makeLockJson(["C1", "C2"]), "utf8");

    expect(() =>
      verifyHeldoutPartitionSeal(["C1", "C3"], lockPath),
    ).toThrow(/partition hash mismatch/);

    rmSync(dir, { recursive: true });
  });

  it("passes silently when hash matches the lock", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "lock.json");
    const indices = ["C1", "C2", "C3"];
    writeFileSync(lockPath, makeLockJson(indices), "utf8");

    // Postcondition: no error thrown.
    expect(() =>
      verifyHeldoutPartitionSeal(indices, lockPath),
    ).not.toThrow();

    rmSync(dir, { recursive: true });
  });

  it("throws when sealed_at is in the future", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "lock.json");
    const indices = ["C1"];
    writeFileSync(
      lockPath,
      makeLockJson(indices, { sealed_at: new Date(Date.now() + 60_000).toISOString() }),
      "utf8",
    );

    expect(() =>
      verifyHeldoutPartitionSeal(indices, lockPath),
    ).toThrow(/in the future/);

    rmSync(dir, { recursive: true });
  });

  it("passes silently for an empty observed_indices array when lock reflects empty set", () => {
    const dir = makeTmpDir();
    const lockPath = join(dir, "lock.json");
    writeFileSync(lockPath, makeLockJson([]), "utf8");

    expect(() =>
      verifyHeldoutPartitionSeal([], lockPath),
    ).not.toThrow();

    rmSync(dir, { recursive: true });
  });
});
