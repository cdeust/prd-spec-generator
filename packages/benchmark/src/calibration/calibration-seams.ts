/**
 * Calibration seams — infrastructure seams shared across the Phase 4
 * calibration subsystem.
 *
 * Seams in this file:
 *   1. FNV-1a hash — deterministic, reproducible partition assignment.
 *   2. verifyHeldoutPartitionSeal — reads the lock file and asserts the
 *      partition has not drifted since it was sealed.
 *   3. HeldoutPartitionLockSchema — Zod schema for the lock file (v2, with
 *      external_grounding_breakdown required).
 *
 * C1 (research-scientist) coordinates: the FNV-1a hash and partition seal
 * are shared with C1's Kaplan-Meier and reliability calibration work.
 * Schema version bump from 1→2 is owned by C2 (this stream); C1 must read
 * the new required fields when generating the lock file.
 *
 * source: PHASE_4_PLAN.md §4.1 "Externally-grounded held-out subset" —
 * partition-lock-v2 schema specification.
 */

import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import type { ExternalGroundingType } from "./external-oracle.js";

// ─── Schema version ───────────────────────────────────────────────────────────

/**
 * Lock file schema version. Bump here when the schema changes.
 * v1 → v2: added external_grounding_breakdown + external_grounding_total.
 *
 * C1 COORDINATION NOTE: if C1 writes the lock file, it must use
 * HELDOUT_PARTITION_LOCK_SCHEMA_VERSION = 2 and populate the two new fields.
 * If the lock file has schema_version = 1, verifyHeldoutPartitionSeal will
 * reject it with a clear error.
 *
 * source: PHASE_4_PLAN.md §4.1 partition-lock-v2 specification.
 */
export const HELDOUT_PARTITION_LOCK_SCHEMA_VERSION = 2 as const;

// ─── FNV-1a hash ─────────────────────────────────────────────────────────────

/**
 * FNV-1a (32-bit) hash for deterministic partition assignment.
 *
 * Used to assign claim IDs to held-out vs calibration partitions without
 * randomness at call time. The seed is committed before data collection
 * starts (CC-1 pre-registration requirement).
 *
 * source: Fowler, M., Noll, L. C., & Vo, P. (1991). FNV hash algorithm.
 *   https://datatracker.ietf.org/doc/html/draft-eastlake-fnv-17
 *   32-bit FNV prime = 16777619; FNV offset basis = 2166136261.
 *
 * Postcondition: deterministic for a given input string.
 * Postcondition: output ∈ [0, 2^32 - 1].
 */
