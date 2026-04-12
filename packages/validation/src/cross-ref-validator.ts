import type { CrossRefValidationResult } from "@prd-gen/core";

/**
 * Deterministic cross-reference graph validator (NEW — fixes LLM-only self-check).
 * Builds a directed graph of all PRD identifiers and validates structural integrity.
 *
 * This replaces the LLM self-assessment for referential integrity checks.
 * Pure regex extraction + graph algorithms. Zero LLM calls.
 */

const ID_PATTERNS: Record<string, RegExp> = {
  FR: /\bFR-(\d+)\b/g,
  AC: /\bAC-(\d+)\b/g,
  US: /\bUS-(\d+)\b/g,
  STORY: /\bSTORY-(\d+)\b/g,
  TEST: /\bTEST-(\d+)\b/g,
  OQ: /\bOQ-(\d+)\b/g,
  RISK: /\bRISK-(\d+)\b/g,
  NFR: /\bNFR-(\d+)\b/g,
};

interface IdOccurrence {
  id: string;
  type: string;
  section: string;
  isDefinition: boolean;
}

function extractIds(content: string, sectionName: string): IdOccurrence[] {
  const occurrences: IdOccurrence[] = [];

  for (const [type, pattern] of Object.entries(ID_PATTERNS)) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const id = match[0];
      // A definition is when the ID appears at the start of a row or heading
      const lineStart = content.lastIndexOf("\n", match.index) + 1;
      const linePrefix = content.slice(lineStart, match.index).trim();
      const isDefinition =
        linePrefix === "" || linePrefix === "|" || linePrefix.startsWith("#");

      occurrences.push({ id, type, section: sectionName, isDefinition });
    }
  }

  return occurrences;
}

function detectCycles(adjacency: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push(path.slice(cycleStart));
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const neighbor of adjacency.get(node) ?? []) {
      dfs(neighbor, [...path]);
    }

    inStack.delete(node);
  }

  for (const node of adjacency.keys()) {
    if (!visited.has(node)) {
      dfs(node, []);
    }
  }

  return cycles;
}

function checkNumberingContinuity(
  ids: string[],
  prefix: string,
): Array<{ prefix: string; expected: number; actual: number }> {
  const gaps: Array<{ prefix: string; expected: number; actual: number }> = [];
  const numbers = ids
    .filter((id) => id.startsWith(`${prefix}-`))
    .map((id) => parseInt(id.split("-")[1], 10))
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);

  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] !== numbers[i - 1] + 1) {
      gaps.push({
        prefix,
        expected: numbers[i - 1] + 1,
        actual: numbers[i],
      });
    }
  }

  return gaps;
}

/**
 * Validate cross-references across all PRD sections.
 */
export function validateCrossReferences(
  sections: ReadonlyArray<{ name: string; content: string }>,
): CrossRefValidationResult {
  // Extract all IDs from all sections
  const allOccurrences: IdOccurrence[] = [];
  for (const section of sections) {
    allOccurrences.push(...extractIds(section.content, section.name));
  }

  // Build definition and reference sets
  const definitions = new Set<string>();
  const references = new Map<string, string[]>(); // id -> sections where referenced

  for (const occ of allOccurrences) {
    if (occ.isDefinition) {
      definitions.add(occ.id);
    }
    const refs = references.get(occ.id) ?? [];
    refs.push(occ.section);
    references.set(occ.id, refs);
  }

  // Check for dangling references (referenced but never defined)
  const danglingReferences = [...references.entries()]
    .filter(([id]) => !definitions.has(id))
    .map(([id, sections]) => ({
      id,
      referencedIn: sections.join(", "),
      type: id.split("-")[0],
    }));

  // Check for orphan definitions (defined but never referenced elsewhere)
  const orphanNodes = [...definitions]
    .filter((id) => {
      const refs = references.get(id) ?? [];
      // Orphan = only appears in one section (its definition)
      return new Set(refs).size <= 1;
    })
    .map((id) => ({
      id,
      type: id.split("-")[0],
      reason: "Defined but not referenced in other sections",
    }));

  // Build dependency graph and detect cycles
  const dependsOnPattern = /Depends\s*(?:On|on)[:\s]*([^\n|]+)/g;
  const adjacency = new Map<string, Set<string>>();

  for (const section of sections) {
    let match: RegExpExecArray | null;
    const regex = new RegExp(dependsOnPattern.source, dependsOnPattern.flags);
    while ((match = regex.exec(section.content)) !== null) {
      const depList = match[1];
      const ids = depList.match(/(?:FR|US|STORY|AC)-\d+/g) ?? [];
      // Find which ID this dependency belongs to
      const lineStart = section.content.lastIndexOf("\n", match.index);
      const lineBefore = section.content.slice(
        Math.max(0, lineStart - 200),
        match.index,
      );
      const ownerMatch = lineBefore.match(/(?:FR|US|STORY|AC)-\d+/g);
      const owner = ownerMatch?.[ownerMatch.length - 1];
      if (owner) {
        if (!adjacency.has(owner)) adjacency.set(owner, new Set());
        for (const dep of ids) {
          adjacency.get(owner)!.add(dep);
        }
      }
    }
  }

  const cycles = detectCycles(adjacency);

  // Check numbering continuity
  const allDefinedIds = [...definitions];
  const numberingGaps = [
    ...checkNumberingContinuity(allDefinedIds, "FR"),
    ...checkNumberingContinuity(allDefinedIds, "AC"),
    ...checkNumberingContinuity(allDefinedIds, "US"),
    ...checkNumberingContinuity(allDefinedIds, "NFR"),
  ];

  // Check duplicate IDs
  const idCounts = new Map<string, number>();
  for (const occ of allOccurrences.filter((o) => o.isDefinition)) {
    idCounts.set(occ.id, (idCounts.get(occ.id) ?? 0) + 1);
  }
  const duplicateIds = [...idCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);

  const isValid =
    danglingReferences.length === 0 &&
    cycles.length === 0 &&
    duplicateIds.length === 0;

  return {
    danglingReferences,
    orphanNodes,
    cycles,
    numberingGaps,
    duplicateIds,
    isValid,
  };
}
