/**
 * Tests for the observation capture layer (Phase 4.1 reliability calibration).
 *
 * Test plan:
 *   Move 3 — Invariant-to-test map:
 *     I1: N verdicts × M judges → N×M observations (excluding parse failures).
 *     I2: Observations with known ground_truth route to repository.
 *     I3: Observations with unknown ground_truth route to JSONL queue.
 *     I4: JSONL queue lines include schema_version field.
 *     I5: Unknown verdict shape throws loudly (assertVerdictShape).
 *     I6: Parse-failure verdicts (parse_error, judge_invocation_failed) excluded.
 *     I7: AP-5 falsifier — both routing paths fire on a synthetic known-good set.
 *     I8: loadGoldenSet returns empty map for undefined/absent path.
 *     I9: loadGoldenSet correctly parses valid JSONL; skips malformed lines.
 *
 *   Move 5 (unit-vs-integration): all tests are unit tests using tmp files
 *   for the JSONL queue. No network, no real SQLite (B2's concern), no
 *   real golden-set file path used in production.
 *
 * source: test-engineer canonical moves 1, 2, 3, 4, 5 (agent instructions).
 */

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  extractJudgeObservations,
  flushObservations,
  loadGoldenSet,
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

function makeClaimTypes(
  entries: Array<[string, JudgeVerdict["verdict"]]> = [],
): ReadonlyMap<string, "correctness"> {
  // Defaults all to "correctness" for test simplicity.
  const base = new Map<string, "correctness">();
  for (const [id] of entries) {
    base.set(id, "correctness");
  }
  return base;
}

