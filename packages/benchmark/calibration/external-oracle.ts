/**
 * External oracle seam for the 4.1 held-out subset independence resolution.
 *
 * The held-out 20% partition of calibration claims must contain claims with
 * EXTERNALLY-VERIFIABLE ground truth, not LLM-opinion ground truth. Without
 * this, the falsifier measures "agreement with annotator-LLM" instead of
 * "agreement with reality" (Curie A2 / annotator-LLM circularity).
 *
 * This module defines:
 *   - ExternalGroundingType — 4 categories of externally-verifiable claims.
 *   - ExternalOracle — the oracle contract (claim in, truth + evidence out).
 *   - 4 stub implementations, one per category. Stubs throw
 *     EXTERNAL_ORACLE_NOT_YET_IMPLEMENTED with a citation. Implementations
 *     are Wave D scope.
 *
 * Wave C scope: type contract + stubs only. No real oracle implementations.
 * Wave D scope: implement each oracle stub using the cited tool/library.
 *
 * source: PHASE_4_PLAN.md §4.1 "Externally-grounded held-out subset" —
 * Option (b) from commit aa42c42.
 */

// ─── Grounding type ───────────────────────────────────────────────────────────

/**
 * The four categories of externally-verifiable ground truth for held-out
 * claims. Each category has a designated oracle tool that provides ground
 * truth independently of any LLM.
 *
 * - "schema" — JSON-schema correctness. Oracle: Ajv / Zod validator.
 * - "math"   — Arithmetic / set-theoretic / combinatorial truth. Oracle: Python/SymPy.
 * - "code"   — TypeScript snippet compilability. Oracle: tsc --noEmit --strict.
 * - "spec"   — Markdown document conformance to a fixed grammar. Oracle: the
 *              Hard Output Rules validator in packages/validation.
 *
 * source: PHASE_4_PLAN.md §4.1 category taxonomy.
 */
export type ExternalGroundingType = "schema" | "math" | "code" | "spec";

// ─── Oracle contract ──────────────────────────────────────────────────────────

/**
 * Input to any external oracle. The `payload` field is category-specific:
 *   schema: { json_instance: unknown; schema: object }
 *   math:   { expression: string; expected: string }
 *   code:   { typescript_snippet: string }
 *   spec:   { markdown: string; section_type: string }
 *
 * The `id` field is the claim's stable identifier for logging and join keys.
 * The `type` field selects which oracle to invoke.
 */
export interface OracleClaimInput {
  readonly id: string;
  readonly type: ExternalGroundingType;
  readonly payload: unknown;
}

/**
 * Output from any external oracle.
 *   truth:          the ground-truth boolean (true = claim is correct).
 *   oracle_evidence: human-readable string citing the oracle's output.
 *                   Must be non-empty and must not reference any LLM output.
 *                   This string is stored alongside the claim in the
 *                   calibration set for audit purposes.
 */
export interface OracleResult {
  readonly truth: boolean;
  readonly oracle_evidence: string;
}

/**
 * External oracle function signature. Every oracle implementation must satisfy
 * this type. The function is async because real oracles (tsc, Ajv, SymPy)
 * require process/filesystem I/O.
 *
 * source: PHASE_4_PLAN.md §4.1 ExternalOracle type specification.
 */
export type ExternalOracle = (
  claim: OracleClaimInput,
) => Promise<OracleResult>;

// ─── Sentinel error ───────────────────────────────────────────────────────────

/**
 * Sentinel thrown by all stub implementations. Tests assert this exact string
 * to verify stubs are stubs, not accidental real implementations.
 */
export const EXTERNAL_ORACLE_NOT_YET_IMPLEMENTED =
  "EXTERNAL_ORACLE_NOT_YET_IMPLEMENTED" as const;

// ─── Stub implementations (Wave D scope) ─────────────────────────────────────

/**
 * Schema oracle stub.
 *
 * Contract: given a JSON instance and a JSON Schema object, return whether
 * the instance validates against the schema.
 *
 * Wave D implementation: use Ajv (https://ajv.js.org/) or Zod to validate
 * the instance. The oracle_evidence should include the full Ajv error list.
 *
 * source: PHASE_4_PLAN.md §4.1 "Schema-grounded" category — "a real
 * validator (Ajv, Zod) is the oracle."
 *
 * Examples of schema-grounded claims:
 *   1. "The JSON object {\"name\":\"Alice\",\"age\":30} is valid against the
 *      schema {type:object, required:[name,age], properties:{name:{type:string},
 *      age:{type:integer}}}."
 *   2. "The payload {\"id\":\"abc\"} is INVALID against the schema that
 *      requires id to be a UUID format string."
 *   3. "The array [1,\"two\",3] fails the schema {type:array, items:{type:integer}}."
 */
