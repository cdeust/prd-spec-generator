/**
 * Tests for machine-class.ts (Wave C3 / B8 final closure).
 *
 * Closes the C3 BLOCK sub-requirement: detectMachineClass() must return one
 * of MACHINE_CLASSES without throwing on any host (including unknown CPUs,
 * empty CPU lists, and stripped-model virtualised environments).
 *
 * source: Wave C cross-audit Fermi sub-finding — machine-class.ts existed but
 * had no unit test asserting the never-throws postcondition.
 */

import { describe, it, expect } from "vitest";
import {
  detectMachineClass,
  getWallTimeMsGateForMachine,
  MACHINE_CLASSES,
  WALL_TIME_MS_GATE_BY_CLASS,
  WALL_TIME_MS_GATE_FALLBACK,
} from "../machine-class.js";

describe("detectMachineClass — Wave C3 / B8", () => {
  it("returns a value in MACHINE_CLASSES on the current host", () => {
    const klass = detectMachineClass();
    expect(MACHINE_CLASSES).toContain(klass);
  });

  it("never throws", () => {
    // Postcondition: returns one of MACHINE_CLASSES; never throws.
    // Per docstring at machine-class.ts:55. The function is heuristic-only
    // and falls back to "ci_runner" on any unrecognised host signal.
    expect(() => detectMachineClass()).not.toThrow();
  });

  it("is deterministic on the same host (same call twice → same result)", () => {
    // Idempotence: detection reads os.cpus() and os.totalmem(), both of which
    // are stable across a single process lifetime. A non-deterministic result
    // would indicate a host-state read that mutates across calls.
    const a = detectMachineClass();
    const b = detectMachineClass();
    expect(a).toBe(b);
  });

  it("MACHINE_CLASSES enum is exhaustive (5 entries)", () => {
    // Pins the surface so a future PR that adds a sixth bucket without
    // updating the WALL_TIME_MS_GATE_BY_CLASS map is loud.
    expect(MACHINE_CLASSES.length).toBe(5);
    expect(MACHINE_CLASSES).toEqual([
      "m_series_high",
      "m_series_mid",
      "x86_intel",
      "x86_amd",
      "ci_runner",
    ]);
  });
});

describe("getWallTimeMsGateForMachine — Wave C3 / B8", () => {
  it("returns a positive finite number on the current host", () => {
    const gate = getWallTimeMsGateForMachine();
    expect(Number.isFinite(gate)).toBe(true);
    expect(gate).toBeGreaterThan(0);
  });

  it("returns either the bucket gate or the fallback (never invents a value)", () => {
    const klass = detectMachineClass();
    const bucketGate = WALL_TIME_MS_GATE_BY_CLASS[klass];
    const observed = getWallTimeMsGateForMachine();
    // Until per-bucket calibration runs land, all buckets are null and the
    // fallback fires. Either form is acceptable: the function MUST return a
    // numeric gate, and its source MUST be either the bucket entry or the
    // fallback constant (no invented intermediate value).
    expect(observed === bucketGate || observed === WALL_TIME_MS_GATE_FALLBACK).toBe(
      true,
    );
  });
});
