/**
 * Prompt-builder field-presence tests.
 *
 * Per cross-audit test-engineer M4 (Phase 3+4, 2026-04): meta-prompting is
 * high-stakes. A regression that drops a required field from a generated
 * prompt does NOT surface in any downstream test that uses canned subagent
 * responses (the canned dispatcher returns a fixed verdict regardless of the
 * prompt it receives).
 *
 * Strategy: assert that load-bearing inputs make it INTO the rendered prompt,
 * not that the prompt is "well-written." We pin the structural contract
 * (feature description, prior Q&A, prior violations, codebase context) so a
 * reader of the prompt can do the work the prompt was constructed for.
 */

import { describe, expect, it } from "vitest";
import {
  buildClarificationPrompt,
  buildSectionPrompt,
  buildJiraPrompt,
} from "../index.js";

describe("buildClarificationPrompt", () => {
  it("includes the feature description verbatim", () => {
    const out = buildClarificationPrompt({
      feature_description: "build OAuth login for the admin console",
      prd_context: "feature",
      round: 1,
      prior_qa: [],
      recall_summary: "",
    });
    expect(out).toContain("build OAuth login for the admin console");
  });

  it("includes the prd_context displayName (not just the enum value)", () => {
    const out = buildClarificationPrompt({
      feature_description: "x",
      prd_context: "feature",
      round: 1,
      prior_qa: [],
      recall_summary: "",
    });
    // PRD_CONTEXT_CONFIGS["feature"].displayName = "Feature"
    expect(out).toContain("Feature");
  });

  it("includes prior Q&A when present", () => {
    const out = buildClarificationPrompt({
      feature_description: "x",
      prd_context: "feature",
      round: 2,
      prior_qa: [
        {
          question: "What is the success metric?",
          answer: "p95 latency under 250ms",
        },
      ],
      recall_summary: "",
    });
    expect(out).toContain("What is the success metric?");
    expect(out).toContain("p95 latency under 250ms");
  });

  it("renders '(no prior questions)' when prior_qa is empty", () => {
    const out = buildClarificationPrompt({
      feature_description: "x",
      prd_context: "feature",
      round: 1,
      prior_qa: [],
      recall_summary: "",
    });
    expect(out).toContain("(no prior questions)");
  });

  it("includes the round number against the context max", () => {
    const out = buildClarificationPrompt({
      feature_description: "x",
      prd_context: "feature",
      round: 3,
      prior_qa: [],
      recall_summary: "",
    });
    // PRD_CONTEXT_CONFIGS["feature"].clarificationRange[1] = 10
    expect(out).toContain("3 of 10");
  });

  it("includes recall_summary in a bounded codebase_context block", () => {
    const out = buildClarificationPrompt({
      feature_description: "x",
      prd_context: "feature",
      round: 1,
      prior_qa: [],
      recall_summary: "MEMORY EXCERPT: oauth handler at src/auth.ts",
    });
    expect(out).toContain("MEMORY EXCERPT: oauth handler at src/auth.ts");
    expect(out).toContain("<codebase_context>");
  });

  it("omits the codebase_context block when recall_summary is empty", () => {
    const out = buildClarificationPrompt({
      feature_description: "x",
      prd_context: "feature",
      round: 1,
      prior_qa: [],
      recall_summary: "",
    });
    expect(out).not.toContain("<codebase_context>");
  });
});

