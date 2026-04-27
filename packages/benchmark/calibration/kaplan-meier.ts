/**
 * Kaplan-Meier survival estimator + log-rank test + Schoenfeld sample-size.
 *
 * Phase 4.2 — MAX_ATTEMPTS calibration math layer (Wave C1).
 *
 * The estimand is CONDITIONAL — P(pass | attempt = k, failed at all attempts < k).
 * The original Phase 4 plan specified a marginal estimand, which Fisher Fi-4.2
 * flagged as a critical specification error. The correct estimand requires a
 * survival-analysis treatment because the population at risk shrinks as
 * sections pass at earlier attempts.
 *
 * source: Kaplan, E. L. & Meier, P. (1958). "Nonparametric Estimation from
 *   Incomplete Observations." J. Am. Stat. Assoc. 53(282), 457-481.
 * source: Greenwood, M. (1926). "The Natural Duration of Cancer." Reports on
 *   Public Health and Medical Subjects 33, 1-26. (Variance of S(t).)
 * source: Mantel, N. (1966). "Evaluation of Survival Data and Two New Rank
 *   Order Statistics Arising in Its Consideration." Cancer Chemotherapy
 *   Reports 50(3), 163-170. (Log-rank test.)
 * source: Schoenfeld, D. (1981). "The Asymptotic Properties of Nonparametric
 *   Tests for Comparing Survival Distributions." Biometrika 68(1), 316-319.
 *   (Sample size for log-rank.)
 *
 * Layer contract (§2.2): stdlib-only. No I/O, no @prd-gen/core imports, no
 * orchestration imports. Pure functions only — suitable for direct unit
 * testing without mocks.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * One observation: a section (or subject) reached time `time`, and at that
 * point either the event was observed (`observed = true`, e.g. "passed at
 * attempt k") or the observation was censored (`observed = false`, e.g.
 * "still pending after attempt k, run terminated").
 */
export interface SurvivalEvent {
  readonly time: number;
  readonly observed: boolean;
}

/**
 * Output of `kmEstimate`. Arrays are aligned: `times[i]`, `survival[i]`,
 * `ci95[i]` all describe the same step in the survival curve.
 *
 * `survival[i]` is the probability of surviving past `times[i]` — i.e.
 * P(T > times[i]). `ci95[i]` is the Greenwood-formula 95% CI on that
 * probability, clamped to [0, 1].
 */
export interface KmCurve {
  readonly times: ReadonlyArray<number>;
  readonly survival: ReadonlyArray<number>;
  readonly ci95: ReadonlyArray<readonly [number, number]>;
}

export interface KmMedian {
  readonly median: number;
  readonly ci95: readonly [number, number];
}

export interface LogRankResult {
  readonly chi2: number;
  readonly pValue: number;
}

// ─── Numerical constants (sourced) ───────────────────────────────────────────

// source: standard normal table; z_{0.025} two-sided 95% critical value.
const Z_975 = 1.959963984540054;
// source: standard normal table; z_{0.20} one-sided power=0.80 critical value.
const Z_80 = 0.8416212335729143;

/**
 * Right-tail probability of a chi-squared distribution with 1 df:
 *   P(X > chi2) where X ~ χ²(1).
 *
 * For 1 df, χ²(1) = Z² where Z is standard normal, so the survival function
 * reduces to 2 · (1 - Φ(√chi2)). We compute Φ via the Abramowitz & Stegun
 * 7.1.26 rational approximation (max abs error 1.5e-7).
 *
 * source: Abramowitz, M. & Stegun, I. A. (1964). "Handbook of Mathematical
 *   Functions." NBS Applied Math Series 55. Eq. 7.1.26 (erf approximation).
 */
function chi2OneDfSurvival(chi2: number): number {
  if (!Number.isFinite(chi2) || chi2 <= 0) return 1;
  const z = Math.sqrt(chi2);
  // Φ(z) for z >= 0 via 1 - 0.5 · erfc(z/√2).
  // erfc approximation per A&S 7.1.26 (positive argument).
  const t = 1 / (1 + 0.3275911 * (z / Math.SQRT2));
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erfc =
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
    t *
    Math.exp(-(z * z) / 2);
  // erfc here is for arg z/√2; A&S 7.1.26 form. P(Z > z) = 0.5 · erfc(z/√2).
  return Math.min(1, Math.max(0, erfc));
}

// ─── Core estimator ──────────────────────────────────────────────────────────

