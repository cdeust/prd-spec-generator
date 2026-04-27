/**
 * XmR (Individuals + Moving Range) control chart — CC-4 implementation.
 *
 * source: Wheeler, D. J. (1995). "Advanced Topics in Statistical Process
 *   Control." SPC Press. Chapter 3 (XmR charts).
 * source: Deming, W. E. (1986). "Out of the Crisis." MIT Press. Chapter 11
 *   (common-cause vs special-cause variation).
 *
 * The XmR chart plots individual measurements (X) and the moving range
 * (mR) between adjacent measurements. Limits are computed from the average
 * moving range; the multiplier d2=1.128 is the standard for n=2 subgroups
 * (source: ASTM Manual on Presentation of Data and Control Chart Analysis,
 * 6th ed., 1976, Table 3 — d2 for n=2).
 *
 * Western Electric rules (1956 Statistical Quality Control Handbook):
 *   Rule 1: any single point outside ±3σ → special cause.
 *   Rule 4: 8 consecutive points on one side of the centerline → sustained
 *     shift (legitimate update trigger per Phase 4 CC-4).
 *
 * This module is pure: no I/O, no global state. Suitable for direct unit
 * testing.
 */

// source: ASTM Manual, 1976. d2 constant for moving range subgroups of size 2.
const D2_FOR_N2 = 1.128;
// source: Wheeler 1995, p. 49. 3-sigma multiplier on mR for individuals chart.
const SIGMA_MULTIPLIER = 3;
// source: Western Electric 1956, Rule 4. Run-of-8 detection threshold.
const RUN_LENGTH_THRESHOLD = 8;

export interface XmRLimits {
  readonly centerline: number;
  readonly upperControlLimit: number;
  readonly lowerControlLimit: number;
  /** Average moving range — preserved for diagnostics. */
  readonly meanMovingRange: number;
  /** Number of points used to compute the limits. */
  readonly basePoints: number;
}

export interface XmRSignal {
  readonly index: number;
  readonly value: number;
  readonly rule: "outside_3sigma" | "run_of_8";
}

export interface XmRReport {
  readonly limits: XmRLimits;
  readonly signals: ReadonlyArray<XmRSignal>;
  readonly inControl: boolean;
}

/**
 * Compute XmR limits from a baseline series. Caller is expected to pass the
 * first ~12-20 points of stable history; subsequent points should be checked
 * against frozen limits via `evaluatePoint`.
 *
 * Throws if fewer than 2 points are supplied (cannot compute moving range).
 */
export function computeLimits(baseline: ReadonlyArray<number>): XmRLimits {
  if (baseline.length < 2) {
    throw new Error("XmR requires at least 2 baseline points");
  }
  const mean =
    baseline.reduce((s, v) => s + v, 0) / baseline.length;
  const ranges: number[] = [];
  for (let i = 1; i < baseline.length; i++) {
    ranges.push(Math.abs(baseline[i] - baseline[i - 1]));
  }
  const meanMR = ranges.reduce((s, v) => s + v, 0) / ranges.length;
  const sigmaEstimate = meanMR / D2_FOR_N2;
  const halfWidth = SIGMA_MULTIPLIER * sigmaEstimate;
  return {
    centerline: mean,
    upperControlLimit: mean + halfWidth,
    lowerControlLimit: mean - halfWidth,
    meanMovingRange: meanMR,
    basePoints: baseline.length,
  };
}

/**
 * Scan a full series against frozen limits and return any control-rule
 * signals. Used after baseline is locked.
 */
export function scanSeries(
  series: ReadonlyArray<number>,
  limits: XmRLimits,
): XmRReport {
  const signals: XmRSignal[] = [];
  // Rule 1: outside 3σ.
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v > limits.upperControlLimit || v < limits.lowerControlLimit) {
      signals.push({ index: i, value: v, rule: "outside_3sigma" });
    }
  }
  // Rule 4: run of N consecutive points on one side of centerline.
  let runSide: "above" | "below" | null = null;
  let runLength = 0;
  for (let i = 0; i < series.length; i++) {
    const side =
      series[i] > limits.centerline
        ? "above"
        : series[i] < limits.centerline
          ? "below"
          : null;
    if (side === null) {
      runSide = null;
      runLength = 0;
      continue;
    }
    if (side === runSide) {
      runLength += 1;
    } else {
      runSide = side;
      runLength = 1;
    }
    if (runLength === RUN_LENGTH_THRESHOLD) {
      signals.push({ index: i, value: series[i], rule: "run_of_8" });
    }
  }
  return {
    limits,
    signals,
    inControl: signals.length === 0,
  };
}

/**
 * Convenience: compute limits from the first `baselineCount` points and scan
 * the entire series (baseline + new) against those frozen limits.
 */
export function xmrAnalyze(
  series: ReadonlyArray<number>,
  baselineCount: number,
): XmRReport {
  if (baselineCount < 2 || baselineCount > series.length) {
    throw new Error(
      `baselineCount must be in [2, series.length]; got ${baselineCount}`,
    );
  }
  const limits = computeLimits(series.slice(0, baselineCount));
  return scanSeries(series, limits);
}
