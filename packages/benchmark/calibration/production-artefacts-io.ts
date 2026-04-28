/**
 * Production-mode artefact I/O + summary formatting.
 *
 * Extracted from `calibrate-gates-production.ts` in the Wave F final
 * remediation (2026-04-28) to keep that file under the §4.1 500-LOC cap.
 * This module owns the side-effecting concerns (event-rate K=N driver,
 * filesystem writes, summary-line formatting); the parent file owns the
 * orchestration and gate-math.
 *
 * source: Wave F code-reviewer extraction; coding-standards.md §4.1.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import type { ProductionDispatcher } from "@prd-gen/orchestration";
import { clopperPearson } from "./clopper-pearson.js";
import { measureEventRate } from "./event-rate.js";
import type { EventRateK50 } from "./calibration-outputs.js";
import {
  PRE_REGISTERED_SEED_42,
  EVENT_RATE_TOLERANCE,
  PROVISIONAL_EVENT_RATE,
} from "./calibrate-gates-constants.js";
import {
  driveProductionRuns,
  type ProductionGateCalibration,
  type ProductionRunnerOptions,
  type XmrFile,
  PRODUCTION_OUTPUT_BASENAME,
} from "./calibrate-gates-production.js";

/**
 * Drive the K=N event-rate measurement run + assemble the EventRateK50
 * artefact. The seed is fixed to PRE_REGISTERED_SEED_42 (separate from the
 * gate-calibration seed) so the two measurements remain independent.
 */
export function buildProductionEventRateArtefact(
  options: ProductionRunnerOptions,
  headCommit: string,
  nowIso: string,
  dispatch: ProductionDispatcher,
): Promise<EventRateK50> {
  return driveProductionRuns({
    k: options.eventRateK,
    seed: PRE_REGISTERED_SEED_42,
    runIdPrefix: "phase42-eventrate-prod",
    featureDescription: options.featureDescription,
    codebasePath: options.codebasePath,
    dispatch,
  }).then((eventRateKpis) => {
    const { totalAttempts, events } = measureEventRate(eventRateKpis);
    const measuredRate = totalAttempts > 0 ? events / totalAttempts : 0;
    const cp =
      totalAttempts > 0
        ? clopperPearson(events, totalAttempts, 0.95)
        : { lower: 0, upper: 0, pointEstimate: 0 };
    const diverges =
      Math.abs(measuredRate - PROVISIONAL_EVENT_RATE) > EVENT_RATE_TOLERANCE;
    return {
      schema_version: 1,
      commit_hash: headCommit,
      seed_used: PRE_REGISTERED_SEED_42,
      timestamp: nowIso,
      k_target: options.eventRateK,
      k_observed: eventRateKpis.length,
      total_attempts: totalAttempts,
      total_events: events,
      measured_event_rate: measuredRate,
      ci95_clopper_pearson: { lower: cp.lower, upper: cp.upper },
      provisional_anchor: PROVISIONAL_EVENT_RATE,
      diverges_beyond_tolerance: diverges,
      recompute_recommended: diverges,
    };
  });
}

/** Write the gate-calibration + event-rate + per-gate XmR artefacts. */
export function persistProductionArtefacts(
  result: {
    gateCalibration: ProductionGateCalibration;
    eventRate: EventRateK50;
    xmrFiles: ReadonlyArray<XmrFile>;
  },
  outputDir: string,
): void {
  const gatePath = join(outputDir, PRODUCTION_OUTPUT_BASENAME);
  if (!existsSync(dirname(gatePath))) {
    mkdirSync(dirname(gatePath), { recursive: true });
  }
  writeFileSync(
    gatePath,
    JSON.stringify(result.gateCalibration, null, 2) + "\n",
    "utf8",
  );
  // Event-rate artefact also lands in a non-canned filename.
  const erPath = join(outputDir, "event-rate-K50-production.json");
  writeFileSync(
    erPath,
    JSON.stringify(result.eventRate, null, 2) + "\n",
    "utf8",
  );
  for (const xmr of result.xmrFiles) {
    const dir = dirname(xmr.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      xmr.path,
      JSON.stringify(xmr.record, null, 2) + "\n",
      "utf8",
    );
  }
}

/** Resolve the current `git HEAD` commit for the artefact attribution. */
export function resolveHeadCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Pretty-print a one-screen summary of the production calibration. */
export function buildProductionSummary(args: {
  gc: ProductionGateCalibration;
  er: EventRateK50;
}): ReadonlyArray<string> {
  const { gc, er } = args;
  const lines: string[] = [
    `[production-mode] data_source=${gc.data_source}`,
    `[production-mode] agent_invoker_class=${gc.agent_invoker_class}`,
    `K achieved: ${gc.k_achieved} / ${gc.k_target}`,
    `Frozen baseline commit: ${gc.frozen_baseline_commit}`,
    `Pipeline-KPIs content hash: ${gc.frozen_baseline_content_hash}`,
    "",
    "Per-gate provisional vs calibrated (production):",
  ];
  for (const g of gc.gates) {
    const dir = g.would_tighten
      ? "tighten"
      : g.would_loosen
        ? "loosen"
        : "hold";
    lines.push(
      `  ${g.gate_name}: ${g.provisional} → ${g.calibrated.toFixed(3)} (${dir})`,
    );
  }
  lines.push(
    "",
    `Event-rate (production K=${er.k_observed}): ${er.measured_event_rate.toFixed(4)}`,
    `CI95: [${er.ci95_clopper_pearson.lower.toFixed(4)}, ${er.ci95_clopper_pearson.upper.toFixed(4)}]`,
  );
  return lines;
}
