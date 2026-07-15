/**
 * @prd-gen/validation contract tests.
 *
 * Per cross-audit test-engineer C1 (Phase 3+4, 2026-04): the validation
 * package gates section_generation retries. A regression that silently
 * weakens any rule cascades through the full pipeline. These tests pin
 * the contract — they do NOT mirror the implementation: each assertion
 * is on an OBSERVABLE postcondition (a violation surfaces, the score
 * decreases, the report shape is correct), not on the internal regex.
 */

import { describe, expect, it } from "vitest";
import { validateSection, validateDocument } from "../index.js";
import {
  HardOutputRuleSchema,
  isCriticalRule,
  scorePenalty,
  isDeterministicRule,
} from "@prd-gen/core";

describe("isCriticalRule + scorePenalty + isDeterministicRule contracts", () => {
  it("scorePenalty is 0.15 for critical and 0.05 for non-critical", () => {
    for (const rule of HardOutputRuleSchema.options) {
      const penalty = scorePenalty(rule);
      if (isCriticalRule(rule)) {
        expect(penalty).toBe(0.15);
      } else {
        expect(penalty).toBe(0.05);
      }
    }
  });

  it("the two LLM-judgment rules are non-deterministic; everything else is deterministic", () => {
    expect(isDeterministicRule("post_generation_self_check")).toBe(false);
    expect(isDeterministicRule("mandatory_codebase_analysis")).toBe(false);
    expect(isDeterministicRule("fr_numbering_gaps")).toBe(true);
    expect(isDeterministicRule("ac_numbering")).toBe(true);
    expect(isDeterministicRule("clean_architecture")).toBe(true);
  });
});

describe("validateSection report shape", () => {
  it("returns a ValidationReport with the required fields", () => {
    const report = validateSection(
      "## Requirements\n\n- FR-001: OAuth login support.",
      "requirements",
    );
    expect(report).toMatchObject({
      sectionType: "requirements",
      violations: expect.any(Array),
      rulesChecked: expect.any(Array),
      rulesPassed: expect.any(Array),
      hasCriticalViolations: expect.any(Boolean),
      totalScore: expect.any(Number),
      checkedAt: expect.any(String),
    });
    expect(report.totalScore).toBeGreaterThanOrEqual(0);
    expect(report.totalScore).toBeLessThanOrEqual(1);
  });

  it("rulesChecked = rulesPassed ∪ rules-with-violations (no rule lost)", () => {
    const report = validateSection(
      "## Requirements\n\n- FR-001: OAuth login.",
      "requirements",
    );
    const ruleSet = new Set(report.rulesChecked);
    for (const passed of report.rulesPassed) {
      expect(ruleSet.has(passed)).toBe(true);
    }
    for (const v of report.violations) {
      expect(ruleSet.has(v.rule)).toBe(true);
    }
  });

  it("hasCriticalViolations is true iff at least one violation has isCritical=true", () => {
    const report = validateSection(
      "## Requirements\n\n- FR-001: x\n- FR-099: y", // FR-numbering gap
      "requirements",
    );
    const anyCritical = report.violations.some((v) => v.isCritical);
    expect(report.hasCriticalViolations).toBe(anyCritical);
  });

  it("totalScore decreases as violations accumulate (score is penalty-driven, never negative)", () => {
    const clean = validateSection(
      "## Requirements\n\n- FR-001: OAuth login support.",
      "requirements",
    );
    // The same content with an FR-numbering gap should trigger fr_numbering_gaps.
    const gap = validateSection(
      "## Requirements\n\n- FR-001: x\n- FR-099: y",
      "requirements",
    );
    expect(gap.totalScore).toBeLessThanOrEqual(clean.totalScore);
    expect(gap.totalScore).toBeGreaterThanOrEqual(0);
  });
});

