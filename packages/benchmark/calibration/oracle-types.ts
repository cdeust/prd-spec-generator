/**
 * Shared types for external oracle implementations.
 *
 * Precondition: caller supplies { id, type, payload } matching the oracle's expected payload shape.
 * Postcondition: returned { truth, oracle_evidence } is determined solely by objective
 *   external criteria (Ajv, mathjs, tsc, @prd-gen/validation) — no LLM involvement.
 */

export interface OracleInput {
  /** Unique identifier for this oracle invocation — used for audit tracing. */
  readonly id: string;
  /** Discriminant selecting which oracle to invoke. */
  readonly type: "schema" | "math" | "code" | "spec";
  /** Payload whose shape is oracle-specific. */
  readonly payload: SchemaPayload | MathPayload | CodePayload | SpecPayload;
}

export interface OracleResult {
  /** Objective truth: does the payload's claim hold? */
  readonly truth: boolean;
  /** Human-readable derivation trace for the verdict. Must be non-empty. */
  readonly oracle_evidence: string;
}

// ---------------------------------------------------------------------------
// Per-oracle payload types
// ---------------------------------------------------------------------------

export interface SchemaPayload {
  /** JSON Schema draft-07 object. */
  readonly schema: Record<string, unknown>;
  /** Value to validate against the schema. */
  readonly instance: unknown;
  /** The claim being made: "instance should be valid against schema." */
  readonly expected_valid: boolean;
}

export interface MathPayload {
  /** Mathematical expression string evaluated by mathjs (no eval()). */
  readonly expression: string;
  /** Expected numeric result. */
  readonly expected_value: number;
  /**
   * Acceptable absolute deviation.
   * Default: 1e-9 (source: IEEE 754 double-precision epsilon is ~2.2e-16;
   *   1e-9 allows for accumulated floating-point rounding across typical
   *   algebraic expressions while ruling out order-of-magnitude errors.)
   */
  readonly tolerance?: number;
}

export interface CodePayload {
  /** TypeScript snippet to compile under --strict --noEmit. */
  readonly snippet: string;
  /** The claim being made: "this snippet compiles cleanly." */
  readonly expected_compiles: boolean;
}

export interface SpecPayload {
  /** Markdown content to validate. */
  readonly markdown: string;
  /** PRD section type (must be a valid SectionType from @prd-gen/core). */
  readonly section_type: string;
  /** The claim being made: "markdown passes Hard Output Rules for section_type." */
  readonly expected_passes: boolean;
}
