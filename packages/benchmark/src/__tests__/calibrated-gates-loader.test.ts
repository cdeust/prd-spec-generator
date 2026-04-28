/**
 * Calibrated-gate loader tests — Wave D / D3.5.
 *
 * Coverage:
 *   - returns null when the file is missing.
 *   - returns null when the file is unparseable JSON.
 *   - returns null when the file fails schema validation.
 *   - returns null when `gates` is empty (unsealed-template).
 *   - returns null when no gate `passes_threshold`.
 *   - overlays calibrated values for promoted gates only; provisional values
 *     stay in effect for everything else.
 *   - getActiveKpiGates falls back to KPI_GATES when no calibrated set exists.
 *
 * source: D3.5 brief — null-on-failure semantics so provisional defaults
 * remain in effect when calibration data is missing or invalid.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadCalibratedGates,
  getActiveKpiGates,
} from "../calibrated-gates-loader.js";
import { KPI_GATES } from "../pipeline-kpis.js";

const TMP_DIR_PREFIX = join(
  tmpdir(),
  `calib-loader-test-${process.pid}-${Date.now()}`,
);
let tmpCounter = 0;
function freshTmpDir(): string {
  const dir = `${TMP_DIR_PREFIX}-${tmpCounter++}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (let i = 0; i < tmpCounter; i++) {
    const dir = `${TMP_DIR_PREFIX}-${i}`;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("loadCalibratedGates — D3.5", () => {
  it("returns null when the file does not exist", () => {
    expect(loadCalibratedGates("/nonexistent/calib.json")).toBeNull();
  });

  it("returns null on unparseable JSON", () => {
    const dir = freshTmpDir();
    const path = join(dir, "bad.json");
    writeFileSync(path, "not json {{", "utf8");
    expect(loadCalibratedGates(path)).toBeNull();
  });

  it("returns null on schema mismatch", () => {
    const dir = freshTmpDir();
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ schema_version: 99 }), "utf8");
    expect(loadCalibratedGates(path)).toBeNull();
  });

  it("returns null when gates array is empty (unsealed template)", () => {
    const dir = freshTmpDir();
    const path = join(dir, "empty.json");
    writeFileSync(
      path,
      JSON.stringify({ schema_version: 1, k_achieved: 0, gates: [] }),
      "utf8",
    );
    expect(loadCalibratedGates(path)).toBeNull();
  });

  it("returns null when no gate passed the promotion threshold", () => {
    const dir = freshTmpDir();
    const path = join(dir, "all-hold.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        k_achieved: 100,
        gates: [
          {
            gate_name: "iteration_count_max",
            calibrated: 95,
            passes_threshold: false,
          },
          {
            gate_name: "wall_time_ms_max",
            calibrated: 50,
            passes_threshold: false,
          },
        ],
      }),
      "utf8",
    );
    expect(loadCalibratedGates(path)).toBeNull();
  });

  it("overlays calibrated values for promoted gates and keeps provisional for the rest", () => {
    const dir = freshTmpDir();
    const path = join(dir, "promoted.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        k_achieved: 100,
        gates: [
          {
            gate_name: "iteration_count_max",
            calibrated: 70,
            passes_threshold: true, // promote
          },
          {
            gate_name: "wall_time_ms_max",
            calibrated: 600,
            passes_threshold: false, // hold provisional 500
          },
        ],
      }),
      "utf8",
    );
    const overlay = loadCalibratedGates(path);
    expect(overlay).not.toBeNull();
    if (!overlay) throw new Error("unreachable");
    expect(overlay.iteration_count_max).toBe(70);
    // wall_time_ms_max stayed at provisional because it did NOT pass.
    expect(overlay.wall_time_ms_max).toBe(KPI_GATES.wall_time_ms_max);
    // Other gates untouched.
    expect(overlay.error_count_max).toBe(KPI_GATES.error_count_max);
    expect(overlay.safety_cap_hit_allowed).toBe(
      KPI_GATES.safety_cap_hit_allowed,
    );
  });

  it("getActiveKpiGates returns KPI_GATES when no calibrated file exists", () => {
    const overlay = getActiveKpiGates("/nonexistent/calib.json");
    expect(overlay).toBe(KPI_GATES);
  });

  it("getActiveKpiGates returns the overlay when a valid promoted artefact exists", () => {
    const dir = freshTmpDir();
    const path = join(dir, "active.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        k_achieved: 100,
        gates: [
          {
            gate_name: "iteration_count_max",
            calibrated: 80,
            passes_threshold: true,
          },
        ],
      }),
      "utf8",
    );
    const active = getActiveKpiGates(path);
    expect(active.iteration_count_max).toBe(80);
  });

  // ─── Popper AP-1 closure — production-pilot file protection ─────────────────
  //
  // Verifies that `gate-calibration-K100-production.json` (K=5 pilot data)
  // is fully guarded by hold_provisional: true on every gate, so that no
  // future caller passing this path to the loader can accidentally promote a
  // K=5 pilot gate into the active KPI set.
  //
  // source: Popper AP-1, Wave F remediation.

  it("Popper AP-1: production-pilot file — loadCalibratedGates returns null (all gates hold_provisional)", () => {
    // Precondition: gate-calibration-K100-production.json has hold_provisional: true
    //   on every gate, including the two passes_threshold=true ones.
    // Postcondition: loadCalibratedGates returns null — no gate is promoted.
    // Invariant: the loader's hold_provisional guard (calibrated-gates-loader.ts:109)
    //   skips all gates; the result is treated as "no promoted gates" → null.
    const productionPilotPath = resolve(
      __dirname,
      "../../calibration/data/gate-calibration-K100-production.json",
    );
    const result = loadCalibratedGates(productionPilotPath);
    // null means no gates were promoted — KPI_GATES remains in effect.
    expect(result).toBeNull();
  });

  it("Popper AP-1: getActiveKpiGates with production-pilot path returns KPI_GATES unchanged", () => {
    // Precondition: same as above — all gates hold_provisional: true.
    // Postcondition: getActiveKpiGates falls back to KPI_GATES (no overlay applied).
    // Invariant: KPI thresholds are not tightened/loosened by K=5 pilot data.
    const productionPilotPath = resolve(
      __dirname,
      "../../calibration/data/gate-calibration-K100-production.json",
    );
    const active = getActiveKpiGates(productionPilotPath);
    // Must be the exact KPI_GATES object (reference equality from the fallback path).
    expect(active).toBe(KPI_GATES);
  });
});
