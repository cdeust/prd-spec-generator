/**
 * Backoff computation for 429 responses — pure function, no timers, no fetch.
 *
 * Precondition: `attempt` is a 1-based retry counter (1 = first retry after
 * the initial request failed); `retryAfterHeader` is the raw `Retry-After`
 * header value (string) if the server sent one, else undefined.
 * Postcondition: returns a non-negative integer delay in milliseconds. When
 * the server sends `Retry-After`, that value is authoritative and returned
 * verbatim (converted to ms) — the exponential schedule is only a fallback
 * for servers that return 429 without the header.
 *
 * source: RFC 6585 §4 (HTTP 429 Too Many Requests, Retry-After semantics) —
 * honoring Retry-After over a client-guessed schedule is the standard-
 * mandated behavior, not a local invention.
 * Exponential base/factor/cap: no published SLA for the free tiers this
 * targets (Gemini AI Studio, Mistral Experiment); values below are a
 * conservative engineering default sized to Mistral's user-stated ~2
 * req/min ceiling (MIN_INTERVAL_MS), not an invented magic number for the
 * schedule shape itself.
 */

const BASE_DELAY_MS = 1_000; // first fallback retry waits >= 1s
const BACKOFF_FACTOR = 2; // standard doubling schedule
const MAX_DELAY_MS = 30_000; // cap so a flaky run doesn't stall a CI job for minutes
const MAX_ATTEMPTS = 5; // source: task constraint — bounded retries, never infinite

/**
 * Mistral free "Experiment" tier: ~2 requests/minute (user-provided
 * constraint, §config.mjs). Enforced client-side as a floor between any two
 * outbound requests to a mistral-provider config, independent of whether a
 * 429 was actually received — this is proactive throttling, not reactive
 * backoff.
 */
export const MIN_INTERVAL_MS = { mistral: 30_000, gemini: 0, custom: 0 };

/**
 * @param {number} attempt 1-based retry attempt number
 * @param {string|undefined} retryAfterHeader raw Retry-After header value
 * @returns {number} delay in milliseconds, >= 0
 */
export function computeBackoffDelayMs(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const asSeconds = Number(retryAfterHeader);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return Math.round(asSeconds * 1000);
    }
    // Retry-After may also be an HTTP-date; fall back to the exponential
    // schedule if it isn't a plain integer-seconds value we can parse.
    const asDate = Date.parse(retryAfterHeader);
    if (!Number.isNaN(asDate)) {
      return Math.max(0, asDate - Date.now());
    }
  }
  const exponential = BASE_DELAY_MS * BACKOFF_FACTOR ** Math.max(0, attempt - 1);
  return Math.min(exponential, MAX_DELAY_MS);
}

export { BASE_DELAY_MS, BACKOFF_FACTOR, MAX_DELAY_MS, MAX_ATTEMPTS };
