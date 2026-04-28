/**
 * Wave F3.D — seal-reliability-corpus.mjs
 *
 * Draws the 20% held-out partition from `reliability-claim-corpus.json` using
 * the pre-registered RNG seed string and writes the fully-populated v2
 * reliability lock file to `data/heldout-partition.lock.json`.
 *
 * Reproducibility (Wave F3 brief HARD CONSTRAINTS):
 *   - The seed string is committed in the corpus + lock file.
 *   - mulberry32 is initialised with fnv1a32(seedString) — same primitive used
 *     by ablation-pairing-helpers.ts:stringSeedToNumber, so calibration code
 *     that consumes lock.seed via stringSeedToNumber lands at the SAME RNG
 *     stream this seal used.
 *   - Sort order is alphabetic over claim_id (stable) before drawing.
 *   - Stratification: each grounding type's claims are partitioned independently
 *     so the held-out preserves the population breakdown.
 *
 * Hashes:
 *   - claim_set_hash    = sha256(sorted-newline-joined ALL claim_ids)
 *   - partition_hash    = sha256(sorted-newline-joined HELD-OUT claim_ids)
 *                         (recorded as a sidecar /tmp file for replay; the
 *                          v2 lock schema does NOT have a partition_hash field,
 *                          but the held-out claim list itself is reproducible
 *                          from corpus + seed + this script.)
 *
 * source: docs/PHASE_4_PLAN.md §4.1; Wave F3 brief F3.C + F3.D.
 * source: ablation-pairing-helpers.ts:stringSeedToNumber (FNV-1a 32-bit).
 */

import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const CORPUS_PATH =
  "packages/benchmark/calibration/data/reliability-claim-corpus.json";
const LOCK_PATH =
  "packages/benchmark/calibration/data/heldout-partition.lock.json";
const HELDOUT_FRACTION = 0.20;

// ─── Primitives (mirror calibration-seams.ts) ────────────────────────────────

/** FNV-1a 32-bit. source: calibration-seams.ts (Eastlake/Hansen IETF draft). */
function fnv1a32(input) {
  const FNV_OFFSET_BASIS = 2166136261;
  const FNV_PRIME = 16777619;
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** Mulberry32. source: Tommy Ettinger 2017; identical to calibrate-gates.ts. */
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

function sha256SortedJoin(ids) {
  return createHash("sha256").update([...ids].sort().join("\n")).digest("hex");
}

// ─── Load corpus ─────────────────────────────────────────────────────────────

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
if (corpus.schema_version !== 1) {
  console.error(`unexpected corpus schema_version=${corpus.schema_version}`);
  process.exit(1);
}
const seed = corpus.seed;
if (typeof seed !== "string" || !seed) {
  console.error("corpus.seed missing or empty");
  process.exit(1);
}

// ─── Stratified 80/20 partition ──────────────────────────────────────────────

const groups = { schema: [], math: [], code: [], spec: [] };
for (const c of corpus.claims) {
  const t = c.external_grounding.type;
  if (!groups[t]) {
    console.error(`unknown grounding type ${t}`);
    process.exit(1);
  }
  groups[t].push(c.claim_id);
}

const numericSeed = fnv1a32(seed);
const rng = mulberry32(numericSeed);

const heldout = [];
for (const t of ["code", "math", "schema", "spec"]) {
  // Sort deterministically before shuffle so a re-run produces identical results.
  const sorted = [...groups[t]].sort();
  // Fisher-Yates with shared mulberry32 stream → cross-group order is stable
  // because we iterate types in a fixed order.
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
  }
  // Take ceil(0.20 * n) so every type contributes ≥1 held-out claim if n ≥ 5.
  const k = Math.max(1, Math.round(sorted.length * HELDOUT_FRACTION));
  for (const id of sorted.slice(0, k)) heldout.push(id);
}

// ─── Compute hashes + breakdown ──────────────────────────────────────────────

const claim_set_hash = sha256SortedJoin(corpus.claims.map((c) => c.claim_id));
const partition_hash_sidecar = sha256SortedJoin(heldout);

const breakdown = { schema: 0, math: 0, code: 0, spec: 0 };
for (const id of heldout) {
  const claim = corpus.claims.find((c) => c.claim_id === id);
  breakdown[claim.external_grounding.type]++;
}

const partition_size = heldout.length;
const external_grounding_total = breakdown.schema + breakdown.math + breakdown.code + breakdown.spec;

if (partition_size !== external_grounding_total) {
  console.error(`size mismatch: partition=${partition_size} total=${external_grounding_total}`);
  process.exit(1);
}

// ─── Write the fully-sealed v2 lock ──────────────────────────────────────────

const sealed_at = new Date().toISOString();
const lock = {
  $schema: "reliability-heldout-lock-schema-v2",
  schema_version: 2,
  _comment:
    "Phase 4.1 reliability held-out partition — Wave F3 FULLY SEALED. " +
    "Drawn from data/reliability-claim-corpus.json (50 claims, " +
    "schema=15/math=15/code=13/spec=7) using pre-registered seed " +
    "'phase4-section-4.1-rng-2025'. Stratified 20% draw via mulberry32(fnv1a32(seed)). " +
    "Held-out partition_size=" + partition_size +
    " (sidecar partition_hash=" + partition_hash_sidecar.slice(0, 16) + "…). " +
    "Reproduce via: node packages/benchmark/calibration/scripts/seal-reliability-corpus.mjs.",
  seed,
  partition_size,
  sealed_at,
  external_grounding_breakdown: breakdown,
  external_grounding_total,
  external_grounding_schema_version: 1,
  claim_set_hash,
};

writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + "\n", "utf8");

writeFileSync(
  "/tmp/reliability-heldout-claim-ids.txt",
  [...heldout].sort().join("\n") + "\n",
  "utf8",
);

console.log("Sealed §4.1 reliability lock:");
console.log(`  partition_size = ${partition_size}`);
console.log(`  breakdown = ${JSON.stringify(breakdown)}`);
console.log(`  claim_set_hash = ${claim_set_hash}`);
console.log(`  partition_hash (sidecar) = ${partition_hash_sidecar}`);
console.log(`  sealed_at = ${sealed_at}`);
console.log(`  held-out claim_ids written to /tmp/reliability-heldout-claim-ids.txt`);
