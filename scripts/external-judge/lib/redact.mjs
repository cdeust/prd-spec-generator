/**
 * Redaction — strip credentials from anything that might get logged.
 *
 * Precondition: `value` is a JSON-serializable object (headers map, request
 * options, error payload, etc.) or a string.
 * Postcondition: returns a deep-cloned value with any Authorization header
 * value and any key literally named "apiKey" / "api_key" replaced by
 * "***REDACTED***"; the original object is never mutated.
 *
 * Invariant: no code path in this module ever logs `config.apiKey` or an
 * "Authorization" header value verbatim — this is the single choke point
 * every debug-output call site must route through.
 */

const REDACTED = "***REDACTED***";
const SENSITIVE_KEYS = new Set(["apikey", "api_key", "authorization"]);

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function redact(value) {
  if (typeof value === "string") {
    // Bearer tokens / raw keys pasted directly into a string (e.g. a URL
    // query param or a curl-command echo).
    return value.replace(/Bearer\s+\S+/gi, `Bearer ${REDACTED}`);
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        out[key] = REDACTED;
      } else {
        out[key] = redact(val);
      }
    }
    return out;
  }
  return value;
}
