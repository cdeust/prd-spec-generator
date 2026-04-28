/**
 * CLI shell for the §4.5 calibration runner (Wave D / D3.1).
 *
 * Pure argv-parsing + summary-formatting. The runtime invocation point
 * imported by `calibrate-gates.ts` after the runner produces its result.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 — `pnpm calibrate:gates` re-run command.
 *
 * Layer contract (§2.2): no business logic; argv → flags + result → string[].
 */

import type {
  GateCalibrationK100,
  EventRateK50,
} from "./calibration-outputs.js";
import { EVENT_RATE_TOLERANCE } from "./calibrate-gates-constants.js";

export function parseFlag(
  argv: ReadonlyArray<string>,
  name: string,
): string | null {
  const prefix = `--${name}=`;
  for (const a of argv) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return null;
}

export function hasFlag(
  argv: ReadonlyArray<string>,
  name: string,
): boolean {
  return argv.includes(`--${name}`);
}

/**
 * Build the runner stdout summary lines.
 *
 * source: D3.1 brief — print "K achieved", per-gate provisional vs
 *   calibrated, tighten/loosen/hold, and the event-rate divergence warning.
 */
export function buildSummary(
  gc: GateCalibrationK100,
  er: EventRateK50,
): ReadonlyArray<string> {
  const lines: string[] = [
    `K achieved: ${gc.k_achieved} / ${gc.k_target}`,
    `Frozen baseline commit: ${gc.frozen_baseline_commit}`,
    `Pipeline-KPIs content hash: ${gc.frozen_baseline_content_hash}`,
    "",
    "Per-gate provisional vs calibrated:",
  ];
  for (const g of gc.gates) {
    const dir = g.would_tighten
      ? "tighten"
      : g.would_loosen
        ? "loosen"
        : "hold";
    const pass = g.passes_threshold
      ? "[PASS-THRESHOLD]"
      : "[hold-provisional]";
    lines.push(
      `  ${g.gate_name}: ${g.provisional} → ${g.calibrated.toFixed(3)} ` +
        `(${dir}) ${pass}`,
    );
  }
  lines.push(
    "",
    `Event-rate measurement (§4.2): ${er.measured_event_rate.toFixed(4)} ` +
      `(K=${er.k_observed}, attempts=${er.total_attempts}, ` +
      `events=${er.total_events})`,
    `Clopper-Pearson 95% CI: [${er.ci95_clopper_pearson.lower.toFixed(4)}, ` +
      `${er.ci95_clopper_pearson.upper.toFixed(4)}]`,
  );
  if (er.diverges_beyond_tolerance) {
    lines.push(
      `WARNING: measured event_rate diverges from provisional 0.30 by ` +
        `more than ±${EVENT_RATE_TOLERANCE}; per docs/PHASE_4_PLAN.md §4.2 ` +
        `the Schoenfeld N=823 must be recomputed via ` +
        `schoenfeldRequiredEvents() before any §4.2 study begins.`,
    );
  } else {
    lines.push(
      `Event-rate within ±${EVENT_RATE_TOLERANCE} of provisional 0.30 ` +
        `anchor — no Schoenfeld recompute required.`,
    );
  }
  return lines;
}
