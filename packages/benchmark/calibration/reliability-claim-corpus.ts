/**
 * Reliability claim corpus — Phase 4.1 externally-grounded held-out subset (Wave F3).
 *
 * Schema for `data/reliability-claim-corpus.json`. Every claim:
 *   - declares an `external_grounding` payload that one of the 4 oracles
 *     (schema/math/code/spec) can adjudicate without LLM involvement;
 *   - declares the claim's `expected_truth` (what oracle SHOULD return per the
 *     authoring intent) so a validator can detect drift between the corpus and
 *     the oracles;
 *   - carries a stable `claim_id` used for partition draws + sha256 hashes.
 *
 * Layer contract (§2.2): zod + Node stdlib + local oracle types only. No
 * orchestration, no I/O outside explicit read/write helpers.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 "Externally-grounded held-out subset".
 * source: Wave F3 brief — claim corpus + partition seal.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
// (oracle-types.ts payload shapes are tracked at the build boundary in
// invokeOracle()/oracle-types.ts; we re-state the shapes here as Zod schemas
// — schema-version drift is caught by validate-corpus.mjs which actually
// invokes the oracles against every claim.)

// ─── Canonical paths ─────────────────────────────────────────────────────────

/**
 * Canonical path to the committed reliability claim corpus JSON.
 * source: Wave F3 brief — corpus committed under data/.
 */
export const RELIABILITY_CLAIM_CORPUS_PATH =
  "packages/benchmark/calibration/data/reliability-claim-corpus.json";

/**
 * Canonical path to the §4.1 reliability held-out partition lock.
 * source: heldout-seals.ts — ReliabilityHeldoutLockSchema target.
 */
export const RELIABILITY_HELDOUT_LOCK_PATH =
  "packages/benchmark/calibration/data/heldout-partition.lock.json";

// ─── ClaimType enum (mirror of @prd-gen/core ClaimSchema.claim_type) ─────────

/**
 * Subset of @prd-gen/core ClaimSchema.claim_type re-stated as a Zod enum so
 * the corpus file is statically validated without a runtime dependency on
 * @prd-gen/core (the corpus is read by tooling that should not have to load
 * the orchestration graph).
 *
 * Drift between the two enums is caught by the cross-package compile check
 * in @prd-gen/core/__tests__ (typed import below would error at build time).
 *
 * source: @prd-gen/core domain/agent.ts ClaimSchema.claim_type enum (2026-04).
 */
export const ClaimTypeSchema = z.enum([
  "architecture",
  "performance",
  "correctness",
  "security",
  "data_model",
  "test_coverage",
  "story_point_arithmetic",
  "fr_traceability",
  "risk",
  "acceptance_criteria_completeness",
  "cross_file_consistency",
]);

export type ClaimType = z.infer<typeof ClaimTypeSchema>;

// ─── Per-grounding-type payload schemas ───────────────────────────────────────

/** source: oracle-types.ts SchemaPayload. */
export const SchemaPayloadSchema = z.object({
  schema: z.record(z.unknown()),
  instance: z.unknown(),
  expected_valid: z.boolean(),
});

/** source: oracle-types.ts MathPayload. */
export const MathPayloadSchema = z.object({
  expression: z.string().min(1),
  expected_value: z.number(),
  tolerance: z.number().nonnegative().optional(),
});

/** source: oracle-types.ts CodePayload. */
export const CodePayloadSchema = z.object({
  snippet: z.string().min(1),
  expected_compiles: z.boolean(),
});

/** source: oracle-types.ts SpecPayload. */
export const SpecPayloadSchema = z.object({
  markdown: z.string().min(1),
  section_type: z.string().min(1),
  expected_passes: z.boolean(),
});

// ─── Discriminated grounding union ───────────────────────────────────────────

/**
 * One claim's external-grounding payload. The discriminant `type` selects
 * which of the 4 oracles consumes the payload.
 *
 * source: external-oracle.ts ExternalGroundingType + invokeOracle().
 */
