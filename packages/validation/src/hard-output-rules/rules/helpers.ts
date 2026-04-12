import type {
  HardOutputRule,
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { isCriticalRule, scorePenalty } from "@prd-gen/core";

/**
 * Find all matches of a pattern and return a violation for each.
 * Ported from HardOutputRulesValidator+Evaluation.swift findPatternViolations.
 */
export function findPatternViolations(
  pattern: RegExp,
  content: string,
  rule: HardOutputRule,
  sectionType: SectionType,
  message: string,
): HardOutputRuleViolation[] {
  const matches = content.match(pattern);
  if (!matches) return [];

  return matches.map((match) => ({
    rule,
    sectionType,
    message,
    offendingContent: match.length > 0 ? match.substring(0, 120) : null,
    location: null,
    isCritical: isCriticalRule(rule),
    scorePenalty: scorePenalty(rule),
  }));
}

/**
 * Check that content contains enough signals from a keyword list.
 * Returns a violation if the signal count is below the threshold.
 */
export function findAbsenceViolation(
  content: string,
  signals: readonly string[],
  threshold: number,
  rule: HardOutputRule,
  sectionType: SectionType,
  message: string,
): HardOutputRuleViolation[] {
  const lowered = content.toLowerCase();
  const signalCount = signals.filter((s) => lowered.includes(s)).length;

  if (signalCount < threshold) {
    return [
      {
        rule,
        sectionType,
        message,
        offendingContent: null,
        location: null,
        isCritical: isCriticalRule(rule),
        scorePenalty: scorePenalty(rule),
      },
    ];
  }

  return [];
}

/**
 * Create a single violation object.
 */
export function makeViolation(
  rule: HardOutputRule,
  sectionType: SectionType | null,
  message: string,
  offendingContent: string | null = null,
): HardOutputRuleViolation {
  return {
    rule,
    sectionType,
    message,
    offendingContent,
    location: null,
    isCritical: isCriticalRule(rule),
    scorePenalty: scorePenalty(rule),
  };
}

/**
 * Extract code blocks from markdown content.
 * Returns the inner content of each ```...``` block.
 */
export function extractCodeBlocks(content: string): string[] {
  const pattern = /```(?:\w+)?\s*\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

/**
 * Extract a type name from a line containing a type declaration.
 * Ported from CodeQualityRules extractTypeName.
 */
export function extractTypeName(line: string): string {
  const typeKeywords = [
    "struct",
    "class",
    "enum",
    "interface",
    "object",
    "record",
  ];
  const words = line.split(/\s+/).filter((w) => w.length > 0);

  for (let i = 0; i < words.length; i++) {
    const clean = words[i].toLowerCase().replace(/[^\w]/g, "");
    if (typeKeywords.includes(clean) && i + 1 < words.length) {
      return words[i + 1].replace(/[^\w]/g, "");
    }
  }

  return "Unknown";
}
