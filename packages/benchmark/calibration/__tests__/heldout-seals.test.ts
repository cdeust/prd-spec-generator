/**
 * Tests for heldout-seals.ts — B1 (fnv1a32 pin), B4 (schema separation).
 *
 * Coverage:
 *   B1: fnv1a32 with Math.imul — pin known hash value, verify no overflow.
 *   B4: MaxAttemptsHeldoutLockSchema — valid seal, missing-lock, unsealed template.
 *   B4: ReliabilityHeldoutLockSchema — valid v2, breakdown-mismatch, wrong version.
 *   B4: KpiGatesHeldoutLockSchema — valid with null fields (unsealed template).
 *   B4: verifyReliabilityHeldoutSeal — missing-file, bad-JSON, invalid-schema.
 *   B4: verifyKpiGatesHeldoutSeal — missing-file, valid unsealed template.
 *
 * source: Wave C integration — B1 + B4 remediation (code-reviewer audit).
 * source: docs/PHASE_4_PLAN.md §4.1, §4.2, §4.5.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  verifyMaxAttemptsHeldoutSeal,
  ReliabilityHeldoutLockSchema,
  RELIABILITY_HELDOUT_LOCK_SCHEMA_VERSION,
  verifyReliabilityHeldoutSeal,
  KpiGatesHeldoutLockSchema,
  verifyKpiGatesHeldoutSeal,
} from "../heldout-seals.js";
import { fnv1a32 } from "../calibration-seams.js";

// ─── B1: fnv1a32 with Math.imul — pin test ────────────────────────────────────

describe("fnv1a32 — B1 Math.imul correctness", () => {
  it("is deterministic for the same input", () => {
    expect(fnv1a32("test-run-1")).toBe(fnv1a32("test-run-1"));
    expect(fnv1a32("hello-world")).toBe(fnv1a32("hello-world"));
  });

  it("output is a non-negative 32-bit integer", () => {
    const h = fnv1a32("any-input");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(h)).toBe(true);
  });

  it("empty string returns the FNV offset basis (2166136261)", () => {
    // source: FNV-1a IETF draft — empty input = FNV offset basis 2166136261.
    expect(fnv1a32("")).toBe(2166136261);
  });

  it("different inputs produce different hashes", () => {
    expect(fnv1a32("abc")).not.toBe(fnv1a32("def"));
    expect(fnv1a32("run-1")).not.toBe(fnv1a32("run-2"));
  });

  it("known pin: fnv1a32('test-run-1') === 3480766147", () => {
    // Pin: computed using the reference C implementation of FNV-1a at
    // https://datatracker.ietf.org/doc/html/draft-eastlake-fnv-17
    // Verified against the Go fnv.New32a reference (matching result).
    // This test will FAIL if Math.imul is replaced with plain * multiplication,
    // confirming that overflow protection is active.
    // source: FNV-1a IETF draft; manual computation.
    expect(fnv1a32("test-run-1")).toBe(3480766147);
  });

  it("output fits in 32 bits for long strings (no overflow under Math.imul)", () => {
    // Long string whose naive `*` overflow would produce a float > 2^32.
    const longInput = "a".repeat(1000);
    const h = fnv1a32(longInput);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(h)).toBe(true);
  });
});

// ─── B4: MaxAttemptsHeldoutLockSchema ────────────────────────────────────────

describe("verifyMaxAttemptsHeldoutSeal — B4 MaxAttempts schema", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `max-attempts-seal-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws for a missing lock file", () => {
    expect(() =>
      verifyMaxAttemptsHeldoutSeal(["r1"], join(tmpDir, "missing.json")),
    ).toThrow(/lock file missing/);
  });

  it("throws for an unsealed template (null fields)", () => {
    const lockPath = join(tmpDir, "unsealed.json");
    writeFileSync(
      lockPath,
      JSON.stringify({ schema_version: 1, rng_seed: null, partition_hash: null, partition_size: null, sealed_at: null }),
    );
    expect(() => verifyMaxAttemptsHeldoutSeal(["r1"], lockPath)).toThrow(
      /unsealed template/,
    );
  });

  it("throws for a partition hash mismatch", () => {
    const lockPath = join(tmpDir, "mismatch.json");
    writeFileSync(
      lockPath,
      JSON.stringify({
        schema_version: 1,
        rng_seed: 42,
        partition_hash: "a".repeat(64),
        partition_size: 1,
        sealed_at: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(() => verifyMaxAttemptsHeldoutSeal(["r1"], lockPath)).toThrow(
      /partition hash mismatch/,
    );
  });
});

// ─── B4: ReliabilityHeldoutLockSchema (v2) ───────────────────────────────────

describe("ReliabilityHeldoutLockSchema — B4 v2 schema", () => {
  it("accepts a valid v2 lock object", () => {
    const valid = {
      schema_version: RELIABILITY_HELDOUT_LOCK_SCHEMA_VERSION,
      seed: "pre-registered-seed",
      partition_size: 40,
      sealed_at: "2026-04-27T00:00:00.000Z",
      external_grounding_breakdown: { schema: 10, math: 10, code: 10, spec: 10 },
      external_grounding_total: 40,
      external_grounding_schema_version: 1,
      claim_set_hash: "deadbeef01234567",
    };
    expect(ReliabilityHeldoutLockSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects schema_version=1 (must be 2)", () => {
    const invalid = {
      schema_version: 1,
      seed: "s",
      partition_size: 4,
      sealed_at: "2026-04-27T00:00:00.000Z",
      external_grounding_breakdown: { schema: 1, math: 1, code: 1, spec: 1 },
      external_grounding_total: 4,
      external_grounding_schema_version: 1,
      claim_set_hash: "abc",
    };
    expect(ReliabilityHeldoutLockSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects when breakdown sum !== external_grounding_total", () => {
    const invalid = {
      schema_version: RELIABILITY_HELDOUT_LOCK_SCHEMA_VERSION,
      seed: "s",
      partition_size: 40,
      sealed_at: "2026-04-27T00:00:00.000Z",
      external_grounding_breakdown: { schema: 10, math: 10, code: 10, spec: 5 },
      // sum = 35, but total = 40
      external_grounding_total: 40,
      external_grounding_schema_version: 1,
      claim_set_hash: "abc",
    };
    expect(ReliabilityHeldoutLockSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects when external_grounding_total !== partition_size", () => {
    const invalid = {
      schema_version: RELIABILITY_HELDOUT_LOCK_SCHEMA_VERSION,
      seed: "s",
      partition_size: 40,
      sealed_at: "2026-04-27T00:00:00.000Z",
      external_grounding_breakdown: { schema: 5, math: 5, code: 5, spec: 5 },
      // sum = 20, total = 20, but partition_size = 40
      external_grounding_total: 20,
      external_grounding_schema_version: 1,
      claim_set_hash: "abc",
    };
    expect(ReliabilityHeldoutLockSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("verifyReliabilityHeldoutSeal — B4", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `reliability-seal-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws for a missing file", () => {
    expect(() =>
      verifyReliabilityHeldoutSeal(join(tmpDir, "missing.json")),
    ).toThrow(/lock file not found/);
  });

  it("throws for invalid JSON", () => {
    const badPath = join(tmpDir, "bad.json");
    writeFileSync(badPath, "{ not json", "utf-8");
    expect(() => verifyReliabilityHeldoutSeal(badPath)).toThrow(
      /failed to parse lock file/,
    );
  });

  it("throws for schema-invalid lock", () => {
    const badPath = join(tmpDir, "bad-schema.json");
    writeFileSync(badPath, JSON.stringify({ schema_version: 2, seed: "s" }), "utf-8");
    expect(() => verifyReliabilityHeldoutSeal(badPath)).toThrow(
      /failed schema validation/,
    );
  });

  it("returns parsed lock for a valid v2 file", () => {
    const lockPath = join(tmpDir, "valid.json");
    const lock = {
      schema_version: RELIABILITY_HELDOUT_LOCK_SCHEMA_VERSION,
      seed: "test-seed",
      partition_size: 4,
      sealed_at: "2026-04-27T00:00:00.000Z",
      external_grounding_breakdown: { schema: 1, math: 1, code: 1, spec: 1 },
      external_grounding_total: 4,
      external_grounding_schema_version: 1,
      claim_set_hash: "deadbeef",
    };
    writeFileSync(lockPath, JSON.stringify(lock), "utf-8");
    const result = verifyReliabilityHeldoutSeal(lockPath);
    expect(result.seed).toBe("test-seed");
    expect(result.partition_size).toBe(4);
  });
});

// ─── B4: KpiGatesHeldoutLockSchema ───────────────────────────────────────────

describe("KpiGatesHeldoutLockSchema — B4 KPI-gates schema", () => {
  it("accepts a valid unsealed template (all null fields)", () => {
    const valid = {
      schema_version: 1,
      rng_seed: null,
      partition_hash: null,
      partition_size: null,
      sealed_at: null,
    };
    expect(KpiGatesHeldoutLockSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects schema_version !== 1", () => {
    const invalid = { schema_version: 2, rng_seed: null, partition_hash: null, partition_size: null, sealed_at: null };
    expect(KpiGatesHeldoutLockSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("verifyKpiGatesHeldoutSeal — B4", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `kpigates-seal-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws for a missing file", () => {
    expect(() =>
      verifyKpiGatesHeldoutSeal(join(tmpDir, "missing.json")),
    ).toThrow(/lock file not found/);
  });

  it("returns the parsed lock for a valid unsealed template", () => {
    const lockPath = join(tmpDir, "unsealed.json");
    const template = {
      schema_version: 1,
      rng_seed: null,
      partition_hash: null,
      partition_size: null,
      sealed_at: null,
    };
    writeFileSync(lockPath, JSON.stringify(template), "utf-8");
    const result = verifyKpiGatesHeldoutSeal(lockPath);
    expect(result.schema_version).toBe(1);
    expect(result.rng_seed).toBeNull();
  });
});
