import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildClaimPrompt } from "../lib/prompt-builder.mjs";
import { loadGroundTruth, summarize } from "../calibrate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GROUND_TRUTH_PATH = join(__dirname, "..", "fixtures", "ground-truth.json");

const MAX_PROMPT_CHARS = 8000; // task requirement: claim-scoped prompts target <= 8K chars

test("loadGroundTruth: fixture has exactly the 10 documented claims", () => {
  const gt = loadGroundTruth(GROUND_TRUTH_PATH);
  assert.equal(gt.claims.length, 10);
  const ids = gt.claims.map((c) => c.claim_id);
  assert.deepEqual(
    ids,
    ["FR-001", "FR-002", "FR-007", "FR-011", "ARCH-001", "ARCH-002", "AC-005", "AC-008", "AC-014", "AC-016"],
  );
});

test("buildClaimPrompt: every claim-scoped prompt stays under the 8K char budget", () => {
  const gt = loadGroundTruth(GROUND_TRUTH_PATH);
  for (const claim of gt.claims) {
    const prompt = buildClaimPrompt(claim);
    assert.ok(
      prompt.length <= MAX_PROMPT_CHARS,
      `${claim.claim_id} prompt is ${prompt.length} chars, exceeds ${MAX_PROMPT_CHARS}`,
    );
  }
});

test("buildClaimPrompt: is NOT the full PRD — every claim prompt is far smaller than fixtures/01-prd.md", () => {
  const fullPrd = readFileSync(join(__dirname, "..", "fixtures", "01-prd.md"), "utf8");
  const gt = loadGroundTruth(GROUND_TRUTH_PATH);
  for (const claim of gt.claims) {
    const prompt = buildClaimPrompt(claim);
    assert.ok(
      prompt.length < fullPrd.length / 2,
      `${claim.claim_id} prompt (${prompt.length} chars) is not meaningfully smaller than the full PRD (${fullPrd.length} chars) — claim scoping failed`,
    );
  }
});

test("buildClaimPrompt: zero neighbor-claim leakage between UNRELATED claims (no shared Depends-On/reference)", () => {
  // A claim's evidence legitimately quotes an FR/AC it explicitly depends
  // on or references in its own text (e.g. AC-005's evidence quotes FR-002,
  // which AC-005 cites by ID) — that is claim-scoped grounding, not
  // leakage. This test instead asserts the negative case: pairs of claims
  // with NO dependency/reference relationship must not share each other's
  // claim-specific wording. Reference behavior mirrors PR #18's snippet
  // fix (a judge sees only what its claim is linked to).
  const gt = loadGroundTruth(GROUND_TRUTH_PATH);
  const byId = Object.fromEntries(gt.claims.map((c) => [c.claim_id, c]));

  // Deliberately-unrelated pairs: neither claim's `text` references the
  // other's ID, and neither PRD "Depends On" links them.
  const unrelatedPairs = [
    ["FR-001", "AC-014"], // grad_rgb replacement vs. sweep-execution test
    ["FR-001", "AC-016"], // grad_rgb replacement vs. diff/gate-G6 inspection
    ["FR-011", "AC-008"], // no-semaphore-colors vs. segmented-rendering contradiction
    ["ARCH-001", "FR-002"], // ports/adapters architecture vs. threshold boundaries
  ];

  for (const [ownerId, strangerId] of unrelatedPairs) {
    const owner = byId[ownerId];
    const ownSentence = owner.text.split(".")[0];
    assert.ok(ownSentence.length >= 20, `${ownerId} fingerprint too short to be reliable`);
    const strangerPrompt = buildClaimPrompt(byId[strangerId]);
    assert.ok(
      !strangerPrompt.includes(ownSentence),
      `${ownerId}'s claim text leaked into unrelated claim ${strangerId}'s prompt`,
    );
  }
});

test("summarize: computes agreement rate, confusion table, and the AC-008 catch flag", () => {
  const gt = loadGroundTruth(GROUND_TRUTH_PATH);
  const rows = gt.claims.map((claim) => {
    if (claim.claim_id === "AC-008") {
      return { claim, result: { status: "ok", verdict: { verdict: "FAIL", rationale: "r", caveats: [], confidence: 0.6 }, latency_ms: 100 } };
    }
    return {
      claim,
      result: {
        status: "ok",
        verdict: { verdict: claim.expected_verdict, rationale: "r", caveats: [], confidence: 0.8 },
        latency_ms: 100,
      },
    };
  });
  const summaryObj = summarize(rows);
  assert.equal(summaryObj.scored, 10);
  assert.equal(summaryObj.agreementRate, 1);
  assert.equal(summaryObj.ac008Caught, true);
});

test("summarize: skipped claims are excluded from agreement rate, not counted as disagreement", () => {
  const gt = loadGroundTruth(GROUND_TRUTH_PATH);
  const rows = gt.claims.map((claim) => ({ claim, result: { status: "skipped", reason: "no credentials" } }));
  const summaryObj = summarize(rows);
  assert.equal(summaryObj.scored, 0);
  assert.equal(summaryObj.skipped, 10);
  assert.equal(summaryObj.agreementRate, null);
  assert.equal(summaryObj.ac008Caught, null);
});

test("summarize: a judge that always PASSes gets high agreement but does NOT catch AC-008", () => {
  const gt = loadGroundTruth(GROUND_TRUTH_PATH);
  const rows = gt.claims.map((claim) => ({
    claim,
    result: { status: "ok", verdict: { verdict: "PASS", rationale: "r", caveats: [], confidence: 0.9 }, latency_ms: 50 },
  }));
  const summaryObj = summarize(rows);
  // 7 of 10 ground-truth claims are PASS -> a PASS-always judge scores 0.7, AT the default threshold...
  assert.equal(summaryObj.agreementRate, 0.7);
  // ...which is exactly why AC-008 is checked as a SEPARATE, mandatory admission condition (see calibrate.mjs header).
  assert.equal(summaryObj.ac008Caught, false);
});
