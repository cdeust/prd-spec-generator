/**
 * Wave F3 — build-corpus.mjs
 *
 * One-shot generator for `data/reliability-claim-corpus.json`. The corpus
 * source-of-truth lives in this script so every committed claim has an
 * inline justification + traceable authoring intent.
 *
 * Distribution (Wave F3 brief):
 *   schema=15 (30%) | math=15 (30%) | code=13 (26%) | spec=7 (14%) | total=50
 *
 * Each claim:
 *   - claim_id     stable F3-### ID, used by the partition draw
 *   - claim_type   @prd-gen/core ClaimSchema.claim_type enum value
 *   - description  short English purpose-of-the-claim
 *   - external_grounding { type, payload } adjudicable by invokeOracle()
 *   - expected_truth what the oracle SHOULD return for this claim
 *
 * Difficulty mix: easy (~60%), tricky (~30%), adversarial (~10%) — adversarial
 * cases include: math precision traps, schema near-miss, tsc strict-only errors,
 * spec-rule mid-section failures.
 *
 * source: docs/PHASE_4_PLAN.md §4.1 four-category taxonomy.
 * source: Wave F3 brief.
 */

import { writeFileSync } from "node:fs";

// ─── Helper makers ──────────────────────────────────────────────────────────

let _counter = 1;
function nextId() {
  const n = String(_counter++).padStart(3, "0");
  return `F3-${n}`;
}

function math({ description, expression, expected_value, tolerance, expected_truth, claim_type = "correctness" }) {
  return {
    claim_id: nextId(),
    claim_type,
    description,
    external_grounding: {
      type: "math",
      payload:
        tolerance !== undefined
          ? { expression, expected_value, tolerance }
          : { expression, expected_value },
    },
    expected_truth,
  };
}

function schema({ description, schema, instance, expected_valid, expected_truth, claim_type = "data_model" }) {
  return {
    claim_id: nextId(),
    claim_type,
    description,
    external_grounding: {
      type: "schema",
      payload: { schema, instance, expected_valid },
    },
    expected_truth,
  };
}

function code({ description, snippet, expected_compiles, expected_truth, claim_type = "correctness" }) {
  return {
    claim_id: nextId(),
    claim_type,
    description,
    external_grounding: {
      type: "code",
      payload: { snippet, expected_compiles },
    },
    expected_truth,
  };
}

function spec({ description, markdown, section_type, expected_passes, expected_truth, claim_type = "fr_traceability" }) {
  return {
    claim_id: nextId(),
    claim_type,
    description,
    external_grounding: {
      type: "spec",
      payload: { markdown, section_type, expected_passes },
    },
    expected_truth,
  };
}

// ─── 15 MATH claims ─────────────────────────────────────────────────────────

const mathClaims = [
  // Easy arithmetic — 5
  math({ description: "Two plus two equals four (truthful claim).",
    expression: "2 + 2", expected_value: 4, expected_truth: true,
    claim_type: "story_point_arithmetic" }),
  math({ description: "Three times five equals fifteen (truthful claim).",
    expression: "3 * 5", expected_value: 15, expected_truth: true,
    claim_type: "story_point_arithmetic" }),
  math({ description: "Ten minus seven equals three (truthful claim).",
    expression: "10 - 7", expected_value: 3, expected_truth: true,
    claim_type: "story_point_arithmetic" }),
  math({ description: "(7 + 3) × 4 − 2 evaluates to 38 (PHASE_4_PLAN §4.1 example).",
    expression: "(7 + 3) * 4 - 2", expected_value: 38, expected_truth: true }),
  math({ description: "Twelve divided by four equals three (truthful claim).",
    expression: "12 / 4", expected_value: 3, expected_truth: true,
    claim_type: "story_point_arithmetic" }),

  // False arithmetic — 4 (claim asserts wrong value, oracle returns truth=false)
  math({ description: "Two plus two equals five (FALSE — oracle catches arithmetic error).",
    expression: "2 + 2", expected_value: 5, expected_truth: false,
    claim_type: "story_point_arithmetic" }),
  math({ description: "Six times seven equals forty (FALSE — should be 42).",
    expression: "6 * 7", expected_value: 40, expected_truth: false,
    claim_type: "story_point_arithmetic" }),
  math({ description: "Sum of 1..10 equals 50 (FALSE — should be 55).",
    expression: "sum([1,2,3,4,5,6,7,8,9,10])", expected_value: 50, expected_truth: false }),
  math({ description: "Hundred divided by four equals 24 (FALSE — should be 25).",
    expression: "100 / 4", expected_value: 24, expected_truth: false }),

  // Functions / non-trivial — 4 (true)
  math({ description: "Sqrt(2)^2 ≈ 2 within 1e-10 tolerance (FP precision claim).",
    expression: "sqrt(2)^2", expected_value: 2, tolerance: 1e-10, expected_truth: true }),
  math({ description: "Factorial of 5 is 120.",
    expression: "5!", expected_value: 120, expected_truth: true }),
  math({ description: "log10(1000) equals 3.",
    expression: "log10(1000)", expected_value: 3, tolerance: 1e-12, expected_truth: true }),
  math({ description: "sum(1..10) equals 55 (Gauss closed form).",
    expression: "sum([1,2,3,4,5,6,7,8,9,10])", expected_value: 55, expected_truth: true }),

  // Adversarial — 2
  // tolerance=0 trap: sqrt(2)^2 may not be exactly 2 in FP. We claim it equals 2
  // with tolerance ≥ 1e-15 but oracle has DEFAULT_TOLERANCE=1e-9 so this passes.
  math({ description: "0.1 + 0.2 equals 0.3 with default tolerance (FP precision OK at 1e-9).",
    expression: "0.1 + 0.2", expected_value: 0.3, expected_truth: true }),
  // mathjs throws on undefined identifier 'eval' (security trap) → oracle returns truth=false.
  math({ description: "Adversarial: claim expression with unknown identifier (mathjs rejects).",
    expression: "fooBarBaz(1)", expected_value: 0, expected_truth: false,
    claim_type: "correctness" }),
];