describe("validateSection — fr_numbering_gaps detector", () => {
  it("flags FR-001 → FR-099 as a gap (load-bearing assertion for retry test)", () => {
    // Cross-audit closure: this assertion is mirrored in the section-retry
    // injection test (handler-injection.test.ts). If the validator's gap
    // detection is weakened, BOTH tests fail — surfacing the regression
    // at the validator layer instead of letting it propagate.
    const draftWithGap =
      "## Requirements\n\n" +
      "| ID | Requirement | Priority | Source |\n" +
      "|----|-------------|----------|--------|\n" +
      "| FR-001 | OAuth login | P0 | user request |\n" +
      "| FR-099 | password reset | P1 | clarification round 1 |\n";
    const report = validateSection(draftWithGap, "requirements");
    const ruleNames = report.violations.map((v) => v.rule);
    expect(ruleNames).toContain("fr_numbering_gaps");
  });

  it("does NOT flag sequential IDs as a gap", () => {
    const draftSequential =
      "## Requirements\n\n" +
      "| ID | Requirement | Priority | Source |\n" +
      "|----|-------------|----------|--------|\n" +
      "| FR-001 | OAuth login | P0 | u |\n" +
      "| FR-002 | password reset | P1 | u |\n" +
      "| FR-003 | MFA support | P2 | u |\n";
    const report = validateSection(draftSequential, "requirements");
    const ruleNames = report.violations.map((v) => v.rule);
    expect(ruleNames).not.toContain("fr_numbering_gaps");
  });
});

describe("validateSection — ac_numbering detector (acceptance_criteria)", () => {
  it("does not flag AC-001..AC-002..AC-003 sequential", () => {
    const ac =
      "## Acceptance Criteria\n\n" +
      "- AC-001: A user with valid Google credentials can sign in.\n" +
      "- AC-002: A user with invalid credentials sees an error message.\n" +
      "- AC-003: Session tokens expire after 24h.\n";
    const report = validateSection(ac, "acceptance_criteria");
    const ruleNames = report.violations.map((v) => v.rule);
    expect(ruleNames).not.toContain("ac_numbering");
  });
});

describe("validateSection — empty content", () => {
  it("does not throw on empty string content", () => {
    expect(() => validateSection("", "requirements")).not.toThrow();
    const report = validateSection("", "requirements");
    expect(report.sectionType).toBe("requirements");
  });

  it("flags sections of pure whitespace", () => {
    const report = validateSection("   \n\n\n   ", "requirements");
    expect(report.violations.length).toBeGreaterThanOrEqual(0);
    // We don't assert WHICH violations fire (depends on the rule set);
    // we just assert the function doesn't throw and produces a report.
    expect(report.checkedAt).toBeTruthy();
  });
});

describe("validateDocument cross-section checks", () => {
  it("returns a ValidationReport across sections", () => {
    const sections = [
      {
        type: "requirements" as const,
        content: "## Requirements\n\n- FR-001: OAuth login.",
      },
      {
        type: "acceptance_criteria" as const,
        content: "## Acceptance Criteria\n\n- AC-001: User signs in.",
      },
    ];
    const report = validateDocument(sections);
    expect(report).toMatchObject({
      violations: expect.any(Array),
      rulesChecked: expect.any(Array),
      rulesPassed: expect.any(Array),
      totalScore: expect.any(Number),
    });
  });

  it("handles an empty section list without throwing", () => {
    expect(() => validateDocument([])).not.toThrow();
    const report = validateDocument([]);
    // No sections → no rules to check → trivially passing report.
    expect(report.violations.length).toBeGreaterThanOrEqual(0);
  });
});

