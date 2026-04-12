import type { ThinkingStrategy, StrategyTier } from "@prd-gen/core";
import { STRATEGY_TIERS, getStrategyTier } from "@prd-gen/core";

/**
 * Research evidence for strategy selection -- ported from ResearchEvidenceDatabase.swift.
 * Each entry maps a strategy to its research-backed effectiveness data.
 *
 * WARNING (Wu audit finding #2): All benchmarks are from math/code tasks
 * (MATH-500, GSM8K, HumanEval, etc.), NOT from PRD generation.
 * Transferability to PRD generation is UNTESTED.
 *
 * Sources: MIT, Stanford, Harvard, ETH Zurich, Princeton, Google, Anthropic,
 * OpenAI, DeepSeek (2023-2025)
 */
export interface ResearchEvidence {
  readonly strategy: ThinkingStrategy;
  readonly tier: StrategyTier;
  readonly improvementPercent: number;
  readonly claimCharacteristics: readonly string[];
  readonly source: string;
  readonly citation: string;
}

// ── Tier 1: Most Effective ──────────────────────────────────────────────────

const TIER_1_EVIDENCE: readonly ResearchEvidence[] = [
  {
    strategy: "recursive_refinement",
    tier: 1,
    improvementPercent: 0.32,
    claimCharacteristics: [
      "mathematical_reasoning", "multi_step_logic", "complex_technical",
      "iterative_refinement", "high_precision",
    ],
    source: "DeepSeek (2025) — DeepSeek-R1: Incentivizing Reasoning Capability in LLMs",
    citation: "arXiv:2501.12948",
  },
  {
    strategy: "recursive_refinement",
    tier: 1,
    improvementPercent: 0.74,
    claimCharacteristics: [
      "mathematical_reasoning", "multi_step_logic", "self_correction", "high_precision",
    ],
    source: "OpenAI (2024) — Learning to Reason with LLMs",
    citation: "OpenAI technical report (non-peer-reviewed)",
  },
  {
    strategy: "verified_reasoning",
    tier: 1,
    improvementPercent: 0.18,
    claimCharacteristics: [
      "accuracy_critical", "fact_verification", "consistency_check", "high_precision",
    ],
    source: "Stanford/Anthropic (2024) — Chain-of-Verification Reduces Hallucination in LLMs",
    citation: "Stanford/Anthropic 2024",
  },
  {
    strategy: "graph_of_thoughts",
    tier: 1,
    improvementPercent: 0.62,
    claimCharacteristics: [
      "dependency_analysis", "cross_reference", "structural_reasoning", "complex_technical",
    ],
    source: "ETH Zurich (2024) — Graph of Thoughts: Solving Elaborate Problems with LLMs",
    citation: "arXiv:2308.09687",
  },
  {
    strategy: "self_consistency",
    tier: 1,
    improvementPercent: 0.179,
    claimCharacteristics: [
      "mathematical_reasoning", "multiple_approaches", "consistency_check",
      "uncertainty_handling",
    ],
    source: "Google Research (2023) — Self-Consistency Improves Chain of Thought Reasoning",
    citation: "arXiv:2203.11171",
  },
  {
    strategy: "reflexion",
    tier: 1,
    improvementPercent: 0.21,
    claimCharacteristics: [
      "iterative_refinement", "self_correction", "quality_improvement", "code_generation",
    ],
    source: "MIT/Northeastern (2023) — Reflexion: Language Agents with Verbal Reinforcement Learning",
    citation: "arXiv:2303.11366",
  },
  {
    strategy: "problem_analysis",
    tier: 1,
    improvementPercent: 0.24,
    claimCharacteristics: [
      "complex_technical", "multi_dimensional", "structural_reasoning", "risk_analysis",
    ],
    source: "Harvard/MIT (2024) — Structured Decomposition Outperforms Linear Reasoning",
    citation: "Harvard/MIT 2024",
  },
];

// ── Tier 2: Effective with Context ──────────────────────────────────────────

const TIER_2_EVIDENCE: readonly ResearchEvidence[] = [
  {
    strategy: "tree_of_thoughts",
    tier: 2,
    improvementPercent: 0.74,
    claimCharacteristics: [
      "exploratory_reasoning", "multiple_approaches", "creative_problems",
      "branch_exploration",
    ],
    source: "Princeton/Google DeepMind (2024) — Tree of Thoughts: Deliberate Problem Solving with LLMs",
    citation: "arXiv:2305.10601",
  },
  {
    strategy: "react",
    tier: 2,
    improvementPercent: 0.27,
    claimCharacteristics: [
      "codebase_integration", "tool_use", "external_knowledge", "cross_reference",
    ],
    source: "Princeton/Google (2023) — ReAct: Synergizing Reasoning and Acting in Language Models",
    citation: "arXiv:2210.03629",
  },
  {
    strategy: "meta_prompting",
    tier: 2,
    improvementPercent: 0.171,
    claimCharacteristics: [
      "complex_technical", "multi_step_logic", "role_based_reasoning",
      "expert_orchestration",
    ],
    source: "Stanford (2024) — Meta-Prompting: Enhancing Language Models with Task-Agnostic Scaffolding",
    citation: "Stanford 2024",
  },
  {
    strategy: "plan_and_solve",
    tier: 2,
    improvementPercent: 0.058,
    claimCharacteristics: [
      "multi_step_logic", "sequential_planning", "structural_reasoning",
    ],
    source: "NUS (2023) — Plan-and-Solve Prompting: Improving Zero-Shot CoT",
    citation: "arXiv:2305.04091",
  },
];

