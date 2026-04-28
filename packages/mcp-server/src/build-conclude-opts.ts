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
import {
  appendObservationLog,
  JUDGE_OBSERVATION_LOG_PATH,
} from "@prd-gen/benchmark";
import {
  type ConcludeOptions,
} from "@prd-gen/verification";
import {
  getReliabilityRepo,
  getConsensusReliabilityProvider,
} from "./reliability-wiring.js";

export interface BuildConcludeOptsInput {
  readonly consensus_strategy: ConcludeOptions["strategy"];
  readonly run_id?: string;
  readonly claim_types?: Record<string, string>;
}

export function buildConcludeOpts(input: BuildConcludeOptsInput): ConcludeOptions {
  const { consensus_strategy, run_id, claim_types } = input;
  const reliabilityRepo = getReliabilityRepo();
  const reliabilityProvider = getConsensusReliabilityProvider();

  // B5 — Loud diagnostic when claim_types omitted (Curie A3).
  // FAILS_ON: claim_types undefined AND reliabilityRepo open — observations
  //   are silently dropped (claimTypesMap=undefined disables onObservation).
  //   This produces one-sided censoring: runs without claim_types appear to
  //   have no ground-truth signal in the calibration repository even though
  //   the run completed. Warn loudly so operators can fix the caller.
  if (claim_types === undefined && reliabilityRepo !== null) {
    console.warn(
      "[reliability] WARNING: conclude_verification called without claim_types" +
      " — observations will NOT be flushed to the calibration repository for" +
      " this batch. This may produce one-sided censoring across runs.",
    );
  }

  const claimTypesMap = claim_types !== undefined
    ? new Map(Object.entries(claim_types) as [string, string][])
    : undefined;

  // CC-3 control-arm semantics:
  // - getReliabilityForRun returns null on control-arm runs (read-side break).
  // - onObservation fires on ALL runs, INCLUDING control-arm runs (write-side
  //   contributes prior-weighted ground-truth observations to the calibration
  //   pool). This asymmetry is by design: the control arm produces unbiased
  //   training signal that the treatment arm cannot.
  // source: Curie cross-audit Wave D, A1 anomaly resolution.
  const onObservation = reliabilityRepo !== null && claimTypesMap !== undefined
    ? (obs: Parameters<NonNullable<ConcludeOptions["onObservation"]>>[0]) => {
        try {
          reliabilityRepo.recordObservation(
            obs.judge,
            obs.claimType,
            obs.observation,
          );
          // judge_verdict = true ↔ judge's verdict is PASS-class.
          // When gt=PASS: judgeWasCorrect=true ↔ judge said PASS.
          // When gt=FAIL: judgeWasCorrect=true ↔ judge said FAIL.
          const judgeVerdictIsPass = !obs.observation.groundTruthIsFail
            ? obs.observation.judgeWasCorrect
            : !obs.observation.judgeWasCorrect;
          appendObservationLog(
            {
              run_id: run_id ?? "unknown",
              judge_id: { kind: obs.judge.kind, name: obs.judge.name },
              claim_id: obs.claim_id,
              claim_type: obs.claimType,
              judge_verdict: judgeVerdictIsPass,
              judge_confidence: 0,
              ground_truth: obs.observation.groundTruthIsFail,
            },
            JUDGE_OBSERVATION_LOG_PATH,
          );
        } catch {
          // Best-effort: observation persistence must not break the pipeline.
        }
      }
    : undefined;

  return {
    strategy: consensus_strategy,
    reliabilityProvider: reliabilityProvider ?? undefined,
    runId: run_id,
    claimTypes: claimTypesMap as
      | ReadonlyMap<string, Claim["claim_type"]>
      | undefined,
    onObservation,
  };
}