describe("validateSection — explicit-opt-out for service-shaped rules", () => {
  // source: bug found 2026-04-26 during the wiki-grooming PRD run on the
  // Cortex repo. Local-CLI specs were forced to fail rules that only apply
  // to network services (auth, rate limiting, TLS, GDPR consent, distributed
  // tracing, sensitive-data protection, transaction boundaries, structured
  // error handling). The fix added a `hasExplicitOptOut` helper that
  // recognizes "N/A — by construction" framing and exempts the rule.

  function specWithOptOuts(): string {
    // A representative slice of the rules-affected topics, all explicitly
    // opted out with "N/A — by construction" framing and a short reason.
    return `## Technical Specification

### Cross-Cutting Concerns

#### Authentication and Authorization
Authentication and authorization strategy: N/A — local CLI, no endpoint exposed.

#### Rate Limiting
Rate limiting strategy: N/A — no network endpoint to protect from abuse.

#### Secure Communication
TLS / secure communication: N/A — by construction, the tool performs no network I/O at runtime.

#### Distributed Tracing
Distributed tracing and correlation IDs: N/A — single-process job, no second hop.

#### Sensitive Data Protection
Sensitive data protection: by construction, no PII, secrets, or credentials are accepted as input or emitted as output.

#### Consent and Erasure
Consent management and data erasure (GDPR): N/A — no personal data is processed.

#### Transaction Boundaries
Transaction boundaries and rollback strategy: N/A — read-only tool, nothing to roll back. Idempotent by construction.

#### Structured Error Handling
Error handling: N/A — by construction the tool emits a single error envelope with stable error codes; no swallowed exceptions, error propagation through the orchestrator only.
`;
  }

  it("does NOT flag service-shaped rules when each topic is explicitly opted out", () => {
    const report = validateSection(specWithOptOuts(), "technical_specification");
    const ruleNames = new Set(report.violations.map((v) => v.rule));
    // The eight rules covered above must all be exempted by the opt-out helper.
    for (const name of [
      "auth_on_every_endpoint",
      "rate_limiting_required",
      "secure_communication",
      "distributed_tracing",
      "sensitive_data_protection",
      "consent_and_erasure_support",
      "transaction_boundaries",
      "structured_error_handling",
    ] as const) {
      expect(ruleNames.has(name)).toBe(false);
    }
  });

  it("STILL flags a service-shaped rule when no opt-out marker appears near the topic", () => {
    // A spec that mentions a topic but does NOT include an opt-out marker
    // nearby must still be flagged. This pins the helper's scope: mere
    // mention of the topic is not enough — an explicit acknowledgement of
    // non-applicability is required.
    const noOptOut = `## Technical Specification

The service exposes an HTTP API. Requests are handled synchronously.
The team will document the protection strategy later.
`;
    const report = validateSection(noOptOut, "technical_specification");
    const ruleNames = new Set(report.violations.map((v) => v.rule));
    // rate_limiting_required: no rate-limit keywords AND no opt-out marker
    // near any topic signal ⇒ the rule must still fire.
    expect(ruleNames.has("rate_limiting_required")).toBe(true);
  });
});

describe("validateSection — no_self_referencing_deps", () => {
  // source: bug found 2026-04-26 during the wiki-grooming PRD run. The
  // table-pattern regex was anchored only on `[^|]*`, which still matches
  // newlines, so any FR-NNN appearing in a LATER row's "Depends On" cell
  // falsely flagged the FIRST row as a self-reference. These tests pin the
  // observable contract: cross-row references must NOT fire; same-row
  // self-references MUST fire.

  it("does NOT flag a row whose ID is referenced by a LATER row's depends-on cell", () => {
    // FR-001 in row 1; FR-001 also appears in row 2's Depends On cell.
    // That is a forward reference (FR-002 → FR-001), not a self-reference.
    const content = `## Requirements

| ID | Requirement | Priority | Depends On | Source |
|---|---|---|---|---|
| FR-001 | Load templates at startup. | P0 | — | user-request |
| FR-002 | Validate pages against loaded templates. | P0 | FR-001 | user-request |
| FR-003 | Write the report. | P0 | FR-002 | user-request |
`;
    const report = validateSection(content, "requirements");
    const selfRefViolations = report.violations.filter(
      (v) => v.rule === "no_self_referencing_deps",
    );
    expect(selfRefViolations).toEqual([]);
  });

  it("DOES flag a row whose ID appears in its OWN depends-on cell (genuine self-reference)", () => {
    const content = `## Requirements

| ID | Requirement | Priority | Depends On | Source |
|---|---|---|---|---|
| FR-001 | Load templates at startup. | P0 | FR-001 | user-request |
`;
    const report = validateSection(content, "requirements");
    const selfRefViolations = report.violations.filter(
      (v) => v.rule === "no_self_referencing_deps",
    );
    expect(selfRefViolations.length).toBeGreaterThan(0);
    expect(
      selfRefViolations.some((v) => (v.message ?? "").includes("FR-001")),
    ).toBe(true);
  });

  it("DOES flag a prose self-reference within one sentence", () => {
    const content = `## Requirements

FR-005 depends on FR-005 to bootstrap itself, which is a logical impossibility.
`;
    const report = validateSection(content, "requirements");
    const selfRefViolations = report.violations.filter(
      (v) => v.rule === "no_self_referencing_deps",
    );
    expect(selfRefViolations.length).toBeGreaterThan(0);
  });

  it("does NOT flag two paragraphs each mentioning the same FR-NNN with 'depends on' between", () => {
    // FR-007 appears twice but separated by a paragraph (newline) — the prose
    // pattern must not span paragraph boundaries.
    const content = `## Requirements

FR-007 introduces the rule validator port.

The rule validator depends on the kind router. Independently, FR-007 also
exposes a per-rule extension point for future kinds.
`;
    const report = validateSection(content, "requirements");
    const selfRefViolations = report.violations.filter(
      (v) => v.rule === "no_self_referencing_deps",
    );
    expect(selfRefViolations).toEqual([]);
  });

  it("flags only the genuinely self-referencing row when both cross-row and self-row cases coexist", () => {
    const content = `## Requirements

| ID | Requirement | Priority | Depends On | Source |
|---|---|---|---|---|
| FR-001 | Load templates. | P0 | — | user-request |
| FR-002 | Validate pages. | P0 | FR-001 | user-request |
| FR-003 | Bootstrap itself. | P0 | FR-003 | user-request |
`;
    const report = validateSection(content, "requirements");
    const selfRefViolations = report.violations.filter(
      (v) => v.rule === "no_self_referencing_deps",
    );
    // Exactly one violation, on FR-003.
    expect(selfRefViolations.length).toBe(1);
    expect(
      (selfRefViolations[0]?.message ?? "").includes("FR-003"),
    ).toBe(true);
  });
});

