/**
 * Held-out partition lock schemas and seal verification — Phase 4 (all uses).
 *
 * This module owns three distinct lock schemas, one per calibration use case:
 *
 *   1. MaxAttemptsHeldoutLockSchema (v1) — Phase 4.2 retry-loop calibration.
 *      Lock file: data/maxattempts-heldout.lock.json
 *      Verify: verifyMaxAttemptsHeldoutSeal
 *
 *   2. ReliabilityHeldoutLockSchema (v2) — Phase 4.1 reliability calibration.
 *      Lock file: data/heldout-partition.lock.json
 *      Verify: verifyReliabilityHeldoutSeal
 *
 *   3. KpiGatesHeldoutLockSchema (v1) — Phase 4.5 KPI-gate calibration.
 *      Lock file: data/kpigates-heldout.lock.json
 *      Verify: verifyKpiGatesHeldoutSeal
 *
 * Also owns the JSONL sinks for calibration audit trails (dropped-claims,
 * judge-observation log).
 *
 * Layer contract (§2.2): imports from Node stdlib and local types only.
 *
 * source: B-Popper-1, C-Curie-A4, C-Shannon-CONCERN-1 cross-audit findings.
 * source: docs/PHASE_4_PLAN.md §4.1, §4.2, §4.5.
 * source: Wave C integration — B4 schema-collision resolution (code-reviewer).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import type { JudgeId, JudgeObservation } from "./observations.js";

// ─── MaxAttempts held-out lock schema (v1) — Phase 4.2 ───────────────────────

/**
 * Lock-file schema for the MAX_ATTEMPTS retry-calibration held-out partition (v1).
 *
 * Scoped to the Phase 4.2 retry-loop calibration use case.
 * Lock file: `packages/benchmark/calibration/data/maxattempts-heldout.lock.json`.
 * Must be committed before any held-out evaluation run begins.
 *
 * source: docs/PHASE_4_PLAN.md §4.2 negative-falsifier procedure.
 * source: M2 residual — B-Popper-AP5 (sealing has no mechanical enforcement).
 */
export interface MaxAttemptsHeldoutLock {
  readonly schema_version: 1;
  readonly rng_seed: number;
  readonly partition_hash: string; // sha256 hex over sorted-newline-joined run_ids
  readonly partition_size: number;
  readonly sealed_at: string; // ISO-8601 UTC
}

/** @deprecated Use MaxAttemptsHeldoutLock. Kept for backward compat during Wave C transition. */
export type HeldoutPartitionLock = MaxAttemptsHeldoutLock;

/**
 * Runtime validator for `MaxAttemptsHeldoutLock` (v1).
 *
 * The committed template stub carries `null` for every field other than
 * `schema_version`, so we validate the SEALED shape — all fields populated.
 * A null-valued template fails the schema with a clear "lock file is unsealed"
 * diagnostic instead of an opaque downstream NaN cascade.
 *
 * source: Popper AP-5 final-audit residual.
 * source: docs/PHASE_4_PLAN.md §4.2 negative-falsifier procedure.
 */
const MaxAttemptsHeldoutLockSchema = z.object({
  schema_version: z.literal(1),
  rng_seed: z.number().int().nonnegative(),
  partition_hash: z.string().regex(/^[0-9a-f]{64}$/, {
    message: "partition_hash must be a 64-char lowercase sha256 hex digest",
  }),
  partition_size: z.number().int().positive(),
  sealed_at: z.string().refine((s) => !Number.isNaN(new Date(s).getTime()), {
    message: "sealed_at must be a valid ISO-8601 timestamp",
  }),
});

/**
 * Detect the unsealed-template state explicitly. The committed lock file
 * carries `null` for the fields that get populated when the partition is
 * actually drawn and sealed; treat that as a clear-error condition rather than
 * letting it cascade into the runtime validator's per-field complaints.
 */
function isUnsealedTemplate(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    r.rng_seed === null ||
    r.partition_hash === null ||
    r.partition_size === null ||
    r.sealed_at === null
  );
}

