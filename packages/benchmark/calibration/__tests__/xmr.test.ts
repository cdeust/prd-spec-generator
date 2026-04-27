import { describe, it, expect } from "vitest";
import { computeLimits, scanSeries, xmrAnalyze } from "../xmr.js";

describe("xmr.computeLimits", () => {
  // source: Wheeler 1995, p. 49 — limits for stable series should bracket
  // the centerline symmetrically by 3 * mR / 1.128.
  it("symmetric limits around centerline for stable series", () => {
    const series = [1, 1, 1, 1, 1];
    // Constant series → mR=0 → limits collapse to centerline.
    const limits = computeLimits(series);
    expect(limits.centerline).toBe(1);
    expect(limits.upperControlLimit).toBe(1);
    expect(limits.lowerControlLimit).toBe(1);
  });

  it("rejects baseline of length < 2", () => {
    expect(() => computeLimits([1])).toThrow();
  });
});

describe("xmr.scanSeries", () => {
  it("flags an outside-3sigma point", () => {
    const baseline = [10, 10, 10, 10, 10, 10, 11, 9, 10, 10, 11, 10];
    const limits = computeLimits(baseline);
    // Inject a clearly-out-of-control point.
    const series = [...baseline, 100];
    const report = scanSeries(series, limits);
    expect(report.signals.some((s) => s.rule === "outside_3sigma")).toBe(true);
  });

  // source: Western Electric 1956, Rule 4. 8 consecutive points on one side.
  it("flags a run of 8 above centerline", () => {
    const baseline = [10, 9, 11, 10, 9, 11, 10, 9, 11, 10];
    const limits = computeLimits(baseline);
    const series = [...baseline, 11, 11, 11, 11, 11, 11, 11, 11];
    const report = scanSeries(series, limits);
    expect(report.signals.some((s) => s.rule === "run_of_8")).toBe(true);
  });

  it("reports in-control for stable series", () => {
    const series = [10, 10, 10, 10, 10, 10, 10, 10];
    const limits = computeLimits(series);
    const report = scanSeries(series, limits);
    expect(report.inControl).toBe(true);
  });
});

describe("xmr.xmrAnalyze", () => {
  it("convenience wrapper computes limits then scans", () => {
    const series = [10, 10, 10, 10, 10, 10, 10, 10];
    const report = xmrAnalyze(series, 4);
    expect(report.limits.basePoints).toBe(4);
  });
});
