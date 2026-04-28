/**
 * Pre-registered constants for the §4.5 calibration runner (Wave D / D3.1).
 *
 * Split out from `calibrate-gates.ts` so the CLI shell + tests can import
 * the constants without importing the runner (which transitively imports
 * `measurePipeline` and the orchestration runtime).
 *
 * source: docs/PHASE_4_PLAN.md §4.5 (seed, K) and §4.2 (event-rate seed,
 *   tolerance, anchor).
 */

/**
 * Pre-registered RNG seed for §4.5 calibration.
 * source: docs/PHASE_4_PLAN.md §4.5 — `seed = 0x4_05_C3`.
 */
export const PRE_REGISTERED_SEED_45 = 0x4_05_c3;

/**
 * Pre-registered RNG seed for §4.2 event-rate measurement.
 * source: docs/PHASE_4_PLAN.md §4.2 — `seed = 4_020_704`.
 */
export const PRE_REGISTERED_SEED_42 = 4_020_704;

/** Default K target per §4.5 frozen-baseline subsection. */
export const DEFAULT_K = 100;

/** Default K=50 baseline runs for §4.2 event-rate measurement. */
export const DEFAULT_EVENT_RATE_K = 50;

/** Tolerance for the §4.2 ±0.05 absolute event-rate divergence check. */
export const EVENT_RATE_TOLERANCE = 0.05;

/** Provisional event-rate anchor (§4.2). */
export const PROVISIONAL_EVENT_RATE = 0.3;