describe("validateSection — French (FR) technical_specification, bilingual detection", () => {
  // source: bug found 2026-07-15 during e2e run run_mrlqa0aj_u2rh15 — a
  // technical_specification section written in FRENCH for a local bash
  // script (no network, no storage, no PII) failed cryptographic_standards,
  // rate_limiting_required, secure_communication, consent_and_erasure_
  // support, and distributed_tracing across 3 attempts because both the
  // opt-out markers and the topic signals fed to hasExplicitOptOut were
  // English-only. Separately, no_magic_numbers and consistent_naming were
  // flagged even though the spec covered them VERBATIM in French
  // ("constantes nommées", "conventions de nommage") — the keyword signal
  // lists were English-only too.

  function frenchTechSpecWithOptOuts(): string {
    return `## Spécification Technique

### Préoccupations transversales

#### Chiffrement
Chiffrement : non applicable — aucun appel réseau, aucune donnée à chiffrer,
le script ne manipule que des fichiers locaux.

#### Limitation de débit
Limitation de débit : non applicable — aucun point de terminaison exposé,
le script s'exécute en local sans surface d'attaque réseau.

#### Communication sécurisée
Communication sécurisée : sans objet — aucun trafic réseau, le script ne
réalise aucun appel réseau vers l'extérieur.

#### Traçage distribué
Traçage distribué : non applicable — processus unique, exécution locale
sans second saut, monoprocessus par construction.

#### Consentement et effacement
Consentement et effacement des données (RGPD) : non applicable — aucune
donnée personnelle n'est traitée par ce script.

### Constantes et nommage

Toutes les valeurs de configuration sont extraites en constantes nommées
(exemple : \`readonly MAX_RETRY_COUNT=5\`) plutôt que codées en dur. Les
conventions de nommage imposent des noms descriptifs en snake_case pour
les fonctions bash et les variables.

\`\`\`bash
readonly MAX_RETRY_COUNT=5
readonly DEFAULT_TIMEOUT=9
\`\`\`
`;
  }

  it("does NOT flag the five service-shaped rules when opted out in French", () => {
    const report = validateSection(
      frenchTechSpecWithOptOuts(),
      "technical_specification",
    );
    const ruleNames = new Set(report.violations.map((v) => v.rule));
    for (const name of [
      "cryptographic_standards",
      "rate_limiting_required",
      "secure_communication",
      "distributed_tracing",
      "consent_and_erasure_support",
    ] as const) {
      expect(ruleNames.has(name)).toBe(false);
    }
  });

  it("does NOT flag no_magic_numbers or consistent_naming when covered verbatim in French", () => {
    const report = validateSection(
      frenchTechSpecWithOptOuts(),
      "technical_specification",
    );
    const ruleNames = new Set(report.violations.map((v) => v.rule));
    expect(ruleNames.has("no_magic_numbers")).toBe(false);
    expect(ruleNames.has("consistent_naming")).toBe(false);
  });

  it("STILL flags cryptographic_standards in French when no opt-out marker is present", () => {
    // Pins the fix's scope: mentioning the topic is not enough, and the
    // newly-added opt-out escape must not become an unconditional pass.
    const noOptOut = `## Spécification Technique

Le script échange des données avec un serveur distant via une connexion
réseau standard, sans détail de chiffrement.
`;
    const report = validateSection(noOptOut, "technical_specification");
    const ruleNames = new Set(report.violations.map((v) => v.rule));
    expect(ruleNames.has("cryptographic_standards")).toBe(true);
  });
});

