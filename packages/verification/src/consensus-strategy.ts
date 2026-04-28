/**
 * consensus-strategy.ts — Bayesian reliability resolution for consensus.ts.
 *
 * Extracted from consensus.ts (Wave D B7) to keep consensus.ts ≤500 LOC
 * (coding-standards §4.1). Re-exported from consensus.ts for backward compat.
 *
 * Contains:
 *   verdictToDirection    — map verdict → VerdictDirection arm.
 *   resolveReliability    — per-judge reliability with provider/lookup/map/prior fallback.
 *   bayesian              — Bayesian aggregation strategy (internal, re-exported).
 *   uniformPrior          — uniform Dirichlet prior over 5 verdicts.
 *   updatePosterior       — Bayes-update a posterior given one observation.
 *   NO_INFORMATION_FLOOR  — reliability floor below which judge is skipped.
 *
 * Layer contract (§2.2): imports from @prd-gen/core only (no benchmark, no
 * infrastructure, no orchestration).
 *
 * source: Fowler (2018), Refactoring, §6.1 Extract Function.
 * source: coding-standards §4.1 (500-line file limit).
 * source: Wave D B7 remediation.
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
// Type-only import: interfaces are erased at runtime, so the circular
// dependency with consensus.ts is safe (no runtime value dependency).
// source: TypeScript Handbook — "import type" for circular type dependencies.
import type { ReliabilityLookup, ConsensusConfig, ConsensusVerdict } from "./consensus.js";

/**
 * Unique key for an AgentIdentity — used for reliability map lookups.
 * Duplicated here (same as consensus.ts:agentKey) to avoid a circular
 * runtime import (consensus-strategy.ts imports from consensus.ts types only).
 *
 * source: consensus.ts:agentKey; Wave D B7 circular-import resolution.
 */
function agentKey(agent: AgentIdentity): string {
  return `${agent.kind}:${agent.name}`;
}

// ─── Re-used constants from consensus.ts ─────────────────────────────────────

const VERDICTS: readonly Verdict[] = [
  "PASS",
  "SPEC-COMPLETE",
  "NEEDS-RUNTIME",
  "INCONCLUSIVE",
  "FAIL",
];

