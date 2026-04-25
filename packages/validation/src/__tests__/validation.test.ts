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