/**
 * Verify the MAX_ATTEMPTS held-out partition seal before any evaluation run.
 *
 * Scoped to the Phase 4.2 retry-loop calibration use case.
 * MUST be called BEFORE any held-out evaluation against
 * `data/maxattempts-heldout.lock.json`.
 *
 * Precondition: `observed_indices` is the list of run_ids in the held-out
 *   set being evaluated; `lockPath` points to the committed lock file.
 * Postcondition: returns void when the partition hash matches the lock and the
 *   lock is validly sealed (MaxAttemptsHeldoutLockSchema v1).
 * Throws:
 *   - Error if the lock file is missing or unreadable.
 *   - Error if `schema_version` is not 1.
 *   - Error if `sealed_at` is in the future (clock drift guard).
 *   - Error if the sha256 of the sorted run_ids does not match `partition_hash`.
 *
 * source: docs/PHASE_4_PLAN.md §4.2 negative-falsifier sealing requirement.
 * source: M2 residual — Popper AP-5 mechanical enforcement.
 */
export function verifyMaxAttemptsHeldoutSeal(
  observed_indices: ReadonlyArray<string>,
  lockPath: string,
): void {
  if (!existsSync(lockPath)) {
    throw new Error(
      `verifyMaxAttemptsHeldoutSeal: lock file missing at "${lockPath}". ` +
        `The held-out partition must be sealed before any evaluation run. ` +
        `See docs/PHASE_4_PLAN.md §4.2.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (err) {
    throw new Error(
      `verifyMaxAttemptsHeldoutSeal: failed to parse lock file at "${lockPath}": ${String(err)}`,
    );
  }

  if (isUnsealedTemplate(raw)) {
    throw new Error(
      `verifyMaxAttemptsHeldoutSeal: lock file at "${lockPath}" is the unsealed template ` +
        `(rng_seed/partition_hash/partition_size/sealed_at all null). ` +
        `The held-out partition must be drawn and sealed before any evaluation. ` +
        `See docs/PHASE_4_PLAN.md §4.2 negative-falsifier procedure.`,
    );
  }

  const parsed = MaxAttemptsHeldoutLockSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `verifyMaxAttemptsHeldoutSeal: lock file at "${lockPath}" failed schema validation: ` +
        parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; "),
    );
  }
  const lock: MaxAttemptsHeldoutLock = parsed.data;

  const sealedAt = new Date(lock.sealed_at).getTime();
  if (sealedAt > Date.now()) {
    throw new Error(
      `verifyMaxAttemptsHeldoutSeal: sealed_at="${lock.sealed_at}" is in the future. ` +
        `Lock files must be sealed at or before use.`,
    );
  }

  const sorted = [...observed_indices].sort();
  const observed_hash = createHash("sha256")
    .update(sorted.join("\n"))
    .digest("hex");

  if (observed_hash !== lock.partition_hash) {
    throw new Error(
      `verifyMaxAttemptsHeldoutSeal: partition hash mismatch. ` +
        `Lock expects "${lock.partition_hash}" but observed indices hash to "${observed_hash}". ` +
        `The held-out set has changed since sealing — this voids the falsifier (Popper AP-5).`,
    );
  }
}

/** @deprecated Use verifyMaxAttemptsHeldoutSeal. Kept for backward compat during Wave C transition. */
export const verifyHeldoutPartitionSeal = verifyMaxAttemptsHeldoutSeal;

// ─── Reliability held-out lock schema (v2) — Phase 4.1 ───────────────────────

/**
 * Schema version for the 4.1 reliability held-out partition lock file.
 * v2 adds external_grounding_breakdown (required by Curie A2 independence
 * requirement) — every claim in the held-out set must have an externally
 * verifiable ground-truth category.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 "Externally-grounded held-out subset".
 */
export const RELIABILITY_HELDOUT_LOCK_SCHEMA_VERSION = 2 as const;

/**
 * Zod schema for the 4.1 reliability held-out partition lock file (v2).
 *
 * v2 fields vs v1 (MaxAttemptsHeldoutLockSchema):
 *   - `seed` replaces `rng_seed` (string, not integer).
 *   - `claim_set_hash` replaces `partition_hash` (same sha256 semantics).
 *   - `external_grounding_breakdown` is REQUIRED — all 4 grounding categories
 *     must be present (values may be 0 if a category has no claims).
 *   - `external_grounding_total` must equal `partition_size` (Zod refine).
 *   - `external_grounding_schema_version` is always 1.
 *
 * source: PHASE_4_PLAN.md §4.1 partition-lock-v2 specification.
 * source: C2 deliverable, Phase 4 Wave C.
 */
export const ReliabilityHeldoutLockSchema = z
  .object({
    schema_version: z.literal(RELIABILITY_HELDOUT_LOCK_SCHEMA_VERSION),
    /** Pre-registered RNG seed committed before data collection. */
    seed: z.string().min(1),
    /** Total number of claims in the held-out partition. */
    partition_size: z.number().int().positive(),
    /** ISO-8601 timestamp when the partition was sealed. */
    sealed_at: z.string().datetime(),
    /**
     * Claim count per external grounding category. All 4 keys required.
     * Invariant: sum of values === external_grounding_total === partition_size.
     */
    external_grounding_breakdown: z.object({
      schema: z.number().int().nonnegative(),
      math: z.number().int().nonnegative(),
      code: z.number().int().nonnegative(),
      spec: z.number().int().nonnegative(),
    }),
    /** Sum of external_grounding_breakdown. Must equal partition_size. */
    external_grounding_total: z.number().int().nonnegative(),
    /** Version of the external grounding spec (always 1 for initial spec). */
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
        "ReliabilityHeldoutLock: external_grounding_breakdown sum must equal external_grounding_total.",
      path: ["external_grounding_total"],
    },
  )
  .refine(
    (lock) => lock.external_grounding_total === lock.partition_size,
    {
      message:
        "ReliabilityHeldoutLock: external_grounding_total must equal partition_size. Every claim must have an external grounding category.",
      path: ["external_grounding_total"],
    },
  );

export type ReliabilityHeldoutLock = z.infer<typeof ReliabilityHeldoutLockSchema>;

/**
 * Verify the 4.1 reliability held-out partition seal.
 *
 * Precondition: `lockPath` points to the committed `data/heldout-partition.lock.json`.
 * Postcondition: returns a validated ReliabilityHeldoutLock if the file is
 *   present, parses as valid JSON, and satisfies ReliabilityHeldoutLockSchema.
 * Throws Error with a descriptive message for any violation.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 negative-falsifier sealing requirement.
 * source: C2 deliverable, Phase 4 Wave C.
 */
export function verifyReliabilityHeldoutSeal(
  lockPath: string,
): ReliabilityHeldoutLock {
  if (!existsSync(lockPath)) {
    throw new Error(
      `verifyReliabilityHeldoutSeal: lock file not found at "${lockPath}". ` +
        "Seal the partition before running calibration.",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (cause) {
    throw new Error(
      `verifyReliabilityHeldoutSeal: failed to parse lock file at "${lockPath}": ${String(cause)}`,
    );
  }

  const result = ReliabilityHeldoutLockSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `verifyReliabilityHeldoutSeal: lock file at "${lockPath}" failed schema validation:\n` +
        result.error.issues
          .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("\n"),
    );
  }

  return result.data;
}

// ─── KPI-gates held-out lock schema (v1) — Phase 4.5 ────────────────────────

/**
 * Zod schema for the Phase 4.5 KPI-gates held-out partition lock file.
 *
 * Scoped to the gate-threshold calibration use case. Uses v1 field names
 * (rng_seed / partition_hash) consistent with MaxAttemptsHeldoutLockSchema
 * because the sealing artifact here is over run_ids, not claim_ids.
 * Lock file: `data/kpigates-heldout.lock.json`.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 Popper AP-5 sealing artifact.
 * source: C3 deliverable, Phase 4 Wave C.
 */
export const KpiGatesHeldoutLockSchema = z.object({
  schema_version: z.literal(1),
  rng_seed: z.number().int().nonnegative().nullable(),
  partition_hash: z.string().nullable(),
  partition_size: z.number().int().positive().nullable(),
  sealed_at: z
    .string()
    .refine((s) => s === null || !Number.isNaN(new Date(s).getTime()), {
      message: "sealed_at must be a valid ISO-8601 timestamp or null",
    })
    .nullable(),
});

export type KpiGatesHeldoutLock = z.infer<typeof KpiGatesHeldoutLockSchema>;

/**
 * Verify the Phase 4.5 KPI-gates held-out partition seal.
 *
 * Precondition: `lockPath` points to `data/kpigates-heldout.lock.json`.
 * Postcondition: returns a validated KpiGatesHeldoutLock if the file parses
 *   correctly. Note: null fields are valid (unsealed template state).
 * Throws Error with a descriptive message for parse or schema failures.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 Popper AP-5 sealing artifact.
 */
export function verifyKpiGatesHeldoutSeal(lockPath: string): KpiGatesHeldoutLock {
  if (!existsSync(lockPath)) {
    throw new Error(
      `verifyKpiGatesHeldoutSeal: lock file not found at "${lockPath}". ` +
        "Commit the lock template before running KPI-gate calibration.",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (cause) {
    throw new Error(
      `verifyKpiGatesHeldoutSeal: failed to parse lock file at "${lockPath}": ${String(cause)}`,
    );
  }

  const result = KpiGatesHeldoutLockSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `verifyKpiGatesHeldoutSeal: lock file at "${lockPath}" failed schema validation:\n` +
        result.error.issues
          .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("\n"),
    );
  }

  return result.data;
}

// ─── Dropped-claims queue (C-Curie-A4) ───────────────────────────────────────

/**
 * Path to the JSONL file for INCONCLUSIVE-verdict observations dropped from
 * the calibration pool.
 *
 * The dual-annotator procedure (Phase 4.1 §4.1 step 4): if the third reviewer
 * marks a claim as INCONCLUSIVE (ambiguous), it is dropped from the calibration
 * pool. The drop rate is a measurement-quality KPI; a drop rate > 10% triggers
 * rubric review.
 *
 * source: C-Curie-A4 cross-audit finding; docs/PHASE_4_PLAN.md §4.1 step 4
 * "Drop set".
 */
export const DROPPED_CLAIMS_PATH =
  "packages/benchmark/calibration/data/dropped-claims.jsonl";

/**
 * One entry in the dropped-claims JSONL. Written by the third reviewer.
 */
export interface DroppedClaimEntry {
  readonly claim_id: string;
  readonly drop_reason: string;
  readonly schema_version: 1;
  readonly timestamp: string; // ISO-8601
}

/**
 * Append one dropped-claim entry to the dropped-claims log.
 *
 * Precondition: claim_id is a non-empty string; drop_reason describes why the
 *   claim is ambiguous (e.g., "rubric interpretation disagreement").
 * Postcondition: one JSONL line appended to droppedPath; directory created if
 *   needed.
 *
 * source: C-Curie-A4 cross-audit finding.
 */
export function appendDroppedClaim(
  entry: Omit<DroppedClaimEntry, "schema_version" | "timestamp">,
  droppedPath: string = DROPPED_CLAIMS_PATH,
): void {
  const dir = dirname(droppedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const line: DroppedClaimEntry = {
    ...entry,
    schema_version: 1,
    timestamp: new Date().toISOString(),
  };
  appendFileSync(droppedPath, JSON.stringify(line) + "\n", "utf8");
}

// ─── Audit log (C-Shannon-CONCERN-1) ─────────────────────────────────────────

/**
 * Path to the JSONL audit log for resolved observations.
 *
 * Every observation with a known ground_truth (from the golden set) is logged
 * here alongside the judge's verdict. This log is the canonical source for
 * replaying the confusion matrix for any (judge, claim_type) cell at any
 * point in time.
 *
 * source: C-Shannon-CONCERN-1 cross-audit finding.
 */
export const JUDGE_OBSERVATION_LOG_PATH =
  "packages/benchmark/calibration/data/judge-observation-log.jsonl";

/**
 * One entry in the judge observation audit log.
 *
 * Fields preserve the full (judge_id, claim_id, claim_type, ground_truth,
 * judge_verdict, run_id, timestamp) tuple so the confusion matrix can be
 * replayed from this log alone.
 *
 * source: C-Shannon-CONCERN-1 cross-audit finding.
 */
export interface JudgeObservationLogEntry {
  readonly judge_id: JudgeId;
  readonly claim_id: string;
  readonly claim_type: string;
  readonly ground_truth: boolean;
  readonly judge_verdict: boolean;
  readonly run_id: string;
  readonly timestamp: string; // ISO-8601
  readonly schema_version: 1;
}

/**
 * Append one resolved observation to the audit log.
 *
 * Precondition: `obs.ground_truth` is a boolean (not "unknown").
 * Postcondition: one JSONL line appended; directory created if needed.
 *
 * source: C-Shannon-CONCERN-1 cross-audit finding.
 */
export function appendObservationLog(
  obs: JudgeObservation & { readonly ground_truth: boolean },
  logPath: string = JUDGE_OBSERVATION_LOG_PATH,
): void {
  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const entry: JudgeObservationLogEntry = {
    judge_id: obs.judge_id,
    claim_id: obs.claim_id,
    claim_type: obs.claim_type,
    ground_truth: obs.ground_truth,
    judge_verdict: obs.judge_verdict,
    run_id: obs.run_id,
    timestamp: new Date().toISOString(),
    schema_version: 1,
  };
  appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");
}
