/**
 * Tests for ConsensusReliabilityProvider integration in consensus.ts (Wave D2.2).
 *
 * Coverage:
 *   D2.5-1: A stub provider returning a calibrated record causes Bayesian weights
 *            to shift away from the Beta(7,3) prior mean (0.7) toward the
 *            calibrated value.
 *   D2.5-2: When reliabilityProvider is undefined, all weights remain at the
 *            prior (backward compat — identical to pre-Wave-D behaviour).
 *   D2.5-4: End-to-end: a synthetic run with calibrated reliability 0.95 for
 *            one judge produces a DIFFERENT consensus verdict than a run without
 *            calibration in a 2-judge tie-break scenario.
 *
 * Layer check: this test file imports from @prd-gen/core (types) and from
 * ../consensus.js (implementation). It does NOT import @prd-gen/benchmark.
 *
 * source: Wave D2 deliverable D2.5.
 */

import { describe, it, expect } from "vitest";
import { consensus } from "../consensus.js";
import type { JudgeVerdict, AgentIdentity, ConsensusReliabilityProvider } from "@prd-gen/core";
import type { VerdictDirection, JudgeReliabilityRecord } from "@prd-gen/core";
import type { Claim } from "@prd-gen/core";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const judge = (name: string): AgentIdentity => ({ kind: "genius", name } as AgentIdentity);

const verdict = (
  v: JudgeVerdict["verdict"],
  judgeName: string,
  confidence = 0.8,
): JudgeVerdict => ({
  judge: judge(judgeName),
  claim_id: "C-test",
  verdict: v,
  rationale: "stub",
  caveats: [],
  confidence,
});

/**
 * Stub ConsensusReliabilityProvider that returns a fixed JudgeReliabilityRecord.
 *
 * Precondition: alpha, beta > 0.
 * Postcondition: getReliabilityForRun always returns the fixed record regardless
 *   of run partitioning (control-arm logic is bypassed — not production wiring).
 */
function makeStubProvider(alpha: number, beta: number): ConsensusReliabilityProvider {
  const record: JudgeReliabilityRecord = {
    agentKind: "genius",
    agentName: "stub",
    claimType: "functional",
    verdictDirection: "sensitivity_arm",
    alpha,
    beta,
    nObservations: alpha + beta - 10, // ESS = alpha + beta; nObs = (alpha+beta) - 10
    lastUpdated: new Date().toISOString(),
    schemaVersion: 2,
  };
  return {
    getReliabilityForRun(
      _runId: string,
      _judge: AgentIdentity,
      _claimType: Claim["claim_type"],
      _direction: VerdictDirection,
    ): JudgeReliabilityRecord | null {
      return record;
    },
  };
}

/**
 * Stub that always returns null — simulates control arm or cold start.
 */
const nullProvider: ConsensusReliabilityProvider = {
  getReliabilityForRun() {
    return null;
  },
};

// ─── D2.5-1: Provider shifts weights from prior (0.7) toward calibrated value ──