describe("buildSectionPrompt", () => {
  it("includes the section display name and PRD context", () => {
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "OAuth login",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
    });
    // SECTION_DISPLAY_NAMES["requirements"] = "Requirements"
    expect(out).toContain("Requirements");
    expect(out).toContain("Feature");
  });

  it("includes the feature description", () => {
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "OAuth login for admin console",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
    });
    expect(out).toContain("OAuth login for admin console");
  });

  it("includes clarification Q&A only when answer is present", () => {
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [
        { question: "Answered Q?", answer: "Yes — measured." },
        { question: "Pending Q?", answer: "" },
      ],
      prior_violations: [],
      attempt: 1,
    });
    expect(out).toContain("Answered Q?");
    expect(out).toContain("Yes — measured.");
    expect(out).not.toContain("Pending Q?");
  });

  it("on attempt > 1, embeds prior_violations in a previous_attempt_failed block", () => {
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: ["[fr_numbering_gaps] FR-099 missing predecessors"],
      attempt: 2,
    });
    expect(out).toContain("Attempt 1 produced violations:");
    expect(out).toContain("fr_numbering_gaps");
    expect(out).toContain("Fix every violation in this attempt.");
  });

  it("on attempt 1, does NOT include the previous_attempt_failed block", () => {
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
    });
    expect(out).not.toContain("previous_attempt_failed");
    expect(out).not.toContain("Fix every violation");
  });

  it("renders a <strategies> block when strategy_assignment is provided (Phase 4 wiring)", () => {
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "OAuth login",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
      strategy_assignment: {
        required: ["chain_of_thought", "verified_reasoning"],
        optional: ["self_consistency"],
        forbidden: ["zero_shot"],
        expectedImprovement: 0.32,
        assignmentConfidence: 0.85,
        claimAnalysis: {
          claim: "Requirements: OAuth login",
          characteristics: ["multi_step_logic", "structural_reasoning"],
          complexityScore: 0.5,
          complexityTier: "moderate",
          analysisNotes: [],
        },
        researchCitations: ["arXiv:2501.12948"],
      },
    });
    expect(out).toContain("<strategies>");
    expect(out).toContain("chain_of_thought");
    expect(out).toContain("verified_reasoning");
    expect(out).toContain("self_consistency");
    expect(out).toContain("zero_shot");
    expect(out).toContain("REQUIRED");
    expect(out).toContain("OPTIONAL");
    expect(out).toContain("FORBIDDEN");
    expect(out).toContain("arXiv:2501.12948");
    expect(out).toContain("32.0%");
    expect(out).toContain("85.0%");
  });

  it("omits the <strategies> block when strategy_assignment is absent (back-compat)", () => {
    const out = buildSectionPrompt({
      // Use `overview` rather than `requirements` for this back-compat
      // assertion: requirements section guidance contains the word
      // "FORBIDDEN" as part of "SP column FORBIDDEN here", which would
      // mask a real regression. Overview's guidance is strategy-block-free.
      section_type: "overview",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
    });
    expect(out).not.toContain("<strategies>");
    expect(out).not.toContain("REQUIRED (apply all of these)");
    expect(out).not.toContain("FORBIDDEN (do NOT apply");
  });

  it("includes the COMMON_RULES that gate downstream validators", () => {
    const out = buildSectionPrompt({
      section_type: "requirements",
      feature_description: "x",
      prd_context: "feature",
      recall_summary: "",
      clarification_qa: [],
      prior_violations: [],
      attempt: 1,
    });
    // Load-bearing rules — these align with the validation package's regex
    // patterns. If a rule is dropped here AND in validation, the contract
    // silently weakens. The tests in @prd-gen/validation pin the validator
    // side; this pins the prompt side.
    expect(out).toContain("FR-XXX");
    expect(out).toContain("AC-XXX");
    expect(out).toContain("Source:");
  });
});

describe("buildJiraPrompt", () => {
  it("includes feature description and source sections", () => {
    const out = buildJiraPrompt({
      feature_description: "OAuth login for admin console",
      source_sections: [
        {
          section_type: "requirements",
          content: "## Requirements\n\n- FR-001: OAuth login.",
        },
        {
          section_type: "acceptance_criteria",
          content: "## Acceptance Criteria\n\n- AC-001: User signs in.",
        },
      ],
    });
    expect(out).toContain("OAuth login for admin console");
    expect(out).toContain("FR-001");
    expect(out).toContain("AC-001");
  });

  it("filters out sections with empty content", () => {
    const out = buildJiraPrompt({
      feature_description: "x",
      source_sections: [
        { section_type: "requirements", content: "## Requirements\n- FR-001: x" },
        { section_type: "user_stories", content: "" }, // empty → filtered
      ],
    });
    expect(out).toContain("FR-001");
    // The empty section's heading should NOT appear in the source block.
    // The phrase "## Source: user_stories" would be the rendered header.
    expect(out).not.toContain("## Source: user_stories");
  });

  it("includes load-bearing JIRA rules (AC reuse, SP arithmetic, no self-deps)", () => {
    const out = buildJiraPrompt({
      feature_description: "x",
      source_sections: [
        { section_type: "requirements", content: "## Requirements\n- FR-001: x" },
      ],
    });
    expect(out).toContain("AC IDs MUST match");
    expect(out).toContain("SP totals");
    expect(out.toLowerCase()).toContain("self-dependency");
  });
});
