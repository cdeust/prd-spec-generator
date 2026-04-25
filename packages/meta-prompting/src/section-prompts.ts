/**
 * Section drafting prompts.
 *
 * Per-section-type templates that produce a self-contained prompt for the
 * engineer subagent. Each builder takes:
 *   - feature description
 *   - PRD context type
 *   - recall summary (Cortex)
 *   - clarification answers
 *   - prior violations (for retry)
 *
 * Output: a single string the host hands to the Agent tool.
 *
 * The hard-output rules baked into each prompt mirror SKILL.md so the draft
 * has a chance of passing validation on the first attempt.
 */

import {
  SECTION_DISPLAY_NAMES,
  PRD_CONTEXT_CONFIGS,
  type PRDContext,
  type SectionType,
} from "@prd-gen/core";
import type { StrategyAssignment } from "@prd-gen/strategy";

export interface SectionPromptInput {
  readonly section_type: SectionType;
  readonly feature_description: string;
  readonly prd_context: PRDContext;
  readonly recall_summary: string;
  readonly clarification_qa: ReadonlyArray<{ question: string; answer: string }>;
  readonly prior_violations: readonly string[];
  readonly attempt: number;
  /**
   * Research-evidence-backed strategy assignment chosen by `@prd-gen/strategy`.
   * Optional because legacy callers may construct prompts without it; when
   * present, the rendered prompt includes a `<strategies>` block telling the
   * engineer subagent which reasoning patterns to apply (and avoid).
   *
   * source: Phase 4 strategy-wiring (2026-04).
   */
  readonly strategy_assignment?: StrategyAssignment;
}

const COMMON_RULES = [
  "1. Output ONLY the section body. No surrounding prose, no JSON, no fences.",
  "2. Start with `## <Section Display Name>` exactly once.",
  "3. Every Functional Requirement (FR-XXX) MUST cite a Source: user-request, clarification round, or codebase finding.",
  "4. Acceptance Criteria use `AC-XXX` format starting from AC-001.",
  "5. No `AnyCodable`, `AnyJSON` — heterogeneous JSON is an explicit type.",
  "6. NFR claims (latency, throughput, fps, storage) MUST specify a measurement method.",
  "7. Story-point totals must add up. No self-referencing dependencies.",
  "8. Architectural patterns: ports/adapters in code examples, not frameworks in domain.",
];

const PER_SECTION_GUIDANCE: Partial<Record<SectionType, string>> = {
  overview:
    "1-2 paragraphs. State problem, audience, success measure. No requirements here.",
  goals:
    "Bulleted list of measurable goals. Each goal: outcome verb + target + measurement.",
  requirements:
    "Markdown table: | ID | Requirement | Priority | Depends On | Source |. SP column FORBIDDEN here.",
  user_stories:
    "Each story: As a <role>, I want <action>, so that <outcome>. Include AC-XXX list per story.",
  technical_specification:
    "Show ports (interfaces in domain) + adapters (impls in infrastructure) + composition root. No framework imports in domain.",
  acceptance_criteria:
    "Numbered AC-001..AC-NNN. Each AC: Given/When/Then or one-line behaviour. Each AC must trace to one or more FR-XXX.",
  data_model:
    "DDL for tables/types/enums. Every CREATE TYPE / CREATE TABLE must be referenced. NO `NOW()` in partial-index WHERE.",
  api_specification:
    "Endpoint table: | Method | Path | Auth | Request | Response | Errors |. Match any HTTP-style ports from technical_specification.",
  security_considerations:
    "Auth (mechanism), authz (matrix), data-at-rest, data-in-transit, secrets handling, audit logs. Cite STRIDE category per claim.",
  performance_requirements:
    "p50/p95/p99 + measurement method (e.g., k6 script, prod APM). Verdict: SPEC-COMPLETE if method is named, NEEDS-RUNTIME otherwise.",
  testing:
    "Coverage table: | Test name | Tests AC-XXX or FR-XXX | Type (unit/integration/e2e) | Status |. Real implementations only — no `// TODO` test bodies.",
  deployment:
    "Phases (canary, full), rollback procedure, feature flags, monitoring/alerting hooks.",
  risks:
    "Risk register: | Risk | Likelihood | Impact | Mitigation | Owner |. One row per risk.",
  timeline:
    "Phases with sprint counts. Each phase total = sum of stories in that phase. Grand total = sum of phases.",
};

