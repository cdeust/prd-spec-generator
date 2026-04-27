/**
 * Gate-tuning seams — Phase 4.5 (Wave C3).
 *
 * Two seams that are logically distinct from the core observation-capture
 * pipeline (`observations.ts`) and the calibration cross-cutting concerns
 * (`calibration-seams.ts`):
 *
 *   1. Gate-blocked log appender (Curie R6 censoring mitigation): JSONL sink
 *      for KPI gate violations so threshold drift can be audited even when
 *      blocked runs do not complete the pipeline.
 *
 *   2. KPI-gates control arm seam (CC-3 / Phase 4.5): getKpiGatesForRun
 *      switches between provisional and calibrated gate sets per run_id,
 *      using the same FNV-1a partition as 4.1 and 4.2 so the arms align
 *      across all closed loops.
 *
 * Layer contract (§2.2): imports Node stdlib + observations.ts (for the
 * shared `isControlArmRun` partition predicate) + machine-class.ts (for
 * the gate-blocked log path/schema). No core / orchestration imports.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 (Phase 4 Wave C, C3 deliverable).
 * source: CC-3 control arm; Curie R6 censoring mitigation.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isControlArmRun } from "./observations.js";
import {
  GATE_BLOCKED_LOG_PATH,
  type GateBlockedLogEntry,
} from "./machine-class.js";

// ─── Gate-blocked log appender (Phase 4.5 / Curie R6) ────────────────────────

/**
 * Append one gate-blocked entry to the JSONL log.
 *
 * Called from `evaluateGates` consumers when a run produces ≥1 violation.
 * Reuses the JSONL-append pattern from `appendObservationLog` /
 * `appendDroppedClaim`. Path defaults to `GATE_BLOCKED_LOG_PATH` (gitignored).
 *
 * Precondition: `entry.run_id` is non-empty; `entry.gate_name` matches a key
 *   of KPI_GATES; `entry.machine_class` is one of MACHINE_CLASSES.
 * Postcondition: one JSONL line appended; directory created if needed.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 censoring-mitigation requirement.
 */
export function appendGateBlockedEntry(
  entry: Omit<GateBlockedLogEntry, "schema_version" | "timestamp">,
  logPath: string = GATE_BLOCKED_LOG_PATH,
): void {
  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const line: GateBlockedLogEntry = {
    ...entry,
    schema_version: 1,
    timestamp: new Date().toISOString(),
  };
  appendFileSync(logPath, JSON.stringify(line) + "\n", "utf8");
}

// ─── KPI-gates control-arm seam — CC-3 (Phase 4.5) ───────────────────────────

/**
 * Return the calibrated KPI gate set for treatment-arm runs, or the
 * provisional gate set for control-arm runs.
 *
 * Phase 4.5 IS a closed loop: calibrated thresholds gate future runs whose
 * outputs feed the next calibration cycle. CC-3 mandates a forced-exploration
 * control arm; per docs/PHASE_4_PLAN.md §CC-3, ε=0.20 (1-in-5 runs).
 *
 * The control-arm partitioning function is `isControlArmRun` so 4.1, 4.2,
 * 4.4, and 4.5 share the SAME run-arm assignment for any given run_id.
 * A run that is on the control arm for reliability is on the control arm
 * for KPI gates too — this preserves analyst ability to correlate
 * downstream metrics across all closed loops.
 *
 * Precondition: calibratedGates and provisionalGates have identical key sets
 *   (T extends a record type; same shape). Caller is responsible for keeping
 *   the two in sync.
 * Postcondition:
 *   - control arm: returns provisionalGates unchanged.
 *   - treatment arm: returns calibratedGates unchanged.
 *
 * source: CC-3 (docs/PHASE_4_PLAN.md §CC-3); Phase 4.5 closed-loop spec.
 */
export function getKpiGatesForRun<T>(
  runId: string,
  calibratedGates: T,
  provisionalGates: T,
): T {
  return isControlArmRun(runId) ? provisionalGates : calibratedGates;
}
