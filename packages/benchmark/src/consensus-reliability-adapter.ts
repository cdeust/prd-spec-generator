/**
 * BenchmarkConsensusReliabilityProvider — adapter implementing the
 * ConsensusReliabilityProvider port declared in @prd-gen/core.
 *
 * Layer contract (§2.2 / coding-standards):
 *   - Port (ConsensusReliabilityProvider) lives in @prd-gen/core (inner layer).
 *   - This adapter lives in @prd-gen/benchmark (outer layer), src/ directory.
 *   - @prd-gen/verification consumes the port, never this adapter.
 *   - Only the composition root (@prd-gen/mcp-server) imports this adapter
 *     and injects it into ConsensusConfig.reliabilityProvider.
 *
 * DIP (§1.5): core declares the interface; benchmark implements it;
 * the composition root wires them at startup.
 *
 * CC-3 control-arm logic:
 *   isControlArmRun is inlined here (FNV-1a % 5 === 0) so that this module
 *   remains in src/ and can be compiled by tsc (rootDir: src). The canonical
 *   implementation lives in calibration/calibration-seams.ts; both are kept
 *   byte-for-byte consistent. Changes to the CC-3 predicate MUST be mirrored.
 *
 *   source: CC-3 / B-Popper-1 — fnv1a32(runId) % 5 === 0 → control arm.
 *   source: FNV-1a IETF draft (Eastlake/Hansen) — FNV prime = 16777619,
 *     offset basis = 2166136261.
 *   source: Math.imul correctness — MDN Web Docs, "Math.imul".
 *
 * source: docs/PHASE_4_PLAN.md §4.1; Wave D2 deliverable D2.3.
 * source: coding-standards §2.3 (Ports and Adapters).
 */

import type {
  ConsensusReliabilityProvider,
  JudgeReliabilityRecord,
  AgentIdentity,
  VerdictDirection,
  ReliabilityRepository,
} from "@prd-gen/core";
import type { Claim } from "@prd-gen/core";

// ─── CC-3 control-arm predicate (inlined from calibration-seams.ts) ──────────

/**
 * Compute FNV-1a 32-bit hash of a string.
 * Inlined from calibration/calibration-seams.ts to keep this file under src/.
 * Any change to the predicate MUST be mirrored in calibration-seams.ts.
 *
 * Precondition: input is a string.
 * Postcondition: return value ∈ [0, 2^32 − 1]; deterministic.
 * Invariant: hash is a uint32 after each iteration (>>> 0 enforces wrap).
 * Termination: i increases monotonically to input.length.
 *
 * source: FNV-1a IETF draft (Eastlake/Hansen) — prime=16777619, basis=2166136261.
 * source: Math.imul — MDN Web Docs.
 */
function fnv1a32(input: string): number {
  const FNV_OFFSET_BASIS = 2166136261;
  const FNV_PRIME = 16777619;
  let hash = FNV_OFFSET_BASIS;
  // invariant: hash is uint32 after each iteration; terminates at input.length.
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Returns true if this run_id is assigned to the CC-3 control arm.
 *
 * Allocation: fnv1a32(runId) % 5 === 0 → control arm (ε = 0.20; 1 in 5).
 * Inlined from calibration-seams.ts; must remain byte-for-byte identical.
 *
 * source: CC-3 / B-Popper-1; docs/PHASE_4_PLAN.md §CC-3.
 */
function isControlArmRun(runId: string): boolean {
  return fnv1a32(runId) % 5 === 0;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

/**
 * Adapter that bridges the ConsensusReliabilityProvider port to the
 * CC-3-aware control-arm gate and the ReliabilityRepository.
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
    this.repo = repository;
  }

  /**
   * Precondition: runId non-empty; judge/claimType/direction are valid.
   * Postcondition: null ↔ (control arm OR no calibrated data for this cell).
   *
   * source: CC-3 / B-Popper-1 — published seam for Phase 4.1 consumers.
   */
  getReliabilityForRun(
    runId: string,
    judge: AgentIdentity,
    claimType: Claim["claim_type"],
    direction: VerdictDirection,
  ): JudgeReliabilityRecord | null {
    if (isControlArmRun(runId)) {
      // CC-3 control arm: ignore calibrated history, use Beta(7,3) prior.
      // source: CC-3 — ε=0.20 forced exploration arm.
      return null;
    }
    return this.repo.getReliability(judge, claimType, direction);
  }
}