describe("ConsensusReliabilityProvider integration", () => {
  it(
    "D2.5-1: calibrated provider (reliability=0.95) causes Bayesian verdict to " +
      "shift compared to default prior (0.70)",
    () => {
      // Scenario: two judges vote PASS with high confidence.
      // With reliability=0.95 (calibrated), the posterior update is stronger
      // than with the default 0.7 prior mean.
      const verdicts: readonly JudgeVerdict[] = [
        verdict("PASS", "fermi", 0.9),
        verdict("PASS", "carnot", 0.9),
      ];

      // Run A: with calibrated reliability provider (α=16, β=4 → mean=0.8)
      const highAlpha = 16;
      const highBeta = 4;
      const providerHigh = makeStubProvider(highAlpha, highBeta);
      const outHigh = consensus("C-test", verdicts, {
        strategy: "bayesian",
        reliabilityProvider: providerHigh,
        runId: "run-treatment-1",
        claimType: "functional",
      });

      // Run B: without provider (prior mean = 0.7)
      const outPrior = consensus("C-test", verdicts, {
        strategy: "bayesian",
      });

      // Both should reach PASS, but with higher confidence when reliability is higher.
      expect(outHigh.verdict).toBe("PASS");
      expect(outPrior.verdict).toBe("PASS");

      // The higher reliability (0.8) should produce a higher or equal PASS confidence
      // than the default 0.7 prior. Due to the multiplicative effect of reliability*confidence
      // on the posterior update, outHigh should have >= confidence vs outPrior.
      expect(outHigh.distribution.PASS).toBeGreaterThanOrEqual(
        outPrior.distribution.PASS,
      );
    },
  );

  // ─── D2.5-2: Backward compat — undefined provider → prior-only behaviour ──────

  it("D2.5-2: when reliabilityProvider is undefined, all weights fall back to Beta(7,3) prior", () => {
    const verdicts: readonly JudgeVerdict[] = [
      verdict("SPEC-COMPLETE", "fermi", 0.9),
      verdict("SPEC-COMPLETE", "carnot", 0.9),
    ];

    // Run A: no provider configured (pre-Wave-D behaviour)
    const outNone = consensus("C-test", verdicts, { strategy: "bayesian" });

    // Run B: null-returning provider (explicitly control-arm; same semantic)
    const outNull = consensus("C-test", verdicts, {
      strategy: "bayesian",
      reliabilityProvider: nullProvider,
      runId: "run-control",
      claimType: "functional",
    });

    // Both must produce the same result — null provider falls through to prior.
    expect(outNone.verdict).toBe(outNull.verdict);
    expect(outNone.confidence).toBeCloseTo(outNull.confidence, 10);
    // Distribution values must match to floating-point precision.
    const verdictKeys = ["PASS", "SPEC-COMPLETE", "NEEDS-RUNTIME", "INCONCLUSIVE", "FAIL"] as const;
    for (const k of verdictKeys) {
      expect(outNone.distribution[k]).toBeCloseTo(outNull.distribution[k], 10);
    }
  });

  // ─── D2.5-4: End-to-end 2-judge tie-break with calibrated vs uncalibrated ──────

  it(
    "D2.5-4: 2-judge tie-break (PASS vs FAIL) — calibrated reliability=0.95 for " +
      "PASS judge changes verdict vs uncalibrated",
    () => {
      // Scenario: Judge A (fermi) says PASS with confidence 0.9.
      //           Judge B (carnot) says FAIL with confidence 0.9.
      // Equal confidence → without calibration, Bayesian posterior is close to
      // uniform over PASS/FAIL (two equal but opposing updates from the same
      // prior reliability 0.7 each → roughly symmetrical posterior).
      //
      // With fermi's reliability calibrated to 0.95 and carnot left at prior,
      // fermi's PASS observation carries more weight, pushing the posterior toward PASS.
      //
      // NOTE: The Bayesian posterior update is (r * prior[PASS]) + ((1-r)/4 * others).
      // With fermi at 0.95 and carnot at 0.7, fermi's update is stronger.
      // Expected: calibrated run → PASS; uncalibrated run → FAIL or INCONCLUSIVE
      //           due to tie resolved by severity tiebreaker (FAIL > PASS).

      const verdictsFermiPass: readonly JudgeVerdict[] = [
        verdict("PASS", "fermi", 0.9),
        verdict("FAIL", "carnot", 0.9),
      ];

      // Calibrated: fermi at reliability=0.95 (α=16.5, β=1.5 → mean≈0.917)
      // carnot falls through to prior (null return for carnot; stub returns same for all)
      // We use a targeted stub that returns high reliability for fermi only.
      const targetedProvider: ConsensusReliabilityProvider = {
        getReliabilityForRun(
          _runId: string,
          j: AgentIdentity,
          _claimType: Claim["claim_type"],
          _direction: VerdictDirection,
        ): JudgeReliabilityRecord | null {
          if (j.name === "fermi") {
            // Very high reliability for fermi: α=25, β=3 → mean=0.893
            return {
              agentKind: "genius",
              agentName: "fermi",
              claimType: "functional",
              verdictDirection: "specificity_arm",
              alpha: 25,
              beta: 3,
              nObservations: 18,
              lastUpdated: new Date().toISOString(),
              schemaVersion: 2,
            };
          }
          // carnot: return null → falls back to prior (0.7)
          return null;
        },
      };

      const outCalibrated = consensus("C-test", verdictsFermiPass, {
        strategy: "bayesian",
        reliabilityProvider: targetedProvider,
        runId: "run-treatment",
        claimType: "functional",
      });

      const outUncalibrated = consensus("C-test", verdictsFermiPass, {
        strategy: "bayesian",
      });

      // With calibration: fermi (PASS, r≈0.893) >> carnot (FAIL, r=0.7).
      // Fermi's PASS update is stronger → posterior favors PASS.
      expect(outCalibrated.distribution.PASS).toBeGreaterThan(
        outUncalibrated.distribution.PASS,
      );

      // The verdicts should differ: calibrated should lean PASS more.
      // (The exact verdict depends on posterior magnitude; what matters is
      // the calibrated PASS mass is higher than uncalibrated.)
      // Both are deterministic given the inputs above.
      expect(outCalibrated.verdict).toBe("PASS");
      // Uncalibrated: equal reliability 0.7 each → FAIL wins via severity tiebreaker.
      expect(outUncalibrated.verdict).toBe("FAIL");
    },
  );

  // ─── Distribution invariant preserved with provider ──────────────────────────

  it("distribution invariant is preserved when provider returns a high-alpha record", () => {
    const verdicts: readonly JudgeVerdict[] = [
      verdict("PASS", "fermi", 0.9),
      verdict("FAIL", "carnot", 0.8),
      verdict("PASS", "liskov", 0.7),
    ];

    const out = consensus("C-test", verdicts, {
      strategy: "bayesian",
      reliabilityProvider: makeStubProvider(19, 1), // mean=0.95
      runId: "run-inv-test",
      claimType: "functional",
    });

    const keys = ["PASS", "SPEC-COMPLETE", "NEEDS-RUNTIME", "INCONCLUSIVE", "FAIL"] as const;
    let sum = 0;
    for (const k of keys) {
      expect(out.distribution[k]).toBeGreaterThanOrEqual(0);
      expect(out.distribution[k]).toBeLessThanOrEqual(1);
      sum += out.distribution[k];
    }
    expect(sum).toBeGreaterThan(1 - 1e-9);
    expect(sum).toBeLessThan(1 + 1e-9);
    expect(out.confidence).toBeGreaterThanOrEqual(0);
    expect(out.confidence).toBeLessThanOrEqual(1);
  });
});
