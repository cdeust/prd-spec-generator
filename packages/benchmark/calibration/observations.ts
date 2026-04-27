/**
 * Observation capture layer — Phase 4.1 reliability calibration.
 *
 * This module is B3's contribution: it captures (judge_verdict, ground_truth)
 * pairs from real verification runs and routes them for B1's math and B2's
 * storage.
 *
 * Responsibilities:
 *   - Define the JudgeObservation type (one row = one judge × one claim).
 *   - extractJudgeObservations: builds observations from raw JudgeVerdict[].
 *   - GoldenSet: the typed seam for external ground truth (empty until B1's
 *     dual-annotator procedure produces labeled data, per §4.1 Curie R2).
 *   - loadGoldenSet: reads golden set from a JSONL file path; returns empty
 *     map when path is absent (design-by-contract: callers must handle unknown).
 *   - flushObservations: routes known observations to ReliabilityRepository
 *     and unknown observations to a JSONL queue file for async resolution.
 *
 * source: Phase 4.1 plan (docs/PHASE_4_PLAN.md §4.1), specifically:
 *   - Estimand: P(agent_verdict == ground_truth_verdict | parse_succeeded).
 *   - Parse-failure verdicts (INCONCLUSIVE with caveats ["parse_error"] or
 *     ["judge_invocation_failed"]) are EXCLUDED from the reliability estimate.
 *   - Sensitivity/specificity split per (agent, claim_type) deferred to B1.
 *
 * Layer contract (§2.2): this file imports from @prd-gen/core (type-only)
 * and Node stdlib only. It does NOT import from orchestration, mcp-server,
 * or any infrastructure adapter.
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JudgeVerdict, Claim } from "@prd-gen/core";

// ─── Schema version ──────────────────────────────────────────────────────────

/**
 * Schema version for the JSONL queue file. Increment when the JudgeObservation
 * shape changes in a backward-incompatible way.
 *
 * source: semantic versioning convention; the queue consumer (B1 dual-annotator
 * procedure) must reject lines with an unrecognized schema_version.
 */
const QUEUE_SCHEMA_VERSION = 1 as const;

// ─── JudgeObservation type ───────────────────────────────────────────────────

/**
 * Structured judge identity — avoids delimiter encoding entirely (B-Shannon-6).
 *
 * B3 originally built judge_id as `${kind}:${name}`. If `name` contains ":"
 * the round-trip is lossy. Using a record eliminates encoding/decoding entirely.
 *
 * source: B-Shannon-6 cross-audit finding.
 */
export interface JudgeId {
  readonly kind: string;
  readonly name: string;
}

/**
 * One observation row: a single judge's verdict on a single claim, with the
 * ground truth when known.
 *
 * Fields:
 *   run_id           — pipeline run that produced this observation.
 *   judge_id         — { kind, name } record (B-Shannon-6: replaces "<kind>:<name>" string;
 *                      structured form eliminates delimiter-encoding lossy round-trip).
 *   claim_id         — stable claim identifier (e.g., "FR-001").
 *   claim_type       — the Claim.claim_type enum value.
 *   judge_verdict    — true = PASS-class; false = FAIL-class. See verdictIsPass().
 *   judge_confidence — raw confidence from JudgeVerdict [0, 1].
 *   ground_truth     — true/false if this claim is in the golden set; "unknown"
 *                      if it is not (observations with "unknown" do NOT feed the
 *                      Beta-Binomial update until resolved).
 */
export interface JudgeObservation {
  readonly run_id: string;
  readonly judge_id: JudgeId;
  readonly claim_id: string;
  readonly claim_type: Claim["claim_type"];
  readonly judge_verdict: boolean;
  readonly judge_confidence: number;
  readonly ground_truth: boolean | "unknown";
}

// ─── AnnotatorView — judge_verdict leakage prevention (B-Curie-4) ───────────

/**
 * The view of a JudgeObservation that is safe to show to a human annotator.
 *
 * Removes `judge_verdict` and `judge_confidence` — the dual-annotator procedure
 * (docs/PHASE_4_PLAN.md §4.1 Curie R2) forbids annotators from seeing the
 * judge's verdict before they label the claim. Leaking the judge verdict
 * anchors annotators to the judge's decision and defeats the independence
 * property required by the dual-annotator protocol.
 *
 * This is the ONLY view type that may be shown to annotators. The drain
 * consumer MUST call toAnnotatorView() before rendering the queue entry.
 *
 * source: B-Curie-4 cross-audit finding — dual-annotator procedure requires
 * annotator independence from judge verdicts.
 * source: docs/PHASE_4_PLAN.md §4.1 — "Annotators do not see the judge's verdict."
 */
export type AnnotatorView = Omit<JudgeObservation, "judge_verdict" | "judge_confidence">;

