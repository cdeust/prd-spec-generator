import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import {
  findAbsenceViolation,
  extractCodeBlocks,
  makeViolation,
} from "./helpers.js";

// Rule 47: No Magic Numbers
export function checkNoMagicNumbers(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const violations: HardOutputRuleViolation[] = [];
  const codeBlocks = extractCodeBlocks(content);

  const magicNumberPattern =
    /(?:(?:timeout|delay|limit|max|min|size|count|threshold|retry|interval|duration|width|height|margin|padding)\s*[:=]\s*)\d{2,}/gi;

  for (const codeBlock of codeBlocks) {
    const matches = codeBlock.match(magicNumberPattern);
    if (matches && matches.length >= 3) {
      violations.push(
        makeViolation(
          "no_magic_numbers",
          sectionType,
          "Code examples contain multiple raw numeric literals — extract to named constants (e.g., MAX_RETRY_COUNT, DEFAULT_TIMEOUT_MS) for maintainability.",
          `Found ${matches.length} magic numbers in code block`,
        ),
      );
    }
  }

  const lowered = content.toLowerCase();
  const constantSignals = [
    "named constant",
    "named variable",
    "const ",
    "static let",
    "static final",
    "companion object",
    "no magic number",
    "extract constant",
    "configuration value",
  ];

  const hasConstantGuidance = constantSignals.some((s) =>
    lowered.includes(s),
  );

  if (!hasConstantGuidance && codeBlocks.length > 0) {
    violations.push(
      makeViolation(
        "no_magic_numbers",
        sectionType,
        "Technical spec should mandate named constants — all configuration values, thresholds, and limits must be extracted to named constants, not raw literals.",
      ),
    );
  }

  return violations;
}

// Rule 48: Defensive Coding
export function checkDefensiveCoding(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findAbsenceViolation(
    content,
    [
      "guard",
      "precondition",
      "require",
      "assert",
      "null safe",
      "null check",
      "nil check",
      "optional",
      "non-null",
      "nonnull",
      "notnull",
      "bounds check",
      "range check",
      "defensive",
      "fail fast",
      "early return",
      "validation",
      "contract",
      "invariant",
    ],
    2,
    "defensive_coding",
    sectionType,
    "Technical spec must enforce defensive coding — guard clauses, preconditions, null safety, bounds checking at all entry points. Fail fast on invalid state.",
  );
}

// Rule 49: Method Size Limits
export function checkMethodSizeLimits(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const violations: HardOutputRuleViolation[] = [];
  const codeBlocks = extractCodeBlocks(content);

  const funcPattern =
    /(?:func |function |def |fn |fun |public |private |protected |internal |static )*(?:func|function|def|fn|fun|method)\s+(\w+)/;

  for (const codeBlock of codeBlocks) {
    const lines = codeBlock.split("\n");
    let currentFuncName: string | null = null;
    let funcStartLine = 0;
    let braceDepth = 0;
    let inFunction = false;

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];

      if (!inFunction) {
        const match = line.match(funcPattern);
        if (match) {
          currentFuncName = match[1] ?? "anonymous";
          funcStartLine = index;
          inFunction = true;
          braceDepth = 0;
        }
      }

      if (inFunction) {
        braceDepth += (line.match(/\{/g) || []).length;
        braceDepth -= (line.match(/\}/g) || []).length;

        if (braceDepth <= 0 && line.includes("}")) {
          const funcLineCount = index - funcStartLine + 1;
          if (funcLineCount > 30) {
            violations.push(
              makeViolation(
                "method_size_limits",
                sectionType,
                `Code example shows function '${currentFuncName}' spanning ${funcLineCount} lines — extract logic into smaller functions. Methods should be ~30 lines max in PRD examples.`,
                currentFuncName,
              ),
            );
          }
          inFunction = false;
          currentFuncName = null;
        }
      }
    }
  }

  return violations;
}

// Rule 50: Consistent Naming
export function checkConsistentNaming(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findAbsenceViolation(
    content,
    [
      "naming convention",
      "naming standard",
      "naming rule",
      "camelcase",
      "camel case",
      "snake_case",
      "snake case",
      "pascalcase",
      "pascal case",
      "kebab-case",
      "descriptive name",
      "self-documenting",
      "meaningful name",
      "no abbreviation",
      "full word",
      "consistent naming",
    ],
    1,
    "consistent_naming",
    sectionType,
    "Technical spec should establish naming conventions — specify casing style, use descriptive names, avoid abbreviations in public APIs, and enforce consistent patterns.",
  );
}

// Rule 51: API Contract Documentation
export function checkAPIContractDocumentation(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findAbsenceViolation(
    content,
    [
      "request schema",
      "response schema",
      "api contract",
      "openapi",
      "swagger",
      "api spec",
      "endpoint spec",
      "request body",
      "response body",
      "status code",
      "content-type",
      "accept header",
      "api documentation",
      "typed request",
      "typed response",
    ],
    2,
    "api_contract_documentation",
    sectionType,
    "Technical spec must document API contracts — every endpoint needs typed request/response schemas, status codes, error responses, and content-type specifications.",
  );
}

// Rule 52: Deprecation Strategy
export function checkDeprecationStrategy(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findAbsenceViolation(
    content,
    [
      "deprecat",
      "sunset",
      "breaking change",
      "migration path",
      "backward compat",
      "backwards compat",
      "version",
      "api version",
      "v1",
      "v2",
      "changelog",
      "upgrade guide",
      "migration guide",
    ],
    1,
    "deprecation_strategy",
    sectionType,
    "Technical spec should define deprecation strategy — specify migration paths for breaking changes, sunset timelines, and versioning approach.",
  );
}
