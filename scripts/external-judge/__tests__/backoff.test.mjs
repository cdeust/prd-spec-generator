import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBackoffDelayMs, BASE_DELAY_MS, MAX_DELAY_MS, MIN_INTERVAL_MS } from "../lib/backoff.mjs";

test("MIN_INTERVAL_MS: mistral floor respects the task's ~2 req/min constraint (>= 30s between requests)", () => {
  assert.equal(MIN_INTERVAL_MS.mistral, 30_000);
  assert.equal(MIN_INTERVAL_MS.gemini, 0);
  assert.equal(MIN_INTERVAL_MS.custom, 0);
});

test("computeBackoffDelayMs: honors an integer-seconds Retry-After header exactly", () => {
  assert.equal(computeBackoffDelayMs(1, "5"), 5000);
  assert.equal(computeBackoffDelayMs(3, "0"), 0);
});

test("computeBackoffDelayMs: honors an HTTP-date Retry-After header", () => {
  const future = new Date(Date.now() + 10_000).toUTCString();
  const delay = computeBackoffDelayMs(1, future);
  // Allow scheduling jitter in the test itself (Date.now() called twice).
  assert.ok(delay > 8000 && delay <= 10_000, `expected ~10000ms, got ${delay}`);
});

test("computeBackoffDelayMs: falls back to exponential schedule when Retry-After is absent", () => {
  assert.equal(computeBackoffDelayMs(1, undefined), BASE_DELAY_MS);
  assert.equal(computeBackoffDelayMs(2, undefined), BASE_DELAY_MS * 2);
  assert.equal(computeBackoffDelayMs(3, undefined), BASE_DELAY_MS * 4);
});

test("computeBackoffDelayMs: caps the exponential schedule at MAX_DELAY_MS", () => {
  assert.equal(computeBackoffDelayMs(10, undefined), MAX_DELAY_MS);
});

test("computeBackoffDelayMs: falls back to exponential when Retry-After is unparseable garbage", () => {
  const delay = computeBackoffDelayMs(1, "not-a-valid-header");
  assert.equal(delay, BASE_DELAY_MS);
});
