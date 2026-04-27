/**
 * Calibration seams — Phase 4.1 cross-cutting concerns.
 *
 * This module contains three seams that are logically distinct from the core
 * observation-capture pipeline in observations.ts:
 *
 *   1. Dropped-claims queue (C-Curie-A4): JSONL sink for INCONCLUSIVE verdicts
 *      from the third reviewer in the dual-annotator procedure.
 *
 *   2. Judge observation audit log (C-Shannon-CONCERN-1): JSONL append-only log
 *      of resolved observations. Canonical source for confusion-matrix replay.
 *
 *   3. Control arm seam (CC-3 / B-Popper-1): isControlArmRun + getReliabilityForRun.
 *      ε-greedy forced exploration partition; Wave C+ wiring gate.
 *
 * Layer contract (§2.2): imports from Node stdlib and local types only.
 * No @prd-gen/core imports needed — all types are self-contained or come from
 * observations.ts.
 *
 * source: B-Popper-1, C-Curie-A4, C-Shannon-CONCERN-1 cross-audit findings.
 * source: docs/PHASE_4_PLAN.md §CC-3, §4.1.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import type { JudgeId, JudgeObservation } from "./observations.js";

// ─── Held-out partition seal (M2 / Popper AP-5) ──────────────────────────────

/**
 * Lock-file schema for the held-out 20% evaluation partition.
 *
 * The lock file at `packages/benchmark/calibration/data/heldout-partition.lock.json`
 * is the mechanical sealing artifact required by Phase 4.1 §4.1.
 * It MUST be committed before any annotation work begins.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 negative-falsifier procedure.
 * source: M2 residual — B-Popper-AP5 (sealing has no mechanical enforcement).
 */
export interface HeldoutPartitionLock {
  readonly schema_version: 1;
  readonly rng_seed: number;
  readonly partition_hash: string; // sha256 hex over sorted-newline-joined claim_ids
  readonly partition_size: number;
  readonly sealed_at: string; // ISO-8601 UTC
}

/**
 * Runtime validator for `HeldoutPartitionLock`. The committed template stub
 * (data/heldout-partition.lock.json) carries `null` for every field other than
 * `schema_version`, so we validate the SEALED shape — all fields populated and
 * well-typed. A null-valued template fails the schema with a clear "lock file
 * is unsealed" diagnostic instead of an opaque downstream NaN cascade.
 *
 * source: Popper AP-5 final-audit residual (verifyHeldoutPartitionSeal lacked
 * runtime schema validation; null template produced misleading error messages).
 */
