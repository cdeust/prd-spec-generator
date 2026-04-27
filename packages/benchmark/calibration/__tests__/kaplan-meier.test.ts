/**
 * Tests for kaplan-meier.ts — Phase 4.2 Wave C1.
 *
 * Coverage:
 *   - kmEstimate: closed-form check (no censoring → 1 - empirical CDF),
 *     monotone decrease, Greenwood-CI bounds within [0, 1].
 *   - kmEstimate: classic textbook example (Kalbfleisch & Prentice 2002,
 *     Table 1.1) for value-level reproduction.
 *   - kmMedianAttempts: median equals smallest t with S(t) ≤ 0.5.
 *   - logRankTest: chi² matches reference computation on a fixed dataset.
 *   - schoenfeldRequiredEvents: D ≈ 247 at HR=0.7, α=0.05, power=0.80,
 *     equal allocation; N ≈ 824 at event_rate=0.30.
 */

import { describe, it, expect } from "vitest";
import {
  kmEstimate,
  kmMedianAttempts,
  logRankTest,
  schoenfeldRequiredEvents,
  type SurvivalEvent,
} from "../kaplan-meier.js";

// ─── kmEstimate — closed form / no censoring ─────────────────────────────────

describe("kmEstimate — no censoring", () => {
  it("with no censoring, S(t) equals 1 - empirical CDF at each event time", () => {
    // 5 subjects, all observed. Events at t = 1, 2, 3, 4, 5.
    // S(1) = 4/5, S(2) = 3/5, S(3) = 2/5, S(4) = 1/5, S(5) = 0.
    const events: SurvivalEvent[] = [
      { time: 1, observed: true },
      { time: 2, observed: true },
      { time: 3, observed: true },
      { time: 4, observed: true },
      { time: 5, observed: true },
    ];
    const curve = kmEstimate(events);
    expect(curve.times).toEqual([1, 2, 3, 4, 5]);
    expect(curve.survival[0]).toBeCloseTo(0.8, 10);
    expect(curve.survival[1]).toBeCloseTo(0.6, 10);
    expect(curve.survival[2]).toBeCloseTo(0.4, 10);
    expect(curve.survival[3]).toBeCloseTo(0.2, 10);
    expect(curve.survival[4]).toBeCloseTo(0.0, 10);
  });

  it("survival is monotone non-increasing", () => {
    const events: SurvivalEvent[] = [
      { time: 1, observed: true },
      { time: 2, observed: false }, // censored
      { time: 3, observed: true },
      { time: 4, observed: true },
      { time: 5, observed: false },
    ];
    const curve = kmEstimate(events);
    for (let i = 1; i < curve.survival.length; i++) {
      expect(curve.survival[i]).toBeLessThanOrEqual(curve.survival[i - 1] + 1e-12);
    }
  });

  it("Greenwood CI bounds always lie within [0, 1]", () => {
    const events: SurvivalEvent[] = [
      { time: 1, observed: true },
      { time: 1, observed: true },
      { time: 2, observed: true },
      { time: 3, observed: false },
      { time: 4, observed: true },
    ];
    const curve = kmEstimate(events);
    for (const [lo, hi] of curve.ci95) {
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(1);
      expect(lo).toBeLessThanOrEqual(hi);
    }
  });

  it("ties at the same time are handled (multiple events grouped)", () => {
    // 3 events at t=1, 1 event at t=2. n=4 starting.
    // S(1) = (1 - 3/4) = 0.25, S(2) = 0.25 · (1 - 1/1) = 0.
    const events: SurvivalEvent[] = [
      { time: 1, observed: true },
      { time: 1, observed: true },
      { time: 1, observed: true },
      { time: 2, observed: true },
    ];
    const curve = kmEstimate(events);
    expect(curve.times).toEqual([1, 2]);
    expect(curve.survival[0]).toBeCloseTo(0.25, 10);
    expect(curve.survival[1]).toBeCloseTo(0.0, 10);
  });

  it("empty input returns empty curve", () => {
    const curve = kmEstimate([]);
    expect(curve.times.length).toBe(0);
    expect(curve.survival.length).toBe(0);
    expect(curve.ci95.length).toBe(0);
  });

  it("rejects non-positive times", () => {
    expect(() => kmEstimate([{ time: 0, observed: true }])).toThrow();
    expect(() => kmEstimate([{ time: -1, observed: true }])).toThrow();
  });
});

// ─── kmEstimate — textbook example (with censoring) ──────────────────────────

