/**
 * Consensus engine — aggregate JudgeVerdict[] into a single ConsensusVerdict.
 *
 * Two strategies are exported (a third is reserved — see ConsensusStrategy):
 *
 *   weighted_average — confidence-weighted vote across the 5-level taxonomy.
 *                      Default. Robust to one bad judge.
 *
 *   bayesian — treat each judge as a noisy observer with a prior reliability,
 *              update posterior over verdicts. Requires reliability priors
 *              from history; defaults to a moderately-informative Beta(7,3)
 *              prior (mean 0.7, ESS=10) if absent.
 *
 * Constants and formulas are deterministic. We do not call LLMs here.
 *
 * Output invariant (ConsensusVerdict):
 *   - confidence ∈ [0, 1]
 *   - distribution[v] ∈ [0, 1] for every v ∈ Verdict
 *   - sum(distribution[v]) = 1 (within floating-point tolerance) when verdicts
 *     is non-empty; sum = 0 (empty distribution) when verdicts is empty.
 */

import type {
  Verdict,
  JudgeVerdict,
  AgentIdentity,
  JudgeReliabilityRecord,
  VerdictDirection,
  ConsensusReliabilityProvider,
} from "@prd-gen/core";
import { DEFAULT_RELIABILITY_PRIOR } from "@prd-gen/core";

// Verdict severity for ordering — higher = more concerning.
const VERDICT_SEVERITY: Record<Verdict, number> = {
  PASS: 0,
  "SPEC-COMPLETE": 1,
  "NEEDS-RUNTIME": 2,
  INCONCLUSIVE: 3,
  FAIL: 4,
};

const VERDICTS: readonly Verdict[] = [
  "PASS",
  "SPEC-COMPLETE",
  "NEEDS-RUNTIME",
  "INCONCLUSIVE",
  "FAIL",
];

export interface ConsensusVerdict {
  readonly claim_id: string;
  readonly verdict: Verdict;
  /** [0,1] — weighted-vote strength of the chosen verdict */
  readonly confidence: number;
  /** Did all judges agree? */
  readonly unanimous: boolean;
  /** Verdicts from judges that disagreed with the chosen verdict */
  readonly dissenting: readonly JudgeVerdict[];
  /** Per-verdict weighted vote distribution */
  readonly distribution: Readonly<Record<Verdict, number>>;
  /** Strategy used */
  readonly strategy: ConsensusStrategy;
  /** All judge identities that participated */
  readonly judges: readonly AgentIdentity[];
}

/**
 * Available aggregation strategies. `adaptive_stability` is intentionally NOT
 * exposed yet — its required mechanism (a request loop that decides whether to
 * solicit additional judges based on KS divergence between the current and
 * previous verdict distributions) lives outside this engine and has not been
 * implemented. Re-add it to the union when that mechanism ships.
 */
export type ConsensusStrategy = "weighted_average" | "bayesian";

/**
 * Reliability lookup callback — injected by the composition root.
 *
 * Layer contract (§2.2): verification cannot import @prd-gen/benchmark.
 * `getReliabilityForRun` (the CC-3 control-arm seam) lives in benchmark.
 * The composition root (mcp-server) wires this callback to:
 *   `(judge, claimType, direction) =>
 *      getReliabilityForRun(runId, judge, claimType, direction, repository)`
 *
 * This keeps the control-arm logic (and the benchmark import) entirely outside
 * the verification layer. Verification receives only the resolved value —
 * null (control arm or no data → use prior) or a JudgeReliabilityRecord.
 *
 * Precondition: callback is pure (no side effects, idempotent for the same
 *   triple on a given run). Postcondition: returns null → caller falls back
 *   to DEFAULT_RELIABILITY_PRIOR (Beta(7,3) mean = 0.7).
 *
 * source: §2.2 (dependency rule); CC-3 / B-Popper-1 (control-arm seam).
 */
export type ReliabilityLookup = (
  judge: AgentIdentity,
  claimType: string,
  direction: VerdictDirection,
) => JudgeReliabilityRecord | null;