/**
 * Kaplan-Meier non-parametric survival estimator with Greenwood 95% CI.
 *
 * The product-limit estimator:
 *
 *     S(t) = ∏_{t_i ≤ t}  (1 - d_i / n_i)
 *
 * where t_i are distinct event times, d_i is the count of events at t_i, and
 * n_i is the count at risk just before t_i.
 *
 * Greenwood variance:
 *
 *     Var(S(t)) ≈ S(t)² · ∑_{t_i ≤ t}  d_i / (n_i · (n_i - d_i))
 *
 * The 95% CI is computed on S(t) directly with normal approximation and
 * clamped to [0, 1]. (For tighter behaviour near 0 and 1, a log-log
 * transformation is more accurate; we use plain CI here because the use
 * sites only need to compare against 0.05 — far from the boundaries.)
 *
 * Censoring convention: at a tied (time, event-or-censor) instant, events
 * are processed before censoring. Sections "passing at attempt k" decrement
 * the at-risk count at that step; sections censored at k (e.g. terminal
 * failure at k = MAX_ATTEMPTS) leave the at-risk count untouched at this
 * step but are removed for subsequent steps. This matches Kaplan & Meier's
 * 1958 §3 convention.
 *
 * Precondition: every event has time > 0 and finite. (For attempt-based
 * survival, time is the attempt index 1, 2, 3, …)
 * Postcondition: arrays are aligned, monotone non-increasing in `survival`,
 * each ci95 entry within [0, 1], times strictly increasing.
 *
 * source: Kaplan & Meier 1958; Greenwood 1926.
 */
export function kmEstimate(events: ReadonlyArray<SurvivalEvent>): KmCurve {
  if (events.length === 0) {
    return { times: [], survival: [], ci95: [] };
  }
  for (const ev of events) {
    if (!Number.isFinite(ev.time) || ev.time <= 0) {
      throw new Error(
        `kmEstimate: event time must be finite and > 0, got ${ev.time}`,
      );
    }
  }

  // Group events by distinct time. Sort ascending.
  const byTime = new Map<number, { events: number; censored: number }>();
  for (const ev of events) {
    const slot = byTime.get(ev.time) ?? { events: 0, censored: 0 };
    if (ev.observed) slot.events += 1;
    else slot.censored += 1;
    byTime.set(ev.time, slot);
  }
  const distinctTimes = Array.from(byTime.keys()).sort((a, b) => a - b);

  let atRisk = events.length;
  let survival = 1.0;
  let varSum = 0.0; // accumulated Σ d_i / (n_i · (n_i - d_i))

  const outTimes: number[] = [];
  const outSurv: number[] = [];
  const outCi: Array<readonly [number, number]> = [];

  for (const t of distinctTimes) {
    const slot = byTime.get(t)!;
    const d = slot.events;
    const c = slot.censored;
    const n = atRisk;

    // Only emit a step at times where an event occurs (Kaplan-Meier 1958 §3).
    // Censorings still update at-risk for the next step.
    if (d > 0) {
      // Guard against d > n (shouldn't happen with consistent input).
      if (d > n) {
        throw new Error(
          `kmEstimate: events ${d} exceed at-risk ${n} at time ${t} ` +
            `(input is internally inconsistent)`,
        );
      }
      const factor = 1 - d / n;
      survival *= factor;
      // Greenwood term; if n - d === 0 the variance increment is undefined but
      // S has dropped to 0 — leave varSum as-is (any subsequent step is moot).
      if (n - d > 0) {
        varSum += d / (n * (n - d));
      }
      const stdErr = survival * Math.sqrt(varSum);
      const margin = Z_975 * stdErr;
      const lo = Math.max(0, survival - margin);
      const hi = Math.min(1, survival + margin);
      outTimes.push(t);
      outSurv.push(survival);
      outCi.push([lo, hi] as const);
    }
    atRisk -= d + c;
  }

  return { times: outTimes, survival: outSurv, ci95: outCi };
}

/**
 * Median attempts-to-pass derived from a KM curve.
 *
 * Definition: median = smallest t* such that S(t*) ≤ 0.5.
 *
 * 95% CI for the median (Brookmeyer & Crowley 1982): the set of times t for
 * which 0.5 lies inside the Greenwood CI for S(t), i.e. ciLo(t) ≤ 0.5 ≤ ciHi(t).
 * Since S, ciLo, ciHi are all monotone non-increasing in t (modulo numerical
 * noise), this set is an interval [t_lo, t_hi] where:
 *   - t_lo = first t with ciLo(t) ≤ 0.5 (where 0.5 enters the band from above)
 *   - t_hi = last  t with ciHi(t) ≥ 0.5 (where 0.5 is about to leave the band)
 *
 * If S never drops to 0.5 (heavy censoring or insufficient events), the
 * median is undefined → returned as +Infinity, and both CI bounds are +Inf.
 *
 * source: Brookmeyer, R. & Crowley, J. (1982). "A Confidence Interval for
 *   the Median Survival Time." Biometrics 38(1), 29-41.
 *
 * Postcondition: median is finite iff some entry in `survival` ≤ 0.5; the
 *   CI bounds satisfy lo ≤ median ≤ hi when finite.
 */
