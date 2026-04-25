import { SECTIONS_BY_CONTEXT, SECTION_RECALL_TEMPLATES as ORCHESTRATION_RECALL_TEMPLATES, } from "@prd-gen/orchestration";
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
 *
 * source: provisional heuristic — initial values derived from a single
 * production PRD (SnippetLibraryCRUD, 2026-Q1) by counting tokens in the
 * generated section. Phase 4.5 will recalibrate from a corpus of K≥30
 * real PRD outputs to set per-section P95 (docs/PHASE_4_PLAN.md §4.5). Until
 * then these are upper-bound estimates; the budget is conservative.
 */
const SECTION_GENERATION_TOKENS = {
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
 * Retrieval relevance weight per section type. Higher = needs more codebase
 * context from Cortex. Technical spec and data model need the most; overview
 * needs the least.
 *
 * source: provisional heuristic — assigned by hand (2026-Q1) from
 * structural reasoning about which sections cite code (technical_spec,
 * data_model, api_spec) vs which are stakeholder-facing prose (overview,
 * goals). Phase 4.5 will recalibrate from observed retrieval-quality
 * scores per section against a labelled set.
 */
const SECTION_RETRIEVAL_WEIGHT = {
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
// ─── Budget Calculation ──────────────────────────────────────────────────────
/**
 * source: provisional heuristic. 200_000 is the documented Claude context
 * window for Sonnet/Opus 4.x as of model card 2026-01. If the model is
 * downgraded to a smaller-window variant, callers must override this via
 * the `contextWindowSize` parameter. Phase 4 calibration will replace
 * with model-detection at runtime.
 */
const DEFAULT_CONTEXT_WINDOW = 200_000;
/**
 * source: provisional heuristic. SKILL.md is ~103K chars; at ~3 chars/token
 * for technical English the prompt budget rounds to ~35K. Re-measure when
 * the SKILL.md material changes substantially (Phase 4.5 includes a
 * tokenizer-based audit per release).
 */
const SKILL_MD_OVERHEAD = 35_000;
/**
 * source: provisional heuristic. Average clarification history (8-10
 * rounds × ~500 tokens/round) lands near 5K. Replace with measured
 * `state.clarifications.reduce((s, t) => s + estimateTokens(...))` once
 * the clarification budget audit (Phase 4.4) is in place.
 */
const CONVERSATION_OVERHEAD = 5_000;
/**
 * source: provisional heuristic. 10% reserve covers ≤3 retries per section
 * (MAX_ATTEMPTS=3) at the SECTION_GENERATION_TOKENS scale. Phase 4.2 will
 * recalibrate from the measured pass-rate-by-attempt distribution.
 */
const VALIDATION_RESERVE_RATIO = 0.10;
/**
 * source: provisional heuristic. Average Cortex memory record (in tokens)
 * across observed pipeline runs as of 2026-04 (no benchmark logged yet).
 * Phase 4 will replace with empirical mean from `cortex.recall` payload
 * length distribution.
 */
const TOKENS_PER_CORTEX_MEMORY = 500;
/**
 * source: derived from VALIDATION_RESERVE_RATIO complement. Retrieval +
 * generation share the remaining 90%, split 40/50 by convention from the
 * Cortex paper's 60/30/10 pattern adapted for PRD generation. Phase 4.5
 * will calibrate from pipeline-run telemetry.
 */
const RETRIEVAL_BUDGET_RATIO = 0.40;
const GENERATION_BUDGET_RATIO = 0.50;
/**
 * source: provisional heuristic. Default retrieval weight when a section
 * type is absent from SECTION_RETRIEVAL_WEIGHT (e.g. a new section type
 * not yet calibrated). Mid-range value so unknowns don't starve nor
 * dominate other sections.
 */
const UNKNOWN_SECTION_WEIGHT = 0.5;
/**
 * source: provisional heuristic. Default generation tokens for an unknown
 * section type. Roughly the median of SECTION_GENERATION_TOKENS values.
 */
const UNKNOWN_SECTION_GEN_TOKENS = 2000;
export function calculateContextBudget(prdContext, completedSections = [], contextWindowSize = DEFAULT_CONTEXT_WINDOW) {
    // Available budget after overhead
    const overheadEstimate = SKILL_MD_OVERHEAD + CONVERSATION_OVERHEAD;
    const validationReserve = Math.floor(contextWindowSize * VALIDATION_RESERVE_RATIO);
    const totalBudget = contextWindowSize - overheadEstimate - validationReserve;
    // Determine which sections still need generation. Use the canonical
    // per-context plan (SECTIONS_BY_CONTEXT) so the budget is context-aware:
    // a `proposal` (7 sections) gets a different breakdown than a `feature`
    // (11 sections). Pre-fix, this used Object.keys(SECTION_GENERATION_TOKENS),
    // which made the budget identical across contexts (cross-audit code-reviewer
    // C1, Phase 3+4, 2026-04).
    const completedSet = new Set(completedSections);
    const plannedSections = SECTIONS_BY_CONTEXT[prdContext];
    const remainingSections = plannedSections.filter((s) => !completedSet.has(s));
    const retrievalBudget = Math.floor(totalBudget * RETRIEVAL_BUDGET_RATIO);
    const generationBudget = Math.floor(totalBudget * GENERATION_BUDGET_RATIO);
    // Distribute retrieval budget by section weight
    const totalWeight = remainingSections.reduce((sum, s) => sum + (SECTION_RETRIEVAL_WEIGHT[s] ?? UNKNOWN_SECTION_WEIGHT), 0);
    const sections = remainingSections.map((sectionType) => {
        const weight = SECTION_RETRIEVAL_WEIGHT[sectionType] ?? UNKNOWN_SECTION_WEIGHT;
        const genTokens = SECTION_GENERATION_TOKENS[sectionType] ?? UNKNOWN_SECTION_GEN_TOKENS;
        const retrievalTokens = totalWeight > 0
            ? Math.floor(retrievalBudget * (weight / totalWeight))
            : 0;
        const cortexMaxResults = Math.max(1, Math.floor(retrievalTokens / TOKENS_PER_CORTEX_MEMORY));
        return {
            sectionType,
            retrievalTokens,
            generationTokens: genTokens,
            cortexMaxResults,
        };
    });
    // Build the max_results lookup
    const maxResultsPerSection = {};
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
        generationBudget,
        validationReserve,
        overheadEstimate,
    };
}
// ─── Section-Specific Cortex Query Templates ─────────────────────────────────
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
export const SECTION_RECALL_TEMPLATES = ORCHESTRATION_RECALL_TEMPLATES;
//# sourceMappingURL=context-budget.js.map