export interface ConsensusConfig {
  readonly strategy?: ConsensusStrategy;
  /**
   * Reliability priors per agent — Bayesian only. Kept for backward compatibility
   * with callers that inject a static map (e.g. tests, CLI tools). When
   * `reliabilityLookup` is also provided, `reliabilityLookup` takes precedence
   * for each judge whose lookup returns non-null.
   * source: chosen heuristically (uniform weak prior); calibrate per-agent
   * once we have JudgeVerdict history with ground-truth comparison.
   */
  readonly reliability?: ReadonlyMap<string, number>;
  /**
   * Calibrated per-judge reliability lookup (Phase 4.1, Wave D2).
   *
   * When provided, the Bayesian strategy calls this for each (judge, claimType,
   * direction) triple. A non-null return overrides any value in `reliability`;
   * null falls back to `reliability` map, then to DEFAULT_RELIABILITY_PRIOR (Beta(7,3) mean = 0.7).
   *
   * MUST be provided by the composition root for calibrated production use.
   * When absent, the engine behaves exactly as before (scalar prior only).
   *
   * source: docs/PHASE_4_PLAN.md §4.1; CC-3 / B-Popper-1.
   */
  readonly reliabilityLookup?: ReliabilityLookup;
  /**
   * Pipeline run identifier — required when `reliabilityLookup` or
   * `reliabilityProvider` is provided.
   * Passed to reliabilityProvider.getReliabilityForRun so the CC-3 control-arm
   * seam can partition by run_id. For reliabilityLookup callers, run_id is
   * baked into the callback closure; this field is kept for audit / logging.
   *
   * source: CC-3 — run_id partitioning for ε-greedy exploration.
   */
  readonly runId?: string;
  /**
   * Calibrated per-judge reliability provider (Phase 4.1, Wave D2).
   *
   * When provided, the Bayesian strategy calls
   * `reliabilityProvider.getReliabilityForRun(runId, judge, claimType, direction)`
   * for each judge. A non-null return uses the posteriorMean (alpha/(alpha+beta))
   * as the reliability weight. Null falls back to `reliabilityLookup`,
   * then `reliability` map, then the prior mean from DEFAULT_RELIABILITY_PRIOR.
   *
   * Preferred wiring for production callers using the ConsensusReliabilityProvider
   * port. `reliabilityLookup` is kept for backward compatibility with callers
   * that bind runId into a closure.
   *
   * Requires `runId` to be set for the CC-3 control arm to partition by run.
   * When `runId` is absent, this provider is not called.
   *
   * Backward-compat: when absent, all weights fall back to the prior (identical
   * to pre-Wave-D behaviour regardless of reliabilityLookup state).
   *
   * source: docs/PHASE_4_PLAN.md §4.1; Wave D2 — ConsensusReliabilityProvider port.
   */
  readonly reliabilityProvider?: ConsensusReliabilityProvider;
  /**
   * The claim_type of verdicts being aggregated — required for per-cell
   * reliability lookup. When absent, the lookup cannot be called (falls back
   * to scalar prior). The orchestrator sets this per claim batch.
   *
   * source: docs/PHASE_4_PLAN.md §4.1 — per-(agent, claim_type) Beta cell.
   */
  readonly claimType?: string;
  /**
   * If at least this fraction of weight votes a "FAIL" verdict, force FAIL.
   * source: precautionary principle — a 50% confidence-weighted minority
   * voting FAIL is enough to override a plurality of milder verdicts.
   * Tune via offline replay of dissenting verdicts on labelled PRDs once we
   * have any. Until then, 0.5 is the symmetric default.
   */
  readonly fail_threshold?: number;
}

const DEFAULT_CONFIG: Required<
  Omit<ConsensusConfig, "reliability" | "reliabilityLookup" | "reliabilityProvider" | "runId" | "claimType">
> = {
  strategy: "weighted_average",
  // source: see ConsensusConfig.fail_threshold doc-comment.
  fail_threshold: 0.5,
};

/**
 * Clamp a probability-typed value to [0, 1]. Used as a defensive guard
 * at every public-facing reliability/confidence boundary because the
 * upstream JudgeVerdict.confidence type is `number` (Zod-validated to
 * [0,1] at the parse site, but JudgeVerdicts can also be constructed
 * programmatically inside the orchestrator's fallback paths). Without
 * this guard, an out-of-band value (e.g. confidence=2 from a buggy
 * synthetic verdict) would produce posterior probabilities outside the
 * unit interval and break the ConsensusVerdict.distribution invariant.
 *
 * source: dijkstra cross-audit C1 (2026-04).
 */
