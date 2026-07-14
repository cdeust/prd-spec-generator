/**
 * Implementation-stage prompt (design-phases-3-5.md §3, PR 4a; retry mode
 * PR 4b).
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
 *
 * Retry mode (PR 4b, design-phases-3-5.md §3 "review loop retries re-spawn
 * the engineer on the SAME worktree"): when `review_findings` is non-empty,
 * the `<worktree_protocol>` block switches from "create a new worktree" to
 * "continue on the existing worktree/branch" — `existing_worktree_path` /
 * `existing_branch` (orchestration handlers/review.ts reads them off
 * `post_specs.implementation`, still on file from the attempt being
 * retried) make that instruction concrete rather than a bare admonition.
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
  /**
   * `review` step's FAIL findings (design-phases-3-5.md §3, PR 4b), present
   * only when this invocation is a bounded retry after a failed review —
   * see orchestration/handlers/review.ts. Empty/omitted on the first
   * (non-retry) implementation attempt.
   */
  readonly review_findings?: readonly string[];
  /**
   * The worktree path / branch from the PRIOR implementation attempt being
   * retried. Required (together with `review_findings`) to switch
   * `<worktree_protocol>` into continuation mode. Omitted on a non-retry
   * attempt.
   */
  readonly existing_worktree_path?: string;
  readonly existing_branch?: string;
}

function worktreeProtocolBlock(input: ImplementationPromptInput): string {
  const isRetry = Boolean(
    input.review_findings?.length && input.existing_worktree_path && input.existing_branch,
  );
  if (isRetry) {
    return [
      `<worktree_protocol>`,
      `Continue on your EXISTING worktree at ${input.existing_worktree_path}`,
      `(branch ${input.existing_branch}) — do NOT create a new worktree.`,
      `Commit the fixes with conventional commit messages. Do NOT push —`,
      `a later human-gated stage handles that. Stage only the files you`,
      `modified.`,
      `</worktree_protocol>`,
    ].join("\n");
  }
  return [
    `<worktree_protocol>`,
    `Create your own git worktree and branch for this change (do not work`,
    `directly on the checked-out branch). Commit with conventional commit`,
    `messages. Do NOT push — a later human-gated stage handles that. Stage`,
    `only the files you modified.`,
    `</worktree_protocol>`,
  ].join("\n");
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
    input.review_findings && input.review_findings.length > 0
      ? [
          `<review_findings>`,
          `This is a RETRY after a failed review. Fix EVERY finding below on`,
          `the SAME worktree/branch before reporting again:`,
          ...input.review_findings.map((f) => `- ${f}`),
          `</review_findings>`,
          "",
        ].join("\n")
      : "",
    worktreeProtocolBlock(input),
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
