import { z } from "zod";
import { AgentIdentitySchema } from "@prd-gen/core";

/**
 * Snapshot of the verification plan dispatched in self-check Phase A.
 * Persisted so Phase B can map invocation_id → claim/judge without re-running
 * planDocumentVerification (which would corrupt attribution if state.sections
 * mutated between phases).
 *
 * `judges[i]` is the AgentIdentity that received `claim_ids[i]`. Storing both
 * preserves judge attribution in `ConsensusVerdict.judges` even on the
 * plan-mismatch fallback path — Bayesian reliability lookups remain correct.
 *
 * INVARIANT (load-bearing): `claim_ids.length === judges.length`. The
 * fallback path in self-check.ts:parseVerdictsFromSnapshot uses positional
 * lookups (`snapshot.judges[idx]` with `idx < snapshot.claim_ids.length`).
 * If lengths diverge, an out-of-bounds read returns `undefined`, which
 * later fails `agentKey()` in consensus.ts. Enforced via Zod refinement.
 *
 * source: dijkstra cross-audit H1 (Phase 3+4, 2026-04).
 */
export const VerificationPlanSnapshotSchema = z
  .object({
    batch_id: z.string(),
    /** Claim IDs in dispatch order — index = invocation slot. */
    claim_ids: z.array(z.string()),
    /** Judge identities, parallel to claim_ids by index. */
    judges: z.array(AgentIdentitySchema),
  })
  .refine((s) => s.claim_ids.length === s.judges.length, {
    message:
      "VerificationPlanSnapshot: claim_ids and judges must have the same length (positional invariant — see self-check.ts:parseVerdictsFromSnapshot).",
    path: ["judges"],
  });
export type VerificationPlanSnapshot = z.infer<
  typeof VerificationPlanSnapshotSchema
>;
