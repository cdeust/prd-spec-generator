import { z } from "zod";

/**
 * Thinking strategies — ported from ThinkingStrategy.swift.
 * Organized into 4 tiers by research-backed effectiveness.
 * Tier assignments come from ResearchEvidenceDatabase (MIT, Stanford, etc.).
 */
export const ThinkingStrategySchema = z.enum([
  // Core reasoning strategies
  "chain_of_thought",
  "tree_of_thoughts",
  "graph_of_thoughts",
  "react",
  "reflexion",
  "plan_and_solve",
  "verified_reasoning",
  "recursive_refinement",
  "problem_analysis",
  // Prompting strategies
  "zero_shot",
  "few_shot",
  "self_consistency",
  "generate_knowledge",
  "prompt_chaining",
  "multimodal_cot",
  "meta_prompting",
]);

export type ThinkingStrategy = z.infer<typeof ThinkingStrategySchema>;

export type StrategyTier = 1 | 2 | 3 | 4;

export interface StrategyTierConfig {
  readonly selectionWeight: number;
  readonly strategies: readonly ThinkingStrategy[];
}

/**
 * Strategy tier assignments — from ResearchEvidenceDatabase.
 * Tier weights (3.0/2.0/1.0/0.3) are ASSUMED (Wu audit finding #1).
 * These should be validated against PRD generation benchmarks.
 */
export const STRATEGY_TIERS: Record<StrategyTier, StrategyTierConfig> = {
  1: {
    selectionWeight: 3.0,
    strategies: [
      "recursive_refinement",
      "verified_reasoning",
      "self_consistency",
      "graph_of_thoughts",
    ],
  },
  2: {
    selectionWeight: 2.0,
    strategies: [
      "tree_of_thoughts",
      "react",
      "reflexion",
      "problem_analysis",
    ],
  },
  3: {
    selectionWeight: 1.0,
    strategies: [
      "few_shot",
      "meta_prompting",
      "plan_and_solve",
      "generate_knowledge",
    ],
  },
  4: {
    selectionWeight: 0.3,
    strategies: [
      "zero_shot",
      "chain_of_thought",
      "prompt_chaining",
      "multimodal_cot",
    ],
  },
} as const;

export function getStrategyTier(strategy: ThinkingStrategy): StrategyTier {
  for (const [tier, config] of Object.entries(STRATEGY_TIERS)) {
    if (config.strategies.includes(strategy)) {
      return Number(tier) as StrategyTier;
    }
  }
  return 4; // default to lowest tier
}