describe("kmEstimate — Kalbfleisch & Prentice (2002) §1.1.1", () => {
  /**
   * Classic remission-time example, 21 subjects:
   *   times (events):    6,  6,  6,  7, 10, 13, 16, 22, 23
   *   times (censored):  6,  9, 10, 11, 17, 19, 20, 25, 32, 32, 34, 35
   *
   * Reproduced here with at-risk and KM steps for the first three event times:
   *   t=6:  n=21, d=3, c=1  → S(6)  = 1 · (1 - 3/21)         = 18/21 ≈ 0.85714
   *   t=7:  n=17, d=1       → S(7)  = (18/21) · (1 - 1/17)   = 18/21 · 16/17 ≈ 0.80672
   *   t=10: n=15, d=1, c=1  → S(10) = (18/21·16/17) · (1-1/15) = ≈ 0.75294
   *
   * source: Kalbfleisch & Prentice (2002), "The Statistical Analysis of
   * Failure Time Data," 2nd ed., Table 1.1, p. 8.
   */
  const events: SurvivalEvent[] = [
    // 9 events
    { time: 6, observed: true },
    { time: 6, observed: true },
    { time: 6, observed: true },
    { time: 7, observed: true },
    { time: 10, observed: true },
    { time: 13, observed: true },
    { time: 16, observed: true },
    { time: 22, observed: true },
    { time: 23, observed: true },
    // 12 censored
    { time: 6, observed: false },
    { time: 9, observed: false },
    { time: 10, observed: false },
    { time: 11, observed: false },
    { time: 17, observed: false },
    { time: 19, observed: false },
    { time: 20, observed: false },
    { time: 25, observed: false },
    { time: 32, observed: false },
    { time: 32, observed: false },
    { time: 34, observed: false },
    { time: 35, observed: false },
  ];

  it("matches published S(t) at t = 6, 7, 10", () => {
    const curve = kmEstimate(events);
    // First three steps emitted are at the first three distinct event times.
    expect(curve.times[0]).toBe(6);
    expect(curve.times[1]).toBe(7);
    expect(curve.times[2]).toBe(10);
    expect(curve.survival[0]).toBeCloseTo(18 / 21, 6);
    expect(curve.survival[1]).toBeCloseTo((18 / 21) * (16 / 17), 6);
    expect(curve.survival[2]).toBeCloseTo(
      (18 / 21) * (16 / 17) * (14 / 15),
      6,
    );
  });
});

// ─── kmMedianAttempts ────────────────────────────────────────────────────────

describe("kmMedianAttempts", () => {
  it("median is smallest t with S(t) ≤ 0.5", () => {
    // 4 subjects, all events; S(1)=0.75, S(2)=0.5, S(3)=0.25, S(4)=0.
    // median = 2.
    const events: SurvivalEvent[] = [
      { time: 1, observed: true },
      { time: 2, observed: true },
      { time: 3, observed: true },
      { time: 4, observed: true },
    ];
    const m = kmMedianAttempts(events);
    expect(m.median).toBe(2);
  });

  it("median is +Infinity when survival never drops to 0.5", () => {
    // Only one event in a large censored cohort.
    const events: SurvivalEvent[] = [
      { time: 1, observed: true },
      ...Array.from({ length: 99 }, (_, i) => ({
        time: i + 2,
        observed: false,
      })),
    ];
    const m = kmMedianAttempts(events);
    expect(m.median).toBe(Number.POSITIVE_INFINITY);
  });

  it("CI bounds are monotone (lo ≤ median ≤ hi)", () => {
    const events: SurvivalEvent[] = [
      { time: 1, observed: true },
      { time: 2, observed: true },
      { time: 2, observed: true },
      { time: 3, observed: true },
      { time: 4, observed: true },
      { time: 5, observed: true },
      { time: 6, observed: true },
      { time: 7, observed: true },
    ];
    const m = kmMedianAttempts(events);
    expect(m.ci95[0]).toBeLessThanOrEqual(m.median);
    expect(m.median).toBeLessThanOrEqual(m.ci95[1]);
  });
});

// ─── logRankTest ─────────────────────────────────────────────────────────────

