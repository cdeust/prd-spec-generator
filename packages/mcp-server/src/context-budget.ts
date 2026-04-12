import { PRD_CONTEXT_CONFIGS, type PRDContext, type SectionType } from "@prd-gen/core";

/**
 * Context budget coordinator — Beer's missing S2.
 *
 * Prevents token oscillation between Cortex retrieval and PRD generation.
 * Takes PRD context type + current pipeline state, returns token allocations
 * per phase so Claude knows how many results to request from Cortex.
 *
 * Based on Cortex paper's 3-phase budget split (60/30/10) adapted for
 * PRD generation where the phases are: retrieval / generation / validation.
 */

// ─── Section Token Requirements ──────────────────────────────────────────────

/**
 * Estimated token requirements per section type for generation.
 * Based on production PRD output analysis (SnippetLibraryCRUD example).
 */
const SECTION_GENERATION_TOKENS: Partial<Record<SectionType, number>> = {
  overview: 1500,
  goals: 1000,
  requirements: 3000,
  user_stories: 4000,
  technical_specification: 5000,
  acceptance_criteria: 2500,
  data_model: 2000,
  api_specification: 2500,
  security_considerations: 1500,
  performance_requirements: 1500,
  testing: 4000,
  deployment: 2000,
  risks: 1500,
  timeline: 2500,
};

/**
 * Retrieval relevance weight per section type.
 * Higher = needs more codebase context from Cortex.
 * Technical spec and data model need the most; overview needs the least.
 */
const SECTION_RETRIEVAL_WEIGHT: Partial<Record<SectionType, number>> = {
  overview: 0.2,
  goals: 0.3,
  requirements: 0.6,
  user_stories: 0.5,
  technical_specification: 1.0,
  acceptance_criteria: 0.5,
  data_model: 0.9,
  api_specification: 0.8,
  security_considerations: 0.7,
  performance_requirements: 0.6,
  testing: 0.8,
  deployment: 0.5,
  risks: 0.4,
  timeline: 0.3,
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ContextBudgetAllocation {
  /** Total tokens available for this PRD generation */
  totalBudget: number;
  /** Per-section breakdown */
  sections: SectionBudget[];
  /** Cortex recall parameters */
  cortexRecall: {
    /** Max results per section recall */
    maxResultsPerSection: Record<string, number>;
    /** Estimated tokens per Cortex memory */
    tokensPerMemory: number;
    /** Total retrieval token budget */
    totalRetrievalBudget: number;
  };
  /** Budget reserved for validation + retries */
  validationReserve: number;
  /** Budget consumed by SKILL.md + conversation so far */
  overheadEstimate: number;
}

export interface SectionBudget {
  sectionType: string;
  retrievalTokens: number;
  generationTokens: number;
  cortexMaxResults: number;
}

// ─── Budget Calculation ──────────────────────────────────────────────────────

const DEFAULT_CONTEXT_WINDOW = 200_000; // Claude's context window
const SKILL_MD_OVERHEAD = 35_000; // SKILL.md ~103K chars ≈ 35K tokens
const CONVERSATION_OVERHEAD = 5_000; // Clarification history
const VALIDATION_RESERVE_RATIO = 0.10; // 10% for validation + retries
const TOKENS_PER_CORTEX_MEMORY = 500; // Average memory size

export function calculateContextBudget(
  prdContext: PRDContext,
  completedSections: string[] = [],
  contextWindowSize: number = DEFAULT_CONTEXT_WINDOW,
): ContextBudgetAllocation {
  const config = PRD_CONTEXT_CONFIGS[prdContext];

  // Available budget after overhead
  const overheadEstimate = SKILL_MD_OVERHEAD + CONVERSATION_OVERHEAD;
  const validationReserve = Math.floor(contextWindowSize * VALIDATION_RESERVE_RATIO);
  const totalBudget = contextWindowSize - overheadEstimate - validationReserve;

  // Determine which sections still need generation
  const completedSet = new Set(completedSections);
  const allSections = Object.keys(SECTION_GENERATION_TOKENS) as SectionType[];
  const remainingSections = allSections.filter((s) => !completedSet.has(s));

  // Budget split: 40% retrieval, 50% generation, 10% validation
  const retrievalBudget = Math.floor(totalBudget * 0.40);
  const generationBudget = Math.floor(totalBudget * 0.50);

  // Distribute retrieval budget by section weight
  const totalWeight = remainingSections.reduce(
    (sum, s) => sum + (SECTION_RETRIEVAL_WEIGHT[s] ?? 0.5),
    0,
  );

  const sections: SectionBudget[] = remainingSections.map((sectionType) => {
    const weight = SECTION_RETRIEVAL_WEIGHT[sectionType] ?? 0.5;
    const genTokens = SECTION_GENERATION_TOKENS[sectionType] ?? 2000;
    const retrievalTokens = Math.floor(
      retrievalBudget * (weight / totalWeight),
    );
    const cortexMaxResults = Math.max(
      1,
      Math.floor(retrievalTokens / TOKENS_PER_CORTEX_MEMORY),
    );

    return {
      sectionType,
      retrievalTokens,
      generationTokens: genTokens,
      cortexMaxResults,
    };
  });

  // Build the max_results lookup
  const maxResultsPerSection: Record<string, number> = {};
  for (const s of sections) {
    maxResultsPerSection[s.sectionType] = s.cortexMaxResults;
  }

  return {
    totalBudget,
    sections,
    cortexRecall: {
      maxResultsPerSection,
      tokensPerMemory: TOKENS_PER_CORTEX_MEMORY,
      totalRetrievalBudget: retrievalBudget,
    },
    validationReserve,
    overheadEstimate,
  };
}

// ─── Section-Specific Cortex Query Templates ─────────────────────────────────

/**
 * Maps section type to the Cortex recall query pattern.
 * Alexander's P2: Section-Adaptive Retrieval.
 *
 * Claude fills in {feature} from the user's request.
 */
export const SECTION_RECALL_TEMPLATES: Partial<Record<SectionType, string>> = {
  requirements:
    "public API surfaces exports interfaces contracts for {feature}",
  user_stories:
    "user workflows interaction patterns use cases for {feature}",
  technical_specification:
    "architecture patterns module structure dependencies composition for {feature}",
  data_model:
    "database schema tables relationships migrations data types for {feature}",
  api_specification:
    "REST GraphQL endpoints routes handlers middleware for {feature}",
  security_considerations:
    "authentication authorization encryption secrets validation for {feature}",
  performance_requirements:
    "latency throughput caching optimization benchmarks for {feature}",
  testing:
    "test patterns fixtures assertions coverage test utilities for {feature}",
  deployment:
    "deployment configuration environment infrastructure CI/CD for {feature}",
  risks:
    "error handling edge cases failure modes recovery fallback for {feature}",
  timeline:
    "complexity dependencies blocked-by implementation order for {feature}",
  overview:
    "project purpose architecture overview high-level design for {feature}",
  goals:
    "objectives success metrics KPIs business value for {feature}",
  acceptance_criteria:
    "acceptance criteria validation rules business rules for {feature}",
};
