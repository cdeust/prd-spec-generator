/**
 * D2.D unit tests — calibrated reliability integration in the consensus engine.
 *
 * Test plan:
 *   1. High-reliability judge gets higher weight than low-reliability judge
 *      (Bayesian strategy, reliabilityProvider injected).
 *   2. Control-arm run (provider returns null) falls back to scalar prior.
 *   3. Missing reliabilityProvider → identical to pre-Wave-D baseline (scalar prior).
 *   4. ConsensusConfig.reliability map still works (backward compat).
 *   5. Distribution invariants preserved with calibrated weights (no [0,1] violations).
 *
 * All tests use stub implementations — no SQLite, no filesystem I/O.
 *
 * source: D2.D specification; coding-standards §4 (hermetic tests).
 */

import { describe, expect, it } from "vitest";
import { consensus } from "../consensus.js";
import type {
  JudgeVerdict,
  AgentIdentity,
  JudgeReliabilityRecord,
  VerdictDirection,
  ConsensusReliabilityProvider,
} from "@prd-gen/core";
import type { Claim } from "@prd-gen/core";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeJudge(name: string): AgentIdentity {
  return { kind: "genius", name } as AgentIdentity;
}

function makeVerdict(
  judge: AgentIdentity,
  verdict: JudgeVerdict["verdict"],
  confidence = 0.9,
): JudgeVerdict {
  return {
    judge,
    claim_id: "C-1",
    verdict,
    rationale: "test",
    caveats: [],
    confidence,
  };
}

/** Build a calibrated Beta record with posteriorMean = alpha / (alpha + beta). */
function makeRecord(alpha: number, beta: number): JudgeReliabilityRecord {
  return {
    agentKind: "genius",
    agentName: "test",
    claimType: "correctness",
    verdictDirection: "specificity_arm",
    alpha,
    beta,
    nObservations: alpha + beta - 10,
    lastUpdated: new Date().toISOString(),
    schemaVersion: 2,
  };
}

/**
 * Stub ConsensusReliabilityProvider — returns a specified record for a named
 * judge, null for all others (simulating "no calibration data" fallback).
 *
 * Precondition: judgeReliabilities maps agentName → JudgeReliabilityRecord.
 * Postcondition: returns the record for the named judge, null otherwise.
 */
function stubProvider(
  judgeReliabilities: ReadonlyMap<string, JudgeReliabilityRecord | null>,
): ConsensusReliabilityProvider {
  return {
    getReliabilityForRun(
      _runId: string,
      judge: AgentIdentity,
      _claimType: Claim["claim_type"],
      _direction: VerdictDirection,
    ): JudgeReliabilityRecord | null {
      return judgeReliabilities.get(judge.name) ?? null;
    },
  };
}

/** Control-arm stub — always returns null (simulates CC-3 control arm). */
function controlArmProvider(): ConsensusReliabilityProvider {
  return {
    getReliabilityForRun(): JudgeReliabilityRecord | null {
      return null;
    },
  };
}