export const schemaOracle: ExternalOracle = async (_claim) => {
  // Wave D: implement with Ajv or Zod.
  // source: Ajv — https://ajv.js.org/; Zod — https://zod.dev/
  throw new Error(EXTERNAL_ORACLE_NOT_YET_IMPLEMENTED);
};

/**
 * Math oracle stub.
 *
 * Contract: given an arithmetic / set-theoretic / combinatorial expression
 * and an expected result string, return whether the expression evaluates to
 * the expected result.
 *
 * Wave D implementation: spawn a Python/SymPy subprocess.
 * source: PHASE_4_PLAN.md §4.1 "Math-grounded" — "Python/SymPy is the oracle."
 * source: SymPy — https://www.sympy.org/
 *
 * Examples of math-grounded claims:
 *   1. "The number of distinct 3-element subsets of a 5-element set is 10."
 *   2. "The expression (7 + 3) * 4 - 2 evaluates to 38."
 *   3. "The intersection of {1,2,3,4} and {2,4,6} is {2,4}."
 */
export const mathOracle: ExternalOracle = async (_claim) => {
  // Wave D: spawn `python3 -c "import sympy; ..."` and parse stdout.
  // source: SymPy — https://www.sympy.org/en/index.html
  throw new Error(EXTERNAL_ORACLE_NOT_YET_IMPLEMENTED);
};

/**
 * Code oracle stub.
 *
 * Contract: given a TypeScript snippet, return whether it compiles without
 * errors under `tsc --noEmit --strict`.
 *
 * Wave D implementation: write snippet to a temp file, invoke tsc via
 * child_process.spawnSync, parse exit code + stderr.
 *
 * source: PHASE_4_PLAN.md §4.1 "Code-grounded" — "whether a TypeScript
 * snippet compiles with tsc --noEmit (strict)."
 * source: TypeScript compiler — https://www.typescriptlang.org/docs/handbook/compiler-options.html
 *
 * Examples of code-grounded claims:
 *   1. "The snippet `const x: number = 'hello'` fails tsc strict compilation."
 *   2. "The snippet `const y: string = 'world'` compiles without errors."
 *   3. "The snippet `function f(a: number, b: string): number { return a + b; }`
 *      produces a type error under strict mode."
 */
export const codeOracle: ExternalOracle = async (_claim) => {
  // Wave D: spawnSync("tsc", ["--noEmit", "--strict", "--target", "ES2020",
  //           "--module", "ESNext", tempFile]) and parse exit code.
  // source: TypeScript Compiler API — https://www.typescriptlang.org/docs/handbook/using-tsc.html
  throw new Error(EXTERNAL_ORACLE_NOT_YET_IMPLEMENTED);
};

/**
 * Spec oracle stub.
 *
 * Contract: given a markdown document and a section_type, return whether
 * the document conforms to the Hard Output Rules for that section type as
 * implemented in packages/validation.
 *
 * Wave D implementation: call `validateSection(markdown, sectionType)` from
 * @prd-gen/validation and interpret zero violations as truth=true.
 *
 * source: PHASE_4_PLAN.md §4.1 "Spec-grounded" — "whether a markdown
 * document conforms to a fixed grammar (e.g., the Hard Output Rules in
 * packages/validation)."
 * source: packages/validation — the Hard Output Rules are the oracle grammar.
 *
 * Examples of spec-grounded claims:
 *   1. "A requirements section that contains '- [ ] MUST' items and a
 *      Summary subsection passes the requirements HOR validator."
 *   2. "An overview section missing the mandatory H2 'Goals' subsection
 *      fails the overview HOR validator."
 *   3. "A technical_specification section with a code block that is not
 *      fenced with language annotations fails the spec validator."
 */
export const specOracle: ExternalOracle = async (_claim) => {
  // Wave D: import { validateSection } from "@prd-gen/validation" and
  // call validateSection(payload.markdown, payload.section_type).
  // truth = report.violations.length === 0
  // oracle_evidence = violations.map(v => v.message).join("; ") || "no violations"
  throw new Error(EXTERNAL_ORACLE_NOT_YET_IMPLEMENTED);
};

// ─── Oracle registry ──────────────────────────────────────────────────────────

/**
 * Registry mapping ExternalGroundingType to its oracle function.
 * Used by the calibration harness to dispatch claims to the correct oracle.
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
 * Dispatch a claim to the appropriate oracle via the registry.
 *
 * Postcondition: throws EXTERNAL_ORACLE_NOT_YET_IMPLEMENTED for all inputs
 *   in Wave C (stubs not yet implemented).
 * Postcondition: when Wave D implements the stubs, this function returns
 *   a populated OracleResult for every valid ExternalGroundingType.
 */
export async function invokeOracle(
  claim: OracleClaimInput,
): Promise<OracleResult> {
  return ORACLE_REGISTRY[claim.type](claim);
}
