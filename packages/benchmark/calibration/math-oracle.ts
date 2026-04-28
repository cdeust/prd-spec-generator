/**
 * mathOracle — Mathematical expression evaluation via mathjs.
 *
 * Precondition:  payload.expression is a string containing a valid mathjs expression
 *                (no arbitrary JS; mathjs grammar is restricted — see §7 "local reasoning").
 *                payload.expected_value is the claimed numeric result.
 *                payload.tolerance (optional) is the absolute acceptable deviation.
 * Postcondition: truth = |mathjs.evaluate(expression) - expected_value| ≤ tolerance.
 *                oracle_evidence is non-empty and human-readable.
 * Invariant:     eval() is NEVER used. mathjs.evaluate() uses its own restricted parser
 *                that rejects JS constructs including arbitrary function calls.
 *                Source: mathjs docs §"Security" — evaluate() rejects unknown identifiers
 *                and function names outside its built-in scope.
 *
 * Layer: benchmark/calibration.
 */

import { evaluate } from "mathjs";
import type { MathPayload, OracleResult } from "./oracle-types.js";

/**
 * Default tolerance for floating-point comparison.
 * source: IEEE 754 double-precision machine epsilon ≈ 2.22e-16; 1e-9 provides
 * headroom for typical algebraic expression rounding chains while still
 * rejecting arithmetic errors of any meaningful magnitude.
 */
const DEFAULT_TOLERANCE = 1e-9;

/**
 * Evaluate a mathjs expression and compare against the expected value within tolerance.
 *
 * Precondition:  payload matches MathPayload shape; expression is safe mathjs syntax.
 * Postcondition: truth = |computed - expected_value| ≤ (tolerance ?? DEFAULT_TOLERANCE).
 */
export async function mathOracle(payload: MathPayload): Promise<OracleResult> {
  const { expression, expected_value, tolerance } = payload;
  const effectiveTolerance = tolerance ?? DEFAULT_TOLERANCE;

  let computed: number;

  try {
    const raw: unknown = evaluate(expression);

    // mathjs can return complex numbers, matrices, or units — we require a plain number.
    if (typeof raw !== "number") {
      const evidence =
        `mathOracle: expression="${expression}"; ` +
        `mathjs returned non-number type "${typeof raw}" (value=${String(raw)}); ` +
        `expected_value=${expected_value}; truth=false.`;
      return { truth: false, oracle_evidence: evidence };
    }

    computed = raw;
  } catch (err: unknown) {
    // Covers: unknown identifiers (injection attempts), syntax errors, division by zero.
    const msg = err instanceof Error ? err.message : String(err);
    const evidence =
      `mathOracle: expression="${expression}"; ` +
      `mathjs.evaluate() threw: ${msg}; ` +
      `expected_value=${expected_value}; truth=false.`;
    return { truth: false, oracle_evidence: evidence };
  }

  const deviation = Math.abs(computed - expected_value);
  const truth = deviation <= effectiveTolerance;

  const evidence =
    `mathOracle: expression="${expression}"; ` +
    `computed=${computed}; ` +
    `expected_value=${expected_value}; ` +
    `deviation=${deviation.toExponential(3)}; ` +
    `tolerance=${effectiveTolerance.toExponential(3)}; ` +
    `truth=${String(truth)}.`;

  return { truth, oracle_evidence: evidence };
}
