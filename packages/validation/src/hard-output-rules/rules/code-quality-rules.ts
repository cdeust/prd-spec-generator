import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import {
  findAbsenceViolation,
  extractCodeBlocks,
  extractTypeName,
  makeViolation,
} from "./helpers.js";

// Rule 19: No Nested Types
export function checkNoNestedTypes(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const codeBlocks = extractCodeBlocks(content);
  if (codeBlocks.length === 0) return [];

  const typeKeywordPattern =
    /(?:^|\n)\s*(?:public\s+|private\s+|internal\s+|protected\s+|open\s+|fileprivate\s+|final\s+|abstract\s+|sealed\s+|data\s+)*(?:struct|class|enum|interface|object|record)\s+\w+/;

  const violations: HardOutputRuleViolation[] = [];

  for (const codeBlock of codeBlocks) {
    const lines = codeBlock.split("\n");
    let braceDepth = 0;

    for (const line of lines) {
      if (typeKeywordPattern.test(line)) {
        if (braceDepth > 0) {
          const typeName = extractTypeName(line.trim());
          violations.push(
            makeViolation(
              "no_nested_types",
              sectionType,
              `Nested type declaration detected — extract '${typeName}' to its own top-level definition. Nested types reduce readability and reusability.`,
              line.trim(),
            ),
          );
        }
      }

      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
      braceDepth = Math.max(0, braceDepth);
    }
  }

  return violations;
}

// Rule 20: Single Responsibility
export function checkSingleResponsibility(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const violations: HardOutputRuleViolation[] = [];

  const lowered = content.toLowerCase();
  const srpSignals = [
    "single responsibility",
    "separation of concern",
    "one reason to change",
    "focused class",
    "small class",
    "cohesion",
    "cohesive",
    "do one thing",
    "bounded context",
  ];

  if (!srpSignals.some((s) => lowered.includes(s))) {
    violations.push(
      makeViolation(
        "single_responsibility",
        sectionType,
        "Technical spec must establish single responsibility constraints — classes should have one reason to change, with clear separation of concerns.",
      ),
    );
  }

  const codeBlocks = extractCodeBlocks(content);
  const typeStartPattern =
    /(?:public\s+|private\s+|internal\s+|protected\s+|open\s+|final\s+|abstract\s+|sealed\s+|data\s+)*(?:struct|class|enum|interface|object)\s+(\w+)/;

  for (const codeBlock of codeBlocks) {
    const lines = codeBlock.split("\n");
    let currentTypeName: string | null = null;
    let typeStartLine = 0;
    let braceDepth = 0;

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];

      if (braceDepth === 0) {
        const match = line.match(typeStartPattern);
        if (match) {
          currentTypeName = match[1] ?? extractTypeName(line.trim());
          typeStartLine = index;
        }
      }

      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;

      if (braceDepth <= 0 && currentTypeName !== null) {
        const typeLineCount = index - typeStartLine + 1;
        if (typeLineCount > 50) {
          violations.push(
            makeViolation(
              "single_responsibility",
              sectionType,
              `Code example shows '${currentTypeName}' spanning ${typeLineCount} lines — split into smaller, focused types. A single class/struct should not exceed ~50 lines in a PRD example.`,
              currentTypeName,
            ),
          );
        }
        currentTypeName = null;
        braceDepth = 0;
      }
    }
  }

  return violations;
}

// Rule 21: Explicit Access Control
export function checkExplicitAccessControl(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findAbsenceViolation(
    content,
    [
      "access control",
      "visibility",
      "scope",
      "public",
      "private",
      "internal",
      "protected",
      "encapsulation",
      "information hiding",
      "expose only",
      "minimal api surface",
      "least privilege",
      "api boundary",
    ],
    2,
    "explicit_access_control",
    sectionType,
    "Technical spec should establish access control guidelines — define what is public vs private, enforce encapsulation, and minimize exposed API surface.",
  );
}

// Rule 22: Factory-Based Injection
export function checkFactoryBasedInjection(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findAbsenceViolation(
    content,
    [
      "dependency injection",
      "inject",
      "factory",
      "container",
      "composition root",
      "wire",
      "provider",
      "resolver",
      "assembler",
      "inversion of control",
      "ioc",
    ],
    2,
    "factory_based_injection",
    sectionType,
    "Technical spec must mandate dependency injection through factories or DI containers — concrete types should not be instantiated directly in business logic. Specify how dependencies are wired.",
  );
}

// Rule 23: SOLID Compliance
export function checkSolidCompliance(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const lowered = content.toLowerCase();

  const solidCategories: Array<{
    principle: string;
    signals: string[];
  }> = [
    {
      principle: "Single Responsibility",
      signals: [
        "single responsibility",
        "one reason to change",
        "separation of concern",
        "focused",
        "cohesive",
      ],
    },
    {
      principle: "Open/Closed",
      signals: [
        "open/closed",
        "open for extension",
        "closed for modification",
        "extensible",
        "plugin",
        "strategy",
        "decorator",
      ],
    },
    {
      principle: "Dependency Inversion",
      signals: [
        "dependency inversion",
        "depend on abstraction",
        "protocol",
        "interface",
        "port",
        "contract",
        "injection",
        "inversion of control",
      ],
    },
  ];

  let categoriesMet = 0;
  for (const { signals } of solidCategories) {
    if (signals.some((s) => lowered.includes(s))) {
      categoriesMet++;
    }
  }

  if (categoriesMet < 2) {
    return [
      makeViolation(
        "solid_compliance",
        sectionType,
        "Technical spec must demonstrate SOLID principles — at minimum: single responsibility (focused classes), open/closed (extensible without modification), and dependency inversion (depend on abstractions, not concretions).",
      ),
    ];
  }

  return [];
}

// Rule 24: Code Reusability & Readability
export function checkCodeReusability(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const lowered = content.toLowerCase();

  const reusabilitySignals = [
    "reusable",
    "reuse",
    "shared",
    "common",
    "utility",
    "helper",
    "library",
    "module",
    "component",
    "centralized",
  ];

  const readabilitySignals = [
    "readable",
    "readability",
    "naming convention",
    "self-documenting",
    "clean code",
    "maintainable",
    "clear",
    "descriptive",
    "consistent",
  ];

  const hasReusability = reusabilitySignals.some((s) => lowered.includes(s));
  const hasReadability = readabilitySignals.some((s) => lowered.includes(s));

  if (!hasReusability && !hasReadability) {
    return [
      makeViolation(
        "code_reusability",
        sectionType,
        "Technical spec should establish code quality standards — specify that code must be reusable (shared components, centralized utilities) and readable (clear naming, self-documenting, consistent patterns).",
      ),
    ];
  }

  return [];
}
