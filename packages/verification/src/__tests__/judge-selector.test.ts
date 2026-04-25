import { describe, expect, it } from "vitest";
import { selectJudges, getPanel, PANELS } from "../judge-selector.js";
import type { Claim } from "@prd-gen/core";

const claim = (claim_type: Claim["claim_type"]): Claim => ({
  claim_id: "X-1",
  claim_type,
  text: "test",
  evidence: "test",
});

describe("judge-selector", () => {
  it("every claim type has a non-empty panel of genius judges", () => {
    for (const [claim_type, panel] of Object.entries(PANELS)) {
      expect(
        panel.genius.length,
        `${claim_type} has empty genius panel`,
      ).toBeGreaterThan(0);
    }
  });

  it("selectJudges returns deterministic order", () => {
    const a = selectJudges(claim("architecture"));
    const b = selectJudges(claim("architecture"));
    expect(a.map((j) => j.name)).toEqual(b.map((j) => j.name));
  });

  it("selectJudges returns genius before team for architecture", () => {
    const judges = selectJudges(claim("architecture"));
    const firstTeamIdx = judges.findIndex((j) => j.kind === "team");
    const lastGeniusIdx = judges.map((j) => j.kind).lastIndexOf("genius");
    expect(firstTeamIdx).toBeGreaterThan(lastGeniusIdx);
  });

  it("performance panel includes fermi and carnot", () => {
    const panel = getPanel("performance");
    const names = panel.genius.map((g) => g.name);
    expect(names).toContain("fermi");
    expect(names).toContain("carnot");
  });

  it("security panel includes the security-auditor team agent", () => {
    const panel = getPanel("security");
    const names = panel.team.map((t) => t.name);
    expect(names).toContain("security-auditor");
  });
});