export function kmMedianAttempts(events: ReadonlyArray<SurvivalEvent>): KmMedian {
  const curve = kmEstimate(events);
  let median = Number.POSITIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.POSITIVE_INFINITY;
  for (let i = 0; i < curve.times.length; i++) {
    const t = curve.times[i];
    const s = curve.survival[i];
    const [ciLo, ciHi] = curve.ci95[i];
    if (median === Number.POSITIVE_INFINITY && s <= 0.5) median = t;
    // Lower bound: first t where ciLo crosses 0.5 from above (band first
    // contains 0.5).
    if (lo === Number.POSITIVE_INFINITY && ciLo <= 0.5) lo = t;
    // Upper bound: last t where ciHi >= 0.5 (after this, ciHi will fall
    // below 0.5 and 0.5 leaves the band). Track by overwriting on every
    // qualifying step.
    if (ciHi >= 0.5) hi = t;
  }
  return { median, ci95: [lo, hi] as const };
}

// ─── Log-rank test ───────────────────────────────────────────────────────────

/**
 * Two-sample log-rank test (Mantel 1966).
 *
 * For each distinct event time t_i across the pooled sample, compute:
 *   - n_i, n_iA, n_iB: at-risk total and per-arm
 *   - d_i, d_iA: total events and arm-A events
 *   - Expected events in arm A under H0 (equal hazards): E_iA = d_i · n_iA / n_i
 *   - Hypergeometric variance:
 *       V_i = d_i · (n_i − d_i) · n_iA · n_iB / (n_i² · (n_i − 1))
 *
 * Test statistic (1 df, asymptotic χ²):
 *     χ² = (Σ (d_iA − E_iA))² / Σ V_i
 *
 * H0: hazard functions are equal across the two arms.
 *
 * Edge case: when only one arm contributes events, the test is degenerate
 * (variance = 0); we return chi2 = 0, p = 1 to avoid divide-by-zero.
 *
 * source: Mantel 1966; Peto, R. & Peto, J. (1972). "Asymptotically Efficient
 *   Rank Invariant Test Procedures." J. R. Stat. Soc. A 135(2), 185-207.
 */
export function logRankTest(
  armA: ReadonlyArray<SurvivalEvent>,
  armB: ReadonlyArray<SurvivalEvent>,
): LogRankResult {
  if (armA.length === 0 || armB.length === 0) {
    return { chi2: 0, pValue: 1 };
  }

  // Group per-arm by distinct time.
  const groupArm = (
    arr: ReadonlyArray<SurvivalEvent>,
  ): Map<number, { events: number; censored: number }> => {
    const m = new Map<number, { events: number; censored: number }>();
    for (const ev of arr) {
      const slot = m.get(ev.time) ?? { events: 0, censored: 0 };
      if (ev.observed) slot.events += 1;
      else slot.censored += 1;
      m.set(ev.time, slot);
    }
    return m;
  };
  const grpA = groupArm(armA);
  const grpB = groupArm(armB);

  const allTimes = new Set<number>();
  for (const t of grpA.keys()) allTimes.add(t);
  for (const t of grpB.keys()) allTimes.add(t);
  const times = Array.from(allTimes).sort((a, b) => a - b);

  let atRiskA = armA.length;
  let atRiskB = armB.length;

  let observedMinusExpected = 0.0;
  let varianceSum = 0.0;

  for (const t of times) {
    const a = grpA.get(t) ?? { events: 0, censored: 0 };
    const b = grpB.get(t) ?? { events: 0, censored: 0 };
    const d = a.events + b.events;
    const n = atRiskA + atRiskB;
    if (d > 0 && n > 1 && atRiskA > 0 && atRiskB > 0) {
      const expectedA = (d * atRiskA) / n;
      // Hypergeometric variance — Mantel 1966 eq. (6).
      const v =
        (d * (n - d) * atRiskA * atRiskB) / (n * n * (n - 1));
      observedMinusExpected += a.events - expectedA;
      varianceSum += v;
    }
    atRiskA -= a.events + a.censored;
    atRiskB -= b.events + b.censored;
  }

  if (varianceSum <= 0) {
    return { chi2: 0, pValue: 1 };
  }
  const chi2 = (observedMinusExpected * observedMinusExpected) / varianceSum;
  const pValue = chi2OneDfSurvival(chi2);
  return { chi2, pValue };
}