describe("logRankTest", () => {
  it("identical arms produce chi2 ≈ 0 and pValue ≈ 1", () => {
    const arm: SurvivalEvent[] = [
      { time: 1, observed: true },
      { time: 2, observed: true },
      { time: 3, observed: true },
    ];
    const result = logRankTest(arm, arm);
    expect(result.chi2).toBeLessThan(1e-9);
    expect(result.pValue).toBeCloseTo(1, 6);
  });

  it("strongly separated arms produce small p-value", () => {
    // Arm A pass at attempt 1; Arm B never pass within K=3 attempts.
    const armA: SurvivalEvent[] = Array.from({ length: 30 }, () => ({
      time: 1,
      observed: true,
    }));
    const armB: SurvivalEvent[] = Array.from({ length: 30 }, () => ({
      time: 3,
      observed: true,
    }));
    const result = logRankTest(armA, armB);
    expect(result.chi2).toBeGreaterThan(10);
    expect(result.pValue).toBeLessThan(0.01);
  });

  it("matches a hand-computed reference (small fixed dataset)", () => {
    /**
     * Reference dataset:
     *   Arm A: events at t=2, t=3; censored at t=4
     *   Arm B: events at t=1, t=4
     *
     * Pooled distinct times: 1, 2, 3, 4
     *
     * t=1: nA=3 nB=2 n=5 d=1 dA=0 → E_A = 1·3/5=0.6; V = 1·4·3·2/(25·4)=24/100=0.24; OmE=0-0.6=-0.6
     *   atRisk after: nA=3, nB=1
     * t=2: nA=3 nB=1 n=4 d=1 dA=1 → E_A = 1·3/4=0.75; V = 1·3·3·1/(16·3)=9/48=0.1875; OmE += 1-0.75=0.25
     *   atRisk after: nA=2, nB=1
     * t=3: nA=2 nB=1 n=3 d=1 dA=1 → E_A = 1·2/3≈0.6667; V = 1·2·2·1/(9·2)=4/18≈0.2222; OmE += 1-0.6667≈0.3333
     *   atRisk after: nA=1, nB=1
     * t=4: nA=1 nB=1 n=2 d=1 dA=0 (A censored) → E_A = 1·1/2=0.5; V = 1·1·1·1/(4·1)=0.25; OmE += 0-0.5=-0.5
     *
     * Σ OmE = -0.6 + 0.25 + 0.3333... - 0.5 = -0.5167
     * Σ V   = 0.24 + 0.1875 + 0.2222 + 0.25 = 0.8997
     * chi² = (-0.5167)² / 0.8997 ≈ 0.2967
     */
    const armA: SurvivalEvent[] = [
      { time: 2, observed: true },
      { time: 3, observed: true },
      { time: 4, observed: false },
    ];
    const armB: SurvivalEvent[] = [
      { time: 1, observed: true },
      { time: 4, observed: true },
    ];
    const result = logRankTest(armA, armB);
    // Tolerance: ±0.01 around the hand-computed 0.2967.
    expect(result.chi2).toBeGreaterThan(0.28);
    expect(result.chi2).toBeLessThan(0.31);
    expect(result.pValue).toBeGreaterThan(0.5);
    expect(result.pValue).toBeLessThan(0.7);
  });

  it("empty arms produce chi2=0 and pValue=1 (no test possible)", () => {
    const r1 = logRankTest([], [{ time: 1, observed: true }]);
    const r2 = logRankTest([{ time: 1, observed: true }], []);
    expect(r1.chi2).toBe(0);
    expect(r1.pValue).toBe(1);
    expect(r2.chi2).toBe(0);
    expect(r2.pValue).toBe(1);
  });
});

// ─── Schoenfeld sample-size derivation ───────────────────────────────────────

describe("schoenfeldRequiredEvents — Phase 4.2 power calculation", () => {
  /**
   * Hand calculation:
   *   z_{0.025} = 1.95996
   *   z_{0.20}  = 0.84162
   *   (z_a + z_b)² = (2.80158)² = 7.8489
   *   p_A · p_B = 0.5 · 0.5 = 0.25
   *   log(0.7) = -0.35667; (log HR)² = 0.12722
   *   D = 7.8489 / (0.25 · 0.12722) = 7.8489 / 0.031806 ≈ 246.78 → ceil = 247
   *
   *   N at event_rate = 0.30: ceil(246.78 / 0.30) = ceil(822.6) = 823
   *
   * source: Schoenfeld 1981 eq. (1); Collett 2015 §10.2.
   */
  it("HR=0.7, α=0.05, power=0.80, equal allocation → D ≈ 247", () => {
    const out = schoenfeldRequiredEvents({ hr: 0.7, eventRate: 0.3 });
    expect(out.events).toBeGreaterThanOrEqual(246);
    expect(out.events).toBeLessThanOrEqual(248);
  });

  it("at event_rate=0.30, sample size ≈ 823", () => {
    const out = schoenfeldRequiredEvents({ hr: 0.7, eventRate: 0.3 });
    // Allow ±2 for ceiling-vs-rounding differences in the literature.
    expect(out.sampleSize).toBeGreaterThanOrEqual(822);
    expect(out.sampleSize).toBeLessThanOrEqual(825);
  });

  it("rejects HR ≤ 0 or HR = 1 (no detectable effect)", () => {
    expect(() =>
      schoenfeldRequiredEvents({ hr: 1.0, eventRate: 0.3 }),
    ).toThrow();
    expect(() =>
      schoenfeldRequiredEvents({ hr: -0.5, eventRate: 0.3 }),
    ).toThrow();
  });

  it("rejects allocation outside (0, 1) and event_rate outside (0, 1]", () => {
    expect(() =>
      schoenfeldRequiredEvents({ hr: 0.7, eventRate: 0.3, allocationA: 0 }),
    ).toThrow();
    expect(() =>
      schoenfeldRequiredEvents({ hr: 0.7, eventRate: 0.3, allocationA: 1 }),
    ).toThrow();
    expect(() => schoenfeldRequiredEvents({ hr: 0.7, eventRate: 0 })).toThrow();
    expect(() =>
      schoenfeldRequiredEvents({ hr: 0.7, eventRate: 1.1 }),
    ).toThrow();
  });

  it("only α=0.05 / power=0.80 supported in this release", () => {
    expect(() =>
      schoenfeldRequiredEvents({
        hr: 0.7,
        eventRate: 0.3,
        alphaTwoSided: 0.01,
      }),
    ).toThrow();
  });
});
