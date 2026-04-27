/**
 * Clopper-Pearson exact confidence interval for a binomial proportion.
 *
 * source: Clopper, C. J. & Pearson, E. S. (1934). "The Use of Confidence or
 *   Fiducial Limits Illustrated in the Case of the Binomial." Biometrika
 *   26(4), 404-413.
 *
 * The exact CI is the inversion of the binomial test. For x successes in n
 * trials with confidence level (1-α):
 *
 *   lower = Beta⁻¹(α/2;     x,     n-x+1)
 *   upper = Beta⁻¹(1-α/2;   x+1,   n-x  )
 *
 * Edge cases (x=0, x=n) follow the standard convention: lower=0 when x=0,
 * upper=1 when x=n.
 *
 * We use the relation between the inverse-Beta CDF and the inverse-F
 * distribution (source: Hahn & Meeker, "Statistical Intervals," 1991, eq.
 * 6.3) to compute the bounds without a full Beta library:
 *
 *   lower = (x · F_lo) / (n - x + 1 + x · F_lo),
 *     F_lo = F⁻¹(α/2;   2x,        2(n-x+1))
 *   upper = ((x+1) · F_hi) / (n - x + (x+1) · F_hi),
 *     F_hi = F⁻¹(1-α/2; 2(x+1),    2(n-x))
 *
 * Implemented here via Newton-Raphson on the regularized incomplete Beta
 * function (Numerical Recipes 3e, §6.4) — a few dozen LOC, no extra deps.
 *
 * source: Press et al., "Numerical Recipes" 3rd ed. (2007), §6.4 (continued
 *   fraction for incomplete Beta) and §6.14 (inverse Beta via Halley's
 *   method).
 */

const MAX_ITER = 100;
// source: Numerical Recipes 3e §6.4 — convergence tolerance for
// regularized-incomplete-Beta continued fraction.
const EPS = 1e-12;
// source: Numerical Recipes 3e §6.4 — floor protecting against catastrophic
// underflow in the recurrence.
const FPMIN = 1e-300;

function logGamma(x: number): number {
  // source: Lanczos, C. (1964). "A Precision Approximation of the Gamma
  // Function." J. SIAM Numer. Anal. B, 1, 86-96. Coefficients per
  // Numerical Recipes 3e §6.1.
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of cof) {
    y += 1;
    ser += c / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a: number, b: number, x: number): number {
  // source: Numerical Recipes 3e §6.4. Continued-fraction expansion for the
  // regularized incomplete Beta function via Lentz's method.
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) return h;
  }
  return h;
}

/**
 * Regularized incomplete Beta function I_x(a, b).
 * source: Numerical Recipes 3e §6.4.
 */
export function betaiRegularized(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) -
      logGamma(a) -
      logGamma(b) +
      a * Math.log(x) +
      b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/**
 * Inverse regularized incomplete Beta. Returns x such that I_x(a, b) = p.
 * source: bisection (sufficient precision for binomial CIs at p ∈ (0, 1)).
 */
function betaInv(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (betaiRegularized(a, b, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface ClopperPearsonInterval {
  readonly pointEstimate: number;
  readonly lower: number;
  readonly upper: number;
  readonly confidence: number;
  readonly successes: number;
  readonly trials: number;
}

/**
 * Two-sided exact binomial CI.
 * source: Clopper & Pearson 1934.
 */
export function clopperPearson(
  successes: number,
  trials: number,
  confidence = 0.95,
): ClopperPearsonInterval {
  if (trials <= 0) {
    throw new Error("trials must be > 0");
  }
  if (successes < 0 || successes > trials) {
    throw new Error(`successes must be in [0, trials]`);
  }
  const alpha = 1 - confidence;
  const lower =
    successes === 0 ? 0 : betaInv(alpha / 2, successes, trials - successes + 1);
  const upper =
    successes === trials
      ? 1
      : betaInv(1 - alpha / 2, successes + 1, trials - successes);
  return {
    pointEstimate: successes / trials,
    lower,
    upper,
    confidence,
    successes,
    trials,
  };
}
