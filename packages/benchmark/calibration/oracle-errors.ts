/**
 * Typed error classes for oracle unavailability.
 *
 * OracleUnavailableError is thrown by oracle implementations when a required
 * external tool (e.g. tsc) is absent from the calibration environment. Callers
 * catch this error and exclude the claim from the calibrated arm of the
 * comparison rather than scoring it false — preserving the falsifier's
 * interpretability.
 *
 * B3 remediation: replaces the prior stub-mode pattern in code-oracle.ts that
 * returned truth=false when tsc was absent, fabricating labels in the held-out
 * partition and corrupting the calibrated arm.
 *
 * source: Popper AP-4 cross-audit finding, Wave E remediation.
 * source: PHASE_4_PLAN.md §4.1 "Externally-grounded held-out subset" —
 *   "When an oracle is unavailable in the calibration environment (e.g., tsc
 *    not installed), the oracle returns OracleUnavailableError and the claim is
 *    excluded from the calibrated arm of the comparison rather than being scored
 *    as false. This preserves the falsifier's interpretability."
 */

import type { ExternalGroundingType } from "./external-oracle.js";

/**
 * Thrown by an oracle implementation when the required external tool is absent.
 *
 * Precondition:  none — thrown from oracle implementations, not from user code.
 * Postcondition: callers catch this and skip oracle resolution; the claim is
 *                excluded from the calibrated arm (no oracle_resolved_truth written).
 * Invariant:     oracleType identifies which oracle is unavailable for diagnostics.
 */
export class OracleUnavailableError extends Error {
  /** Which oracle type is unavailable. */
  readonly oracleType: ExternalGroundingType;

  constructor(oracleType: ExternalGroundingType, reason: string) {
    super(
      `OracleUnavailableError[${oracleType}]: ${reason}`,
    );
    this.name = "OracleUnavailableError";
    this.oracleType = oracleType;
    // Ensure correct prototype chain for instanceof checks (TS/Node limitation).
    Object.setPrototypeOf(this, OracleUnavailableError.prototype);
  }
}