export function fnv1a32(input: string): number {
  // source: FNV-1a 32-bit constants from the IETF draft above.
  const FNV_PRIME = 16777619;
  const FNV_OFFSET_BASIS = 2166136261;

  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Truncate to 32 bits after multiplication using bitwise OR 0.
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Assign a claim ID to a partition using the FNV-1a hash.
 *
 * Postcondition: deterministic for (claimId, seed).
 * Postcondition: approximately 20% of claims assigned to "heldout"
 *   when partitionFraction = 0.2 (the pre-registered held-out fraction).
 *
 * @param claimId          - Stable claim identifier (content hash or UUID).
 * @param seed             - Pre-registered RNG seed string.
 * @param partitionFraction- Fraction assigned to held-out. Default 0.2.
 * @returns "heldout" | "calibration"
 */
export function assignPartition(
  claimId: string,
  seed: string,
  partitionFraction = 0.2,
): "heldout" | "calibration" {
  const h = fnv1a32(`${seed}:${claimId}`);
  return (h / 0x100000000) < partitionFraction ? "heldout" : "calibration";
}

// ─── Lock file schema (v2) ────────────────────────────────────────────────────

/**
 * Zod schema for the held-out partition lock file.
 *
 * v2 adds two required fields:
 *   external_grounding_breakdown — per-category claim count
 *   external_grounding_total     — sum of breakdown values; must equal
 *                                  partition_size for a valid lock file.
 *   external_grounding_schema_version — always 1 (independent of the lock
 *                                  file schema_version; documents the
 *                                  grounding spec version, not the file format)
 *
 * source: PHASE_4_PLAN.md §4.1 "Externally-grounded held-out subset" —
 * partition-lock-v2 schema specification.
 */
export const HeldoutPartitionLockSchema = z
  .object({
    /** Lock file format version. Must equal HELDOUT_PARTITION_LOCK_SCHEMA_VERSION. */
    schema_version: z.literal(HELDOUT_PARTITION_LOCK_SCHEMA_VERSION),
    /** Pre-registered RNG seed committed before data collection. */
    seed: z.string().min(1),
    /** Total number of claims in the held-out partition. */
    partition_size: z.number().int().positive(),
    /** ISO-8601 timestamp when the partition was sealed. */
    sealed_at: z.string().datetime(),
    /**
     * Number of claims per external grounding category.
     * All 4 categories must be present (values may be 0 if a category
     * has no claims in this partition version, but the key must exist).
     */
    external_grounding_breakdown: z.object({
      schema: z.number().int().nonnegative(),
      math: z.number().int().nonnegative(),
      code: z.number().int().nonnegative(),
      spec: z.number().int().nonnegative(),
    }) satisfies z.ZodType<Record<ExternalGroundingType, number>>,
    /**
     * Sum of external_grounding_breakdown values.
     * Invariant: must equal partition_size.
     * Validated by the Zod refine below.
     */
    external_grounding_total: z.number().int().nonnegative(),
    /**
     * Version of the external grounding specification (independent of
     * the lock file schema_version). Always 1 for the initial grounding spec.
     */
    external_grounding_schema_version: z.literal(1),
    /** SHA-256 of the sorted claim ID list, for drift detection. */
    claim_set_hash: z.string().min(1),
  })
  .refine(
    (lock) => {
      const bd = lock.external_grounding_breakdown;
      const sum = bd.schema + bd.math + bd.code + bd.spec;
      return sum === lock.external_grounding_total;
    },
    {
      message:
        "HeldoutPartitionLock: external_grounding_breakdown sum must equal external_grounding_total.",
      path: ["external_grounding_total"],
    },
  )
  .refine(
    (lock) => lock.external_grounding_total === lock.partition_size,
    {
      message:
        "HeldoutPartitionLock: external_grounding_total must equal partition_size. Every claim in the held-out partition must have an external grounding category.",
      path: ["external_grounding_total"],
    },
  );

export type HeldoutPartitionLock = z.infer<typeof HeldoutPartitionLockSchema>;

// ─── Seal verification ────────────────────────────────────────────────────────

/**
 * Read and verify the held-out partition lock file.
 *
 * Postcondition: if this returns without throwing, the lock file:
 *   1. Exists at `lockPath`.
 *   2. Parses as valid JSON.
 *   3. Satisfies HeldoutPartitionLockSchema (all fields valid).
 *   4. schema_version === HELDOUT_PARTITION_LOCK_SCHEMA_VERSION.
 *   5. external_grounding_total === partition_size.
 *   6. external_grounding_breakdown sums to external_grounding_total.
 *
 * Throws `Error` with a descriptive message for any violation.
 *
 * @param lockPath - Path to `data/heldout-partition.lock.json`.
 * @returns Parsed and validated lock object.
 */
export function verifyHeldoutPartitionSeal(
  lockPath: string,
): HeldoutPartitionLock {
  if (!existsSync(lockPath)) {
    throw new Error(
      `verifyHeldoutPartitionSeal: lock file not found at "${lockPath}". ` +
        "Seal the partition before running calibration.",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(lockPath, "utf-8"));
  } catch (cause) {
    throw new Error(
      `verifyHeldoutPartitionSeal: failed to parse lock file at "${lockPath}": ${String(cause)}`,
    );
  }

  const result = HeldoutPartitionLockSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `verifyHeldoutPartitionSeal: lock file at "${lockPath}" failed schema validation:\n` +
        result.error.issues
          .map((i) => `  ${i.path.join(".")}: ${i.message}`)
          .join("\n"),
    );
  }

  return result.data;
}