export const ExternalGroundingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("schema"), payload: SchemaPayloadSchema }),
  z.object({ type: z.literal("math"), payload: MathPayloadSchema }),
  z.object({ type: z.literal("code"), payload: CodePayloadSchema }),
  z.object({ type: z.literal("spec"), payload: SpecPayloadSchema }),
]);

export type ExternalGrounding = z.infer<typeof ExternalGroundingSchema>;

// ─── Single-claim schema ─────────────────────────────────────────────────────

/**
 * One claim record in the corpus.
 *
 * Invariants:
 *   - `claim_id` is unique across the corpus.
 *   - `expected_truth` is what `invokeOracle` SHOULD return for this claim.
 *     A drift between `expected_truth` and the oracle's verdict is a corpus
 *     bug or an oracle bug; either way it must be caught before partitioning.
 *   - `description` is short human-readable English for forensic replay.
 *
 * source: Wave F3 brief — claim corpus shape.
 */
export const ReliabilityClaimSchema = z.object({
  claim_id: z.string().regex(/^F3-\d{3}$/, {
    message: "claim_id must match F3-### (e.g., F3-001).",
  }),
  claim_type: ClaimTypeSchema,
  description: z.string().min(1).max(200),
  external_grounding: ExternalGroundingSchema,
  expected_truth: z.boolean(),
});

export type ReliabilityClaim = z.infer<typeof ReliabilityClaimSchema>;

// ─── Top-level corpus schema ─────────────────────────────────────────────────

/**
 * The corpus file shape.
 *
 * `schema_version: 1` — bump when the field set changes.
 *
 * Invariants enforced by Zod refine:
 *   - claim_ids are globally unique.
 *   - At least 1 claim per grounding type (so the held-out partition can be
 *     stratified).
 *
 * source: Wave F3 brief — corpus design.
 */
export const ReliabilityClaimCorpusSchema = z
  .object({
    schema_version: z.literal(1),
    seed: z.string().min(1),
    sealed_at: z.string().datetime().optional(),
    description: z.string().min(1),
    claims: z.array(ReliabilityClaimSchema).min(1),
  })
  .refine(
    (c) => {
      const ids = new Set<string>();
      for (const x of c.claims) {
        if (ids.has(x.claim_id)) return false;
        ids.add(x.claim_id);
      }
      return true;
    },
    { message: "ReliabilityClaimCorpus: duplicate claim_id found.", path: ["claims"] },
  )
  .refine(
    (c) => {
      const types = new Set(c.claims.map((x) => x.external_grounding.type));
      return (
        types.has("schema") &&
        types.has("math") &&
        types.has("code") &&
        types.has("spec")
      );
    },
    {
      message:
        "ReliabilityClaimCorpus: at least one claim per grounding type (schema, math, code, spec) required for stratified partition.",
      path: ["claims"],
    },
  );

export type ReliabilityClaimCorpus = z.infer<typeof ReliabilityClaimCorpusSchema>;

// ─── Read helper ─────────────────────────────────────────────────────────────

/**
 * Read + validate the corpus from `path`. Throws an Error with a descriptive
 * message on parse / schema / invariant failure (caller MUST NOT silently
 * fall back to an empty corpus — that would void the falsifier).
 *
 * Precondition: `path` resolves to a JSON file conforming to ReliabilityClaimCorpusSchema.
 * Postcondition: returned corpus has unique claim_ids and ≥1 claim per grounding type.
 *
 * source: Wave F3 brief — F3.B validation pass.
 */
export function readReliabilityClaimCorpus(
  path: string = RELIABILITY_CLAIM_CORPUS_PATH,
): ReliabilityClaimCorpus {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(
      `readReliabilityClaimCorpus: failed to parse "${path}": ${String(cause)}`,
    );
  }
  const parsed = ReliabilityClaimCorpusSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `readReliabilityClaimCorpus: corpus at "${path}" failed schema validation:\n` +
        parsed.error.issues
          .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("\n"),
    );
  }
  return parsed.data;
}
