/**
 * Judge selection — claim type → panel of genius + team agents.
 *
 * Static data table; tune by editing PANELS. Selection is deterministic so
 * the same claim always gets the same panel — judge identities are recorded
 * with each verdict, so reliability priors can be learned over time.
 *
 * Rationale per panel is in comments. The panels map onto the table from
 * the design doc: each panel covers a different reasoning angle so consensus
 * is robust to single-judge failure modes.
 */

import type { Claim, AgentIdentity } from "@prd-gen/core";

export interface JudgePanel {
  readonly genius: ReadonlyArray<AgentIdentity & { kind: "genius" }>;
  readonly team: ReadonlyArray<AgentIdentity & { kind: "team" }>;
  /** When true, panel weight is increased — these are load-bearing claims */
  readonly high_stakes: boolean;
}

function genius(name: (AgentIdentity & { kind: "genius" })["name"]): AgentIdentity & { kind: "genius" } {
  return { kind: "genius", name };
}
function team(name: (AgentIdentity & { kind: "team" })["name"]): AgentIdentity & { kind: "team" } {
  return { kind: "team", name };
}

export const PANELS: Record<Claim["claim_type"], JudgePanel> = {
  // Substitutability, near-decomposability, pattern fit
  architecture: {
    genius: [genius("liskov"), genius("simon"), genius("alexander")],
    team: [team("code-reviewer"), team("architect")],
    high_stakes: true,
  },

  // Order-of-magnitude sanity, queuing limits, efficiency bounds
  performance: {
    genius: [genius("fermi"), genius("erlang"), genius("carnot")],
    team: [team("code-reviewer")],
    high_stakes: true,
  },

  // Invariant reasoning, happens-before, contract substitutability
  correctness: {
    genius: [genius("dijkstra"), genius("lamport"), genius("liskov")],
    team: [team("test-engineer"), team("engineer")],
    high_stakes: true,
  },

  // Correctness discipline, error archaeology, integrity audit
  security: {
    genius: [genius("dijkstra"), genius("wu"), genius("feynman")],
    team: [team("security-auditor")],
    high_stakes: true,
  },

  // Mass-balance accounting, contract substitutability, predictive table
  data_model: {
    genius: [genius("lavoisier"), genius("liskov"), genius("mendeleev")],
    team: [team("dba"), team("code-reviewer")],
    high_stakes: true,
  },

  // Falsifiability, integrity audit, error archaeology
  test_coverage: {
    genius: [genius("popper"), genius("feynman"), genius("wu")],
    team: [team("test-engineer")],
    high_stakes: false,
  },

  // Order-of-magnitude + conservation
  story_point_arithmetic: {
    genius: [genius("fermi"), genius("lavoisier")],
    team: [],
    high_stakes: false,
  },

  // Four-causes interrogation, claim-evidence-warrant chains
  fr_traceability: {
    genius: [genius("aristotle"), genius("toulmin")],
    team: [team("code-reviewer")],
    high_stakes: false,
  },

  // Fragility classification, debiasing, falsifiability
  risk: {
    genius: [genius("taleb"), genius("kahneman"), genius("popper")],
    team: [],
    high_stakes: false,
  },

  // Exhaustive-space audit, gaps-in-the-table
  acceptance_criteria_completeness: {
    genius: [genius("borges"), genius("mendeleev")],
    team: [team("test-engineer")],
    high_stakes: false,
  },

  // Generative consistency rules, exhaustive enumeration
  cross_file_consistency: {
    genius: [genius("panini"), genius("euler")],
    team: [team("code-reviewer")],
    high_stakes: true,
  },
};

/**
 * Select the judge panel for a claim. Returns AgentIdentity[] in deterministic
 * order so the same claim always produces the same set of judge invocations.
 */
export function selectJudges(claim: Claim): readonly AgentIdentity[] {
  const panel = PANELS[claim.claim_type];
  return [...panel.genius, ...panel.team];
}

export function getPanel(claimType: Claim["claim_type"]): JudgePanel {
  return PANELS[claimType];
}