const VERDICT_SEVERITY: Record<Verdict, number> = {
  PASS: 0,
  "SPEC-COMPLETE": 1,
  "NEEDS-RUNTIME": 2,
  INCONCLUSIVE: 3,
  FAIL: 4,
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

// ─── NO_INFORMATION_FLOOR ─────────────────────────────────────────────────────

/**
 * Uniform-noise floor for the (1-r)/4 likelihood model.
 *
 * Below this threshold, a judge's report has likelihood ≤ 0.25 = 1/N for
 * N=4 alternatives — worse than random. Skip such judges (contribute zero
 * information).
 *
 * source: curie cross-audit H3 / FOLLOWUP-76 (Phase 3+4 follow-up, 2026-04).
 * 0.2 = 1/N where N=5 verdict labels.
 */
export const NO_INFORMATION_FLOOR = 0.2;

// ─── verdictToDirection ───────────────────────────────────────────────────────

/**
 * Determine the VerdictDirection arm for a given judge verdict.
 *
 * PASS-class (PASS, SPEC-COMPLETE) → specificity_arm.
 * FAIL-class (FAIL, NEEDS-RUNTIME, INCONCLUSIVE) → sensitivity_arm.
 *
 * Annotator-circularity approximation: no ground truth known here.
 * Wave E external oracles will break this circularity.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 — "verdict_direction from judge_verdict."
 */
export function verdictToDirection(verdict: Verdict): VerdictDirection {
  if (verdict === "PASS" || verdict === "SPEC-COMPLETE") {
    return "specificity_arm";
  }
  return "sensitivity_arm";
}

// ─── resolveReliability ───────────────────────────────────────────────────────

/**
 * Resolve per-judge reliability for Bayesian weighting.
 *
 * Precondition: judge is a valid AgentIdentity; claimType and direction are
 *   valid strings matching their respective domain types.
 * Postcondition: returns a value in [0, 1] clamped to unit interval.
 *   Priority order:
 *     1. reliabilityProvider.getReliabilityForRun(runId, judge, claimType, direction)
 *     2. reliabilityLookup(judge, claimType, direction)
 *     3. reliabilityMap.get(agentKey(judge))
 *     4. DEFAULT_RELIABILITY_PRIOR mean = alpha/(alpha+beta) (scalar fallback)
 *
 * source: docs/PHASE_4_PLAN.md §4.1; CC-3 control-arm seam; Wave D2.
 */
export function resolveReliability(
  judge: AgentIdentity,
  runId: string | undefined,
  claimType: string | undefined,
  direction: VerdictDirection,
  reliabilityProvider: ConsensusReliabilityProvider | undefined,
  reliabilityLookup: ReliabilityLookup | undefined,
  reliabilityMap: ReadonlyMap<string, number>,
): number {
  // 1. ConsensusReliabilityProvider (highest priority — named interface, Wave D2).
  if (reliabilityProvider !== undefined && runId !== undefined && claimType !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const record = reliabilityProvider.getReliabilityForRun(runId, judge, claimType as any, direction);
    if (record !== null) {
      return clampUnit(record.alpha / (record.alpha + record.beta));
    }
  }
  // 2. Closure-based lookup (Wave D1 / backward-compat).
  if (reliabilityLookup !== undefined && claimType !== undefined) {
    const record = reliabilityLookup(judge, claimType, direction);
    if (record !== null) {
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
  return DEFAULT_RELIABILITY_PRIOR.alpha / (DEFAULT_RELIABILITY_PRIOR.alpha + DEFAULT_RELIABILITY_PRIOR.beta);
}

// ─── uniformPrior ─────────────────────────────────────────────────────────────

export function uniformPrior(): Record<Verdict, number> {
  return {
    PASS: 0.2,
    "SPEC-COMPLETE": 0.2,
    "NEEDS-RUNTIME": 0.2,
    INCONCLUSIVE: 0.2,
    FAIL: 0.2,
  };
}

// ─── updatePosterior ──────────────────────────────────────────────────────────

/**
 * Bayes-update a posterior over Verdict given one observation.
 *
 * Precondition:  reliability ∈ [0, 1]. Callers must clamp before invoking.
 * Postcondition: returned posterior[v] ∈ [0, 1] for every v.
 * Postcondition: sum(posterior[v]) = 1 (within fp tolerance).
 *
 * source: dijkstra cross-audit C1 (2026-04).
 */
export function updatePosterior(
  prior: Record<Verdict, number>,
  observed: Verdict,
  reliability: number,
): Record<Verdict, number> {
  const r = clampUnit(reliability);
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

// ─── pickMaxVerdict ───────────────────────────────────────────────────────────

export function pickMaxVerdict(d: Record<Verdict, number>): Verdict {
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

// ─── bayesian ─────────────────────────────────────────────────────────────────

/**
 * Bayesian consensus aggregation.
 *
 * Precondition:  verdicts is non-empty.
 * Postcondition: ConsensusVerdict with distribution summing to 1 (fp tolerance).
 *
 * source: docs/PHASE_4_PLAN.md §4.1; Wave D2 — ConsensusReliabilityProvider port.
 */
export function bayesian(
  claim_id: string,
  verdicts: readonly JudgeVerdict[],
  config: ConsensusConfig,
): ConsensusVerdict {
  let posterior = uniformPrior();
  const reliabilityMap = config.reliability ?? new Map<string, number>();

  for (const v of verdicts) {
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
    const reliability = clampUnit(rawReliability);
    const confidence = clampUnit(v.confidence);
    const adjustedReliability = reliability * confidence;
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
