import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../lib/redact.mjs";

test("redact: masks an apiKey field", () => {
  const out = redact({ apiKey: "sk-super-secret", model: "gemini-2.0-flash" });
  assert.equal(out.apiKey, "***REDACTED***");
  assert.equal(out.model, "gemini-2.0-flash");
});

test("redact: masks an authorization header value regardless of case", () => {
  const out = redact({ headers: { Authorization: "Bearer sk-secret", "content-type": "application/json" } });
  assert.equal(out.headers.Authorization, "***REDACTED***");
  assert.equal(out.headers["content-type"], "application/json");
});

test("redact: masks a Bearer token embedded in a plain string", () => {
  const out = redact("curl -H 'Authorization: Bearer sk-abc123' https://example.com");
  assert.ok(!out.includes("sk-abc123"));
  assert.match(out, /Bearer \*\*\*REDACTED\*\*\*/);
});

test("redact: recurses into nested objects and arrays without mutating the original", () => {
  const original = { config: { apiKey: "secret", nested: [{ api_key: "also-secret" }] } };
  const clone = JSON.parse(JSON.stringify(original));
  const out = redact(original);
  assert.equal(out.config.apiKey, "***REDACTED***");
  assert.equal(out.config.nested[0].api_key, "***REDACTED***");
  assert.deepEqual(original, clone, "redact must not mutate its input");
});

test("redact: leaves non-sensitive primitives untouched", () => {
  assert.equal(redact(42), 42);
  assert.equal(redact(null), null);
  assert.equal(redact(true), true);
});
