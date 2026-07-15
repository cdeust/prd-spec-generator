import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../lib/config.mjs";

test("resolveConfig: gemini preset fills base URL and default model from GEMINI_API_KEY", () => {
  const config = resolveConfig({ provider: "gemini" }, { GEMINI_API_KEY: "g-key" });
  assert.equal(config.provider, "gemini");
  assert.equal(config.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai/");
  assert.equal(config.model, "gemini-2.0-flash");
  assert.equal(config.apiKey, "g-key");
});

test("resolveConfig: mistral preset fills base URL and default model from MISTRAL_API_KEY", () => {
  const config = resolveConfig({ provider: "mistral" }, { MISTRAL_API_KEY: "m-key" });
  assert.equal(config.baseUrl, "https://api.mistral.ai/v1/");
  assert.equal(config.model, "mistral-small-latest");
  assert.equal(config.apiKey, "m-key");
});

test("resolveConfig: explicit flags override provider preset", () => {
  const config = resolveConfig(
    { provider: "gemini", model: "gemini-custom", apiKey: "flag-key" },
    { GEMINI_API_KEY: "env-key" },
  );
  assert.equal(config.model, "gemini-custom");
  assert.equal(config.apiKey, "flag-key");
});

test("resolveConfig: EXTERNAL_JUDGE_* env vars work without a provider preset", () => {
  const config = resolveConfig(
    {},
    {
      EXTERNAL_JUDGE_BASE_URL: "https://example.com/v1/",
      EXTERNAL_JUDGE_MODEL: "custom-model",
      EXTERNAL_JUDGE_API_KEY: "raw-key",
    },
  );
  assert.equal(config.baseUrl, "https://example.com/v1/");
  assert.equal(config.model, "custom-model");
  assert.equal(config.apiKey, "raw-key");
});

test("resolveConfig: no credentials anywhere -> apiKey is empty string, never undefined", () => {
  const config = resolveConfig({ provider: "gemini" }, {});
  assert.equal(config.apiKey, "");
});

test("resolveConfig: unknown provider throws", () => {
  assert.throws(() => resolveConfig({ provider: "openai" }, {}), /Unknown --provider/);
});

test("resolveConfig: default timeout applies when unset or invalid", () => {
  assert.equal(resolveConfig({}, {}).timeoutMs, 30_000);
  assert.equal(resolveConfig({ timeoutMs: "not-a-number" }, {}).timeoutMs, 30_000);
  assert.equal(resolveConfig({ timeoutMs: "5000" }, {}).timeoutMs, 5000);
});
