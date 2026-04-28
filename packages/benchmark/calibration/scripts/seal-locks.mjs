// One-shot sealing script for held-out partition lock files.
// Reproduces the runner's run_id generation to identify the K=100 partition,
// then partitions deterministically using each lock's pre-registered seed.
//
// source: docs/PHASE_4_PLAN.md §4.1 / §4.2 / §4.5 sealing procedure
// source: calibrate-gates.ts:driveRuns + calibrate-gates-constants.ts seeds

import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// ─── Mulberry32 — identical to calibrate-gates.ts ───
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

const PRE_REGISTERED_SEED_45 = 0x4_05_c3;       // 263619
const PRE_REGISTERED_SEED_42 = 4_020_704;
const K = 100;

// Reproduce the same run_ids the runner generates (driveRuns).
function runIds(prefix, seed, k) {
  const rng = mulberry32(seed);
  const ids = [];
  for (let i = 0; i < k; i++) {
    const id = `${prefix}-${i}-${Math.floor(rng() * 0xffffffff)
      .toString(16)
      .padStart(8, "0")}`;
    ids.push(id);
  }
  return ids;
}

// 80/20 partition using a separate Mulberry32 stream from the seal seed.
// Fisher-Yates shuffle with deterministic RNG → take first 20% as held-out.
function partition8020(allIds, seed) {
  const rng = mulberry32(seed);
  const arr = [...allIds];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const heldoutSize = Math.floor(arr.length * 0.2);
  const heldout = arr.slice(0, heldoutSize);
  return heldout;
}

function sha256SortedJoin(ids) {
  const sorted = [...ids].sort();
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

const sealed_at = new Date().toISOString();

// ─── §4.5 KPI-gates seal ─────────────────────────────────────────────────
{
  const gateRunIds = runIds("phase45-calib", PRE_REGISTERED_SEED_45, K);
  const heldout = partition8020(gateRunIds, PRE_REGISTERED_SEED_45);
  const partition_hash = sha256SortedJoin(heldout);
  const lock = {
    $schema: "kpigates-heldout-lock-schema-v1",
    schema_version: 1,
    _comment:
      "Phase 4.5 KPI-gates held-out partition (E3.C SEALED). " +
      "rng_seed=PRE_REGISTERED_SEED_45=0x4_05_C3=263619. partition_size=20 " +
      "(20% of K=100). partition_hash = sha256(sorted(heldout-run_ids).join('\\n')). " +
      "Held-out run_ids drawn from the runner's gate-calibration prefix " +
      "'phase45-calib-{i}-{hex}'. Sealed against the K=100 calibration committed " +
      "in gate-calibration-K100.json (commit 76cfc636).",
    rng_seed: PRE_REGISTERED_SEED_45,
    partition_hash,
    partition_size: heldout.length,
    sealed_at,
  };
  writeFileSync(
    "packages/benchmark/calibration/data/kpigates-heldout.lock.json",
    JSON.stringify(lock, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    "/tmp/kpigates-heldout-runids.txt",
    heldout.join("\n") + "\n",
    "utf8",
  );
  console.log(`§4.5 KPI gates: partition_size=${heldout.length} hash=${partition_hash.slice(0, 16)}…`);
}

// ─── §4.2 MAX_ATTEMPTS seal ──────────────────────────────────────────────
{
  // Per brief: partition the K=100 calibration runs. Use the §4.2 seed
  // (PRE_REGISTERED_SEED_42) for the partition draw. The run_ids used are the
  // same gate-calibration runs (the canned baseline shared across studies);
  // the §4.2 study reuses these identifiers.
  const allRunIds = runIds("phase45-calib", PRE_REGISTERED_SEED_45, K);
  const heldout = partition8020(allRunIds, PRE_REGISTERED_SEED_42);
  const partition_hash = sha256SortedJoin(heldout);
  const lock = {
    $schema: "heldout-partition-lock-schema-v1",
    schema_version: 1,
    _comment:
      "Phase 4.2 MAX_ATTEMPTS held-out partition (E3.C SEALED). " +
      "rng_seed=PRE_REGISTERED_SEED_42=4_020_704. partition_size=20 (20% of " +
      "K=100). partition_hash = sha256(sorted(heldout-run_ids).join('\\n')). " +
      "Held-out run_ids drawn from the K=100 canned-baseline runs (prefix " +
      "'phase45-calib-{i}-{hex}'); §4.2 study identifies arms via the run_id " +
      "→ arm seam getRetryArmForRun, not via prefix. Sealed against the K=100 " +
      "calibration committed in gate-calibration-K100.json (commit 76cfc636).",
    rng_seed: PRE_REGISTERED_SEED_42,
    partition_hash,
    partition_size: heldout.length,
    sealed_at,
  };
  writeFileSync(
    "packages/benchmark/calibration/data/maxattempts-heldout.lock.json",
    JSON.stringify(lock, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    "/tmp/maxattempts-heldout-runids.txt",
    heldout.join("\n") + "\n",
    "utf8",
  );
  console.log(`§4.2 max-attempts: partition_size=${heldout.length} hash=${partition_hash.slice(0, 16)}…`);
}

// ─── §4.1 Reliability partial-seal ───────────────────────────────────────
// E2 oracle wiring is not yet complete in this worktree (no externally-grounded
// claims have been logged yet). Emit a partial-seal that records the seed and
// timestamp but leaves the partition fields null pending E2.
//
// IMPORTANT: the v2 schema (ReliabilityHeldoutLockSchema) does NOT permit null
// fields — verifyReliabilityHeldoutSeal would throw on this partial seal. That
// is the correct behavior: §4.1 must NOT proceed until the partition is sealed
// with real external_grounding_breakdown counts. We use a v2-template comment
// and keep the null-template structure so verify still fails-safe.
{
  const lock = {
    $schema: "reliability-heldout-lock-schema-v2",
    schema_version: 2,
    _comment:
      "Phase 4.1 reliability held-out partition — Wave E.1 PARTIAL SEAL. " +
      "Wave E2 (external-oracle wiring) has not yet logged externally-grounded " +
      "claims, so external_grounding_breakdown remains null. The seed is " +
      "pre-registered as the §4.1 RNG seed string 'phase4-section-4.1-rng-2025'. " +
      "claim_set_hash + partition_size + breakdown will be filled in after the " +
      "first oracle-grounded benchmark run. Until then, " +
      "verifyReliabilityHeldoutSeal will throw — by design (Popper AP-5).",
    _fields: {
      seed: "string — pre-registered RNG seed committed before data collection",
      partition_size: "integer — count of claim_ids in the held-out set",
      sealed_at: "ISO-8601 UTC timestamp at which the partition was sealed",
      external_grounding_breakdown:
        "object — claim count per ExternalGroundingType {schema, math, code, spec}; sum must equal partition_size",
      external_grounding_total:
        "integer — sum of external_grounding_breakdown values; must equal partition_size",
      external_grounding_schema_version: 1,
      claim_set_hash:
        "string — sha256 hex digest over sorted-newline-joined claim_ids",
    },
    seed: "phase4-section-4.1-rng-2025",
    partition_size: null,
    sealed_at,
    external_grounding_breakdown: null,
    external_grounding_total: null,
    external_grounding_schema_version: 1,
    claim_set_hash: null,
  };
  writeFileSync(
    "packages/benchmark/calibration/data/heldout-partition.lock.json",
    JSON.stringify(lock, null, 2) + "\n",
    "utf8",
  );
  console.log(
    "§4.1 reliability: PARTIAL SEAL (seed pre-registered; awaits E2 oracle wiring).",
  );
}

console.log("Sealed at:", sealed_at);
