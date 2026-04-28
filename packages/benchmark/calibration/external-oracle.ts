/**
 * External oracle seam for the 4.1 held-out subset independence resolution.
 *
 * The held-out 20% partition of calibration claims must contain claims with
 * EXTERNALLY-VERIFIABLE ground truth, not LLM-opinion ground truth. Without
 * this, the falsifier measures "agreement with annotator-LLM" instead of
 * "agreement with reality" (Curie A2 / annotator-LLM circularity).
 *
 * Wave E status (2026-04-27):
 *   All four oracle stubs are now real implementations:
 *   - schemaOracle: JSON Schema validation via Ajv (deterministic).
 *   - mathOracle:   Mathematical expression evaluation via mathjs (deterministic).
 *   - codeOracle:   TypeScript compilation check via tsc subprocess (deterministic).
 *   - specOracle:   Hard Output Rules validation via @prd-gen/validation
 *                   (internally-grounded — see caveat in spec-oracle.ts).
 *
 * This module exports:
 *   - ExternalGroundingType — 4 categories of externally-verifiable claims.
 *   - OracleClaimInput / ExternalOracle — legacy contract (payload: unknown).
 *   - OracleInput — typed contract from oracle-types.ts (Wave E seam).
 *   - OracleResult — shared result shape.
 *   - ORACLE_REGISTRY — dispatch table (mutable for test-injection).
 *   - invokeOracle — primary dispatch function (accepts OracleInput).
 *   - EXTERNAL_ORACLE_NOT_YET_IMPLEMENTED — sentinel (kept for legacy tests).
 *
 * source: PHASE_4_PLAN.md §4.1 "Externally-grounded held-out subset".
 */

// ─── Grounding type ───────────────────────────────────────────────────────────

/**
 * The four categories of externally-verifiable ground truth for held-out
 * claims. Each category has a designated oracle tool that provides ground
 * truth independently of any LLM.
 *
 * - "schema" — JSON-schema correctness. Oracle: Ajv validator.
 * - "math"   — Arithmetic / set-theoretic / combinatorial truth. Oracle: mathjs.
 * - "code"   — TypeScript snippet compilability. Oracle: tsc --noEmit --strict.
 * - "spec"   — Markdown document conformance to a fixed grammar. Oracle:
 *              Hard Output Rules validator in packages/validation.
 *
 * source: PHASE_4_PLAN.md §4.1 category taxonomy.
 */
export type ExternalGroundingType = "schema" | "math" | "code" | "spec";

// ─── Legacy oracle contract (backward-compatible) ─────────────────────────────

/**
 * Legacy input type — payload is untyped (unknown). Preserved for backward
 * compatibility with existing tests and calibration-seams.ts contract.
 *
 * Prefer OracleInput (oracle-types.ts) for new call sites — it carries
 * strongly-typed payload shapes per oracle category.
 */
export interface OracleClaimInput {
  readonly id: string;
  readonly type: ExternalGroundingType;
  readonly payload: unknown;
}

/**
 * Oracle result shape shared by both legacy and typed dispatch paths.
 *   truth:           the ground-truth boolean (true = claim is correct).
 *   oracle_evidence: human-readable string citing the oracle's output.
 *                    Must be non-empty and must not reference any LLM output.
 */
export interface OracleResult {
  readonly truth: boolean;
  readonly oracle_evidence: string;
}

/**
 * Legacy oracle function signature (takes OracleClaimInput with unknown payload).
 * Preserved for ORACLE_REGISTRY backward compatibility.
 *
 * source: PHASE_4_PLAN.md §4.1 ExternalOracle type specification.
 */
export type ExternalOracle = (
  claim: OracleClaimInput,
) => Promise<OracleResult>;

// ─── Sentinel (kept for legacy tests that assert stubs are gone) ───────────────

/**
 * Sentinel formerly thrown by all stub implementations.
 * Retained for backward compatibility with tests that import it.
 * Wave E: no oracle throws this any longer — all four are implemented.
 */