// ─── 15 SCHEMA claims ───────────────────────────────────────────────────────

const personSchema = {
  title: "person",
  type: "object",
  required: ["name", "age"],
  properties: { name: { type: "string" }, age: { type: "integer" } },
  additionalProperties: false,
};

const intArraySchema = {
  title: "int_array",
  type: "array",
  items: { type: "integer" },
};

const hexIdSchema = {
  title: "hex_id_obj",
  type: "object",
  required: ["id"],
  // 8-hex-digit ID. Ajv built-ins do not include 'uuid' format (would require
  // ajv-formats); pattern is portable and equivalently strict for the
  // example PHASE_4_PLAN intends.
  properties: { id: { type: "string", pattern: "^[0-9a-f]{8}$" } },
};

const orderSchema = {
  title: "order",
  type: "object",
  required: ["order_id", "qty"],
  properties: {
    order_id: { type: "string", minLength: 1 },
    qty: { type: "integer", minimum: 1 },
  },
};

const enumSchema = {
  title: "priority_enum",
  type: "object",
  required: ["priority"],
  properties: { priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] } },
};

const schemaClaims = [
  // Easy valid — 4 (instance is valid; expected_valid=true; oracle truth=true)
  schema({ description: "Person {name:Alice, age:30} is valid against the person schema.",
    schema: personSchema, instance: { name: "Alice", age: 30 },
    expected_valid: true, expected_truth: true }),
  schema({ description: "Empty array is valid against int_array schema.",
    schema: intArraySchema, instance: [], expected_valid: true, expected_truth: true }),
  schema({ description: "Array of two integers is valid against int_array.",
    schema: intArraySchema, instance: [1, 2], expected_valid: true, expected_truth: true }),
  schema({ description: "Order {order_id:'X1', qty:3} is valid against order schema.",
    schema: orderSchema, instance: { order_id: "X1", qty: 3 },
    expected_valid: true, expected_truth: true }),

  // Easy invalid — 4 (instance invalid; expected_valid=false; oracle truth=true)
  schema({ description: "{id:'abc'} is INVALID against hex_id schema (pattern ^[0-9a-f]{8}$) (PHASE_4_PLAN example).",
    schema: hexIdSchema, instance: { id: "abc" },
    expected_valid: false, expected_truth: true }),
  schema({ description: "[1,'two',3] FAILS int_array schema (PHASE_4_PLAN example).",
    schema: intArraySchema, instance: [1, "two", 3],
    expected_valid: false, expected_truth: true }),
  schema({ description: "Order with qty=0 FAILS minimum=1 constraint.",
    schema: orderSchema, instance: { order_id: "X", qty: 0 },
    expected_valid: false, expected_truth: true }),
  schema({ description: "Enum LOOKED_UP not in {LOW,MEDIUM,HIGH} → invalid.",
    schema: enumSchema, instance: { priority: "LOOKED_UP" },
    expected_valid: false, expected_truth: true }),

  // False claims — caller asserts the wrong validity → oracle truth=false (4)
  schema({ description: "Caller falsely claims valid Person is INVALID (oracle catches).",
    schema: personSchema, instance: { name: "Bob", age: 25 },
    expected_valid: false, expected_truth: false }),
  schema({ description: "Caller falsely claims invalid array is VALID (oracle catches).",
    schema: intArraySchema, instance: [1, "x"], expected_valid: true, expected_truth: false }),
  schema({ description: "Caller falsely claims missing-field instance is VALID.",
    schema: personSchema, instance: { name: "Carol" },
    expected_valid: true, expected_truth: false }),
  schema({ description: "Caller falsely claims qty=0 order is VALID against order schema.",
    schema: orderSchema, instance: { order_id: "Z", qty: 0 },
    expected_valid: true, expected_truth: false }),

  // Adversarial near-miss — 3
  // Person with extra property → additionalProperties=false makes it invalid;
  // claim asserts it's invalid (true), oracle truth=true.
  schema({ description: "Person with extra property fails additionalProperties=false.",
    schema: personSchema, instance: { name: "Dave", age: 40, extra: 1 },
    expected_valid: false, expected_truth: true }),
  // age:30.5 (non-integer) — type=integer rejects fractional.
  schema({ description: "Person with age=30.5 invalid (integer type required) — adversarial.",
    schema: personSchema, instance: { name: "Eve", age: 30.5 },
    expected_valid: false, expected_truth: true }),
  // Empty object against personSchema — required fields missing → invalid; expected_valid=false; truth=true
  schema({ description: "Empty object against required Person → invalid.",
    schema: personSchema, instance: {}, expected_valid: false, expected_truth: true }),
];

