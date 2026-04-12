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

  const testFuncPattern = /func\s+(test\w+)\s*\(/g;
  const definedTestNames = new Set<string>();
  while ((match = testFuncPattern.exec(content)) !== null) {
    definedTestNames.add(match[1]);
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
