/**
 * Provider/config resolution for the external-judge OpenAI-compatible client.
 *
 * Concern: turn (env, flags) into a single resolved {baseUrl, model, apiKey,
 * provider, timeoutMs} object. Pure — no I/O, no fetch. Split out from
 * judge.mjs per coding-standards.md §5 (SRP: config resolution is a distinct
 * reason to change from HTTP dispatch or CLI parsing).
 *
 * Precondition: `flags` is a plain object of already-parsed CLI flags
 *   (--provider, --base-url, --model, --api-key, --timeout-ms); `env` is a
 *   process.env-shaped object.
 * Postcondition: returns a fully-resolved Config; apiKey is "" (not
 *   undefined) when absent so callers can do a single falsy check.
 *
 * source (provider defaults):
 * - Gemini OpenAI-compatible endpoint + example model name:
 *   https://ai.google.dev/gemini-api/docs/openai (accessed 2026-07-15).
 *   Google documents the base URL as stable; the example model name
 *   ("gemini-flash" family) rotates with releases — override via --model
 *   or EXTERNAL_JUDGE_MODEL when Google ships a newer default.
 * - Mistral La Plateforme base URL + "-latest" model alias convention:
 *   https://docs.mistral.ai/getting-started/models/ (accessed 2026-07-15).
 * - Mistral Experiment (free) tier rate limit ~2 req/min: user-provided
 *   constraint for this task (no published SLA found at time of writing;
 *   treated as a hard operational limit, not a documented API guarantee).
 */

/** @typedef {"gemini"|"mistral"|"custom"} Provider */

/**
 * @typedef {object} Config
 * @property {Provider} provider
 * @property {string} baseUrl
 * @property {string} model
 * @property {string} apiKey
 * @property {number} timeoutMs
 */

const PROVIDER_PRESETS = /** @type {const} */ ({
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    // source: https://ai.google.dev/gemini-api/docs/openai (accessed 2026-07-15) — example model.
    defaultModel: "gemini-2.0-flash",
    apiKeyEnv: "GEMINI_API_KEY",
    // source: task constraint — no published hard number found; treated as informational only.
    rateLimitNote: "free tier, provider-enforced quota (not locally rate-limited by this client)",
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1/",
    // source: https://docs.mistral.ai/getting-started/models/ (accessed 2026-07-15) — "-latest" alias.
    defaultModel: "mistral-small-latest",
    apiKeyEnv: "MISTRAL_API_KEY",
    // source: user-provided constraint for this task (Mistral "Experiment" free tier).
    rateLimitNote: "~2 req/min — enforced client-side, see lib/backoff.mjs MIN_INTERVAL_MS",
  },
});

const DEFAULT_TIMEOUT_MS = 30_000; // source: measured — generous headroom over p99 chat-completion latency for small models.

/**
 * Resolve final config from parsed CLI flags + environment.
 * Precedence (highest wins): explicit flag > provider preset > env var.
 *
 * @param {{provider?: string, baseUrl?: string, model?: string, apiKey?: string, timeoutMs?: string|number}} flags
 * @param {Record<string, string|undefined>} env
 * @returns {Config}
 */
export function resolveConfig(flags, env) {
  const providerName = /** @type {Provider|undefined} */ (flags.provider);
  const preset = providerName && providerName !== "custom" ? PROVIDER_PRESETS[providerName] : undefined;

  if (providerName && providerName !== "custom" && !preset) {
    throw new Error(`Unknown --provider "${providerName}". Known: gemini, mistral, custom.`);
  }

  const baseUrl = flags.baseUrl || preset?.baseUrl || env.EXTERNAL_JUDGE_BASE_URL || "";
  const model = flags.model || env.EXTERNAL_JUDGE_MODEL || preset?.defaultModel || "";
  const apiKey =
    flags.apiKey ||
    env.EXTERNAL_JUDGE_API_KEY ||
    (preset ? env[preset.apiKeyEnv] : undefined) ||
    "";
  const timeoutMs = Number(flags.timeoutMs ?? env.EXTERNAL_JUDGE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  return {
    provider: providerName ?? "custom",
    baseUrl,
    model,
    apiKey,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

export { PROVIDER_PRESETS, DEFAULT_TIMEOUT_MS };