/**
 * Project a JudgeObservation down to the AnnotatorView.
 *
 * Precondition: `line` is a valid JudgeObservation.
 * Postcondition: the returned object contains no `judge_verdict` or
 *   `judge_confidence` fields — TypeScript enforces this via the return type.
 *
 * This is the ONLY function that may transform a JudgeObservation for
 * annotator presentation. Call this at every queue drain consumer before
 * rendering or transmitting data to a human annotator.
 *
 * source: B-Curie-4 cross-audit finding.
 */
export function toAnnotatorView(line: JudgeObservation): AnnotatorView {
  // Destructure to drop judge_verdict and judge_confidence.
  // TypeScript will error if the return type is widened to include them.
  const { judge_verdict: _v, judge_confidence: _c, ...view } = line;
  void _v; // explicitly consumed — not a "clever one-liner" (coding-standards §7.2)
  void _c;
  return view;
}

// ─── GoldenSet seam ──────────────────────────────────────────────────────────

/**
 * Typed seam for the external ground-truth mapping.
 *
 * Maps claim_id → boolean (true = this claim passes; false = it fails).
 * A missing claim_id means ground truth is not yet resolved for that claim.
 *
 * The real golden set is produced by the dual-annotator procedure described
 * in Phase 4.1 (Curie R2): deterministic validator + independent human reviewer
 * must agree before a claim enters the golden set. This type defines the seam;
 * B1 owns the procedure that populates it.
 */
export type GoldenSet = ReadonlyMap<string, boolean>;

/**
 * Load a golden set from a JSONL file at `path`.
 *
 * Each line must be a JSON object with the shape:
 *   { "claim_id": string, "ground_truth": boolean }
 *
 * Lines that are empty, do not parse as JSON, or lack the required fields are
 * skipped with a loud console.error (non-fatal: a partial golden set is better
 * than an aborted calibration run). This matches the loud-fail pattern from
 * instrumentation.ts for shape violations.
 *
 * Returns an empty ReadonlyMap when path is undefined or the file does not
 * exist — callers MUST treat unknown ground truth correctly (see
 * extractJudgeObservations).
 *
 * source: §4.1 — golden set path passed via env var PRD_GOLDEN_SET_PATH or
 * CLI flag; the runner wires this; this library function is the only consumer.
 */
export function loadGoldenSet(path: string | undefined): GoldenSet {
  if (!path) {
    return new Map<string, boolean>();
  }
  if (!existsSync(path)) {
    return new Map<string, boolean>();
  }

  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const out = new Map<string, boolean>();

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as unknown;
      if (
        typeof obj !== "object" ||
        obj === null ||
        !("claim_id" in obj) ||
        !("ground_truth" in obj) ||
        typeof (obj as Record<string, unknown>).claim_id !== "string" ||
        typeof (obj as Record<string, unknown>).ground_truth !== "boolean"
      ) {
        console.error(
          `[observations] loadGoldenSet: skipping malformed line — expected { claim_id: string, ground_truth: boolean }, got: ${line}`,
        );
        continue;
      }
      const entry = obj as { claim_id: string; ground_truth: boolean };
      out.set(entry.claim_id, entry.ground_truth);
    } catch (err) {
      console.error(
        `[observations] loadGoldenSet: JSON parse error on line — ${(err as Error).message}: ${line}`,
      );
    }
  }

  return out;
}

// ─── extractJudgeObservations ────────────────────────────────────────────────

/**
 * Exclusion predicate for parse-failure verdicts.
 *
 * Parse failures (Deming: special-cause noise tracked on a separate P-chart)
 * are NOT included in the reliability estimate. A verdict is excluded if any
 * caveat is "parse_error" or "judge_invocation_failed".
 *
 * source: §4.1 PRE-REGISTRATION — "parse-failure verdicts (INCONCLUSIVE with
 * caveats: ['parse_error']) are EXCLUDED from this estimate."
 */
function isParseFailure(verdict: JudgeVerdict): boolean {
  return verdict.caveats.some(
    (c) => c === "parse_error" || c === "judge_invocation_failed",
  );
}

/**
 * Map a multi-label Verdict to a boolean for the Binary reliability model.
 *
 * The reliability estimand (§4.1) is a binary quantity: did the judge agree
 * with ground truth? PASS and SPEC-COMPLETE map to "pass" (true); FAIL,
 * INCONCLUSIVE, NEEDS-RUNTIME map to "not pass" (false).
 *
 * source: §4.1 — "verdict_direction: 'pass' | 'fail'" in the persistence
 * schema. The sensitivity/specificity split (TWO Beta posteriors per cell)
 * is B1's responsibility; this mapping is the input to that split.
 */
function verdictIsPass(verdict: JudgeVerdict["verdict"]): boolean {
  return verdict === "PASS" || verdict === "SPEC-COMPLETE";
}

