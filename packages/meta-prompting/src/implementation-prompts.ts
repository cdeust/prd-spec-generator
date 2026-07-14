/**
 * Implementation-stage prompt (design-phases-3-5.md §3, PR 4a).
 *
 * Composes a self-contained prompt for the `engineer` subagent, invoked once
 * per run (orchestration handlers/implementation.ts) to implement the
 * validated specs produced by section_generation/file_export. Mirrors the
 * shape of git-history-prompts.ts (single builder, no class state).
 *
 * The trailing `<report_format>` block is a CONTRACT, not a suggestion: the
 * caller (implementation.ts's parseImplementationReport) parses the
 * BRANCH:/WORKTREE:/FILES: footer with a fixed regex. Both sides of this
 * contract are owned by this PR, which is why a strict machine-readable
 * footer is a reasonable ask of a prose-reporting subagent rather than a
 * fragile inference over free text.
 */

export interface ImplementationPromptInput {
  readonly feature_description: string;
  readonly codebase_path: string;
  /** PRD deliverable paths written by file_export (state.written_files). */
  readonly spec_files: readonly string[];
  /**
   * Pre-formatted blast-radius summary from pre_impl_grounding
   * (post_specs.impact_queries.results). Empty string when no grounding was
   * collected (no graph, no affected-symbols claims, or every query failed).
   */
  readonly blast_radius_summary: string;
  /**
   * git-historian investigation summary (state.git_history_summary), when
   * one was gathered for this run. Empty/omitted when unavailable.
   */
  readonly git_history_summary?: string;
}

export function buildImplementationPrompt(input: ImplementationPromptInput): string {
  const specFilesBlock =
    input.spec_files.length > 0
      ? input.spec_files.map((p) => `- ${p}`).join("\n")
      : "(no spec files were exported for this run)";

  return [
    `<role>You are an engineer. Implement the feature described below, exactly as specified in the attached PRD/spec files, inside the given codebase.</role>`,
    "",
    `<codebase_path>${input.codebase_path}</codebase_path>`,
    "",
    `<feature>${input.feature_description}</feature>`,
    "",
    `<spec_files>`,
    specFilesBlock,
    `</spec_files>`,
    "",
    input.blast_radius_summary
      ? `<blast_radius>\n${input.blast_radius_summary}\n</blast_radius>\n`
      : "",
    input.git_history_summary
      ? `<git_history>\n${input.git_history_summary}\n</git_history>\n`
      : "",
    `<worktree_protocol>`,
    `Create your own git worktree and branch for this change (do not work`,
    `directly on the checked-out branch). Commit with conventional commit`,
    `messages. Do NOT push — a later human-gated stage handles that. Stage`,
    `only the files you modified.`,
    `</worktree_protocol>`,
    "",
    `<task>`,
    `Implement the change specified in <spec_files>, grounded by`,
    `<blast_radius> and <git_history> when present. Follow`,
    `<worktree_protocol> exactly.`,
    `</task>`,
    "",
    `<report_format>`,
    `End your final response with a short prose summary (a few sentences),`,
    `followed by EXACTLY this footer, each field on its own line, values`,
    `filled in (no placeholders, no surrounding markdown/code fences):`,
    "",
    `BRANCH: <the branch name you created>`,
    `WORKTREE: <the absolute worktree path you created>`,
    `SHA: <the HEAD commit sha after your last commit>`,
    `FILES:`,
    `- <path of a changed file, one per line>`,
    "",
    `Omit the FILES: block entirely if you changed no files. BRANCH and`,
    `WORKTREE are mandatory — the caller cannot proceed without them.`,
    `</report_format>`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