/** Assert distribution invariants on any ConsensusVerdict. */
function assertDistributionInvariants(
  out: ReturnType<typeof consensus>,
  testName: string,
): void {
  const verdicts = [
    "PASS",
    "SPEC-COMPLETE",
    "NEEDS-RUNTIME",
    "INCONCLUSIVE",
    "FAIL",
  ] as const;
  let sum = 0;
  for (const k of verdicts) {
    const p = out.distribution[k];
    expect(p, `${testName}: ${k} must be ≥ 0`).toBeGreaterThanOrEqual(0);
    expect(p, `${testName}: ${k} must be ≤ 1`).toBeLessThanOrEqual(1);
    sum += p;
  }
  if (out.judges.length > 0) {
    expect(sum, `${testName}: distribution must sum to ~1`).toBeGreaterThan(1 - 1e-9);
    expect(sum, `${testName}: distribution must sum to ~1`).toBeLessThan(1 + 1e-9);
  }
  expect(
    out.confidence,
    `${testName}: confidence must be in [0,1]`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    out.confidence,
    `${testName}: confidence must be in [0,1]`,
  ).toBeLessThanOrEqual(1);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("consensus — calibrated reliability integration (D2.A)", () => {
  it("D2.D-1: high-reliability judge gets more weight than low-reliability judge", () => {
    // High-reliability judge (posteriorMean = 0.9).
    const highJudge = makeJudge("high-reliability");
    // Low-reliability judge (posteriorMean = 0.4).
    const lowJudge = makeJudge("low-reliability");

    // High judge says FAIL; low judge says PASS.
    // With calibrated weights, FAIL should be preferred.
    const verdicts = [
      makeVerdict(highJudge, "FAIL", 1.0),
      makeVerdict(lowJudge, "PASS", 1.0),
    ];

    const provider = stubProvider(
      new Map([
        ["high-reliability", makeRecord(9, 1)],  // posteriorMean = 0.9
        ["low-reliability", makeRecord(4, 6)],   // posteriorMean = 0.4
      ]),
    );

    const out = consensus("C-1", verdicts, {
      strategy: "bayesian",
      reliabilityProvider: provider,
      runId: "run_test_high_vs_low",
      claimType: "correctness",
    });

    // High-reliability (0.9) judge's FAIL should outweigh low-reliability (0.4) PASS.
    // The product of adjustedReliability × confidence determines the weight.
    // High: 0.9 × 1.0 = 0.9; Low: 0.4 × 1.0 = 0.4.
    // Both > NO_INFORMATION_FLOOR (0.2), so both contribute.
    // Posterior should favor FAIL.
    expect(out.verdict).toBe("FAIL");
    assertDistributionInvariants(out, "D2.D-1");
  });

  it("D2.D-2: control-arm run (provider returns null) falls back to scalar prior", () => {
    const judgeA = makeJudge("alice");
    const judgeB = makeJudge("bob");

    // Both say SPEC-COMPLETE with equal confidence. Provider is control arm (always null).
    const verdicts = [
      makeVerdict(judgeA, "SPEC-COMPLETE", 0.8),
      makeVerdict(judgeB, "SPEC-COMPLETE", 0.8),
    ];

    // Control-arm provider → null for all judges → falls back to prior mean (0.7).
    const out = consensus("C-1", verdicts, {
      strategy: "bayesian",
      reliabilityProvider: controlArmProvider(),
      runId: "run_control_arm",
      claimType: "correctness",
    });

    // With prior mean 0.7, both judges are informative (> NO_INFORMATION_FLOOR 0.2).
    // Both agree on SPEC-COMPLETE → posterior strongly favors SPEC-COMPLETE.
    expect(out.verdict).toBe("SPEC-COMPLETE");
    assertDistributionInvariants(out, "D2.D-2");
  });

  it("D2.D-3: no reliabilityProvider → pre-Wave-D baseline (scalar prior for all)", () => {
    const judgeA = makeJudge("fermi");
    const verdicts = [makeVerdict(judgeA, "PASS", 0.9)];

    // No provider, no lookup, no static map — falls back to DEFAULT_RELIABILITY_PRIOR_MEAN.
    const outWithProvider = consensus("C-1", verdicts, {
      strategy: "bayesian",
      reliabilityProvider: controlArmProvider(), // always returns null
      claimType: "correctness",
      runId: "any-run",
    });

    const outWithoutProvider = consensus("C-1", verdicts, {
      strategy: "bayesian",
      // No reliabilityProvider — identical pre-Wave-D behaviour.
    });

    // Both should produce the same verdict and distribution because the control
    // arm / absent provider both fall through to the scalar prior (0.7).
    expect(outWithProvider.verdict).toBe(outWithoutProvider.verdict);
    assertDistributionInvariants(outWithProvider, "D2.D-3 with provider");
    assertDistributionInvariants(outWithoutProvider, "D2.D-3 without provider");
  });

  it("D2.D-4: backward compat — ConsensusConfig.reliability map still works", () => {
    const judgeA = makeJudge("high-rel");
    const judgeB = makeJudge("low-rel");

    const verdicts = [
      makeVerdict(judgeA, "FAIL", 1.0),
      makeVerdict(judgeB, "PASS", 1.0),
    ];

    // Static map takes priority over scalar prior, but not over reliabilityProvider.
    const out = consensus("C-1", verdicts, {
      strategy: "bayesian",
      reliability: new Map([
        ["genius:high-rel", 0.9],
        ["genius:low-rel", 0.4],
      ]),
      // No reliabilityProvider — uses static map.
    });

    // Same logic as D2.D-1 but via static map.
    expect(out.verdict).toBe("FAIL");
    assertDistributionInvariants(out, "D2.D-4");
  });

  it("D2.D-5: distribution invariants preserved with calibrated weights", () => {
    // Stress test with multiple judges and varying reliabilities.
    const judges = ["a", "b", "c", "d", "e"].map(makeJudge);
    const verdicts = [
      makeVerdict(judges[0], "PASS", 0.9),
      makeVerdict(judges[1], "FAIL", 0.8),
      makeVerdict(judges[2], "SPEC-COMPLETE", 0.7),
      makeVerdict(judges[3], "NEEDS-RUNTIME", 1.0),
      makeVerdict(judges[4], "INCONCLUSIVE", 0.5),
    ];

    const provider = stubProvider(
      new Map([
        ["a", makeRecord(9, 1)],  // posteriorMean = 0.9
        ["b", makeRecord(8, 2)],  // posteriorMean = 0.8
        ["c", makeRecord(7, 3)],  // posteriorMean = 0.7 (prior)
        ["d", makeRecord(6, 4)],  // posteriorMean = 0.6
        ["e", makeRecord(4, 6)],  // posteriorMean = 0.4 — but adjusted = 0.4 × 0.5 = 0.2 → exactly floor
        // Note: e is skipped because adjustedReliability ≤ NO_INFORMATION_FLOOR (0.2).
      ]),
    );

    const out = consensus("C-1", verdicts, {
      strategy: "bayesian",
      reliabilityProvider: provider,
      runId: "run_stress",
      claimType: "correctness",
    });

    assertDistributionInvariants(out, "D2.D-5");
  });

  it("D2.D-6: provider lookup returns null for unknown judge → falls back to static map", () => {
    const knownJudge = makeJudge("known");
    const unknownJudge = makeJudge("unknown");

    const verdicts = [
      makeVerdict(knownJudge, "FAIL", 1.0),
      makeVerdict(unknownJudge, "PASS", 1.0),
    ];

    // Provider knows only "known" judge; "unknown" falls back to static map (0.3 → low).
    const provider = stubProvider(
      new Map<string, JudgeReliabilityRecord | null>([
        ["known", makeRecord(9, 1)], // posteriorMean = 0.9
        ["unknown", null],           // null → fallback to static map
      ]),
    );

    const out = consensus("C-1", verdicts, {
      strategy: "bayesian",
      reliabilityProvider: provider,
      runId: "run_fallback",
      claimType: "correctness",
      reliability: new Map([
        ["genius:unknown", 0.3], // static map fallback for unknown judge
      ]),
    });

    // known (0.9 × 1.0 = 0.9) >> unknown (0.3 × 1.0 = 0.3 > floor).
    // Both informative, but known judge's FAIL has much more weight.
    expect(out.verdict).toBe("FAIL");
    assertDistributionInvariants(out, "D2.D-6");
  });
});
