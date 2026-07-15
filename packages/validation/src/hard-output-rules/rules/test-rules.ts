import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import { findPatternViolations, makeViolation } from "./helpers.js";

// Rule 7: No Placeholder Tests
export function checkNoPlaceholderTests(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const patterns: RegExp[] = [
    /func\s+test\w+\s*\([^)]*\)\s*(?:throws\s+)?(?:async\s+)?(?:throws\s+)?\{[^}]*\/\/\s*(?:TODO|FIXME|PLACEHOLDER)[^}]*\}/g,
    /func\s+test\w+\s*\([^)]*\)\s*(?:throws\s+)?(?:async\s+)?(?:throws\s+)?\{\s*\}/g,
    /^\s*\|\s*test\w+\s*\|[^|]*\|\s*`?\s*\/\/\s*(?:TODO|Setup)/gm,
  ];

  const violations: HardOutputRuleViolation[] = [];
  for (const pattern of patterns) {
    violations.push(
      ...findPatternViolations(
        pattern,
        content,
        "no_placeholder_tests",
        sectionType,
        "Found placeholder test with empty or TODO-only body",
      ),
    );
  }

  return violations;
}

// Rule 17: Test Traceability Integrity
export function checkTestTraceabilityIntegrity(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const matrixRowPattern = /^\s*\|\s*(test\w+)\s*\|/gm;
  const matrixTestNames: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = matrixRowPattern.exec(content)) !== null) {
    matrixTestNames.push(match[1]);
  }

  if (matrixTestNames.length === 0) return [];

  // source: bug found 2026-07-15, e2e run run_mrlqa0aj_u2rh15 — a testing
  // section for a bash script defined every coverage-table test as
  // `test_xxx() { ... }` and `function test_xxx() { ... }` inside fenced
  // code blocks (```bash and untagged), but the old pattern only matched
  // the Swift-style `func test_xxx(` keyword form, so every bash test was
  // reported as "no matching func found" even though it was defined.
  // Detection is language-agnostic: each pattern targets one function-
  // definition syntax; a name is "defined" if ANY pattern matches it,
  // independent of the fence's language tag (extractCodeBlocks is not
  // needed here — code block bodies are already part of `content`).
  const testFuncPatterns: readonly RegExp[] = [
    // Swift/Kotlin: func test_xxx(...)
    /func\s+(test\w+)\s*\(/g,
    // JS/TS/PHP/bash named-function keyword: function test_xxx(...)
    /function\s+(test\w+)\s*\(/g,
    // Python: def test_xxx(...)
    /def\s+(test\w+)\s*\(/g,
    // Rust: fn test_xxx(...)
    /fn\s+(test\w+)\s*\(/g,
    // Bash implicit-function form: test_xxx() { ... } / test_xxx () { ... }
    // (optional space before both the parens and the opening brace)
    /(test\w+)\s*\(\s*\)\s*\{/g,
    // Bash explicit "function" form without parens: function test_xxx { ... }
    /function\s+(test\w+)\s*\{/g,
  ];

  const definedTestNames = new Set<string>();
  for (const pattern of testFuncPatterns) {
    let funcMatch: RegExpExecArray | null;
    while ((funcMatch = pattern.exec(content)) !== null) {
      definedTestNames.add(funcMatch[1]);
    }
  }

  const violations: HardOutputRuleViolation[] = [];
  for (const matrixName of matrixTestNames) {
    if (!definedTestNames.has(matrixName)) {
      violations.push(
        makeViolation(
          "test_traceability_integrity",
          sectionType,
          `Test '${matrixName}' listed in traceability matrix but no matching func ${matrixName}() found in test code`,
          matrixName,
        ),
      );
    }
  }

  return violations;
}

// Document-Level Rule 17: Cross-Section Test Traceability
export function checkDocumentTestTraceability(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const testSections = sections.filter((s) => s.type === "testing");
  if (testSections.length === 0) return [];

  const combinedTestContent = testSections
    .map((s) => s.content)
    .join("\n\n");
  return checkTestTraceabilityIntegrity(combinedTestContent, "testing");
}
