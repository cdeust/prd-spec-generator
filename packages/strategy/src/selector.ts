import type { ThinkingStrategy, LicenseTier, StrategyTier } from "@prd-gen/core";
import { TIER_CAPABILITIES, STRATEGY_TIERS } from "@prd-gen/core";
import type { EvidenceRepository } from "@prd-gen/core";
import { ResearchEvidenceDatabase } from "./research-evidence-database.js";
import { analyzeClaim, type ClaimAnalysisResult } from "./claim-analyzer.js";

/**
 * Strategy selection -- ported from ResearchWeightedSelector.swift.
 * Selects optimal strategy based on research evidence + historical feedback.
 *
 * The closed feedback loop (fixes Deming finding):
 * 1. Base score from ResearchEvidenceDatabase
 * 2. Historical adjustment from SQLite evidence repository
 * 3. Formula: score = researchBaseScore * (1 + historicalAdjustment)
 *    where adjustment is bounded [-0.3, +0.3]
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface StrategyAssignment {
  readonly required: ThinkingStrategy[];
  readonly optional: ThinkingStrategy[];
  readonly forbidden: ThinkingStrategy[];
  readonly expectedImprovement: number;
  readonly assignmentConfidence: number;
  readonly claimAnalysis: ClaimAnalysisResult;
  readonly researchCitations: readonly string[];
}

interface ScoredStrategy {
  readonly strategy: ThinkingStrategy;
  readonly score: number;
  readonly tier: StrategyTier;
  readonly improvement: number;
  readonly overlapCount: number;
}

export interface SelectorOptions {
  readonly claim: string;
  readonly context?: string;
  readonly licenseTier: LicenseTier;
  readonly hasCodebase?: boolean;
  readonly hasMockups?: boolean;
  readonly evidenceRepository?: EvidenceRepository;
  readonly overlapWeight?: number;
  readonly minimumImprovementThreshold?: number;
  readonly maxRequiredStrategies?: number;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

const db = new ResearchEvidenceDatabase();

function scoreStrategies(
  characteristics: ReadonlySet<string>,
  historicalAdjustments: Map<ThinkingStrategy, number>,
  overlapWeight: number,
  minimumThreshold: number,
): ScoredStrategy[] {
  const allStrategies = db.getAllStrategies();

  const scored: ScoredStrategy[] = [];
  for (const strategy of allStrategies) {
    const tier = db.getTier(strategy);
    if (tier === undefined) continue;

    const evidence = db.getEvidence(strategy);
    if (evidence.length === 0) continue;

    let totalOverlap = 0;
    let weightedImprovement = 0.0;

    for (const ev of evidence) {
      const evChars = new Set(ev.claimCharacteristics);
      let overlap = 0;
      for (const c of characteristics) {
        if (evChars.has(c)) overlap++;
      }
      totalOverlap += overlap;

      const overlapRatio = overlap / Math.max(1, ev.claimCharacteristics.length);
      weightedImprovement +=
        ev.improvementPercent * (overlapWeight * overlapRatio + (1 - overlapWeight));
    }

    const avgImprovement = weightedImprovement / evidence.length;

    // Skip if below threshold (unless tier 1)
    if (avgImprovement < minimumThreshold && tier !== 1) continue;

    // Base score: tier weight * improvement * overlap factor
    const overlapFactor = 1.0 + (totalOverlap / Math.max(1, characteristics.size));
    let score =
      STRATEGY_TIERS[tier].selectionWeight * avgImprovement * overlapFactor;

    // Apply historical adjustment (closed feedback loop)
    const adjustment = historicalAdjustments.get(strategy) ?? 0;
    const clampedAdjustment = Math.max(-0.3, Math.min(0.3, adjustment));
    score = score * (1 + clampedAdjustment);

    scored.push({ strategy, score, tier, improvement: avgImprovement, overlapCount: totalOverlap });
  }

  // Sort: tier ascending first, then score descending
  return scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    return b.score - a.score;
  });
}

// ── Complexity Constraints ──────────────────────────────────────────────────

function applyComplexityConstraints(
  strategies: ScoredStrategy[],
  complexityTier: "simple" | "moderate" | "complex",
): ScoredStrategy[] {
  const maxAllowedTier: StrategyTier =
    complexityTier === "complex" ? 2 :
    complexityTier === "moderate" ? 3 : 4;

  return strategies.filter((s) => s.tier <= maxAllowedTier);
}

// ── Selection ───────────────────────────────────────────────────────────────

function selectRequired(
  strategies: ScoredStrategy[],
  analysis: ClaimAnalysisResult,
  maxRequired: number,
): ThinkingStrategy[] {
  const required: ThinkingStrategy[] = [];

  // Complex claims MUST have at least one Tier 1 strategy
  if (analysis.complexityTier === "complex") {
    const tier1 = strategies.find((s) => s.tier === 1);
    if (tier1) required.push(tier1.strategy);
  }

  // Add highest-scoring strategy if not already added
  const best = strategies[0];
  if (best && !required.includes(best.strategy)) {
    required.push(best.strategy);
  }

  // High-precision claims: add verified_reasoning
  if (
    analysis.characteristics.has("accuracy_critical") ||
    analysis.characteristics.has("high_precision")
  ) {
    if (!required.includes("verified_reasoning")) {
      required.push("verified_reasoning");
    }
  }

  // Codebase integration: add react
  if (analysis.characteristics.has("codebase_integration")) {
    if (!required.includes("react") && !required.includes("verified_reasoning")) {
      required.push("react");
    }
  }

  return required.slice(0, maxRequired);
}

function selectOptional(
  strategies: ScoredStrategy[],
  required: ThinkingStrategy[],
): ThinkingStrategy[] {
  const reqSet = new Set(required);
  return strategies
    .filter((s) => !reqSet.has(s.strategy) && s.tier <= 3)
    .slice(0, 3)
    .map((s) => s.strategy);
}

function selectForbidden(
  complexityTier: "simple" | "moderate" | "complex",
): ThinkingStrategy[] {
  switch (complexityTier) {
    case "complex":
      return ["zero_shot", "chain_of_thought"];
    case "moderate":
      return ["zero_shot"];
    case "simple":
      return [];
  }
}

// ── Citations & Metrics ─────────────────────────────────────────────────────

function buildCitations(strategies: ThinkingStrategy[]): string[] {
  const citations: string[] = [];
  for (const strategy of strategies) {
    const evidence = db.getEvidence(strategy);
    for (const ev of evidence.slice(0, 2)) {
      citations.push(ev.citation);
    }
  }
  return citations;
}

function calculateExpectedImprovement(
  strategies: ThinkingStrategy[],
  characteristics: ReadonlySet<string>,
): number {
  if (strategies.length === 0) return 0.0;

  const improvements = strategies.map((s) =>
    db.calculateScore(s, characteristics),
  );
  return Math.max(...improvements);
}

function calculateAssignmentConfidence(
  strategies: ThinkingStrategy[],
  characteristics: ReadonlySet<string>,
  complexityTier: "simple" | "moderate" | "complex",
): number {
  let confidence = 0.5;

  if (complexityTier === "complex") {
    const hasTier1 = strategies.some((s) => db.getTier(s) === 1);
    if (hasTier1) confidence += 0.3;
  }

  let totalOverlap = 0;
  for (const strategy of strategies) {
    for (const ev of db.getEvidence(strategy)) {
      const evChars = new Set(ev.claimCharacteristics);
      for (const c of characteristics) {
        if (evChars.has(c)) totalOverlap++;
      }
    }
  }
  confidence += Math.min(0.2, totalOverlap * 0.02);

  return Math.min(1.0, confidence);
}

// ── Public API ──────────────────────────────────────────────────────────────

export function selectStrategy(options: SelectorOptions): StrategyAssignment {
  const {
    claim,
    context,
    licenseTier,
    hasCodebase = false,
    hasMockups = false,
    evidenceRepository,
    overlapWeight = 0.6,
    minimumImprovementThreshold = 0.05,
    maxRequiredStrategies = 3,
  } = options;

  // Step 1: Analyze claim characteristics
  const analysis = analyzeClaim(claim, context);
  const characteristics = new Set(analysis.characteristics);

  // Enrich with context flags
  if (hasCodebase) {
    characteristics.add("codebase_integration");
    characteristics.add("tool_use");
  }
  if (hasMockups) {
    characteristics.add("visual_reasoning");
    characteristics.add("multimodal");
  }

  // Free tier: degraded assignment
  const capabilities = TIER_CAPABILITIES[licenseTier];
  if (licenseTier === "free") {
    return {
      required: ["chain_of_thought"],
      optional: [],
      forbidden: [],
      expectedImprovement: 0,
      assignmentConfidence: 0.3,
      claimAnalysis: { ...analysis, characteristics },
      researchCitations: [],
    };
  }

  // Step 2: Get historical adjustments (closed feedback loop)
  let historicalAdjustments = new Map<ThinkingStrategy, number>();
  if (evidenceRepository) {
    historicalAdjustments = evidenceRepository.getHistoricalAdjustments();
  }

  // Step 3: Score all strategies
  const scored = scoreStrategies(
    characteristics,
    historicalAdjustments,
    overlapWeight,
    minimumImprovementThreshold,
  );

  // Step 4: Filter by allowed strategies for license tier
  const allowed = new Set(capabilities.allowedStrategies);
  const allowedScored = scored.filter((s) => allowed.has(s.strategy));

  // Step 5: Apply complexity constraints
  const constrained = applyComplexityConstraints(allowedScored, analysis.complexityTier);

  // Step 6: Select required, optional, forbidden
  const enrichedAnalysis: ClaimAnalysisResult = { ...analysis, characteristics };
  const required = selectRequired(constrained, enrichedAnalysis, maxRequiredStrategies);
  const optional = selectOptional(constrained, required);
  const forbidden = selectForbidden(analysis.complexityTier);

  // Step 7: Build citations and metrics
  const allSelected = [...required, ...optional];
  const researchCitations = buildCitations(allSelected);
  const expectedImprovement = calculateExpectedImprovement(required, characteristics);
  const assignmentConfidence = calculateAssignmentConfidence(
    required,
    characteristics,
    analysis.complexityTier,
  );

  return {
    required,
    optional,
    forbidden,
    expectedImprovement,
    assignmentConfidence,
    claimAnalysis: enrichedAnalysis,
    researchCitations,
  };
}
