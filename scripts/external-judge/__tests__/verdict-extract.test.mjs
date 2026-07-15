import { test } from "node:test";
import assert from "node:assert/strict";
import { extractVerdict } from "../lib/verdict-extract.mjs";

test("extractVerdict: parses a clean JSON-only reply", () => {
  const raw = '{"verdict":"PASS","rationale":"looks fine","caveats":[],"confidence":0.9}';
  const v = extractVerdict(raw);
  assert.equal(v.verdict, "PASS");
  assert.equal(v.rationale, "looks fine");
  assert.deepEqual(v.caveats, []);
  assert.equal(v.confidence, 0.9);
});

test("extractVerdict: tolerates markdown code fences around the object", () => {
  const raw = '```json\n{"verdict":"FAIL","rationale":"contradiction found","caveats":["c1"],"confidence":0.6}\n```';
  const v = extractVerdict(raw);
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(v.caveats, ["c1"]);
});

test("extractVerdict: tolerates leading prose before the JSON object", () => {
  const raw =
    'Here is my assessment of the claim.\n\n{"verdict":"SPEC-COMPLETE","rationale":"method specified","caveats":[],"confidence":0.75}\n\nLet me know if you need more detail.';
  const v = extractVerdict(raw);
  assert.equal(v.verdict, "SPEC-COMPLETE");
});

test("extractVerdict: handles a brace character inside a quoted rationale without truncating", () => {
  const raw = '{"verdict":"PASS","rationale":"the block { is fine } here","caveats":[],"confidence":0.8}';
  const v = extractVerdict(raw);
  assert.equal(v.rationale, "the block { is fine } here");
});

test("extractVerdict: defaults missing caveats to []", () => {
  const raw = '{"verdict":"PASS","rationale":"ok","confidence":0.5}';
  const v = extractVerdict(raw);
  assert.deepEqual(v.caveats, []);
});

test("extractVerdict: clamps out-of-range confidence into [0,1]", () => {
  assert.equal(extractVerdict('{"verdict":"PASS","rationale":"x","confidence":1.5}').confidence, 1);
  assert.equal(extractVerdict('{"verdict":"PASS","rationale":"x","confidence":-0.2}').confidence, 0);
});

test("extractVerdict: throws a clear error on empty reply", () => {
  assert.throws(() => extractVerdict(""), /empty reply/);
});

test("extractVerdict: throws a clear error when no JSON object is present", () => {
  assert.throws(() => extractVerdict("I refuse to answer in JSON."), /no balanced JSON object/);
});

test("extractVerdict: throws a clear error on an invalid verdict enum value", () => {
  assert.throws(
    () => extractVerdict('{"verdict":"MAYBE","rationale":"x","confidence":0.5}'),
    /must be one of/,
  );
});

test("extractVerdict: throws a clear error on unparseable JSON", () => {
  assert.throws(() => extractVerdict("{verdict: PASS, not valid json}"), /failed to parse/);
});

test("extractVerdict: throws when rationale is missing or empty", () => {
  assert.throws(
    () => extractVerdict('{"verdict":"PASS","rationale":"","confidence":0.5}'),
    /rationale.*non-empty/,
  );
});
