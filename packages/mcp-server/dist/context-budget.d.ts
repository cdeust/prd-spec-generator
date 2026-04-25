import { type PRDContext, type SectionType } from "@prd-gen/core";
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
    /**
     * Total generation token budget (sum across remaining sections).
     * Distinct from per-section generation tokens in `sections[i].generationTokens`.
     */
    generationBudget: number;
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
export declare function calculateContextBudget(prdContext: PRDContext, completedSections?: string[], contextWindowSize?: number): ContextBudgetAllocation;
/**
 * Maps section type to the Cortex recall query pattern.
 *
 * Single source of truth: @prd-gen/orchestration owns the canonical templates
 * because that's the package that actually issues the queries during
 * section_generation. We re-export here so the host can pre-fetch using the
 * SAME templates the orchestrator will later use, preventing host/orchestrator
 * divergence.
 *
 * Claude fills in {feature} from the user's request.
 */
export declare const SECTION_RECALL_TEMPLATES: Record<SectionType, string>;
//# sourceMappingURL=context-budget.d.ts.map