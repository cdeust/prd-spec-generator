import type { HardOutputRuleViolation, SectionType } from "@prd-gen/core";
import { findAbsenceViolation } from "./helpers.js";

// Rule 63: Dependency Vulnerability Scanning
export function checkDependencyVulnerabilityScanning(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findAbsenceViolation(
    content,
    [
      "dependency scan",
      "vulnerability scan",
      "cve",
      "snyk",
      "dependabot",
      "renovate",
      "trivy",
      "software composition analysis",
      "sca",
      "supply chain",
      "sbom",
      "software bill of materials",
      "known vulnerabilit",
      "security advisory",
      "dependency audit",
      "npm audit",
      "pip audit",
    ],
    1,
    "dependency_vulnerability_scanning",
    sectionType,
    "Technical spec must require dependency vulnerability scanning — specify SCA tooling, CVE monitoring, and automated scanning in CI/CD pipeline.",
  );
}

// Rule 64: Minimal Dependency Principle
export function checkMinimalDependencyPrinciple(
  content: string,
  sectionType: SectionType,
): HardOutputRuleViolation[] {
  return findAbsenceViolation(
    content,
    [
      "minimal dependenc",
      "minimize dependenc",
      "reduce dependenc",
      "standard library",
      "built-in",
      "native",
      "justify dependenc",
      "dependency rationale",
      "license compliance",
      "license audit",
      "license check",
      "dependency review",
      "approved dependenc",
    ],
    1,
    "minimal_dependency_principle",
    sectionType,
    "Technical spec should apply minimal dependency principle — justify new dependencies, prefer standard library, and verify license compliance.",
  );
}
