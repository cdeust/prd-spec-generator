/**
 * Per-judge reliability calibration — pure math layer (Phase 4.1, Wave B1).
 *
 * Closed-form Beta-Binomial conjugate update for per-(judge × claim_type)
 * reliability with sensitivity / specificity split.
 *
 * Layer rule (coding-standards §2.2): this module imports from @prd-gen/core
 * (inner layer) and stdlib only. No orchestration, no verification, no
 * infrastructure. Callers in the composition root wire these pure functions
 * to data sources.
 *
 * The Beta prior is defined as the single source of truth in @prd-gen/core
 * (DIP §1.5 / B-Shannon-7): inner layers define abstractions; outer layers
 * import from them.
 *
 * Sources:
 * - Beta-Binomial conjugacy: Gelman et al. (2013), "Bayesian Data Analysis",
 *   3rd ed., Ch. 2.4 (Conjugate prior distributions).
 * - Beta(7,3) prior elicitation: docs/PHASE_4_PLAN.md §4.1 PRE-REGISTRATION
 *   block (mean=0.7, ESS=10; moderately informative toward reliability).
 * - N=30 dominance threshold: Laplace cross-audit L4 (data dominates the
 *   prior when N > ESS_prior; ±0.05 precision requires N≥30; recorded in
 *   docs/PHASE_4_PLAN.md §4.1 stopping rule).
 * - Sensitivity / specificity split: Laplace cross-audit L4
 *   (verdict-direction asymmetry; docs/PHASE_4_PLAN.md §4.1).
 * - dominanceThreshold ESS correction: Fermi cross-audit B-Fermi-3 (subtract
 *   prior ESS so threshold fires at N_observations ≥ 30, not ESS ≥ 30).
 */

import {
  DEFAULT_RELIABILITY_PRIOR,
  RELIABILITY_PRIOR_ESS,
} from "@prd-gen/core";

/**
 * Beta-distribution parameters. Both must be strictly positive (Gelman
 * et al. 2013, eqn 2.13).
 *
 * This is a local alias for the math layer; the canonical definition
 * (BetaParamsCore) lives in @prd-gen/core/reliability-repository.
 * The two types are structurally compatible (same shape).
 */
export interface BetaParams {
  readonly alpha: number;
  readonly beta: number;
}

export { DEFAULT_RELIABILITY_PRIOR };

/**
 * Prior effective sample size, re-exported for callers.
 * Equals DEFAULT_RELIABILITY_PRIOR.alpha + DEFAULT_RELIABILITY_PRIOR.beta = 10.
 *
 * source: docs/PHASE_4_PLAN.md §4.1; @prd-gen/core RELIABILITY_PRIOR_ESS.
 */
export const PRIOR_ESS: number = RELIABILITY_PRIOR_ESS;

/**
 * Minimum N_observations (= observations only, prior ESS subtracted) at which
 * observed data dominates the Beta(7,3) prior.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 stopping-rule derivation
 * (ESS_prior = 10, ±0.05 precision requires N_obs ≥ 30; Laplace L4).
 * source: Fermi cross-audit B-Fermi-3 — dominance must fire at N_observations
 * ≥ 30, not at total ESS ≥ 30 (which would incorrectly count the prior).
 * source: Fermi cross-audit, two-proportion z-test, see PHASE_4_PLAN.md §4.1
 */
export const DOMINANCE_THRESHOLD_N = 30;

/**
 * One annotated observation feeding the calibration update.
 *
 * `ground_truth` and `judge_verdict` are binary, Curie R2 dual-annotator
 * consensus labels (PASS or FAIL on a single claim). INCONCLUSIVE
 * verdicts MUST be filtered upstream; passing one here is a precondition
 * violation and the function will throw.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 ground-truth procedure.
 */
export interface ClaimObservation {
  readonly ground_truth: "PASS" | "FAIL";
  readonly judge_verdict: "PASS" | "FAIL";
}

/**
 * Closed-form Beta posterior given a Bernoulli likelihood:
 *   posterior = Beta(α + success, β + (total - success))
 *
 * Precondition: `success ≥ 0`, `total ≥ success`, both finite integers.
 * The function refuses to silently "fix" bad inputs because that would
 * defeat the §6 root-cause discipline — a negative count or a
 * success>total is an upstream contract failure that must surface.
 *
 * source: Gelman et al. (2013), eqn 2.18.
 */
export function betaUpdate(
  prior: BetaParams,
  success: number,
  total: number,
): BetaParams {
  assertValidBeta(prior);
  if (!Number.isFinite(success) || !Number.isFinite(total)) {
    throw new RangeError(
      `betaUpdate: success and total must be finite (got success=${success}, total=${total}).`,
    );
  }
  if (success < 0 || total < 0 || success > total) {
    throw new RangeError(
      `betaUpdate: require 0 ≤ success ≤ total (got success=${success}, total=${total}).`,
    );
  }
  return {
    alpha: prior.alpha + success,
    beta: prior.beta + (total - success),
  };
}

/**
 * Posterior mean of Beta(α, β) = α / (α + β).
 *
 * source: Gelman et al. (2013), eqn 2.13.
 */
export function posteriorMean(beta: BetaParams): number {
  assertValidBeta(beta);
  return beta.alpha / (beta.alpha + beta.beta);
}

