import { z } from "zod";
import type { ThinkingStrategy } from "./thinking-strategy.js";
import type { PRDContext } from "./prd-context.js";

export const LicenseTierSchema = z.enum(["free", "trial", "licensed"]);

export type LicenseTier = z.infer<typeof LicenseTierSchema>;

export interface TierCapabilities {
  readonly maxStrategies: number;
  readonly allowedStrategies: readonly ThinkingStrategy[];
  readonly maxClarificationRounds: number;
  readonly allowedContextTypes: readonly PRDContext[];
  readonly maxSections: number;
  readonly ragHopsOverride: number | null;
  readonly verificationLevel: "basic" | "full";
}

/**
 * License tier capabilities — from skill-config.json.
 * Free tier is intentionally limited to drive upgrades.
 */
export const TIER_CAPABILITIES: Record<LicenseTier, TierCapabilities> = {
  free: {
    maxStrategies: 2,
    allowedStrategies: ["zero_shot", "chain_of_thought"],
    maxClarificationRounds: 3,
    allowedContextTypes: ["feature", "bug"],
    maxSections: 6,
    ragHopsOverride: 1,
    verificationLevel: "basic",
  },
  trial: {
    // source: matches allowedStrategies.length below. Previously declared as
    // 17 by mistake (Darwin difficulty-book pass-2, 2026-04).
    maxStrategies: 16,
    allowedStrategies: [
      "chain_of_thought", "tree_of_thoughts", "graph_of_thoughts",
      "react", "reflexion", "plan_and_solve", "verified_reasoning",
      "recursive_refinement", "problem_analysis", "zero_shot",
      "few_shot", "self_consistency", "generate_knowledge",
      "prompt_chaining", "multimodal_cot", "meta_prompting",
    ],
    maxClarificationRounds: Infinity,
    allowedContextTypes: [
      "proposal", "feature", "bug", "incident", "poc", "mvp", "release", "cicd",
    ],
    maxSections: 11,
    ragHopsOverride: null,
    verificationLevel: "full",
  },
  licensed: {
    // source: matches allowedStrategies.length below.
    maxStrategies: 16,
    allowedStrategies: [
      "chain_of_thought", "tree_of_thoughts", "graph_of_thoughts",
      "react", "reflexion", "plan_and_solve", "verified_reasoning",
      "recursive_refinement", "problem_analysis", "zero_shot",
      "few_shot", "self_consistency", "generate_knowledge",
      "prompt_chaining", "multimodal_cot", "meta_prompting",
    ],
    maxClarificationRounds: Infinity,
    allowedContextTypes: [
      "proposal", "feature", "bug", "incident", "poc", "mvp", "release", "cicd",
    ],
    maxSections: 11,
    ragHopsOverride: null,
    verificationLevel: "full",
  },
} as const;
