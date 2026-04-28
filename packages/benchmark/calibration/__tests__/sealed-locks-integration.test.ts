/**
 * Integration test — E3.D sealed-locks against verify functions at production
 * call sites. Confirms each lock's verify-API behavior on the actual committed
 * lock files:
 *
 *   §4.2  verifyMaxAttemptsHeldoutSeal(observed_run_ids, lockPath)  → returns void
 *   §4.5  verifyKpiGatesHeldoutSeal(lockPath)                        → returns lock
 *   §4.1  verifyReliabilityHeldoutSeal(lockPath)                     → THROWS
 *
 * The §4.1 throw is by design — the partition is partial-sealed (E2 oracle
 * wiring incomplete) and verifyReliabilityHeldoutSeal is the AP-5 mechanical
 * enforcement that prevents premature §4.1 study execution.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 / §4.2 / §4.5 sealing procedure
 * source: heldout-seals.ts verify* functions
 * source: calibrate-gates.ts driveRuns — Mulberry32 reproduces run_ids
 */

import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  verifyMaxAttemptsHeldoutSeal,
  verifyKpiGatesHeldoutSeal,
  verifyReliabilityHeldoutSeal,
} from "../heldout-seals.js";

// ─── Mulberry32 — copied from calibrate-gates.ts to reproduce run_ids. ───
// source: Tommy Ettinger, "Mulberry32" (2017). Period 2^32.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

const PRE_REGISTERED_SEED_45 = 0x4_05_c3;
const PRE_REGISTERED_SEED_42 = 4_020_704;
const K = 100;

function generateRunIds(prefix: string, seed: number, k: number): string[] {
  const rng = mulberry32(seed);
  const ids: string[] = [];
  for (let i = 0; i < k; i++) {
    const id = `${prefix}-${i}-${Math.floor(rng() * 0xffffffff)
      .toString(16)
      .padStart(8, "0")}`;
    ids.push(id);
  }
  return ids;
}

function partition8020(allIds: readonly string[], seed: number): string[] {
  const rng = mulberry32(seed);
  const arr = [...allIds];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.floor(arr.length * 0.2));
}

function sha256SortedJoin(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(TEST_DIR, "..", "data"); // packages/benchmark/calibration/data

// ─── E3.D.1 §4.2 max-attempts seal verifies cleanly ─────────────────────
describe("E3.D — §4.2 verifyMaxAttemptsHeldoutSeal accepts the sealed lock", () => {
  it("does not throw on the committed sealed lock with the recomputed held-out run_ids", () => {
    const allRunIds = generateRunIds("phase45-calib", PRE_REGISTERED_SEED_45, K);
    const heldout = partition8020(allRunIds, PRE_REGISTERED_SEED_42);
    const lockPath = join(DATA_DIR, "maxattempts-heldout.lock.json");
    expect(() =>
      verifyMaxAttemptsHeldoutSeal(heldout, lockPath),
    ).not.toThrow();
  });

  it("throws when an unrelated run_id list is presented (partition-hash mismatch)", () => {
    const wrongIds = ["a", "b", "c"];
    const lockPath = join(DATA_DIR, "maxattempts-heldout.lock.json");
    expect(() =>
      verifyMaxAttemptsHeldoutSeal(wrongIds, lockPath),
    ).toThrow(/partition hash mismatch/);
  });

  it("the committed partition_hash matches sha256(sorted(heldout-runids))", () => {
    const allRunIds = generateRunIds("phase45-calib", PRE_REGISTERED_SEED_45, K);
    const heldout = partition8020(allRunIds, PRE_REGISTERED_SEED_42);
    const expected = sha256SortedJoin(heldout);
    const lockPath = join(DATA_DIR, "maxattempts-heldout.lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
      partition_hash: string;
      partition_size: number;
      rng_seed: number;
    };
    expect(lock.partition_hash).toBe(expected);
    expect(lock.partition_size).toBe(heldout.length);
    expect(lock.rng_seed).toBe(PRE_REGISTERED_SEED_42);
  });
});

// ─── E3.D.2 §4.5 KPI-gates seal verifies cleanly ────────────────────────
describe("E3.D — §4.5 verifyKpiGatesHeldoutSeal accepts the sealed lock", () => {
  it("does not throw and returns a populated lock", () => {
    const lockPath = join(DATA_DIR, "kpigates-heldout.lock.json");
    expect(() => verifyKpiGatesHeldoutSeal(lockPath)).not.toThrow();
    const lock = verifyKpiGatesHeldoutSeal(lockPath);
    expect(lock.rng_seed).toBe(PRE_REGISTERED_SEED_45);
    expect(lock.partition_size).toBe(20);
    expect(lock.partition_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the committed partition_hash matches sha256(sorted(heldout-runids))", () => {
    const allRunIds = generateRunIds("phase45-calib", PRE_REGISTERED_SEED_45, K);
    const heldout = partition8020(allRunIds, PRE_REGISTERED_SEED_45);
    const expected = sha256SortedJoin(heldout);
    const lockPath = join(DATA_DIR, "kpigates-heldout.lock.json");
    const lock = verifyKpiGatesHeldoutSeal(lockPath);
    expect(lock.partition_hash).toBe(expected);
  });
});

// ─── F3 §4.1 reliability seal verifies cleanly (was partial-seal pre-F3) ─
// History: until Wave F3, the §4.1 lock carried null breakdown/partition_size
// and verifyReliabilityHeldoutSeal threw by design (Popper AP-5 mechanical
// enforcement, awaiting the externally-grounded claim corpus). Wave F3
// (commit landing this test edit) curated 50 oracle-grounded claims, drew
// the 80/20 partition with the committed seed, and fully populated the lock.
// The verify call must now succeed. AP-5 enforcement is preserved by the
// negative test below: a hand-crafted partial lock STILL throws.
describe("F3 — §4.1 verifyReliabilityHeldoutSeal accepts the fully-sealed lock", () => {
  it("does not throw on the committed Wave F3 lock", () => {
    const lockPath = join(DATA_DIR, "heldout-partition.lock.json");
    expect(() => verifyReliabilityHeldoutSeal(lockPath)).not.toThrow();
  });

  it("the lock has populated breakdown + partition_size + claim_set_hash", () => {
    const lockPath = join(DATA_DIR, "heldout-partition.lock.json");
    const lock = verifyReliabilityHeldoutSeal(lockPath);
    expect(lock.partition_size).toBeGreaterThan(0);
    expect(lock.external_grounding_total).toBe(lock.partition_size);
    const bd = lock.external_grounding_breakdown;
    expect(bd.schema + bd.math + bd.code + bd.spec).toBe(lock.partition_size);
    expect(lock.claim_set_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.seed).toBe("phase4-section-4.1-rng-2025");
  });

  it("a hand-crafted partial lock STILL throws (Popper AP-5 preserved)", () => {
    // Negative: emit a temp lock with null breakdown to confirm the throw path
    // remains exercised. This guards against silent regressions where the v2
    // schema later relaxes its required fields.
    const partialPath = join(
      mkdtempSync(join(tmpdir(), "f3-partial-")),
      "partial.lock.json",
    );
    const partial = {
      schema_version: 2,
      seed: "phase4-section-4.1-rng-2025",
      partition_size: null,
      sealed_at: new Date().toISOString(),
      external_grounding_breakdown: null,
      external_grounding_total: null,
      external_grounding_schema_version: 1,
      claim_set_hash: null,
    };
    writeFileSync(partialPath, JSON.stringify(partial), "utf8");
    expect(() => verifyReliabilityHeldoutSeal(partialPath)).toThrow();
  });
});
