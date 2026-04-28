/**
 * Calibrated-gate loader (Phase 4.5 / Wave D / D3.5).
 *
 * Reads `data/gate-calibration-K100.json` and overlays calibrated values
 * onto the provisional `KPI_GATES`. Returns `null` when the file is missing,
 * malformed, unsealed (empty `gates` array), or no gate passed the §4.5
 * promotion threshold.
 *
 * Why this file lives in `src/` (not `calibration/`):
 *   - `tsconfig.json` has `rootDir: "./src"`, so production callers in this
 *     package can only import from `src/`. The calibration runner outputs
 *     a JSON file at a stable path; the loader reads JSON + Zod-validates,
 *     no source-level dependency on the runner module.
 *   - The schema in this file is INLINE-pinned to the canonical schema in
 *     `calibration/calibration-outputs.ts::GateCalibrationK100Schema`. The
 *     pinning is enforced by the runner integration test (round-trip read).
 *
 * Layer contract (§2.2): zod (workspace dep) + Node stdlib only. No
 * imports from `calibration/` (would break the rootDir contract).
 *
 * source: docs/PHASE_4_PLAN.md §4.5 calibration outputs.
 * source: D3.5 brief — `loadCalibratedGates(): typeof KPI_GATES | null`.
 */

import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { KPI_GATES } from "./pipeline-kpis.js";

/**
 * Default canonical path to the calibration runner output, relative to the
 * monorepo root. Matches `GATE_CALIBRATION_K100_PATH` in
 * `calibration/calibration-outputs.ts` — the two MUST stay in sync.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 — `data/gate-calibration-K100.json`.
 */
export const CALIBRATED_GATES_DEFAULT_PATH =
  "packages/benchmark/calibration/data/gate-calibration-K100.json";

/**
 * Minimal runtime-validated shape mirroring `GateCalibrationK100Schema`. Only
 * the fields the loader actually consumes are validated; extra fields are
 * stripped by Zod's default object semantics.
 *
 * source: pinned to calibration/calibration-outputs.ts via the runner
 * round-trip integration test.
 */
const CalibratedGateEntrySchema = z.object({
  gate_name: z.string().min(1),
  calibrated: z.number(),
  passes_threshold: z.boolean(),
  /**
   * Wave E override: when true, skip promotion even if passes_threshold=true.
   * Used for wall_time_ms_max which was calibrated on canned-dispatcher runs
   * only and would fire gates on all production claims.
   *
   * source: PHASE_4_PLAN.md §4.5 wall_time_ms_max disposition (Wave E, option b).
   */
  hold_provisional: z.boolean().optional(),
});

const CalibratedGatesFileSchema = z.object({
  schema_version: z.literal(1),
  k_achieved: z.number().int().nonnegative(),
  gates: z.array(CalibratedGateEntrySchema),
});

/**
 * Load and validate `gate-calibration-K100.json`. Returns the calibrated
 * `KPI_GATES`-shaped object on success, or `null` when:
 *   - the file does not exist,
 *   - the file fails schema validation or JSON parse,
 *   - the file's `gates` array is empty (unsealed-template state),
 *   - no gate passed the §4.5 promotion threshold.
 *
 * Per docs/PHASE_4_PLAN.md §4.5: a calibrated gate is promoted ONLY when its
 * `passes_threshold === true` (95% CI excludes the provisional value AND
 * the divergence is ≥ ±5% relative). Mixed sets return a partial overlay
 * onto `KPI_GATES` — every gate retains its provisional value unless
 * explicitly promoted.
 *
 * Precondition: none.
 * Postcondition: when non-null, the returned object has the same key set as
 *   `KPI_GATES` and every value type matches the corresponding KPI_GATES
 *   value type (number for numeric gates, boolean for safety_cap_hit_allowed).
 *
 * source: D3.5 brief — null-on-failure semantics so provisional defaults stay
 *   in effect when calibration data is missing or invalid.
 */
export function loadCalibratedGates(
  path: string = CALIBRATED_GATES_DEFAULT_PATH,
): typeof KPI_GATES | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const parsed = CalibratedGatesFileSchema.safeParse(raw);
  if (!parsed.success) return null;
  const file = parsed.data;
  if (file.gates.length === 0) return null;
  let promotedAny = false;
  const overlay: Record<string, number | boolean> = { ...KPI_GATES };
  for (const g of file.gates) {
    if (!g.passes_threshold) continue;
    // Wave E: hold_provisional blocks auto-promotion regardless of passes_threshold.
    // FAILS_ON: hold_provisional=true with passes_threshold=true — gate is skipped.
    if (g.hold_provisional === true) continue;
    if (!(g.gate_name in KPI_GATES)) continue;
    const provisional = (
      KPI_GATES as Readonly<Record<string, number | boolean>>
    )[g.gate_name];
    // Boolean gates (safety_cap_hit_allowed) are special-cause defects per
    // §4.5 and are NOT calibrated against the canned baseline.
    if (typeof provisional === "boolean") continue;
    overlay[g.gate_name] = g.calibrated;
    promotedAny = true;
  }
  if (!promotedAny) return null;
  return overlay as unknown as typeof KPI_GATES;
}

/**
 * Production startup hook. Returns the calibrated gates when a valid
 * promoted artefact exists at `CALIBRATED_GATES_DEFAULT_PATH`; otherwise
 * the provisional `KPI_GATES`.
 *
 * Synthetic / regression tests should NOT use this hook — they import
 * `KPI_GATES` directly so they remain anchored to the provisional values
 * (per gate-tuning-regression.test.ts).
 *
 * source: D3.5 brief — startup hook for production callers.
 */
export function getActiveKpiGates(
  path: string = CALIBRATED_GATES_DEFAULT_PATH,
): typeof KPI_GATES {
  return loadCalibratedGates(path) ?? KPI_GATES;
}
