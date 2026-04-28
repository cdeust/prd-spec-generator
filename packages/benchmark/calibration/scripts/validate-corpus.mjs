/**
 * Wave F3.B — validate-corpus.mjs
 *
 * Invokes invokeOracle() against every claim in the committed
 * reliability-claim-corpus.json and asserts the oracle's `truth` agrees with
 * the corpus's `expected_truth`. Any drift is a fatal error — the corpus or
 * the oracle is wrong, and partition-drawing must NOT proceed.
 *
 * Run from repo root:
 *   node packages/benchmark/calibration/scripts/validate-corpus.mjs
 *
 * Exit codes:
 *   0  every claim's expected_truth matches its oracle verdict.
 *   1  ≥1 mismatch; details printed to stderr.
 *
 * source: docs/PHASE_4_PLAN.md §4.1; Wave F3 brief F3.B.
 */

import { readFileSync } from "node:fs";
import { invokeOracle } from "../../dist/calibration/external-oracle.js";

const CORPUS_PATH =
  "packages/benchmark/calibration/data/reliability-claim-corpus.json";

const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));

if (corpus.schema_version !== 1) {
  console.error(`unexpected corpus schema_version=${corpus.schema_version}`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
const failures = [];

for (const claim of corpus.claims) {
  const { claim_id, external_grounding, expected_truth } = claim;
  let result;
  try {
    result = await invokeOracle({
      id: claim_id,
      type: external_grounding.type,
      payload: external_grounding.payload,
    });
  } catch (err) {
    failures.push({
      claim_id,
      type: external_grounding.type,
      reason: `oracle threw: ${err?.message ?? String(err)}`,
    });
    fail++;
    continue;
  }
  if (result.truth === expected_truth) {
    pass++;
  } else {
    fail++;
    failures.push({
      claim_id,
      type: external_grounding.type,
      expected_truth,
      actual_truth: result.truth,
      evidence: result.oracle_evidence,
    });
  }
}

console.log(`Validated ${corpus.claims.length} claims.`);
console.log(`Passing: ${pass}`);
console.log(`Failing: ${fail}`);
if (fail > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(JSON.stringify(f, null, 2));
  process.exit(1);
}
process.exit(0);