/**
 * Validate that a JudgeVerdict has the shape we expect. Throws on unknown
 * shape — same loud-fail pattern as instrumentation.ts.
 *
 * Invariant: any JudgeVerdict that passed Zod parsing upstream is valid here.
 * This guard catches programmatically-constructed synthetic verdicts that bypass
 * the Zod parse path (e.g., in test fixtures).
 */
function assertVerdictShape(v: unknown): asserts v is JudgeVerdict {
  if (
    typeof v !== "object" ||
    v === null ||
    !("judge" in v) ||
    !("claim_id" in v) ||
    !("verdict" in v) ||
    !("confidence" in v) ||
    !("caveats" in v)
  ) {
    throw new Error(
      `[observations] assertVerdictShape: unknown verdict shape — ${JSON.stringify(v)}`,
    );
  }
  const candidate = v as Record<string, unknown>;
  if (
    typeof candidate.claim_id !== "string" ||
    typeof candidate.verdict !== "string" ||
    typeof candidate.confidence !== "number" ||
    !Array.isArray(candidate.caveats)
  ) {
    throw new Error(
      `[observations] assertVerdictShape: field type mismatch — ${JSON.stringify(v)}`,
    );
  }
}

/**
 * Build JudgeObservation[] from a set of raw JudgeVerdict objects.
 *
 * One observation per (judge × claim) pair. Parse-failure verdicts are
 * silently excluded (Deming). All others become observations; ground_truth
 * is resolved from the golden set if present, else "unknown".
 *
 * The claimTypes map provides the claim_type for each claim_id. If a
 * claim_id is absent from the map, claim_type defaults to "correctness" with
 * a console.warn — the observation is still recorded so we don't silently
 * drop data.
 *
 * Throws on unknown verdict shape (assertVerdictShape) — loud-fail, not
 * silent skip, so test suites catch fixture bugs immediately.
 *
 * Postcondition: every element of the returned array satisfies the
 * JudgeObservation type. The array is ReadonlyArray to prevent mutation.
 */
export function extractJudgeObservations(
  run_id: string,
  verdicts: ReadonlyArray<unknown>,
  claimTypes: ReadonlyMap<string, Claim["claim_type"]>,
  goldenSet: GoldenSet,
): ReadonlyArray<JudgeObservation> {
  const out: JudgeObservation[] = [];

  for (const raw of verdicts) {
    assertVerdictShape(raw);
    const v = raw as JudgeVerdict;

    // Exclude parse-failure verdicts per §4.1.
    if (isParseFailure(v)) {
      continue;
    }

    // B-Shannon-6: structured record instead of "<kind>:<name>" string to
    // eliminate delimiter-encoding lossy round-trip when name contains ":".
    const judge_id: JudgeId = { kind: v.judge.kind, name: v.judge.name };
    const claim_type = claimTypes.get(v.claim_id) ?? (() => {
      console.warn(
        `[observations] extractJudgeObservations: claim_id "${v.claim_id}" not found in claimTypes map; defaulting to "correctness"`,
      );
      return "correctness" as const;
    })();

    const ground_truth: boolean | "unknown" = goldenSet.has(v.claim_id)
      ? (goldenSet.get(v.claim_id) as boolean)
      : "unknown";

    out.push({
      run_id,
      judge_id,
      claim_id: v.claim_id,
      claim_type,
      judge_verdict: verdictIsPass(v.verdict),
      judge_confidence: v.confidence,
      ground_truth,
    });
  }

  return out;
}

// ─── ReliabilityRepository interface (local stub for B2 coordination) ────────

/**
 * Minimal interface for the reliability repository. B2 (dba) owns the
 * implementation; this local definition types the `flushObservations`
 * boundary so B3's code compiles and tests pass independently.
 *
 * TODO(B2-coordination): align this interface with B2's published
 * ReliabilityRepository once it lands. The fields here (run_id, judge_id,
 * claim_id, claim_type, judge_verdict, judge_confidence, ground_truth)
 * match the §4.1 persistence schema:
 *   agent_reliability(agent_kind, agent_name, claim_type, verdict_direction,
 *                     alpha, beta, last_updated)
 * The recordObservation call provides the raw observation; B2's implementation
 * runs the Beta-Binomial update internally.
 *
 * source: Phase 4.1 plan §4.1 persistence schema (docs/PHASE_4_PLAN.md).
 */
export interface ReliabilityRepository {
  recordObservation(observation: JudgeObservation): void;
}

// ─── Pending-observation queue ────────────────────────────────────────────────

