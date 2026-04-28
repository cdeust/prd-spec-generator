/**
 * `buildConcludeOpts` — extracted from pipeline-tools.ts in the Wave D
 * code-reviewer remediation (2026-04-28) to keep pipeline-tools.ts under
 * the §4.1 500-LOC cap.
 *
 * Encapsulates four concerns of the `conclude_verification` MCP tool's
 * call-site preparation:
 *
 *   1. Reliability-repo lookup + provider hookup (D2 wiring).
 *   2. Curie A3 loud-warn when `claim_types` is omitted (one-sided
 *      censoring guard).
 *   3. CC-3 observation flusher (B4 control-arm write semantics, B5
 *      claim_id threading, annotator-circularity ground-truth path).
 *   4. ConsensusConfig wiring (strategy, runId, claimTypes).
 *
 * source: Wave D code-reviewer extraction; coding-standards.md §4.1.
 */
import type { Claim } from "@prd-gen/core";
import { type ConcludeOptions } from "@prd-gen/verification";
export interface BuildConcludeOptsInput {
    readonly consensus_strategy: ConcludeOptions["strategy"];
    readonly run_id?: string;
    readonly claim_types?: Record<string, string>;
    /**
     * OPTIONAL. Pass the Claim objects from the corresponding
     * plan_section_verification / plan_document_verification response if you want
     * oracle-based ground truth (breaks Curie A2 annotator-circularity for
     * grounded claims). Claims that carry `external_grounding` will have their
     * truth resolved by the appropriate oracle; claims without it fall back to
     * consensus-majority (back-compat preserved).
     *
     * Precondition: each Claim in the map is keyed by its claim_id.
     * Postcondition: the returned ConcludeOptions.claims is populated, enabling
     *   the orchestrator's concludeFromVerdicts to propagate external_grounding
     *   into ClaimObservationFlushed events and thence into the oracle pipeline.
     *
     * source: Curie A2.3, PHASE_4_PLAN.md §4.1 Wave F closure; Wave D A7 /
     *   Wave E A2.3 triple-pattern (type-level seam → orchestrator propagation →
     *   MCP-tool-API parameter). This field closes the MCP-tool-API leg.
     */
    readonly claims?: ReadonlyMap<string, Claim>;
}
export declare function buildConcludeOpts(input: BuildConcludeOptsInput): ConcludeOptions;
//# sourceMappingURL=build-conclude-opts.d.ts.map