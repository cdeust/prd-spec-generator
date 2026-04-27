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
 * One observation row: a single judge's verdict on a single claim, with the
 * ground truth when known.
 *
 * Fields:
 *   run_id        — pipeline run that produced this observation.
 *   judge_id      — agentKey format: "<kind>:<name>" (matches consensus.ts agentKey).
 *   claim_id      — stable claim identifier (e.g., "FR-001").
 *   claim_type    — the Claim.claim_type enum value.
 *   judge_verdict — true = PASS-class; false = FAIL-class. See verdictIsPass().
 *   judge_confidence — raw confidence from JudgeVerdict [0, 1].
 *   ground_truth  — true/false if this claim is in the golden set; "unknown"
 *                   if it is not (observations with "unknown" do NOT feed the
 *                   Beta-Binomial update until resolved).
 */
export interface JudgeObservation {
  readonly run_id: string;
  readonly judge_id: string;
  readonly claim_id: string;
  readonly claim_type: Claim["claim_type"];
  readonly judge_verdict: boolean;
  readonly judge_confidence: number;
  readonly ground_truth: boolean | "unknown";
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

    const judge_id = `${v.judge.kind}:${v.judge.name}`;
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