function clampUnit(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

export function consensus(
  claim_id: string,
  verdicts: readonly JudgeVerdict[],
  config: ConsensusConfig = {},
): ConsensusVerdict {
  if (verdicts.length === 0) {
    return {
      claim_id,
      verdict: "INCONCLUSIVE",
      confidence: 0,
      unanimous: false,
      dissenting: [],
      distribution: emptyDistribution(),
      strategy: config.strategy ?? DEFAULT_CONFIG.strategy,
      judges: [],
    };
  }

  const strategy = config.strategy ?? DEFAULT_CONFIG.strategy;
  switch (strategy) {
    case "weighted_average":
      return weightedAverage(claim_id, verdicts, config);
    case "bayesian":
      return bayesian(claim_id, verdicts, config);
  }
}

// ─── Weighted average ───────────────────────────────────────────────────────

function weightedAverage(
  claim_id: string,
  verdicts: readonly JudgeVerdict[],
  config: ConsensusConfig,
): ConsensusVerdict {
  const distribution = emptyDistribution();
  let totalWeight = 0;

  for (const v of verdicts) {
    // clampUnit: confidence may arrive out-of-band (e.g. a fallback
    // INCONCLUSIVE constructed in self-check.ts has confidence=0; a
    // buggy upstream could emit >1). Bound to [0,1] before weighting.
    const w = clampUnit(v.confidence);
    distribution[v.verdict] += w;
    totalWeight += w;
  }

  // If every judge had 0 confidence, fall back to count-based vote.
  if (totalWeight === 0) {
    for (const v of verdicts) distribution[v.verdict] += 1;
    totalWeight = verdicts.length;
  }

  const failThreshold = config.fail_threshold ?? DEFAULT_CONFIG.fail_threshold;
  const failWeight = distribution.FAIL;
  const failFrac = totalWeight > 0 ? failWeight / totalWeight : 0;

  let chosen: Verdict;
  if (failFrac >= failThreshold) {
    chosen = "FAIL";
  } else {
    chosen = pickMaxVerdict(distribution);
  }

  const confidence = totalWeight > 0 ? distribution[chosen] / totalWeight : 0;
  const unanimous = verdicts.every((v) => v.verdict === chosen);
  const dissenting = verdicts.filter((v) => v.verdict !== chosen);

  return {
    claim_id,
    verdict: chosen,
    confidence,
    unanimous,
    dissenting,
    distribution: normalizeDistribution(distribution, totalWeight),
    strategy: "weighted_average",
    judges: verdicts.map((v) => v.judge),
  };
}

// ─── Bayesian ───────────────────────────────────────────────────────────────

/**
 * Uniform-noise floor for the (1-r)/4 likelihood model.
 *
 * Below this threshold, an "observation" contributes anti-information: the
 * judge's reported verdict has likelihood ≤ 0.25 = 1/N for N=4 alternatives,
 * meaning the model treats the report as worse-than-random. A judge whose
 * adjustedReliability falls below the floor should NOT update the posterior
 * — the correct treatment is to skip them (contribute zero information).
 *
 * source: curie cross-audit H3 / FOLLOWUP-76 (Phase 3+4 follow-up, 2026-04).
 * 0.2 = 1/N where N=5 verdict labels: at exactly r=0.2, likelihood is uniform
 * (the observation distinguishes nothing); below 0.2, likelihood is
 * anti-correlated. Phase 4.1 calibration may revisit this constant when
 * per-agent reliability data is collected.
 */
const NO_INFORMATION_FLOOR = 0.2;

/**
 * Determine the VerdictDirection arm to read from the reliability repository
 * for a given judge verdict.
 *
 * When ground truth is unknown (consensus-majority context), we use the judge's
 * reported verdict to select the arm:
 *   - PASS-class (PASS, SPEC-COMPLETE) → specificity_arm
 *     (tracks P(judge says PASS | ground truth is PASS))
 *   - FAIL-class (FAIL, NEEDS-RUNTIME, INCONCLUSIVE) → sensitivity_arm
 *     (tracks P(judge says FAIL | ground truth is FAIL))
 *
 * This is an annotator-circularity approximation: we do not know ground truth,
 * so we use the verdict itself as a proxy. Phase 4.1 external-grounding (Wave E)
 * will break this circularity by providing oracle verdicts as ground truth.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 — "verdict_direction from judge_verdict
 * when ground truth is unknown; annotator-circularity documented."
 */
function verdictToDirection(verdict: Verdict): VerdictDirection {
  if (verdict === "PASS" || verdict === "SPEC-COMPLETE") {
    return "specificity_arm";
  }
  return "sensitivity_arm";
}

/**
 * Resolve per-judge reliability for Bayesian weighting.
 *
 * Precondition: judge is a valid AgentIdentity; claimType and direction are
 *   valid strings matching their respective domain types.
 * Postcondition: returns a value in [0, 1] clamped to unit interval.
 *   Priority order:
 *     1. reliabilityProvider.getReliabilityForRun(runId, judge, claimType, direction)
 *        → posteriorMean if non-null and runId + claimType are present
 *     2. reliabilityLookup(judge, claimType, direction) → posteriorMean if non-null
 *     3. reliabilityMap.get(agentKey(judge)) if present
 *     4. DEFAULT_RELIABILITY_PRIOR mean = alpha/(alpha+beta) (scalar fallback)
 *
 * source: docs/PHASE_4_PLAN.md §4.1; CC-3 control-arm seam; Wave D2.
 */
function resolveReliability(
  judge: AgentIdentity,
  runId: string | undefined,
  claimType: string | undefined,
  direction: VerdictDirection,
  reliabilityProvider: ConsensusReliabilityProvider | undefined,
  reliabilityLookup: ReliabilityLookup | undefined,
  reliabilityMap: ReadonlyMap<string, number>,
): number {
  // 1. ConsensusReliabilityProvider (highest priority — named interface, Wave D2).
  //    Requires both runId and claimType to call; otherwise falls through.
  //    posteriorMean = alpha / (alpha + beta).
  //    source: Gelman et al. (2013) §2.4, eqn 2.13.
  if (reliabilityProvider !== undefined && runId !== undefined && claimType !== undefined) {
    // Type assertion: ConsensusConfig.claimType is `string` to avoid importing
    // the Claim enum into ConsensusConfig (keep types simple). The orchestrator
    // always passes a valid Claim["claim_type"] value. If an invalid string is
    // passed, getReliabilityForRun returns null and we fall through to the prior.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const record = reliabilityProvider.getReliabilityForRun(runId, judge, claimType as any, direction);
    if (record !== null) {
      return clampUnit(record.alpha / (record.alpha + record.beta));
    }
  }
  // 2. Closure-based lookup (Wave D1 / backward-compat — runId baked into closure).
  if (reliabilityLookup !== undefined && claimType !== undefined) {
    const record = reliabilityLookup(judge, claimType, direction);
    if (record !== null) {
      // posteriorMean = alpha / (alpha + beta); inlined to avoid importing
      // @prd-gen/benchmark into the verification layer (§2.2 layer rule).
      return clampUnit(record.alpha / (record.alpha + record.beta));
    }
  }
  // 3. Static map (backward-compat for tests and CLI callers).
  const key = agentKey(judge);
  const mapped = reliabilityMap.get(key);
  if (mapped !== undefined) {
    return clampUnit(mapped);
  }
  // 4. Prior mean fallback (control arm or cold start).
  //    Computed from DEFAULT_RELIABILITY_PRIOR (single source of truth in core).
  //    source: DEFAULT_RELIABILITY_PRIOR = Beta(7,3); mean = 7/10 = 0.7.
  return DEFAULT_RELIABILITY_PRIOR.alpha / (DEFAULT_RELIABILITY_PRIOR.alpha + DEFAULT_RELIABILITY_PRIOR.beta);
}

function bayesian(
  claim_id: string,
  verdicts: readonly JudgeVerdict[],
  config: ConsensusConfig,
): ConsensusVerdict {
  // Uniform prior across the 5 verdicts.
  let posterior = uniformPrior();
  const reliabilityMap = config.reliability ?? new Map<string, number>();

  for (const v of verdicts) {
    // Determine which reliability arm to consult based on the judge's verdict.
    // When ground truth is unknown, the judge's own verdict is used as a proxy.
    // This is the annotator-circularity path; Wave E external oracles will break it.
    const direction = verdictToDirection(v.verdict);
    const rawReliability = resolveReliability(
      v.judge,
      config.runId,
      config.claimType,
      direction,
      config.reliabilityProvider,
      config.reliabilityLookup,
      reliabilityMap,
    );
    // Both factors must lie in [0,1] to keep adjustedReliability in [0,1].
    // Without clamping, an out-of-band reliability (caller-supplied map)
    // or confidence (upstream bug) would produce negative likelihoods in
    // updatePosterior and break the [0,1] sum-to-1 distribution invariant.
    const reliability = clampUnit(rawReliability);
    const confidence = clampUnit(v.confidence);
    const adjustedReliability = reliability * confidence;
    // Skip no-information judges (HIGH-15 / FOLLOWUP-76 closure). At or
    // below NO_INFORMATION_FLOOR the (1-r)/4 likelihood model would
    // anti-vote against the reported verdict — the right semantic is
    // "this judge contributes nothing." Equivalent to omitting them.
    if (adjustedReliability <= NO_INFORMATION_FLOOR) {
      continue;
    }
    posterior = updatePosterior(posterior, v.verdict, adjustedReliability);
  }

  const distribution: Record<Verdict, number> = {
    PASS: 0,
    "SPEC-COMPLETE": 0,
    "NEEDS-RUNTIME": 0,
    INCONCLUSIVE: 0,
    FAIL: 0,
  };
  for (const v of VERDICTS) {
    distribution[v] = posterior[v];
  }

  const chosen = pickMaxVerdict(distribution);
  const confidence = distribution[chosen];
  const unanimous = verdicts.every((v) => v.verdict === chosen);
  const dissenting = verdicts.filter((v) => v.verdict !== chosen);

  return {
    claim_id,
    verdict: chosen,
    confidence,
    unanimous,
    dissenting,
    distribution,
    strategy: "bayesian",
    judges: verdicts.map((v) => v.judge),
  };
}

function uniformPrior(): Record<Verdict, number> {
  return {
    PASS: 0.2,
    "SPEC-COMPLETE": 0.2,
    "NEEDS-RUNTIME": 0.2,
    INCONCLUSIVE: 0.2,
    FAIL: 0.2,
  };
}

/**
 * Bayes-update a posterior over Verdict given one observation.
 *
 * Precondition:  reliability ∈ [0, 1]. Callers must clamp before invoking.
 *                Within consensus.ts every call site uses clampUnit; a
 *                defensive guard repeats it here so unit tests of this
 *                function stand on their own.
 * Precondition:  prior[v] ≥ 0 for every v ∈ VERDICTS. uniformPrior
 *                guarantees this (every entry = 0.2).
 * Postcondition: returned posterior[v] ∈ [0, 1] for every v.
 * Postcondition: sum(posterior[v]) = 1 (within fp tolerance) when
 *                any prior entry is > 0; otherwise returned posterior
 *                equals prior (degenerate case — never reached because
 *                uniformPrior is strictly positive).
 *
 * source: dijkstra cross-audit C1 (2026-04). The previous implementation
 * computed `(1 - reliability) / 4` without clamping, allowing negative
 * likelihoods if reliability > 1 reached this point.
 */
function updatePosterior(
  prior: Record<Verdict, number>,
  observed: Verdict,
  reliability: number,
): Record<Verdict, number> {
  const r = clampUnit(reliability);
  // Likelihood model: judge says X if true verdict is X with prob `r`,
  // otherwise picks uniformly among the other 4. Closed-form Bayes update.
  // With r ∈ [0,1], `other = (1 - r) / 4 ∈ [0, 0.25]` — strictly non-negative.
  const likelihood: Record<Verdict, number> = {
    PASS: 0,
    "SPEC-COMPLETE": 0,
    "NEEDS-RUNTIME": 0,
    INCONCLUSIVE: 0,
    FAIL: 0,
  };
  const other = (1 - r) / 4;
  for (const v of VERDICTS) {
    likelihood[v] = v === observed ? r : other;
  }

  const posterior: Record<Verdict, number> = {
    PASS: 0,
    "SPEC-COMPLETE": 0,
    "NEEDS-RUNTIME": 0,
    INCONCLUSIVE: 0,
    FAIL: 0,
  };
  let total = 0;
  for (const v of VERDICTS) {
    posterior[v] = prior[v] * likelihood[v];
    total += posterior[v];
  }
  if (total > 0) {
    for (const v of VERDICTS) posterior[v] /= total;
  }
  return posterior;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function emptyDistribution(): Record<Verdict, number> {
  return {
    PASS: 0,
    "SPEC-COMPLETE": 0,
    "NEEDS-RUNTIME": 0,
    INCONCLUSIVE: 0,
    FAIL: 0,
  };
}

function normalizeDistribution(
  d: Record<Verdict, number>,
  total: number,
): Record<Verdict, number> {
  if (total <= 0) return d;
  const out = emptyDistribution();
  for (const v of VERDICTS) out[v] = d[v] / total;
  return out;
}

function pickMaxVerdict(d: Record<Verdict, number>): Verdict {
  // Tie-breaker: more severe verdict wins (precautionary principle —
  // never default to PASS when there's tension).
  let best: Verdict = "PASS";
  let bestScore = -Infinity;
  for (const v of VERDICTS) {
    const s = d[v];
    if (s > bestScore || (s === bestScore && VERDICT_SEVERITY[v] > VERDICT_SEVERITY[best])) {
      best = v;
      bestScore = s;
    }
  }
  return best;
}

export function agentKey(agent: AgentIdentity): string {
  return `${agent.kind}:${agent.name}`;
}