// ─── Schoenfeld sample-size formula ──────────────────────────────────────────

/**
 * Required event count `D` for a log-rank test under Schoenfeld's formula:
 *
 *     D = (z_{α/2} + z_β)² / (p_A · p_B · (log HR)²)
 *
 * where p_A, p_B are the per-arm allocation fractions (sum to 1), HR is the
 * detectable hazard ratio, α is the two-sided significance level, and
 * (1 − β) is the desired power.
 *
 * Convert to sample size:
 *     N = ceil(D / event_rate)
 *
 * `event_rate` is the expected fraction of subjects who experience the event
 * before censoring. For the MAX_ATTEMPTS calibration this is the first-attempt
 * fail rate (≈ 0.30 in production data) because only sections that fail at
 * least once contribute later-attempt observations.
 *
 * Defaults match the Phase 4.2 pre-registration:
 *   - α = 0.05 two-sided
 *   - power = 0.80
 *   - allocation = 0.5 / 0.5
 *   - HR = 0.7 (30% reduction in attempt-to-fail hazard)
 *
 * Precondition: hr > 0 ∧ hr ≠ 1; allocationA ∈ (0, 1); eventRate ∈ (0, 1].
 * Postcondition: returns positive integers; N = ceil(D / eventRate).
 *
 * source: Schoenfeld 1981, eq. (1).
 * source: Collett, D. (2015). "Modelling Survival Data in Medical Research,"
 *   3rd ed., Ch. 10.2 — practical sample-size derivation for the log-rank test.
 */
export interface SchoenfeldInput {
  readonly hr: number;
  readonly alphaTwoSided?: number; // default 0.05
  readonly power?: number;          // default 0.80
  readonly allocationA?: number;    // default 0.5
  readonly eventRate: number;       // fraction of subjects expected to event
}

export interface SchoenfeldOutput {
  readonly events: number;          // ceiling D
  readonly sampleSize: number;      // ceiling N = D / eventRate
  readonly hr: number;
  readonly alphaTwoSided: number;
  readonly power: number;
  readonly allocationA: number;
  readonly eventRate: number;
}

export function schoenfeldRequiredEvents(
  input: SchoenfeldInput,
): SchoenfeldOutput {
  const alpha = input.alphaTwoSided ?? 0.05;
  const power = input.power ?? 0.8;
  const pA = input.allocationA ?? 0.5;
  const pB = 1 - pA;
  const hr = input.hr;
  const eventRate = input.eventRate;

  if (!(hr > 0) || hr === 1) {
    throw new Error(`schoenfeldRequiredEvents: hr must be > 0 and ≠ 1, got ${hr}`);
  }
  if (!(pA > 0 && pA < 1)) {
    throw new Error(
      `schoenfeldRequiredEvents: allocationA must be in (0, 1), got ${pA}`,
    );
  }
  if (!(eventRate > 0 && eventRate <= 1)) {
    throw new Error(
      `schoenfeldRequiredEvents: eventRate must be in (0, 1], got ${eventRate}`,
    );
  }
  // Defaults verified against tabulated values: α=0.05 two-sided ⇒ Z_975;
  // power=0.80 ⇒ Z_80. For non-default α / power, fall back to the same
  // tabulated values (this Phase only uses the defaults).
  if (Math.abs(alpha - 0.05) > 1e-9 || Math.abs(power - 0.8) > 1e-9) {
    throw new Error(
      `schoenfeldRequiredEvents: only α=0.05 / power=0.80 supported in this ` +
        `release (no inverse-Φ implemented). Got α=${alpha}, power=${power}.`,
    );
  }
  const zAlpha = Z_975;
  const zBeta = Z_80;
  const logHr = Math.log(hr);
  const D = (zAlpha + zBeta) ** 2 / (pA * pB * logHr * logHr);
  const events = Math.ceil(D);
  const sampleSize = Math.ceil(D / eventRate);
  return {
    events,
    sampleSize,
    hr,
    alphaTwoSided: alpha,
    power,
    allocationA: pA,
    eventRate,
  };
}
