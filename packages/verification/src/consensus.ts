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
 *
 * B7 refactor (Wave D): resolveReliability, verdictToDirection, bayesian,
 * uniformPrior, updatePosterior, and pickMaxVerdict have been extracted to
 * consensus-strategy.ts to keep this file ≤500 LOC (coding-standards §4.1).
 * All public behaviour is unchanged; backward-compat re-exports are provided.
 *
 * source: Fowler (2018), Refactoring, §6.1 Extract Function.
 * source: coding-standards §4.1 (500-line file limit).
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
import { bayesian } from "./consensus-strategy.js";

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
 * Available aggregation strategies.
 */
export type ConsensusStrategy = "weighted_average" | "bayesian";

/**
 * Reliability lookup callback — injected by the composition root.
 *
 * Layer contract (§2.2): verification cannot import @prd-gen/benchmark.
 *
 * Precondition: callback is pure (no side effects, idempotent).
 * Postcondition: returns null → caller falls back to DEFAULT_RELIABILITY_PRIOR.
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
   * Reliability priors per agent — Bayesian only. Backward compatibility.
   * source: chosen heuristically (uniform weak prior).
   */
  readonly reliability?: ReadonlyMap<string, number>;
  /**
   * Calibrated per-judge reliability lookup (Phase 4.1, Wave D2).
   * source: docs/PHASE_4_PLAN.md §4.1; CC-3 / B-Popper-1.
   */
  readonly reliabilityLookup?: ReliabilityLookup;
  /**
   * Pipeline run identifier — required when reliabilityLookup or
   * reliabilityProvider is provided.
   * source: CC-3 — run_id partitioning for ε-greedy exploration.
   */
  readonly runId?: string;
  /**
   * Calibrated per-judge reliability provider (Phase 4.1, Wave D2).
   * source: docs/PHASE_4_PLAN.md §4.1; Wave D2.
   */
  readonly reliabilityProvider?: ConsensusReliabilityProvider;
  /**
   * Claim_type of verdicts being aggregated — required for per-cell lookup.
   * source: docs/PHASE_4_PLAN.md §4.1 — per-(agent, claim_type) Beta cell.
   */
  readonly claimType?: string;
  /**
   * If at least this fraction of weight votes FAIL, force FAIL.
   * source: precautionary principle. 0.5 is the symmetric default.
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
 * Clamp a probability-typed value to [0, 1].
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
    const w = clampUnit(v.confidence);
    distribution[v.verdict] += w;
    totalWeight += w;
  }

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
  // Tie-breaker: more severe verdict wins (precautionary principle).
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

// ─── Backward-compat re-exports from consensus-strategy.ts ──────────────────

/**
 * Re-exported for callers that previously imported from consensus.ts directly.
 * The functions now live in consensus-strategy.ts (Wave D B7).
 *
 * source: Wave D B7 remediation — backward compat.
 */
export {
  verdictToDirection,
  resolveReliability,
  NO_INFORMATION_FLOOR,
  uniformPrior,
  updatePosterior,
  pickMaxVerdict as pickMaxVerdictFromStrategy,
} from "./consensus-strategy.js";