// ─── 13 CODE claims ─────────────────────────────────────────────────────────

const codeClaims = [
  // Compiles — 5 (oracle truth=true when expected_compiles=true and tsc exits 0)
  code({ description: "Trivial number assignment compiles under --strict.",
    snippet: "const x: number = 42; export { x };",
    expected_compiles: true, expected_truth: true }),
  code({ description: "String + interface compile under --strict.",
    snippet: "interface User { id: number; name: string }\nconst u: User = { id: 1, name: 'a' }; export { u };",
    expected_compiles: true, expected_truth: true }),
  code({ description: "Function with two-arg signature compiles.",
    snippet: "function f(a: number, b: number): number { return a + b }\nexport { f };",
    expected_compiles: true, expected_truth: true }),
  code({ description: "Generic identity function compiles.",
    snippet: "function id<T>(x: T): T { return x }\nexport { id };",
    expected_compiles: true, expected_truth: true }),
  code({ description: "Readonly array literal type compiles.",
    snippet: "const arr: readonly number[] = [1, 2, 3]; export { arr };",
    expected_compiles: true, expected_truth: true }),

  // Fails to compile — 4 (snippet has type error; expected_compiles=false; truth=true)
  code({ description: "const x: number = 'hello' fails strict TS (PHASE_4_PLAN example).",
    snippet: "const x: number = 'hello'; export { x };",
    expected_compiles: false, expected_truth: true }),
  code({ description: "Function returning a+b where b: string fails strict (PHASE_4_PLAN example).",
    snippet: "function f(a: number, b: string): number { return a + b }\nexport { f };",
    expected_compiles: false, expected_truth: true }),
  code({ description: "Missing required property in object literal fails strict.",
    snippet: "interface U { id: number; name: string }\nconst u: U = { id: 1 }; export { u };",
    expected_compiles: false, expected_truth: true }),
  code({ description: "Calling string method on number fails strict.",
    snippet: "const n: number = 5; const s: string = n.toUpperCase(); export { s };",
    expected_compiles: false, expected_truth: true }),

  // Caller asserts the wrong compilation outcome (truth=false) — 2
  code({ description: "Caller falsely claims invalid snippet compiles (oracle catches).",
    snippet: "const x: number = 'oops'; export { x };",
    expected_compiles: true, expected_truth: false }),
  code({ description: "Caller falsely claims valid snippet does NOT compile.",
    snippet: "const ok: string = 'fine'; export { ok };",
    expected_compiles: false, expected_truth: false }),

  // Adversarial — 2
  // Strict-only check: implicit-any on unannotated function param fails under --strict.
  code({ description: "Implicit-any param fails ONLY under --strict (adversarial).",
    snippet: "function plus(a, b) { return a + b }\nexport { plus };",
    expected_compiles: false, expected_truth: true }),
  // Conditional type that resolves correctly compiles cleanly.
  code({ description: "Conditional type T extends number compiles under --strict.",
    snippet: "type IsNum<T> = T extends number ? 1 : 0;\nconst v: IsNum<5> = 1; export { v };",
    expected_compiles: true, expected_truth: true }),
];

// ─── 7 SPEC claims ──────────────────────────────────────────────────────────

// `overview` section type has zero rules mapped (rule-mapping.ts) — anything passes.
const cleanOverview = "## Overview\n\nThis feature adds single sign-on support to the platform.\n";
const cleanOverviewLong =
  "## Overview\n\nThe API gateway terminates TLS and forwards requests to the back-end.\n";

