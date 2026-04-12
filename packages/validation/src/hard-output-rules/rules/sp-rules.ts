import type {
  HardOutputRuleViolation,
  SectionType,
} from "@prd-gen/core";
import { findPatternViolations, makeViolation } from "./helpers.js";

// Rule 8: SP Not In FR Table
export function checkSPNotInFRTable(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findPatternViolations(
    /^\s*\|(?:[^|]*\|)*[^|]*(?:Story\s*Points?)[^|]*\|/gim,
    content,
    "sp_not_in_fr_table",
    sectionType,
    "FR table contains Story Points column — SP belongs only in Implementation Roadmap",
  );
}

// Rule 9: Uneven SP Distribution
export function checkUnevenSPDistribution(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const sprintPattern =
    /(?:sprint|iteration)\s*\d+[^|]*?\|\s*(\d+)\s*(?:SP|story\s*points?)/gim;

  const spValues: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = sprintPattern.exec(content)) !== null) {
    const val = parseInt(match[1], 10);
    if (!isNaN(val)) spValues.push(val);
  }

  if (spValues.length < 3) return [];

  const allSame = new Set(spValues).size === 1;
  if (allSame) {
    return [
      makeViolation(
        "uneven_sp_distribution",
        sectionType,
        `All ${spValues.length} sprints have identical SP (${spValues[0]}) — real projects have uneven complexity`,
        `Sprint SP values: ${spValues.join(", ")}`,
      ),
    ];
  }

  return [];
}

// Rule 1: SP Arithmetic
export function checkSPArithmetic(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const totalRowPattern =
    /^\s*\|\s*(?:\*{0,2})(?:Total|Sum|Grand\s+Total)(?:\*{0,2})\s*\|(.+)\|/gim;
  const numberPattern = /(\d+)/g;
  const dataRowPattern =
    /^\s*\|\s*(?!\s*(?:-|(?:\*{0,2})(?:Total|Sum|Grand\s+Total)))([^|]+)\|(.+)\|/gim;

  // Collect individual SP values from data rows
  const individualSPs: number[] = [];
  let dataMatch: RegExpExecArray | null;
  while ((dataMatch = dataRowPattern.exec(content)) !== null) {
    const cellsText = dataMatch[2];
    const numbers: number[] = [];
    let numMatch: RegExpExecArray | null;
    const numRegex = /(\d+)/g;
    while ((numMatch = numRegex.exec(cellsText)) !== null) {
      numbers.push(parseInt(numMatch[1], 10));
    }
    if (numbers.length > 0) {
      individualSPs.push(numbers[numbers.length - 1]);
    }
  }

  // Check total rows
  const violations: HardOutputRuleViolation[] = [];
  let totalMatch: RegExpExecArray | null;
  while ((totalMatch = totalRowPattern.exec(content)) !== null) {
    const cellsText = totalMatch[1];
    const numbers: number[] = [];
    let numMatch: RegExpExecArray | null;
    const numRegex = /(\d+)/g;
    while ((numMatch = numRegex.exec(cellsText)) !== null) {
      numbers.push(parseInt(numMatch[1], 10));
    }
    if (numbers.length === 0) continue;

    const totalValue = numbers[numbers.length - 1];
    const computedSum = individualSPs.reduce((sum, v) => sum + v, 0);

    if (computedSum > 0 && computedSum !== totalValue) {
      violations.push(
        makeViolation(
          "sp_arithmetic",
          sectionType,
          `SP total row shows ${totalValue} but individual rows sum to ${computedSum}`,
          `Total: ${totalValue}, Computed: ${computedSum}`,
        ),
      );
    }
  }

  return violations;
}

// Document-Level SP Arithmetic
export function checkDocumentSPArithmetic(
  sections: ReadonlyArray<{ type: SectionType; content: string }>,
): HardOutputRuleViolation[] {
  const spSections = sections.filter(
    (s) =>
      s.type === "timeline" ||
      s.type === "deployment" ||
      s.type === "requirements",
  );

  if (spSections.length === 0) return [];

  const combinedContent = spSections.map((s) => s.content).join("\n\n");
  return checkSPArithmetic(combinedContent, "timeline");
}
