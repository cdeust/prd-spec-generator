import type {
  HardOutputRule,
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { makeViolation } from "./helpers.js";

// Rule 3: AC Numbering
export function checkACNumbering(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const acPattern = /AC-(\d+)/g;
  const acNumbers: number[] = [];

  let match: RegExpExecArray | null;
  while ((match = acPattern.exec(content)) !== null) {
    acNumbers.push(parseInt(match[1], 10));
  }

  if (acNumbers.length === 0) return [];

  const sorted = [...new Set(acNumbers)].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const gaps: number[] = [];
  for (let n = first; n <= last; n++) {
    if (!sorted.includes(n)) gaps.push(n);
  }

  if (gaps.length > 0) {
    return [
      makeViolation(
        "ac_numbering",
        sectionType,
        `AC numbering has gaps: missing AC-${gaps.join(", AC-")}`,
        `Found: AC-${sorted.join(", AC-")}`,
      ),
    ];
  }

  return [];
}

// Rule 11: FR Traceability
export function checkFRTraceability(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const tableHeaderPattern =
    /^\s*\|[^\n]*\bID\b[^\n]*(?:Requirement|Description)[^\n]*\|/gim;

  if (!tableHeaderPattern.test(content)) return [];

  const sourcePattern = /^\s*\|[^\n]*\bID\b[^\n]*\bSource\b[^\n]*\|/gim;
  if (!sourcePattern.test(content)) {
    return [
      makeViolation(
        "fr_traceability",
        sectionType,
        "FR table exists but lacks a Source/Traceability column — every FR must trace to its origin",
      ),
    ];
  }

  return [];
}

// Rule 18: Duplicate Requirement IDs
export function checkDuplicateRequirementIds(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const idPattern = /^\s*\|\s*((FR|NFR)-\d+)\s*\|/gm;

  const seenIds = new Map<string, number>();
  let match: RegExpExecArray | null;
  while ((match = idPattern.exec(content)) !== null) {
    const id = match[1];
    seenIds.set(id, (seenIds.get(id) ?? 0) + 1);
  }

  const violations: HardOutputRuleViolation[] = [];
  for (const [id, count] of seenIds) {
    if (count > 1) {
      violations.push(
        makeViolation(
          "duplicate_requirement_ids",
          sectionType,
          `Requirement ID '${id}' appears ${count} times — each ID must be unique`,
          id,
        ),
      );
    }
  }

  return violations;
}

// Rule 22: FR Numbering Gaps
export function checkFRNumberingGaps(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return [
    ...checkIdNumberingGaps(content, "FR", "fr_numbering_gaps", sectionType),
    ...checkIdNumberingGaps(content, "NFR", "fr_numbering_gaps", sectionType),
  ];
}

function checkIdNumberingGaps(
  content: string,
  prefix: string,
  rule: HardOutputRule,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const pattern = new RegExp(`${prefix}-(\\d+)`, "g");
  const numbers: number[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    numbers.push(parseInt(match[1], 10));
  }

  if (numbers.length === 0) return [];

  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const gaps: number[] = [];
  for (let n = first; n <= last; n++) {
    if (!sorted.includes(n)) gaps.push(n);
  }

  if (gaps.length > 0) {
    return [
      makeViolation(
        rule,
        sectionType,
        `${prefix} numbering has gaps: missing ${prefix}-${gaps.join(`, ${prefix}-`)}`,
        `Found: ${prefix}-${sorted.join(`, ${prefix}-`)}`,
      ),
    ];
  }

  return [];
}

// Document-Level AC Consistency
export function checkDocumentACConsistency(
  content: string,
): HardOutputRuleViolation[] {
  const acPattern = /AC-(\d+)/g;
  const acNumbers: number[] = [];

  let match: RegExpExecArray | null;
  while ((match = acPattern.exec(content)) !== null) {
    acNumbers.push(parseInt(match[1], 10));
  }

  if (acNumbers.length <= 1) return [];

  const sorted = [...new Set(acNumbers)].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const gaps: number[] = [];
  for (let n = first; n <= last; n++) {
    if (!sorted.includes(n)) gaps.push(n);
  }

  if (gaps.length > 0) {
    return [
      makeViolation(
        "ac_numbering",
        null,
        `Document-level AC numbering has gaps: missing AC-${gaps.join(", AC-")}`,
        `Found across document: AC-${sorted.join(", AC-")}`,
      ),
    ];
  }

  return [];
}
