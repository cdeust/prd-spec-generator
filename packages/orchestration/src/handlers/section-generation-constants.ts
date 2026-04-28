/**
 * Constants for the section-generation handler.
 *
 * Extracted to a separate file so both section-generation.ts and
 * section-generation/validate-and-advance.ts can import MAX_ATTEMPTS
 * without a circular dependency.
 *
 * source: Wave D B6 refactor (circular import resolution).
 * source: docs/PHASE_4_PLAN.md §4.2 retry budget.
 */

/**
 * Maximum draft attempts per section before marking it failed and moving on.
 *
 * This constant is the single authoritative value re-exported by
 * section-generation.ts for the benchmark layer (Wave D1.A).
 *
 * source: docs/PHASE_4_PLAN.md §4.2 retry budget; provisional anchor pending
 * the Schoenfeld N=823 ablation study (Wave D + future calibration runs).
 * Current value (1 initial + 2 retries = 3) was chosen based on engineering
 * judgment; the calibrated replacement is injected at runtime via
 * state.retry_policy.maxAttempts (see D1.C).
 */
// source: docs/PHASE_4_PLAN.md §4.2 retry budget; provisional anchor pending
// the Schoenfeld N=823 ablation study (Wave D + future calibration runs).
export const MAX_ATTEMPTS = 3;
