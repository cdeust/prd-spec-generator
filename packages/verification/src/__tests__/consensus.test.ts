import { describe, expect, it } from "vitest";
import { consensus } from "../consensus.js";
import type { JudgeVerdict } from "@prd-gen/core";

const judge = (kind: "genius" | "team", name: string) =>
  ({ kind, name } as const) as JudgeVerdict["judge"];

const v = (
  verdict: JudgeVerdict["verdict"],
  confidence = 0.8,
  judgeName = "liskov",
): JudgeVerdict => ({
  judge: judge("genius", judgeName) as JudgeVerdict["judge"],
  claim_id: "C-1",
  verdict,
  rationale: "x",
  caveats: [],
  confidence,
});

describe("consensus", () => {
  it("returns INCONCLUSIVE with confidence 0 on empty verdicts", () => {
    const out = consensus("C-1", []);
    expect(out.verdict).toBe("INCONCLUSIVE");
    expect(out.confidence).toBe(0);
    expect(out.unanimous).toBe(false);
    expect(out.judges).toEqual([]);
  });

  it("weighted_average — picks the plurality verdict", () => {
    const verdicts = [v("PASS", 0.9), v("PASS", 0.9), v("SPEC-COMPLETE", 0.5)];
    const out = consensus("C-1", verdicts);
    expect(out.verdict).toBe("PASS");
    expect(out.unanimous).toBe(false);
  });

  it("weighted_average — fail_threshold forces FAIL when ≥50% confidence votes FAIL", () => {
    const verdicts = [
      v("PASS", 0.4),
      v("FAIL", 0.6),
    ];
    const out = consensus("C-1", verdicts);
    expect(out.verdict).toBe("FAIL");
  });

  it("weighted_average — tie-breaking favors more-severe verdict (precautionary)", () => {
    // Equal weight on PASS and INCONCLUSIVE → INCONCLUSIVE wins (more severe).
    // To get truly equal weights we override fail_threshold so FAIL gating is moot.
    const verdicts = [v("PASS", 1), v("INCONCLUSIVE", 1)];
    const out = consensus("C-1", verdicts, { strategy: "weighted_average" });
    expect(out.verdict).toBe("INCONCLUSIVE");
  });

  it("falls back to count-based vote when all confidences are 0", () => {
    const verdicts = [v("FAIL", 0), v("FAIL", 0), v("PASS", 0)];
    const out = consensus("C-1", verdicts);
    // FAIL has 2/3 weight under count-based fallback → triggers fail_threshold.
    expect(out.verdict).toBe("FAIL");
  });

  it("bayesian — converges toward repeated verdicts", () => {
    const verdicts = [
      v("SPEC-COMPLETE", 0.9),
      v("SPEC-COMPLETE", 0.9),
      v("SPEC-COMPLETE", 0.9),
    ];
    const out = consensus("C-1", verdicts, { strategy: "bayesian" });
    expect(out.verdict).toBe("SPEC-COMPLETE");
    expect(out.confidence).toBeGreaterThan(0.5);
    expect(out.unanimous).toBe(true);
  });

  it("records every judge's identity in the result", () => {
    const verdicts = [v("PASS", 0.9, "fermi"), v("PASS", 0.9, "carnot")];
    const out = consensus("C-1", verdicts);
    expect(out.judges).toHaveLength(2);
    expect(out.judges[0].name).toBe("fermi");
    expect(out.judges[1].name).toBe("carnot");
  });

  it("dissenting list excludes the chosen verdict", () => {
    const verdicts = [v("PASS", 0.9), v("FAIL", 0.1), v("PASS", 0.9)];
    const out = consensus("C-1", verdicts);
    expect(out.verdict).toBe("PASS");
    expect(out.dissenting).toHaveLength(1);
    expect(out.dissenting[0].verdict).toBe("FAIL");
  });

  // ─── Distribution invariant guards (dijkstra C1) ─────────────────────────
  // Every output ConsensusVerdict.distribution must satisfy:
  //   distribution[v] ∈ [0, 1] for every Verdict v
  //   sum(distribution[v]) ∈ {0, ~1} (0 only on empty input).
  // The previous implementation broke this if reliability or confidence
  // arrived outside [0,1] (e.g. a buggy upstream emitting confidence=2 or
  // a caller-supplied reliability map containing 1.5). With the clampUnit
  // guards in place, we lock the invariant in.

  function assertDistributionInvariants(
    out: ReturnType<typeof consensus>,
  ): void {
    const verdicts = ["PASS", "SPEC-COMPLETE", "NEEDS-RUNTIME", "INCONCLUSIVE", "FAIL"] as const;
    let sum = 0;
    for (const k of verdicts) {
      const p = out.distribution[k];
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      sum += p;
    }
    // Either empty (sum=0) or normalized (sum≈1).
    if (out.judges.length === 0) {
      expect(sum).toBe(0);
    } else {
      expect(sum).toBeGreaterThan(1 - 1e-9);
      expect(sum).toBeLessThan(1 + 1e-9);
    }
    expect(out.confidence).toBeGreaterThanOrEqual(0);
    expect(out.confidence).toBeLessThanOrEqual(1);
  }

  it("weighted_average — distribution stays in [0,1] when confidence is out-of-band", () => {
    // Confidence 2 (out of band) and -1 (negative) must be clamped to [0,1].
    // Without the clampUnit guard, the dist would carry weight 2 on PASS and
    // produce a >1 confidence value.
    const verdicts = [v("PASS", 2), v("FAIL", -1), v("SPEC-COMPLETE", 0.5)];
    const out = consensus("C-1", verdicts);
    assertDistributionInvariants(out);
  });

  it("bayesian — distribution stays in [0,1] when reliability map is out-of-band", () => {
    // Reliability 1.5 must be clamped to 1; -0.3 to 0. Without clamping,
    // (1 - reliability)/4 produces negative likelihoods and the normalized
    // posterior contains values outside the unit interval.
    const reliability = new Map<string, number>([
      ["genius:fermi", 1.5],
      ["genius:carnot", -0.3],
    ]);
    const verdicts = [v("PASS", 0.9, "fermi"), v("FAIL", 0.9, "carnot")];
    const out = consensus("C-1", verdicts, {
      strategy: "bayesian",
      reliability,
    });
    assertDistributionInvariants(out);
  });

  it("bayesian — out-of-band confidence is clamped before posterior update", () => {
    // HIGH-15 closure (Phase 3+4 follow-up, 2026-04). Previously this test
    // was "distribution-invariant only" because confidence=0 produced
    // anti-correlated likelihoods (a confidence-0 PASS judge subtracted
    // weight from PASS rather than ignoring the verdict). The fix in
    // bayesian() now skips judges whose adjustedReliability falls at or
    // below NO_INFORMATION_FLOOR, which is the correct semantic: a judge
    // with no confidence contributes nothing.
    const verdicts = [
      v("PASS", 1.5, "fermi"),    // clamped to 1; adjusted = 0.7 (informative)
      v("PASS", -0.5, "carnot"),  // clamped to 0; adjusted = 0 (skipped)
      v("PASS", 0.5, "liskov"),   // adjusted = 0.35 (informative)
    ];
    const out = consensus("C-1", verdicts, { strategy: "bayesian" });
    assertDistributionInvariants(out);
    // Two informative PASS judges remain; the third (adj=0) is skipped.
    // Posterior must favor PASS, NOT subtract weight from it.
    expect(out.verdict).toBe("PASS");
    expect(out.distribution.PASS).toBeGreaterThan(0.2); // > uniform prior
  });

  it("bayesian — judges with reliability=0 are skipped (no anti-information)", () => {
    // The reliability map can drive adjustedReliability to 0 directly via
    // a hostile/unreliable agent record. A reliability=0 entry means the
    // judge is treated as no-information, NOT anti-correlated.
    const reliability = new Map<string, number>([
      ["genius:carnot", 0], // explicitly no information
    ]);
    const verdicts = [
      v("PASS", 0.9, "fermi"),
      v("FAIL", 0.9, "carnot"), // skipped
    ];
    const out = consensus("C-1", verdicts, {
      strategy: "bayesian",
      reliability,
    });
    assertDistributionInvariants(out);
    // Carnot's FAIL would otherwise pull the posterior toward FAIL with the
    // anti-correlated old model. Now it is skipped, so PASS dominates.
    expect(out.verdict).toBe("PASS");
  });

  it("weighted_average — distribution sums to 1 on normal input", () => {
    const verdicts = [v("PASS", 0.9), v("FAIL", 0.1), v("PASS", 0.9)];
    const out = consensus("C-1", verdicts);
    assertDistributionInvariants(out);
  });

  it("bayesian — distribution sums to 1 on normal input", () => {
    const verdicts = [
      v("SPEC-COMPLETE", 0.9),
      v("SPEC-COMPLETE", 0.9),
      v("PASS", 0.4),
    ];
    const out = consensus("C-1", verdicts, { strategy: "bayesian" });
    assertDistributionInvariants(out);
  });
});