// requirements section: introduce duplicate FR IDs to trigger duplicate_requirement_ids.
// We use a body that contains "FR-001" twice in identifiable rule-pattern positions.
const dupReqMarkdown = [
  "## Functional Requirements",
  "",
  "| ID | Title | Description | AC | Priority | SP |",
  "|---|---|---|---|---|---|",
  "| FR-001 | Login | User can log in | AC-001 | High | 3 |",
  "| FR-001 | Duplicate ID | Trips duplicate_requirement_ids rule | AC-002 | High | 2 |",
  "",
].join("\n");

// Second requirements section with duplicate FR IDs (different surface form
// from dupReqMarkdown — extra columns, different ID FR-100). Confirmed via
// validateSection() to trigger duplicate_requirement_ids during Wave F3
// authoring (build-corpus.mjs probe 2026-04-27).
const dupReqMarkdown2 = [
  "## Functional Requirements",
  "",
  "| ID | Title | Description | AC | Priority | SP |",
  "|---|---|---|---|---|---|",
  "| FR-100 | Sign in | First duplicate | AC-100 | Med | 2 |",
  "| FR-100 | Sign out | Second duplicate of FR-100 | AC-101 | Med | 2 |",
  "",
].join("\n");

const specClaims = [
  // Pass — overview section is rule-free (3)
  spec({ description: "Clean overview section passes (zero rules applicable).",
    markdown: cleanOverview, section_type: "overview",
    expected_passes: true, expected_truth: true,
    claim_type: "fr_traceability" }),
  spec({ description: "Another clean overview body passes.",
    markdown: cleanOverviewLong, section_type: "overview",
    expected_passes: true, expected_truth: true,
    claim_type: "architecture" }),
  // Caller falsely claims clean overview fails → oracle truth=false.
  spec({ description: "Caller falsely claims a clean overview FAILS (oracle catches).",
    markdown: cleanOverview, section_type: "overview",
    expected_passes: false, expected_truth: false,
    claim_type: "fr_traceability" }),

  // Requirements with duplicate IDs → fails; claim says fails → truth=true (2).
  spec({ description: "Requirements with duplicate FR-001 fails; claim asserts fail → truth=true.",
    markdown: dupReqMarkdown, section_type: "requirements",
    expected_passes: false, expected_truth: true,
    claim_type: "fr_traceability" }),
  spec({ description: "Second dup-FR-100 requirements section fails; claim asserts fail → truth=true.",
    markdown: dupReqMarkdown2, section_type: "requirements",
    expected_passes: false, expected_truth: true,
    claim_type: "fr_traceability" }),

  // Adversarial — caller wrongly claims duplicate-IDs requirements PASSES → oracle truth=false (1).
  spec({ description: "Caller falsely claims dup-FR requirements section PASSES (oracle catches).",
    markdown: dupReqMarkdown, section_type: "requirements",
    expected_passes: true, expected_truth: false,
    claim_type: "fr_traceability" }),

  // jira_tickets is a synthetic section with no HOR rules — should always pass (1).
  spec({ description: "jira_tickets section is rule-free; clean body passes.",
    markdown: "## JIRA Tickets\n\n- FOO-1: implement login\n",
    section_type: "jira_tickets",
    expected_passes: true, expected_truth: true,
    claim_type: "fr_traceability" }),
];

// ─── Compose + verify totals ─────────────────────────────────────────────────

const claims = [...mathClaims, ...schemaClaims, ...codeClaims, ...specClaims];

const breakdown = { schema: 0, math: 0, code: 0, spec: 0 };
for (const c of claims) breakdown[c.external_grounding.type]++;

if (claims.length !== 50) {
  console.error(`expected 50 claims, got ${claims.length}`);
  process.exit(1);
}
const expected = { schema: 15, math: 15, code: 13, spec: 7 };
for (const k of Object.keys(expected)) {
  if (breakdown[k] !== expected[k]) {
    console.error(`expected ${expected[k]} ${k}, got ${breakdown[k]}`);
    process.exit(1);
  }
}

const corpus = {
  schema_version: 1,
  seed: "phase4-section-4.1-rng-2025",
  description:
    "Phase 4.1 reliability claim corpus (Wave F3). 50 claims with externally-" +
    "verifiable ground truth across 4 oracle categories. Each claim's " +
    "expected_truth records what invokeOracle() should return; validate-corpus.mjs " +
    "asserts the corpus matches reality before any partition draw.",
  claims,
};

const path = "packages/benchmark/calibration/data/reliability-claim-corpus.json";
writeFileSync(path, JSON.stringify(corpus, null, 2) + "\n", "utf8");
console.log(`Wrote ${claims.length} claims to ${path}`);
console.log("Breakdown:", breakdown);
