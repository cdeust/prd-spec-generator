/**
 * JIRA ticket generation prompt.
 *
 * Takes the requirements + user_stories + acceptance_criteria sections and
 * produces a self-contained prompt for the engineer subagent to emit a
 * markdown JIRA ticket document.
 */

export interface JiraPromptInput {
  readonly feature_description: string;
  readonly source_sections: ReadonlyArray<{
    section_type: string;
    content: string;
  }>;
}

const RULES = [
  "1. Output ONLY a markdown document. No JSON, no preamble, no fences.",
  "2. AC IDs MUST match the AC-XXX IDs in the source. NEVER create new AC numbering.",
  "3. Each ticket: ID (TICKET-NNN), Title, Description, Acceptance Criteria (referencing AC-XXX), Story Points (Fibonacci), Depends On, Source.",
  "4. SP totals: Epic SP = sum of story SPs. Phase SP = sum of stories in phase. Grand total = sum of phases.",
  "5. NEVER list a ticket as a self-dependency.",
  "6. Distribute SP unevenly — real complexity is uneven.",
  "7. Group tickets into Phases (Phase 1, Phase 2, ...) reflecting delivery order.",
  "8. End with a Summary table: | Phase | Story Count | Total SP |.",
];

export function buildJiraPrompt(input: JiraPromptInput): string {
  const sourceBlock = input.source_sections
    .filter((s) => s.content)
    .map((s) => `## Source: ${s.section_type}\n\n${s.content}`)
    .join("\n\n");

  return [
    `<role>You generate JIRA tickets from a PRD.</role>`,
    "",
    `<feature>${input.feature_description}</feature>`,
    "",
    `<source_prd>`,
    sourceBlock,
    `</source_prd>`,
    "",
    `<rules>`,
    RULES.join("\n"),
    `</rules>`,
    "",
    `Produce the JIRA ticket document now.`,
  ].join("\n");
}