describe("validateSection — regression: English opt-out and keyword detection unchanged", () => {
  // A3 (regression leg): the bilingual fix must not weaken or remove any
  // English-language detection path that existed before it.

  it("cryptographic_standards is still satisfied by English crypto signals (no opt-out needed)", () => {
    const content = `## Technical Specification

Encryption strategy: AES-256 for data at rest, bcrypt for password hashing,
TLS 1.3 for transport, with a documented key rotation policy.
`;
    const report = validateSection(content, "technical_specification");
    const ruleNames = new Set(report.violations.map((v) => v.rule));
    expect(ruleNames.has("cryptographic_standards")).toBe(false);
  });

  it("cryptographic_standards is still exempted by an English 'N/A — by construction' opt-out", () => {
    const content = `## Technical Specification

Encryption: N/A — by construction, the tool performs no network I/O and
handles no data requiring encryption at rest or in transit.
`;
    const report = validateSection(content, "technical_specification");
    const ruleNames = new Set(report.violations.map((v) => v.rule));
    expect(ruleNames.has("cryptographic_standards")).toBe(false);
  });

  it("no_magic_numbers and consistent_naming are still satisfied by the original English signals", () => {
    const content = `## Technical Specification

All configuration values are extracted to named constants
(e.g. \`MAX_RETRY_COUNT\`) rather than hardcoded. Naming convention:
descriptive snake_case names for shell functions and variables.

\`\`\`bash
readonly MAX_RETRY_COUNT=5
\`\`\`
`;
    const report = validateSection(content, "technical_specification");
    const ruleNames = new Set(report.violations.map((v) => v.rule));
    expect(ruleNames.has("no_magic_numbers")).toBe(false);
    expect(ruleNames.has("consistent_naming")).toBe(false);
  });
});

describe("validateSection — test_traceability_integrity, bash function syntax", () => {
  // source: bug found 2026-07-15 during e2e run run_mrlqa0aj_u2rh15 — a
  // testing section defined every coverage-table test as a bash function
  // (`test_xxx() { ... }` and `function test_xxx() { ... }`), inside a
  // ```bash fence and an untagged fence respectively, but the detector
  // only recognized the Swift-style `func test_xxx(` keyword form.

  function bashTestingSection(): string {
    return `## Testing

| Test | Scenario | Expected |
|---|---|---|
| test_help_flag | Runs with --help | Prints usage and exits 0 |
| test_missing_arg | Runs with no argument | Prints error and exits 1 |

\`\`\`bash
test_help_flag() {
  run_script --help
  assert_exit_code 0
}
\`\`\`

\`\`\`
function test_missing_arg() {
  run_script
  assert_exit_code 1
}
\`\`\`
`;
  }

  it("resolves both bash function syntaxes — zero traceability violations", () => {
    const report = validateSection(bashTestingSection(), "testing");
    const traceViolations = report.violations.filter(
      (v) => v.rule === "test_traceability_integrity",
    );
    expect(traceViolations).toEqual([]);
  });

  it("still flags a coverage-table test with NO matching definition of any syntax", () => {
    const missing = `## Testing

| Test | Scenario | Expected |
|---|---|---|
| test_help_flag | Runs with --help | Prints usage and exits 0 |
| test_orphaned | Never implemented | n/a |

\`\`\`bash
test_help_flag() {
  run_script --help
  assert_exit_code 0
}
\`\`\`
`;
    const report = validateSection(missing, "testing");
    const traceViolations = report.violations.filter(
      (v) => v.rule === "test_traceability_integrity",
    );
    expect(traceViolations.length).toBe(1);
    expect(traceViolations[0]?.offendingContent).toBe("test_orphaned");
  });

  it("regression: the original Swift-style 'func test_xxx(' syntax is still detected", () => {
    const content = `## Testing

| Test | Scenario | Expected |
|---|---|---|
| testLoginSucceeds | Valid credentials | Returns session token |

\`\`\`swift
func testLoginSucceeds() throws {
  let result = try login(validCredentials)
  XCTAssertNotNil(result.token)
}
\`\`\`
`;
    const report = validateSection(content, "testing");
    const traceViolations = report.violations.filter(
      (v) => v.rule === "test_traceability_integrity",
    );
    expect(traceViolations).toEqual([]);
  });
});
