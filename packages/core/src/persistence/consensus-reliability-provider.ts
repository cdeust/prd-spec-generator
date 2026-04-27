/**
 * ConsensusReliabilityProvider — port declared by core for the consensus engine.
 *
 * Placement rationale (DIP §1.5 / coding-standards §2.3):
 *   - Core declares the port (this file).
 *   - Benchmark implements the adapter (BenchmarkConsensusReliabilityProvider).
 *   - Verification consumes the port only — never benchmark.
 *
 * Layer rule (§2.2):
 *   verification → core (this interface)   ✓ inward dependency
 *   verification → benchmark               ✗ FORBIDDEN
 *
 * Null contract (cold-start / control-arm):
 *   getReliabilityForRun returning null means "no calibrated posterior for this
 *   cell." Callers MUST fall back to DEFAULT_RELIABILITY_PRIOR (Beta(7,3)).
 *   The provider does NOT embed fallback policy — that lives in consensus.ts.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 — "Wiring into consensus.ts is Wave D scope."
 * source: coding-standards §1.5 (DIP), §2.3 (Ports and Adapters).
 */

import type { AgentIdentity } from "../index.js";
import type { Claim } from "../domain/agent.js";
import type { JudgeReliabilityRecord, VerdictDirection } from "./reliability-repository.js";

/**
 * Port for per-(judge × claim_type × verdict_direction) reliability lookup.
 *
 * Consumed by the consensus engine in @prd-gen/verification.
 * Implemented by BenchmarkConsensusReliabilityProvider in @prd-gen/benchmark.
 *
 * Precondition (per call):
 *   - runId is a non-empty string identifying the current pipeline run.
 *   - judge, claimType, direction are valid values matching the domain types.
 * Postcondition:
 *   - Returns null when: (a) the run is in the CC-3 control arm, OR
 *     (b) no calibrated posterior exists for this (judge × claim_type × direction) cell.
 *   - Returns a JudgeReliabilityRecord when a calibrated posterior exists and
 *     the run is in the treatment arm.
 * Invariant: this method is pure-read; it must NOT modify persistent state.
 */
export interface ConsensusReliabilityProvider {
  /**
   * Look up the calibrated Beta posterior for (judge, claimType, direction)
   * for a given run. Returns null when:
   *   - The run is in the CC-3 control arm (forced exploration — returns prior).
   *   - No calibrated posterior exists for this cell (cold start).
   * Callers MUST treat null as "fall back to DEFAULT_RELIABILITY_PRIOR".
   */
  getReliabilityForRun(
    runId: string,
    judge: AgentIdentity,
    claimType: Claim["claim_type"],
    direction: VerdictDirection,
  ): JudgeReliabilityRecord | null;
}
