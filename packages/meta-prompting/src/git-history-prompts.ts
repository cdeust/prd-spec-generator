/**
 * Git-historian investigation prompt.
 *
 * Composes a self-contained prompt for the `zetetic-team-subagents:git-historian`
 * agent, invoked once per run (input_analysis, Phase 2) to mine the target
 * codebase's version-control history for context a PRD should ground on:
 * provenance, abandoned-approach recovery, churn hotspots, and constraints
 * discovered in commit/PR history. Mirrors the shape of jira-prompts.ts /
 * clarification-prompts.ts (single builder, no class state).
 *
 * source: Phase 2 (2026-07-14) — git-historian stage. The agent's own
 * contract (zetetic-team-subagents agents/git-historian.md) accepts a free-text
 * question and self-classifies it (Move 1: regression / prior-art /
 * provenance); this prompt deliberately asks for ALL of provenance +
 * prior-art in one pass rather than dispatching three separate invocations,
 * because a PRD-grounding report needs a single compact synthesis, not three
 * History Verdicts to reconcile downstream.
 */

export interface GitHistoryPromptInput {
  readonly feature_description: string;
  readonly codebase_path: string;
  /**
   * Optional scope hint derived from AP code-graph grounding
   * (state.codebase_grounding), e.g. "3 matched symbols across 2 impacted
   * communities". Empty/omitted when no grounding exists — the investigation
   * then covers the feature description alone.
   */
  readonly grounding_summary?: string;
}

/**
 * source: bounds the report to a size the caller's defensive truncation
 * (input-analysis.ts:GIT_HISTORY_TRUNCATE_CHARS) rarely needs to engage —
 * the char cap is the enforced backstop, this is the requested target.
 */
const REPORT_WORD_LIMIT = 400;

export function buildGitHistoryPrompt(input: GitHistoryPromptInput): string {
  return [
    `<role>You are git-historian. Investigate the repository history at the given codebase path for context relevant to an upcoming PRD, before any spec is drafted.</role>`,
    "",
    `<codebase_path>${input.codebase_path}</codebase_path>`,
    "",
    `<feature>${input.feature_description}</feature>`,
    "",
    input.grounding_summary
      ? `<code_graph_hint>\n${input.grounding_summary}\n</code_graph_hint>\n`
      : "",
    `<task>`,
    `Investigate the git history of the zone this feature touches and report:`,
    `- Relevant commits/PRs that shaped this area`,
    `- Prior attempts visible in history (branches, reverts) and, where recorded, why they stopped`,
    `- Churn hotspots among the affected files`,
    `- Constraints discovered from commit messages / PR discussion`,
    "",
    `If <codebase_path> is not inside a git repository, or git history is`,
    `otherwise unavailable, state that plainly as your entire report and stop`,
    `— do not speculate or fabricate history that cannot be verified.`,
    `</task>`,
    "",
    `<output_format>`,
    `Plain prose, at most ${REPORT_WORD_LIMIT} words. No JSON, no code fences.`,
    `One optional leading line as a heading; no further markdown structure`,
    `required.`,
    `</output_format>`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
