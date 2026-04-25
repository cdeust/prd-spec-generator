/**
 * Shared helpers for audit-flags engine + pipeline-ops.
 *
 * source: cross-audit code-reviewer Blocking-#1 (Phase 3+4 follow-up,
 * 2026-04). Extracted from engine.ts to break the §4.1 (>500 lines)
 * violation while keeping pipeline-ops.ts independent of engine.ts.
 */

import type { AuditRule, AuditFinding, SectionInput } from "./types.js";
import type { SectionType } from "@prd-gen/core";

// ─── Pattern helpers ─────────────────────────────────────────────────────────

export function testRegex(pattern: string, text: string): RegExpMatchArray[] {
  try {
    const re = new RegExp(pattern, "gm");
    return [...text.matchAll(re)];
  } catch {
    return [];
  }
}

export function hasMatch(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, "gm").test(text);
  } catch {
    return false;
  }
}

// ─── Section helpers ─────────────────────────────────────────────────────────

export function sectionMatchesRule(
  sectionType: SectionType,
  ruleSections: readonly string[],
): boolean {
  return ruleSections.length === 0 || ruleSections.includes(sectionType);
}

export function combineSections(
  sections: readonly SectionInput[],
  filter: readonly string[],
): string {
  return sections
    .filter((s) => filter.length === 0 || filter.includes(s.type))
    .map((s) => s.content)
    .join("\n\n");
}

// ─── Suppress scope evaluation ───────────────────────────────────────────────

export function getLineIndex(text: string, charIndex: number): number {
  let line = 0;
  for (let i = 0; i < charIndex && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

export function getRowAtIndex(
  lines: readonly string[],
  lineIdx: number,
): string {
  return lines[lineIdx] ?? "";
}

export function getNearbyLines(
  lines: readonly string[],
  lineIdx: number,
  radius: number,
): string {
  const start = Math.max(0, lineIdx - radius);
  const end = Math.min(lines.length, lineIdx + radius + 1);
  return lines.slice(start, end).join("\n");
}

export function isSuppressedAtMatch(
  suppressors: readonly AuditRule["suppress"][number][],
  sectionContent: string,
  matchIndex: number,
  allContent: string,
): boolean {
  if (suppressors.length === 0) return false;

  const lines = sectionContent.split("\n");
  const lineIdx = getLineIndex(sectionContent, matchIndex);

  for (const sup of suppressors) {
    let searchText: string;
    if (sup.scope === "same_row") {
      searchText = getRowAtIndex(lines, lineIdx);
    } else if (sup.scope === "same_section") {
      searchText = sectionContent;
    } else if (sup.scope === "any_section") {
      searchText = allContent;
    } else if (sup.scope.startsWith("nearby_lines_")) {
      const radius = parseInt(sup.scope.slice("nearby_lines_".length), 10);
      searchText = getNearbyLines(lines, lineIdx, radius);
    } else {
      searchText = sectionContent;
    }
    if (hasMatch(sup.pattern, searchText)) return true;
  }
  return false;
}

// ─── Finding constructor ─────────────────────────────────────────────────────

export function makeFinding(
  rule: AuditRule,
  matchCount: number,
  message: string,
): AuditFinding {
  return {
    ruleId: rule.id,
    familyCode: rule.family.code,
    familyName: rule.family.display_name,
    ruleName: rule.display_name,
    message,
    suggestedAction: rule.suggested_action,
    severity: rule.severity ?? "warning",
    matchCount,
  };
}