/**
 * Render the strategies block. Empty string when no assignment is provided
 * (legacy callers); a structured block listing required / optional / forbidden
 * strategies + the research citations + the expected improvement when present.
 *
 * source: Phase 4 strategy-wiring (2026-04). The block is structured so the
 * subagent can apply the strategies deliberately rather than treating them
 * as decorative metadata.
 */
function renderStrategiesBlock(
  assignment: StrategyAssignment | undefined,
): string {
  if (!assignment) return "";
  const lines: string[] = [
    `<strategies>`,
    `Apply the following research-evidence-backed reasoning strategies:`,
    "",
  ];
  if (assignment.required.length > 0) {
    lines.push(`REQUIRED (apply all of these):`);
    for (const s of assignment.required) lines.push(`  - ${s}`);
  }
  if (assignment.optional.length > 0) {
    lines.push(`OPTIONAL (apply if natural for this section):`);
    for (const s of assignment.optional) lines.push(`  - ${s}`);
  }
  if (assignment.forbidden.length > 0) {
    lines.push(`FORBIDDEN (do NOT apply — these have been shown to harm this kind of claim):`);
    for (const s of assignment.forbidden) lines.push(`  - ${s}`);
  }
  if (assignment.researchCitations.length > 0) {
    lines.push("");
    lines.push(`Citations backing this assignment:`);
    for (const c of assignment.researchCitations) lines.push(`  - ${c}`);
  }
  // The number is a population-level aggregate of research-evidence scores
  // across the strategies in this assignment — NOT a forward-looking
  // prediction calibrated to this specific section/feature. Labeling it
  // as such prevents the engineer subagent from inflating its own
  // confidence based on a number that is structurally an average over
  // unrelated benchmarks (cross-audit feynman MED-1, Phase 4 wiring,
  // 2026-04).
  lines.push(
    `Research-evidence baseline (population aggregate, NOT a per-section prediction): ${(assignment.expectedImprovement * 100).toFixed(1)}%`,
  );
  lines.push(
    `Assignment confidence: ${(assignment.assignmentConfidence * 100).toFixed(1)}%`,
  );
  lines.push(`</strategies>`);
  return lines.join("\n");
}

export function buildSectionPrompt(input: SectionPromptInput): string {
  const display = SECTION_DISPLAY_NAMES[input.section_type];
  const contextConfig = PRD_CONTEXT_CONFIGS[input.prd_context];
  const sectionGuidance =
    PER_SECTION_GUIDANCE[input.section_type] ??
    "Follow the section's standard structure.";

  const clarificationLines = input.clarification_qa
    .filter((c) => c.answer)
    .map((c) => `Q: ${c.question}\nA: ${c.answer}`)
    .join("\n\n");

  const violationsBlock = input.prior_violations.length
    ? [
        `<previous_attempt_failed validation>`,
        `Attempt ${input.attempt - 1} produced violations:`,
        input.prior_violations.map((v) => `- ${v}`).join("\n"),
        `Fix every violation in this attempt.`,
        `</previous_attempt_failed>`,
      ].join("\n")
    : "";

  const strategiesBlock = renderStrategiesBlock(input.strategy_assignment);

  return [
    `<role>You draft section "${display}" of a ${contextConfig.displayName} PRD.</role>`,
    "",
    `<feature>${input.feature_description}</feature>`,
    "",
    `<context>`,
    `PRD type: ${contextConfig.displayName}`,
    `Focus: ${contextConfig.description}`,
    `Attempt: ${input.attempt}`,
    `</context>`,
    "",
    input.recall_summary
      ? `<codebase_context>\n${input.recall_summary}\n</codebase_context>\n`
      : "",
    clarificationLines
      ? `<clarifications>\n${clarificationLines}\n</clarifications>\n`
      : "",
    violationsBlock,
    violationsBlock ? "" : "",
    strategiesBlock,
    strategiesBlock ? "" : "",
    `<guidance>`,
    sectionGuidance,
    `</guidance>`,
    "",
    `<hard_rules>`,
    COMMON_RULES.join("\n"),
    `</hard_rules>`,
    "",
    `Produce the "${display}" section now. Markdown only.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
