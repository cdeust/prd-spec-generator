/**
 * Per-gate statistical primitives for the §4.5 calibration runner (Wave D).
 *
 * Pure module — no I/O. Computes:
 *   - empirical P95 + P5 via linear-interpolation order statistics
 *   - 95% Clopper-Pearson CI translated to value-scale order-stat bounds
 *   - XmR baseline + scan over the full series
 *
 * source: docs/PHASE_4_PLAN.md §4.5 Estimator (P95 + Clopper-Pearson 95% CI).
 * source: Hyndman & Fan (1996). "Sample Quantiles in Statistical Packages."
 *   The American Statistician 50(4), 361-365 — Type 7 default.
 * source: Hahn & Meeker (1991). "Statistical Intervals." Wiley §6.3 — order-
 *   statistic CI for a quantile uses binomial-tail bounds on the rank.
 *
 * Layer contract (§2.2): zero non-stdlib deps; consumed by `calibrate-gates.ts`.
 */

import { clopperPearson } from "./clopper-pearson.js";
import { computeLimits, scanSeries, type XmRReport } from "./xmr.js";
import type { XmRRecord } from "./calibration-outputs.js";

/**
 * Wheeler 1995 §3 — first 12 to 20 points form the baseline window. We use
 * 12 to maximise post-baseline monitoring points within a fixed K=100.
 */
const XMR_BASELINE_POINTS = 12;

export interface GateStats {
  readonly p95: number;
  readonly p5: number;
  readonly ci_upper: number;
  readonly ci_lower: number;
  readonly xmr: XmRRecord;
}

/**
 * Linear-interpolation percentile (Hyndman & Fan 1996 Type 7).
 *
 * Precondition: values is non-empty; p ∈ [0, 1].
 * Postcondition: returns a number ≥ min(values) and ≤ max(values).
 *
 * source: NumPy default (since 1.22 the equivalent is `method="linear"`).
 */
export function percentile(values: ReadonlyArray<number>, p: number): number {
  if (values.length === 0) throw new Error("percentile: empty input");
  if (p < 0 || p > 1) throw new Error(`percentile: p must be in [0,1]; got ${p}`);
  const sorted = [...values].sort((a, b) => a - b);
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

function buildXmrRecord(values: ReadonlyArray<number>): XmRRecord {
  const baselineCount = Math.min(XMR_BASELINE_POINTS, values.length);
  const baseline = values.slice(0, Math.max(2, baselineCount));
  const limits = computeLimits(baseline);
  const report: XmRReport = scanSeries(values, limits);
  return {
    centerline: limits.centerline,
    upperControlLimit: limits.upperControlLimit,
    lowerControlLimit: limits.lowerControlLimit,
    meanMovingRange: limits.meanMovingRange,
    basePoints: limits.basePoints,
    signals: report.signals.map((s) => ({
      index: s.index,
      value: s.value,
      rule: s.rule,
    })),
    inControl: report.inControl,
    series: [...values],
  };
}

/**
 * Compute the §4.5 calibration statistics for one gate's KPI series.
 *
 * The Clopper-Pearson CI is on the indicator I(value > P95) — the §4.5
 * estimator. Bounds are translated back to the value scale via order-
 * statistic CI (Hahn & Meeker 1991 §6.3): the lower/upper bound on the
 * tail proportion maps to a rank in the sorted series, and the value at
 * that rank is the corresponding bound on the P95 estimate.
 *
 * Precondition: values.length ≥ 2 (XmR cannot compute a moving range with 1).
 * Postcondition: returns a GateStats with all four numeric fields finite
 *   and an XmR record whose `series` mirrors the input.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 Estimator + §4.5 Per-gate table.
 */
export function computeGateStats(
  values: ReadonlyArray<number>,
): GateStats {
  if (values.length < 2) {
    throw new Error(
      `computeGateStats: need ≥2 observations for XmR; got ${values.length}`,
    );
  }
  const sorted = [...values].sort((a, b) => a - b);
  const p95 = percentile(values, 0.95);
  const p5 = percentile(values, 0.05);
  const successes = values.filter((v) => v > p95).length;
  const cp = clopperPearson(successes, values.length, 0.95);
  const n = values.length;
  const lowerRank = Math.max(0, Math.min(n - 1, Math.floor(cp.lower * n)));
  const upperRank = Math.max(0, Math.min(n - 1, Math.ceil(cp.upper * n)));
  return {
    p95,
    p5,
    ci_lower: sorted[lowerRank],
    ci_upper: sorted[upperRank],
    xmr: buildXmrRecord(values),
  };
}