// ── Tier 3: Specialized Use Cases ───────────────────────────────────────────

const TIER_3_EVIDENCE: readonly ResearchEvidence[] = [
  {
    strategy: "few_shot",
    tier: 3,
    improvementPercent: 0.25,
    claimCharacteristics: [
      "pattern_matching", "domain_specific", "example_based",
    ],
    source: "OpenAI (2020) — Language Models are Few-Shot Learners",
    citation: "arXiv:2005.14165",
  },
  {
    strategy: "generate_knowledge",
    tier: 3,
    improvementPercent: 0.15,
    claimCharacteristics: [
      "domain_knowledge", "fact_generation", "commonsense_reasoning",
    ],
    source: "AI2 (2022) — Generated Knowledge Prompting for Commonsense Reasoning",
    citation: "arXiv:2110.08387",
  },
  {
    strategy: "multimodal_cot",
    tier: 3,
    improvementPercent: 0.16,
    claimCharacteristics: [
      "visual_reasoning", "multimodal", "diagram_analysis",
    ],
    source: "Amazon/UCLA (2023) — Multimodal Chain-of-Thought Reasoning",
    citation: "arXiv:2302.00923",
  },
];

// ── Tier 4: Basic (Free Tier) ───────────────────────────────────────────────

const TIER_4_EVIDENCE: readonly ResearchEvidence[] = [
  {
    strategy: "chain_of_thought",
    tier: 4,
    improvementPercent: 0.0,
    claimCharacteristics: ["basic_reasoning"],
    source: "Google/DeepMind (2024) — Chain-of-Thought Reasoning Without Prompting",
    citation: "arXiv:2402.10200",
  },
  {
    strategy: "zero_shot",
    tier: 4,
    improvementPercent: 0.0,
    claimCharacteristics: [],
    source: "Various (2023) — Baseline comparison meta-analysis",
    citation: "Various 2023",
  },
];

// ── Database ────────────────────────────────────────────────────────────────

const ALL_EVIDENCE: readonly ResearchEvidence[] = [
  ...TIER_1_EVIDENCE,
  ...TIER_2_EVIDENCE,
  ...TIER_3_EVIDENCE,
  ...TIER_4_EVIDENCE,
];

export class ResearchEvidenceDatabase {
  private readonly evidence: readonly ResearchEvidence[] = ALL_EVIDENCE;

  getEvidence(strategy: ThinkingStrategy): ResearchEvidence[] {
    return this.evidence.filter((e) => e.strategy === strategy);
  }

  getBestEvidence(strategy: ThinkingStrategy): ResearchEvidence | undefined {
    return this.getEvidence(strategy)
      .sort((a, b) => b.improvementPercent - a.improvementPercent)[0];
  }

  getTier(strategy: ThinkingStrategy): StrategyTier | undefined {
    const first = this.evidence.find((e) => e.strategy === strategy);
    return first?.tier;
  }

  getStrategiesInTier(tier: StrategyTier): ThinkingStrategy[] {
    const seen = new Set<ThinkingStrategy>();
    for (const e of this.evidence) {
      if (e.tier === tier) seen.add(e.strategy);
    }
    return [...seen];
  }

  getMatchingStrategies(
    characteristics: readonly string[],
  ): ResearchEvidence[] {
    const charSet = new Set(characteristics);
    return this.evidence
      .filter((e) =>
        e.claimCharacteristics.some((c) => charSet.has(c)),
      )
      .sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        return b.improvementPercent - a.improvementPercent;
      });
  }

  calculateScore(
    strategy: ThinkingStrategy,
    characteristics: ReadonlySet<string>,
  ): number {
    const matching = this.getEvidence(strategy);
    if (matching.length === 0) return 0.0;

    let totalScore = 0.0;
    for (const ev of matching) {
      const evChars = new Set(ev.claimCharacteristics);
      let overlap = 0;
      for (const c of characteristics) {
        if (evChars.has(c)) overlap++;
      }
      const overlapRatio = overlap / Math.max(1, ev.claimCharacteristics.length);
      const tierWeight = STRATEGY_TIERS[ev.tier].selectionWeight;
      totalScore += ev.improvementPercent * tierWeight * (0.5 + 0.5 * overlapRatio);
    }

    return totalScore / matching.length;
  }

  getCitations(strategy: ThinkingStrategy): string[] {
    return this.getEvidence(strategy).map((e) => e.citation);
  }

  getAllStrategies(): ThinkingStrategy[] {
    const seen = new Set<ThinkingStrategy>();
    for (const e of this.evidence) {
      seen.add(e.strategy);
    }
    return [...seen];
  }

  getAllEvidence(): readonly ResearchEvidence[] {
    return this.evidence;
  }
}
