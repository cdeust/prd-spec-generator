import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import { findPatternViolations, makeViolation } from "./helpers.js";

// Rule 6: No AnyCodable
export function checkNoAnyCodable(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findPatternViolations(
    /\bAny(?:Codable|Encodable|Decodable|JSON)\b/g,
    content,
    "no_any_codable",
    sectionType,
    "Found prohibited AnyCodable/AnyEncodable/AnyDecodable/AnyJSON type",
  );
}

// Rule 5: No NOW() in Partial Indexes
export function checkNoNowInPartialIndexes(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findPatternViolations(
    /CREATE\s+INDEX\b[^;]*WHERE\b[^;]*\b(?:NOW\s*\(\)|CURRENT_TIMESTAMP)/gi,
    content,
    "no_now_in_partial_indexes",
    sectionType,
    "NOW()/CURRENT_TIMESTAMP in partial index WHERE clause — evaluated once at creation, not at query time",
  );
}

// Rule 4: No Orphan DDL
export function checkNoOrphanDDL(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const typePattern = /CREATE\s+(?:TYPE|ENUM)\s+(\w+)/gi;
  const violations: HardOutputRuleViolation[] = [];

  let match: RegExpExecArray | null;
  while ((match = typePattern.exec(content)) !== null) {
    const typeName = match[1];
    const escapedName = typeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const refPattern = new RegExp(`\\b${escapedName}\\b`, "gi");
    const refMatches = content.match(refPattern);
    const refCount = refMatches ? refMatches.length : 0;

    if (refCount <= 1) {
      violations.push(
        makeViolation(
          "no_orphan_ddl",
          sectionType,
          `Type '${typeName}' is defined but never referenced by any table or column`,
          `CREATE TYPE/ENUM ${typeName}`,
        ),
      );
    }
  }

  return violations;
}

// Rule 21: FK References Exist
export function checkFKReferencesExist(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  const createPattern =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;

  const tableNames = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = createPattern.exec(content)) !== null) {
    tableNames.add(match[1].toLowerCase());
  }

  if (tableNames.size === 0) return [];

  const refPattern = /REFERENCES\s+(\w+)/gi;
  const violations: HardOutputRuleViolation[] = [];

  while ((match = refPattern.exec(content)) !== null) {
    const refTarget = match[1];
    if (!tableNames.has(refTarget.toLowerCase())) {
      violations.push(
        makeViolation(
          "fk_references_exist",
          sectionType,
          `Foreign key references table '${refTarget}' which has no CREATE TABLE in the data model`,
          `REFERENCES ${refTarget}`,
        ),
      );
    }
  }

  return violations;
}