function makeTmpQueuePath(): string {
  const dir = join(tmpdir(), `obs-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "pending-observations.jsonl");
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

// ─── I1: N verdicts × M judges → N×M observations ───────────────────────────

describe("extractJudgeObservations — cardinality", () => {
  it("produces N×M observations for N claims × M judges", () => {
    const claimIds = ["FR-001", "FR-002", "FR-003"];
    const judges: Array<JudgeVerdict["judge"]> = [
      { kind: "genius", name: "feynman" },
      { kind: "genius", name: "shannon" },
      { kind: "team", name: "test-engineer" },
    ];

    const verdicts: JudgeVerdict[] = [];
    for (const claim_id of claimIds) {
      for (const judge of judges) {
        verdicts.push(makeVerdict({ claim_id, judge, verdict: "PASS" }));
      }
    }

    const claimTypes = new Map<string, "correctness">(
      claimIds.map((id) => [id, "correctness"]),
    );
    const goldenSet: GoldenSet = new Map();

    const obs = extractJudgeObservations("run-1", verdicts, claimTypes, goldenSet);

    // Postcondition I1: N×M observations
    expect(obs.length).toBe(claimIds.length * judges.length);
  });

  it("each observation carries the correct run_id, judge_id, claim_id", () => {
    const verdict = makeVerdict({
      judge: { kind: "genius", name: "curie" },
      claim_id: "NFR-LAT",
      verdict: "PASS",
      confidence: 0.85,
    });
    const claimTypes = new Map([["NFR-LAT", "performance" as const]]);
    const goldenSet: GoldenSet = new Map();

    const obs = extractJudgeObservations("run-abc", [verdict], claimTypes, goldenSet);

    expect(obs.length).toBe(1);
    expect(obs[0].run_id).toBe("run-abc");
    // B-Shannon-6: judge_id is now a { kind, name } record, not a string.
    expect(obs[0].judge_id).toStrictEqual({ kind: "genius", name: "curie" });
    expect(obs[0].claim_id).toBe("NFR-LAT");
    expect(obs[0].claim_type).toBe("performance");
    expect(obs[0].judge_confidence).toBe(0.85);
  });
});

// ─── I2: Known ground_truth → repository ────────────────────────────────────

describe("flushObservations — routing to repository", () => {
  it("routes known-ground-truth observations to repository", () => {
    const repo = new RecordingRepository();
    const queuePath = makeTmpQueuePath();

    const obs: JudgeObservation = {
      run_id: "run-1",
      judge_id: { kind: "genius", name: "feynman" },
      claim_id: "FR-001",
      claim_type: "correctness",
      judge_verdict: true,
      judge_confidence: 0.9,
      ground_truth: true,
    };

    flushObservations([obs], repo, queuePath);

    // Postcondition I2: record was called once; queue is empty.
    expect(repo.recorded.length).toBe(1);
    expect(repo.recorded[0]).toStrictEqual(obs);
    expect(readQueueLines(queuePath).length).toBe(0);
  });
});

// ─── I3: Unknown ground_truth → JSONL queue ──────────────────────────────────

describe("flushObservations — routing to JSONL queue", () => {
  it("routes unknown-ground-truth observations to the JSONL queue", () => {
    const repo = new RecordingRepository();
    const queuePath = makeTmpQueuePath();

    const obs: JudgeObservation = {
      run_id: "run-2",
      judge_id: { kind: "genius", name: "shannon" },
      claim_id: "AC-001",
      claim_type: "acceptance_criteria_completeness",
      judge_verdict: false,
      judge_confidence: 0.6,
      ground_truth: "unknown",
    };

    flushObservations([obs], repo, queuePath);

    // Postcondition I3: repository untouched; queue has one line.
    expect(repo.recorded.length).toBe(0);
    const lines = readQueueLines(queuePath);
    expect(lines.length).toBe(1);
  });
});

// ─── I4: JSONL queue lines include schema_version ────────────────────────────

describe("JSONL queue — schema versioning", () => {
  it("each queue line includes schema_version field", () => {
    const repo = new RecordingRepository();
    const queuePath = makeTmpQueuePath();

    const obs: JudgeObservation = {
      run_id: "run-sv",
      judge_id: { kind: "team", name: "test-engineer" },
      claim_id: "NFR-SEC",
      claim_type: "security",
      judge_verdict: false,
      judge_confidence: 0.7,
      ground_truth: "unknown",
    };

    flushObservations([obs], repo, queuePath);

    const lines = readQueueLines(queuePath);
    expect(lines.length).toBe(1);

    // Postcondition I4: schema_version present and is a number.
    expect(typeof lines[0].schema_version).toBe("number");
    expect(lines[0].schema_version).toBeGreaterThanOrEqual(1);
  });

  it("queue lines carry the observation payload inside the observation field", () => {
    const repo = new RecordingRepository();
    const queuePath = makeTmpQueuePath();

    const obs: JudgeObservation = {
      run_id: "run-payload",
      judge_id: { kind: "genius", name: "dijkstra" },
      claim_id: "FR-007",
      claim_type: "correctness",
      judge_verdict: true,
      judge_confidence: 0.8,
      ground_truth: "unknown",
    };

    flushObservations([obs], repo, queuePath);

    const lines = readQueueLines(queuePath);
    const inner = lines[0].observation as Record<string, unknown>;
    expect(inner.claim_id).toBe("FR-007");
    expect(inner.run_id).toBe("run-payload");
    expect(inner.ground_truth).toBe("unknown");
  });
});

// ─── I5: Unknown verdict shape throws loudly ──────────────────────────────────

describe("extractJudgeObservations — loud-fail on bad shape", () => {
  it("throws when verdict lacks required fields", () => {
    const badVerdict = { judge: { kind: "genius", name: "feynman" } };
    const claimTypes = new Map<string, "correctness">();
    const goldenSet: GoldenSet = new Map();

    expect(() =>
      extractJudgeObservations("run-bad", [badVerdict], claimTypes, goldenSet),
    ).toThrow(/assertVerdictShape/);
  });

  it("throws when verdict.confidence is not a number", () => {
    const badVerdict = {
      judge: { kind: "genius", name: "feynman" },
      claim_id: "X",
      verdict: "PASS",
      confidence: "high", // wrong type
      caveats: [],
    };
    const claimTypes = new Map<string, "correctness">();
    const goldenSet: GoldenSet = new Map();

    expect(() =>
      extractJudgeObservations("run-bad", [badVerdict], claimTypes, goldenSet),
    ).toThrow(/assertVerdictShape/);
  });
});

// ─── I6: Parse-failure verdicts excluded ─────────────────────────────────────

describe("extractJudgeObservations — parse-failure exclusion", () => {
  it("excludes verdicts with parse_error caveat", () => {
    const verdicts = [
      makeVerdict({ claim_id: "FR-001", verdict: "PASS", caveats: [] }),
      makeVerdict({ claim_id: "FR-002", verdict: "INCONCLUSIVE", caveats: ["parse_error"] }),
    ];
    const claimTypes = new Map([
      ["FR-001", "correctness" as const],
      ["FR-002", "correctness" as const],
    ]);
    const goldenSet: GoldenSet = new Map();

    const obs = extractJudgeObservations("run-pe", verdicts, claimTypes, goldenSet);

    // Postcondition I6: only FR-001 appears (FR-002 excluded).
    expect(obs.length).toBe(1);
    expect(obs[0].claim_id).toBe("FR-001");
  });

  it("excludes verdicts with judge_invocation_failed caveat", () => {
    const verdicts = [
      makeVerdict({ claim_id: "FR-003", verdict: "PASS", caveats: [] }),
      makeVerdict({
        claim_id: "FR-004",
        verdict: "INCONCLUSIVE",
        caveats: ["judge_invocation_failed"],
        confidence: 0,
      }),
    ];
    const claimTypes = new Map([
      ["FR-003", "correctness" as const],
      ["FR-004", "correctness" as const],
    ]);
    const goldenSet: GoldenSet = new Map();

    const obs = extractJudgeObservations("run-jif", verdicts, claimTypes, goldenSet);

    expect(obs.length).toBe(1);
    expect(obs[0].claim_id).toBe("FR-003");
  });

  it("excludes all parse-failure verdicts leaving an empty result", () => {
    const verdicts = [
      makeVerdict({ verdict: "INCONCLUSIVE", caveats: ["parse_error"] }),
      makeVerdict({ verdict: "INCONCLUSIVE", caveats: ["judge_invocation_failed"] }),
    ];
    const claimTypes = new Map([["FR-001", "correctness" as const]]);
    const goldenSet: GoldenSet = new Map();

    const obs = extractJudgeObservations("run-all-fail", verdicts, claimTypes, goldenSet);

    expect(obs.length).toBe(0);
  });
});

// ─── I7: AP-5 falsifier — both routing paths fire ────────────────────────────

/**
 * AP-5 falsifier (Popper): inject a known-good synthetic observation set with
 * both known and unknown ground truths; verify that BOTH routing paths fire.
 *
 * Matches the Wave A1 instrumentation-injection.test.ts pattern.
 *
 * source: Phase 4.1 §4.1 — "Negative falsifier: on a held-out labeled set,
 * calibrated consensus accuracy ≥ uncalibrated accuracy. If the negative
 * falsifier fires, REVERT to default prior and investigate." This test
 * exercises the observation routing infrastructure that feeds the calibration,
 * not the math itself (B1's concern).
 */
describe("AP-5 falsifier — synthetic injection", () => {
  it("both routing paths fire on a mixed-ground-truth observation set", () => {
    const repo = new RecordingRepository();
    const queuePath = makeTmpQueuePath();

    const knownObs: JudgeObservation = {
      run_id: "ap5-run",
      judge_id: { kind: "genius", name: "feynman" },
      claim_id: "FR-KNOWN",
      claim_type: "correctness",
      judge_verdict: true,
      judge_confidence: 0.95,
      ground_truth: true, // in golden set
    };

    const unknownObs: JudgeObservation = {
      run_id: "ap5-run",
      judge_id: { kind: "genius", name: "feynman" },
      claim_id: "FR-UNKNOWN",
      claim_type: "correctness",
      judge_verdict: false,
      judge_confidence: 0.7,
      ground_truth: "unknown", // not yet labeled
    };

    flushObservations([knownObs, unknownObs], repo, queuePath);

    // Golden path must have fired exactly once.
    expect(repo.recorded.length).toBe(1);
    expect(repo.recorded[0].claim_id).toBe("FR-KNOWN");

    // Queue path must have fired exactly once.
    const lines = readQueueLines(queuePath);
    expect(lines.length).toBe(1);
    const queuedObs = (lines[0].observation as Record<string, unknown>);
    expect(queuedObs.claim_id).toBe("FR-UNKNOWN");
    expect(queuedObs.ground_truth).toBe("unknown");
  });

  it("multiple observations of mixed kind route correctly (end-to-end)", () => {
    const repo = new RecordingRepository();
    const queuePath = makeTmpQueuePath();

    // 5 claims, 2 judges → 10 verdicts
    const claimIds = ["C1", "C2", "C3", "C4", "C5"];
    const judges: JudgeVerdict["judge"][] = [
      { kind: "genius", name: "feynman" },
      { kind: "team", name: "test-engineer" },
    ];
    const verdicts: JudgeVerdict[] = [];
    for (const claim_id of claimIds) {
      for (const judge of judges) {
        verdicts.push(makeVerdict({ claim_id, judge, verdict: "PASS" }));
      }
    }

    const claimTypes = new Map<string, "correctness">(
      claimIds.map((id) => [id, "correctness"]),
    );

    // C1, C2 have known ground truth; C3, C4, C5 do not.
    const goldenSet: GoldenSet = new Map([
      ["C1", true],
      ["C2", false],
    ]);

    const obs = extractJudgeObservations("run-multi", verdicts, claimTypes, goldenSet);

    // 10 verdicts → 10 observations (no parse failures).
    expect(obs.length).toBe(10);

    flushObservations(obs, repo, queuePath);

    // C1 and C2 × 2 judges = 4 known → repository.
    expect(repo.recorded.length).toBe(4);

    // C3, C4, C5 × 2 judges = 6 unknown → queue.
    const lines = readQueueLines(queuePath);
    expect(lines.length).toBe(6);

    // Every queue line must have schema_version.
    for (const line of lines) {
      expect(typeof line.schema_version).toBe("number");
    }
  });
});

// ─── I8 + I9: loadGoldenSet ──────────────────────────────────────────────────

describe("loadGoldenSet", () => {
  it("returns empty map when path is undefined", () => {
    const gs = loadGoldenSet(undefined);
    expect(gs.size).toBe(0);
  });

  it("returns empty map when file does not exist", () => {
    const gs = loadGoldenSet("/tmp/nonexistent-golden-set-xyz.jsonl");
    expect(gs.size).toBe(0);
  });

  it("parses valid JSONL and returns correct entries", () => {
    const dir = join(tmpdir(), `golden-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "golden.jsonl");

    // Write two valid lines.
    writeFileSync(
      path,
      [
        JSON.stringify({ claim_id: "FR-001", ground_truth: true }),
        JSON.stringify({ claim_id: "FR-002", ground_truth: false }),
      ].join("\n") + "\n",
      "utf8",
    );

    const gs = loadGoldenSet(path);
    expect(gs.size).toBe(2);
    expect(gs.get("FR-001")).toBe(true);
    expect(gs.get("FR-002")).toBe(false);

    rmSync(dir, { recursive: true });
  });

  it("skips malformed lines and loads valid ones", () => {
    const dir = join(tmpdir(), `golden-malformed-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "golden.jsonl");

    writeFileSync(
      path,
      [
        JSON.stringify({ claim_id: "FR-001", ground_truth: true }),
        "not-json-at-all",
        JSON.stringify({ claim_id: "FR-002" }), // missing ground_truth
        JSON.stringify({ claim_id: "FR-003", ground_truth: true }),
      ].join("\n") + "\n",
      "utf8",
    );

    const gs = loadGoldenSet(path);
    // FR-001 and FR-003 are valid; the others are skipped.
    expect(gs.size).toBe(2);
    expect(gs.get("FR-001")).toBe(true);
    expect(gs.get("FR-003")).toBe(true);

    rmSync(dir, { recursive: true });
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

// B-Curie-4, B-Shannon-6, and B-Popper-1 tests are in calibration-seams.test.ts
// (split to keep this file under 500 lines per coding-standards §4.1).
