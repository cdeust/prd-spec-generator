import { describe, expect, it } from "vitest";
import {
  extractClaims,
  extractClaimsFromDocument,
} from "../claim-extractor.js";

describe("extractClaims", () => {
  it("extracts FR claims from a requirements section", () => {
    const content = `
| ID | Requirement | Priority |
|----|-------------|----------|
| FR-001 | The system MUST support OAuth login | P0 |
| FR-002 | The system SHOULD log every failed attempt | P1 |
`.trim();
    const claims = extractClaims("requirements", content);
    expect(claims.length).toBeGreaterThanOrEqual(2);
    expect(claims.every((c) => c.claim_type === "fr_traceability")).toBe(true);
    expect(claims.find((c) => c.claim_id === "FR-001")).toBeDefined();
    expect(claims.find((c) => c.claim_id === "FR-002")).toBeDefined();
  });

  it("extracts AC claims with completeness type", () => {
    const content = `
- AC-001: User can log in with valid credentials
- AC-002: Failed login increments retry counter
`.trim();
    const claims = extractClaims("acceptance_criteria", content);
    expect(claims.find((c) => c.claim_id === "AC-001")?.claim_type).toBe(
      "acceptance_criteria_completeness",
    );
  });

  it("extracts NFR latency claims as performance type", () => {
    const content = "p95 < 500ms under nominal load.";
    const claims = extractClaims("performance_requirements", content);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims[0].claim_type).toBe("performance");
    expect(claims[0].claim_id).toMatch(/NFR-LATENCY/);
  });

  it("extracts security claims when keywords are present", () => {
    const content =
      "We use OAuth 2.0 with JWT tokens for authentication, AES-256 at rest.";
    const claims = extractClaims("security_considerations", content);
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => c.claim_type === "security")).toBe(true);
  });

  it("returns empty for sections without registered extractors", () => {
    const claims = extractClaims("overview", "Some prose text.");
    expect(claims).toEqual([]);
  });

  it("dedupes claims with duplicate IDs across sections", () => {
    const sections = [
      { type: "requirements" as const, content: "| FR-001 | first | P0 |" },
      { type: "api_specification" as const, content: "| FR-001 | dup | P0 |" },
    ];
    const claims = extractClaimsFromDocument(sections);
    const ids = claims.map((c) => c.claim_id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
  });

  // Root-cause regression for the AC-009/AC-010 near-miss (claim-tier.ts
  // module doc): a fixed ±2-line window used to bleed a neighboring
  // claim's text into the current claim's evidence when adjacent AC
  // bullets are separated by a single blank line. `snippet()` must now
  // bound the window at the next/previous claim's own start line.
  it("does not leak an adjacent AC bullet's text into this claim's evidence", () => {
    const content = `
AC-008 : Étant donné une jauge dont le remplissage traverse plusieurs paliers, alors chaque cellule pleine est colorée individuellement selon son palier propre.

AC-009 : Étant donné une jauge partiellement remplie, alors elle conserve le caractère OVERLAY existant.

AC-010 : Étant donné le code source, quand on l'inspecte, alors aucune fonction lerp n'est présente.
`.trim();
    const claims = extractClaims("acceptance_criteria", content);
    const ac009 = claims.find((c) => c.claim_id === "AC-009")!;
    expect(ac009).toBeDefined();

    // Neither neighbor's own claim-ID marker nor its distinguishing wording
    // may appear in AC-009's evidence.
    expect(ac009.evidence).not.toContain("AC-008");
    expect(ac009.evidence).not.toContain("AC-010");
    expect(ac009.evidence).not.toContain("colorée individuellement");
    expect(ac009.evidence).not.toContain("aucune fonction lerp");
    expect(ac009.evidence).toContain("AC-009");
    expect(ac009.evidence).toContain("OVERLAY");
  });

  it("bounds requirement evidence at the neighboring FR row (dense table)", () => {
    const content = `
| ID | Requirement |
|----|-------------|
| FR-001 | First requirement, distinct wording alpha. |
| FR-002 | Second requirement, distinct wording beta. |
| FR-003 | Third requirement, distinct wording gamma. |
`.trim();
    const claims = extractClaims("requirements", content);
    const fr002 = claims.find((c) => c.claim_id === "FR-002")!;
    expect(fr002).toBeDefined();
    expect(fr002.evidence).not.toContain("wording alpha");
    expect(fr002.evidence).not.toContain("wording gamma");
    expect(fr002.evidence).toContain("wording beta");
  });
});