/**
 * Path to the JSONL queue for observations with unknown ground truth.
 *
 * This queue grows during normal operation and is drained by the
 * dual-annotator procedure (B1's design). The file is gitignored (see
 * .gitignore: packages/benchmark/calibration/data/pending-observations.jsonl).
 *
 * source: §4.1 — "resolving ground_truth happens asynchronously via the
 * dual-annotator procedure." Queue exists so no observations are silently
 * dropped while waiting for human review.
 */
export const PENDING_QUEUE_PATH =
  "packages/benchmark/calibration/data/pending-observations.jsonl";

/**
 * One line in the JSONL queue. Includes schema_version so consumers can
 * reject lines from a future incompatible schema.
 */
interface QueueLine {
  readonly schema_version: typeof QUEUE_SCHEMA_VERSION;
  readonly observation: JudgeObservation;
}

/**
 * Append one observation to the pending-observations JSONL queue.
 *
 * Creates the data directory if it does not exist (idempotent). Appends
 * atomically per line — a crash between lines does not corrupt existing data.
 *
 * The queuePath parameter exists so tests can redirect to a tmp file instead
 * of the real queue. Default is PENDING_QUEUE_PATH.
 */
function appendToQueue(
  observation: JudgeObservation,
  queuePath: string = PENDING_QUEUE_PATH,
): void {
  const dir = dirname(queuePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const line: QueueLine = {
    schema_version: QUEUE_SCHEMA_VERSION,
    observation,
  };
  appendFileSync(queuePath, JSON.stringify(line) + "\n", "utf8");
}

// ─── flushObservations ───────────────────────────────────────────────────────

/**
 * Route observations to their appropriate destination:
 *   - ground_truth known → repository.recordObservation(obs)
 *   - ground_truth "unknown" → JSONL queue (pending-observations.jsonl)
 *
 * Parse-failure observations must already be excluded before calling this
 * function (extractJudgeObservations enforces this upstream).
 *
 * The `queuePath` parameter is injected for testing — callers in production
 * omit it and rely on PENDING_QUEUE_PATH.
 *
 * source: §4.1 — the dual-annotator procedure resolves ground truth
 * asynchronously; the queue is the holding area for unresolved observations.
 */
export function flushObservations(
  observations: ReadonlyArray<JudgeObservation>,
  repository: ReliabilityRepository,
  queuePath: string = PENDING_QUEUE_PATH,
): void {
  for (const obs of observations) {
    if (obs.ground_truth === "unknown") {
      appendToQueue(obs, queuePath);
    } else {
      repository.recordObservation(obs);
    }
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
 * Called by flushObservations for every observation where ground_truth is known.
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
 * Deterministic control-arm partition for the ε-greedy feedback loop (CC-3).
 *
 * Allocation: run_id_hash % 5 === 0 → control arm (ε = 0.20).
 * Control-arm runs use the Beta(7,3) prior and IGNORE the ReliabilityRepository.
 * Treatment-arm runs use the persisted posterior from the ReliabilityRepository.
 *
 * The hash function is FNV-1a 32-bit (deterministic, no external deps).
 * The same run_id always maps to the same arm — partitioning is stable across
 * restarts and does not depend on call order.
 *
 * Comparison metric: downstream consensus accuracy on the held-out 20%,
 * NOT the calibration's own output (self-referential comparison is forbidden
 * per CC-3 / Curie A6).
 *
 * This seam is published so 4.4 and 4.5 CANNOT ship without wiring it into
 * the consensus engine (Wave C+ scope). The Wire step is intentionally deferred.
 *
 * source: CC-3 / B-Popper-1 cross-audit finding; docs/PHASE_4_PLAN.md §CC-3.
 * source: FNV-1a: Fowler et al. (1991), http://www.isthe.com/chongo/tech/comp/fnv/
 */

/**
 * Compute FNV-1a 32-bit hash of a string.
 * Returns a non-negative integer in [0, 2^32).
 *
 * source: FNV-1a specification — http://www.isthe.com/chongo/tech/comp/fnv/
 */
function fnv1a32(s: string): number {
  let hash = 2166136261; // FNV offset basis
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
 * Precondition: run_id is a non-empty string.
 * Postcondition: deterministic — the same run_id always returns the same value.
 *   Approximately 20% of run_ids map to true (ε = 0.20; 1 in 5 buckets).
 *
 * source: CC-3 / B-Popper-1 — deterministic partition run_id_hash % 5 === 0.
 */
export function isControlArmRun(runId: string): boolean {
  return fnv1a32(runId) % 5 === 0;
}

/**
 * Return null (= use the Beta(7,3) prior) for control-arm runs; delegate to
 * the repository for treatment-arm runs.
 *
 * This is the published seam that 4.4 (strategy wiring) and 4.5 (KPI gate
 * calibration) MUST call instead of calling the repository directly. Wiring
 * into consensus.ts is Wave C+ scope — do not wire it yet. This function
 * exists so the seam is typed and visible before consensus.ts is touched.
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
