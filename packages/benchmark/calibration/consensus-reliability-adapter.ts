/**
 * BenchmarkConsensusReliabilityProvider — adapter implementing the
 * ConsensusReliabilityProvider port for the benchmark calibration layer.
 *
 * Layer contract (§2.2 / coding-standards):
 *   - Port (ConsensusReliabilityProvider) lives in @prd-gen/core (inner layer).
 *   - This adapter lives in @prd-gen/benchmark (outer layer).
 *   - @prd-gen/verification consumes the port, never this adapter.
 *   - Only the composition root (@prd-gen/mcp-server) imports this adapter
 *     and injects it into ConsensusConfig.reliabilityProvider.
 *
 * DIP (§1.5): core declares the interface; benchmark implements it;
 * the composition root wires them at startup.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 — "Wiring into consensus.ts is Wave D scope."
 * source: CC-3 / B-Popper-1 — getReliabilityForRun is the published seam.
 * source: coding-standards §2.3 (Ports and Adapters).
 */

import type {
  ConsensusReliabilityProvider,
  JudgeReliabilityRecord,
  AgentIdentity,
  VerdictDirection,
} from "@prd-gen/core";
import type { Claim } from "@prd-gen/core";
import { getReliabilityForRun } from "./calibration-seams.js";
import type { ReliabilityRepository } from "@prd-gen/core";

/**
 * Adapter that bridges the ConsensusReliabilityProvider port to the
 * CC-3-aware getReliabilityForRun seam from calibration-seams.ts.
 *
 * The CC-3 control-arm logic (isControlArmRun → return null) is applied
 * inside getReliabilityForRun. This class is a thin delegation wrapper;
 * it does not duplicate control-arm logic.
 *
 * Constructor precondition: repository is a live, opened ReliabilityRepository.
 * Constructor postcondition: this.repo references the same repository instance.
 *
 * getReliabilityForRun postcondition (per ConsensusReliabilityProvider contract):
 *   - Returns null when runId maps to the CC-3 control arm.
 *   - Returns null when no record exists for (judge × claimType × direction).
 *   - Returns the persisted JudgeReliabilityRecord otherwise.
 *   - Does not modify the repository (pure read).
 */
export class BenchmarkConsensusReliabilityProvider
  implements ConsensusReliabilityProvider
{
  private readonly repo: ReliabilityRepository;

  constructor(repository: ReliabilityRepository) {
    // precondition: repository is open (assertOpen is enforced by the repository
    // implementation on every read call; we do not replicate it here).
    this.repo = repository;
  }

  /**
   * Precondition: runId non-empty; judge/claimType/direction are valid.
   * Postcondition: null ↔ (control arm OR no calibrated data for this cell).
   *
   * Delegates to getReliabilityForRun from calibration-seams.ts, which
   * applies the CC-3 isControlArmRun(runId) gate.
   *
   * source: CC-3 / B-Popper-1 — published seam for Phase 4.1 consumers.
   */
  getReliabilityForRun(
    runId: string,
    judge: AgentIdentity,
    claimType: Claim["claim_type"],
    direction: VerdictDirection,
  ): JudgeReliabilityRecord | null {
    // getReliabilityForRun is generic over the repository shape; the
    // ReliabilityRepository.getReliability signature matches the constraint.
    return getReliabilityForRun(
      runId,
      judge,
      claimType,
      direction,
      this.repo,
    ) as JudgeReliabilityRecord | null;
  }
}
