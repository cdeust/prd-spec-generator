import { z } from "zod";

/**
 * 5-level verification verdict taxonomy — from SKILL.md Rule 15.
 * This is a load-bearing quality driver (Ginzburg audit #6).
 *
 * The expected distribution prevents sycophantic rubber-stamping:
 *   PASS: 60-80%
 *   SPEC-COMPLETE: 10-25%
 *   NEEDS-RUNTIME: 2-10%
 *   INCONCLUSIVE: 1-5%
 *   FAIL: 0% (after self-check — violations should be fixed before delivery)
 *
 * A report with 100% PASS verdicts is REJECTED.
 * NFR claims (latency, throughput, storage) MUST NOT receive PASS.
 */
export const VerdictSchema = z.enum([
  "PASS",
  "SPEC-COMPLETE",
  "NEEDS-RUNTIME",
  "INCONCLUSIVE",
  "FAIL",
]);

export type Verdict = z.infer<typeof VerdictSchema>;

export const EXPECTED_VERDICT_DISTRIBUTION = {
  PASS: { min: 0.6, max: 0.8 },
  "SPEC-COMPLETE": { min: 0.1, max: 0.25 },
  "NEEDS-RUNTIME": { min: 0.02, max: 0.1 },
  INCONCLUSIVE: { min: 0.01, max: 0.05 },
  FAIL: { min: 0, max: 0 },
} as const;

/**
 * Check if a verdict distribution is suspicious (all PASS = confirmatory bias).
 */
export function isDistributionSuspicious(
  verdicts: readonly Verdict[],
): boolean {
  if (verdicts.length < 5) return false;
  const passRate = verdicts.filter((v) => v === "PASS").length / verdicts.length;
  return passRate >= 1.0;
}