const HeldoutPartitionLockSchema = z.object({
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
 * Verify the held-out partition seal before any evaluation run.
 *
 * MUST be called BEFORE any held-out evaluation (see docs/PHASE_4_PLAN.md §4.1
 * implementation: `packages/benchmark/calibration/calibration-seams.ts::verifyHeldoutPartitionSeal`).
 *
 * Precondition: `observed_indices` is the list of claim_ids in the held-out
 *   set being evaluated; `lockPath` points to the committed lock file.
 * Postcondition: returns void when the partition hash matches the lock and the
 *   lock is validly sealed.
 * Throws:
 *   - Error if the lock file is missing or unreadable.
 *   - Error if `schema_version` is not 1.
 *   - Error if `sealed_at` is in the future (clock drift guard).
 *   - Error if the sha256 of the sorted claim_ids does not match `partition_hash`.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 negative-falsifier sealing requirement.
 * source: M2 residual — Popper AP-5 mechanical enforcement.
 */
export function verifyHeldoutPartitionSeal(
  observed_indices: ReadonlyArray<string>,
  lockPath: string,
): void {
  if (!existsSync(lockPath)) {
    throw new Error(
      `verifyHeldoutPartitionSeal: lock file missing at "${lockPath}". ` +
        `The held-out partition must be sealed before any evaluation run. ` +
        `See docs/PHASE_4_PLAN.md §4.1.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (err) {
    throw new Error(
      `verifyHeldoutPartitionSeal: failed to parse lock file at "${lockPath}": ${String(err)}`,
    );
  }

  // Explicit unsealed-template guard: the committed stub at
  // data/heldout-partition.lock.json carries `null` for every field other than
  // schema_version. Detect that state up-front so the error names the actual
  // problem instead of cascading into per-field schema complaints.
  if (isUnsealedTemplate(raw)) {
    throw new Error(
      `verifyHeldoutPartitionSeal: lock file at "${lockPath}" is the unsealed template ` +
        `(rng_seed/partition_hash/partition_size/sealed_at all null). ` +
        `The held-out partition must be drawn and sealed before any evaluation. ` +
        `See docs/PHASE_4_PLAN.md §4.1 negative-falsifier procedure.`,
    );
  }

  // Runtime schema validation. Replaces the prior unsafe `as` cast.
  const parsed = HeldoutPartitionLockSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `verifyHeldoutPartitionSeal: lock file at "${lockPath}" failed schema validation: ` +
        parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; "),
    );
  }
  const lock: HeldoutPartitionLock = parsed.data;

  // Guard: sealed_at must not be in the future (clock drift or pre-dated lock).
  // The schema already ensured `sealed_at` parses to a valid Date, so the
  // NaN-check at this layer is redundant but kept defensively.
  const sealedAt = new Date(lock.sealed_at).getTime();
  if (sealedAt > Date.now()) {
    throw new Error(
      `verifyHeldoutPartitionSeal: sealed_at="${lock.sealed_at}" is in the future. ` +
        `Lock files must be sealed at or before use.`,
    );
  }

  // Compute sha256 over sorted, newline-joined claim_ids.
  const sorted = [...observed_indices].sort();
  const observed_hash = createHash("sha256")
    .update(sorted.join("\n"))
    .digest("hex");

  if (observed_hash !== lock.partition_hash) {
    throw new Error(
      `verifyHeldoutPartitionSeal: partition hash mismatch. ` +
        `Lock expects "${lock.partition_hash}" but observed indices hash to "${observed_hash}". ` +
        `The held-out set has changed since sealing — this voids the falsifier (Popper AP-5).`,
    );
  }
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
 * The third reviewer writes to this file with { claim_id, drop_reason } for
 * every dropped claim. Gitignored alongside pending-observations.jsonl.
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
 * Called by the third reviewer's tooling when an INCONCLUSIVE verdict is reached
 * and the claim is removed from the calibration pool.
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
 * replaying the confusion matrix for any (judge, claim_type) cell at any point
 * in time.
 *
 * Stored alongside reliability.db; gitignored.
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
 * Called for every observation where ground_truth is known.
 * The audit log is append-only; it is never modified after a line is written.
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

// ─── Control arm seam — CC-3 / B-Popper-1 ────────────────────────────────────

/**
 * Compute FNV-1a 32-bit hash of a string.
 * Returns a non-negative integer in [0, 2^32).
 *
 * source: FNV-1a specification — http://www.isthe.com/chongo/tech/comp/fnv/
 * source: Fowler et al. (1991), "Noll Hashing Revisited."
 */
function fnv1a32(s: string): number {
  let hash = 2166136261; // FNV offset basis
  // invariant: hash is a uint32 after each iteration (>>> 0 enforces this)
  // termination: i increases monotonically to s.length
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    // Multiply by FNV prime (2^24 + 2^8 + 0x93) with 32-bit wrap
    hash = (hash * 16777619) >>> 0;
  }
  return hash;
}

/**
 * Returns true if this run_id is assigned to the control arm.
 *
 * Allocation: fnv1a32(runId) % 5 === 0 → control arm (ε = 0.20; 1 in 5).
 * The same run_id always maps to the same arm — partitioning is deterministic
 * and stable across restarts.
 *
 * Precondition: runId is a non-empty string.
 * Postcondition: deterministic — the same runId always returns the same value.
 *
 * source: CC-3 / B-Popper-1 — deterministic partition run_id_hash % 5 === 0.
 * source: docs/PHASE_4_PLAN.md §CC-3.
 */
export function isControlArmRun(runId: string): boolean {
  return fnv1a32(runId) % 5 === 0;
}

/**
 * Return null (= use the Beta(7,3) prior) for control-arm runs; delegate to
 * the repository for treatment-arm runs.
 *
 * This is the published seam that 4.4 (strategy wiring) and 4.5 (KPI gate
 * calibration) MUST call instead of calling the repository directly.
 * Wiring into consensus.ts is Wave C+ scope — do NOT wire it yet. This
 * function exists so the seam is typed and visible before consensus.ts is
 * touched.
 *
 * Precondition: judge, claimType, verdictDirection are valid.
 * Postcondition:
 *   - control arm (isControlArmRun(runId) = true): returns null unconditionally.
 *   - treatment arm: returns repository.getReliability(judge, claimType, direction).
 *
 * source: B-Popper-1 cross-audit finding; CC-3 implementation gate.
 * source: Fermi cross-audit, two-proportion z-test, see PHASE_4_PLAN.md §4.1
 */
export function getReliabilityForRun<
  J extends { kind: string; name: string },
  CT extends string,
  D extends string,
>(
  runId: string,
  judge: J,
  claimType: CT,
  verdictDirection: D,
  repository: {
    getReliability(judge: J, claimType: CT, verdictDirection: D): unknown;
  },
): unknown {
  if (isControlArmRun(runId)) {
    // Control arm: ignore history, use Beta(7,3) prior.
    // source: CC-3 — ε=0.20 forced exploration arm.
    return null;
  }
  return repository.getReliability(judge, claimType, verdictDirection);
}