export const EXTERNAL_ORACLE_NOT_YET_IMPLEMENTED =
  "EXTERNAL_ORACLE_NOT_YET_IMPLEMENTED" as const;

// ─── Real implementations (Wave E) ───────────────────────────────────────────

import {
  schemaOracle as _schemaOracle,
} from "./schema-oracle.js";
import {
  mathOracle as _mathOracle,
} from "./math-oracle.js";
import {
  codeOracle as _codeOracle,
  isTscAvailable,
} from "./code-oracle.js";
import {
  specOracle as _specOracle,
} from "./spec-oracle.js";
import type {
  OracleInput,
  SchemaPayload,
  MathPayload,
  CodePayload,
  SpecPayload,
} from "./oracle-types.js";

// Re-export typed input type so call sites can use either API.
export type { OracleInput, SchemaPayload, MathPayload, CodePayload, SpecPayload };

// Re-export individual oracles for direct test access.
export { isTscAvailable };

/**
 * Legacy wrappers: bridge OracleClaimInput (unknown payload) → typed oracle.
 * Precondition: claim.payload matches the shape for claim.type.
 * Postcondition: delegates to the typed implementation; returns OracleResult.
 *
 * Justification for `as` casts: OracleClaimInput.payload is `unknown` by
 * legacy contract; the caller is responsible for providing the correct shape.
 * The typed oracles validate defensively (Ajv, mathjs, tsc), so a malformed
 * payload surfaces as truth=false with an evidence string rather than a throw.
 */
export const schemaOracle: ExternalOracle = async (claim) => {
  return _schemaOracle(claim.payload as SchemaPayload);
};

export const mathOracle: ExternalOracle = async (claim) => {
  return _mathOracle(claim.payload as MathPayload);
};

export const codeOracle: ExternalOracle = async (claim) => {
  return _codeOracle(claim.payload as CodePayload);
};

export const specOracle: ExternalOracle = async (claim) => {
  return _specOracle(claim.payload as SpecPayload);
};

// ─── Oracle registry ──────────────────────────────────────────────────────────

/**
 * Registry mapping ExternalGroundingType to its oracle function.
 * Mutable to allow test injection of synthetic oracles.
 *
 * All four keys must be present. TypeScript enforces completeness via the
 * `Record<ExternalGroundingType, ExternalOracle>` annotation.
 */
export const ORACLE_REGISTRY: Record<ExternalGroundingType, ExternalOracle> = {
  schema: schemaOracle,
  math: mathOracle,
  code: codeOracle,
  spec: specOracle,
};

/**
 * Dispatch a claim to the appropriate oracle via the typed OracleInput API.
 *
 * Precondition:  input.type is one of "schema" | "math" | "code" | "spec";
 *                input.payload matches the corresponding payload shape.
 * Postcondition: returned OracleResult.truth is determined solely by external
 *                objective criteria; OracleResult.oracle_evidence is non-empty.
 *                Throws TypeError for unknown input.type.
 *
 * source: PHASE_4_PLAN.md §4.1 invokeOracle specification.
 * source: Wave E E2 — real oracle implementations now back all 4 types.
 */
export async function invokeOracle(input: OracleInput): Promise<OracleResult> {
  const { type, payload } = input;

  switch (type) {
    case "schema":
      return _schemaOracle(payload as SchemaPayload);
    case "math":
      return _mathOracle(payload as MathPayload);
    case "code":
      return _codeOracle(payload as CodePayload);
    case "spec":
      return _specOracle(payload as SpecPayload);
    default: {
      // Exhaustiveness guard — TypeScript never-check at compile time;
      // runtime guard for callers using untyped input.
      const exhaustiveCheck: never = type;
      throw new TypeError(
        `invokeOracle: unknown oracle type "${String(exhaustiveCheck)}". ` +
          `Valid types: schema, math, code, spec.`,
      );
    }
  }
}