/**
 * Posterior mode of Beta(α, β) = (α − 1) / (α + β − 2) when α > 1 and
 * β > 1 (the unimodal interior case). For α ≤ 1 or β ≤ 1 the mode lies
 * at a boundary (0 or 1) and the closed form is undefined; we return the
 * posterior mean as a documented fallback.
 *
 * The mode is the maximum-a-posteriori (MAP) point estimate and is the
 * correct point estimate per Laplace cross-audit L4: the mean over-shoots
 * toward the prior when N is small.
 *
 * source: Gelman et al. (2013), eqn 2.13 derivation; Laplace L4.
 */
export function posteriorMode(beta: BetaParams): number {
  assertValidBeta(beta);
  if (beta.alpha > 1 && beta.beta > 1) {
    return (beta.alpha - 1) / (beta.alpha + beta.beta - 2);
  }
  return posteriorMean(beta);
}

/**
 * Effective sample size of a Beta posterior = α + β.
 *
 * source: Gelman et al. (2013), §2.4 (the prior is equivalent to having
 * observed α successes and β failures).
 */
export function effectiveSampleSize(beta: BetaParams): number {
  assertValidBeta(beta);
  return beta.alpha + beta.beta;
}

/**
 * Returns true when the posterior has accumulated enough OBSERVED data (prior
 * ESS subtracted) for the likelihood to dominate the Beta(7,3) prior.
 *
 * Before fix (B-Fermi-3): used `effectiveSampleSize(beta) >= 30`, which counts
 * the prior's own 10 ESS, so the threshold fired at N_observations = 20, not 30.
 * Fix: N_observations = effectiveSampleSize(beta) - PRIOR_ESS >= DOMINANCE_THRESHOLD_N.
 *
 * Precondition: beta is a valid BetaParams (alpha > 0, beta > 0).
 * Postcondition: returns true iff the number of actual observations
 *   (ESS minus prior ESS) >= DOMINANCE_THRESHOLD_N.
 *
 * source: Laplace cross-audit L4; DOMINANCE_THRESHOLD_N derivation.
 * source: Fermi cross-audit B-Fermi-3 — off-by-prior-ESS correction.
 */
export function dominanceThreshold(beta: BetaParams): boolean {
  return effectiveSampleSize(beta) - PRIOR_ESS >= DOMINANCE_THRESHOLD_N;
}

/**
 * Confusion-matrix counts derived from a list of dual-annotator-consensus
 * observations.
 *
 * Naming follows binary-classifier convention with PASS as the
 * "positive" class (the judge predicts the claim holds).
 */
export interface ConfusionCounts {
  readonly true_positives: number;
  readonly false_positives: number;
  readonly true_negatives: number;
  readonly false_negatives: number;
}

/**
 * Tally a confusion matrix from observations. Pure reduction; no
 * filtering or imputation.
 */
export function tallyConfusion(
  observations: readonly ClaimObservation[],
): ConfusionCounts {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const o of observations) {
    if (o.ground_truth === "PASS" && o.judge_verdict === "PASS") tp += 1;
    else if (o.ground_truth === "FAIL" && o.judge_verdict === "PASS") fp += 1;
    else if (o.ground_truth === "FAIL" && o.judge_verdict === "FAIL") tn += 1;
    else fn += 1; // gt=PASS, verdict=FAIL
  }
  return {
    true_positives: tp,
    false_positives: fp,
    true_negatives: tn,
    false_negatives: fn,
  };
}

/**
 * Posterior pair for a (judge × claim_type) cell:
 *   sens = P(judge_verdict=PASS | ground_truth=PASS)
 *   spec = P(judge_verdict=FAIL | ground_truth=FAIL)
 *
 * Both posteriors are updated independently from the Beta(7,3) prior;
 * the verdict-direction asymmetry tracking is mandatory (Laplace L4).
 *
 * source: docs/PHASE_4_PLAN.md §4.1 sensitivity/specificity split.
 */
export interface SensitivitySpecificityPosterior {
  readonly sens: BetaParams;
  readonly spec: BetaParams;
  readonly counts: ConfusionCounts;
}

/**
 * Update Beta(7,3) priors independently for sensitivity and specificity.
 *
 * - sens posterior = Beta(7 + TP, 3 + FN)   (positives correctly called)
 * - spec posterior = Beta(7 + TN, 3 + FP)   (negatives correctly called)
 *
 * The two priors are deliberately the same Beta(7,3): both quantities
 * are reliability-on-a-class, and neither has elicitation evidence
 * favoring an asymmetric prior (see §4.1 PRE-REGISTRATION).
 */
export function splitSensitivitySpecificity(
  observations: readonly ClaimObservation[],
  prior: BetaParams = DEFAULT_RELIABILITY_PRIOR,
): SensitivitySpecificityPosterior {
  assertValidBeta(prior);
  const counts = tallyConfusion(observations);
  const sens = betaUpdate(
    prior,
    counts.true_positives,
    counts.true_positives + counts.false_negatives,
  );
  const spec = betaUpdate(
    prior,
    counts.true_negatives,
    counts.true_negatives + counts.false_positives,
  );
  return { sens, spec, counts };
}

/**
 * Internal: enforce α > 0 and β > 0. A non-positive parameter is a
 * contract violation upstream — refuse, surface, do not paper over.
 */
function assertValidBeta(b: BetaParams): void {
  if (
    !Number.isFinite(b.alpha) ||
    !Number.isFinite(b.beta) ||
    b.alpha <= 0 ||
    b.beta <= 0
  ) {
    throw new RangeError(
      `BetaParams: require alpha > 0 and beta > 0 (got alpha=${b.alpha}, beta=${b.beta}).`,
    );
  }
}
