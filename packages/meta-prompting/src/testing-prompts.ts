/**
 * Testing-stage prompt (design-phases-3-5.md §3, PR 4b).
 *
 * Composes a self-contained prompt for the `test-engineer` subagent, invoked
 * once per run (orchestration handlers/testing.ts) to write/run tests
 * against the code `implementation` produced. Mirrors the shape of
 * implementation-prompts.ts (single builder, no class state), but the
 * subagent works on the SAME worktree/branch `implementation` already
 * created (isolation "none" — no second worktree), so the prompt instructs
 * it to change into that path rather than create its own.
 *
 * No machine-readable report footer is required here: `TestingStateSchema`
 * (design §2.1) stores only `{ raw_report }` — the reviewer (PR 4b's
 * `review` step), not this handler, is the one that assesses whether the
 * tests the report describes actually pass.
 */

export interface TestingPromptInput {
  readonly feature_description: string;
  readonly worktree_path: string;
  readonly branch: string;
  /** PRD deliverable paths written by file_export (state.written_files). */
  readonly spec_files: readonly string[];
  /** implementation.ts's (truncated) raw_report — what was implemented. */
  readonly implementation_summary: string;
  /** post_impl_verification's gates_passed + a short verdict summary. */
  readonly verification_summary: string;
}

export function buildTestingPrompt(input: TestingPromptInput): string {
  const specFilesBlock =
    input.spec_files.length > 0
      ? input.spec_files.map((p) => `- ${p}`).join("\n")
      : "(no spec files were exported for this run)";

  return [
    `<role>You are a test engineer. Write and run tests for the change described below, against the code already implemented on the given worktree/branch.</role>`,
    "",
    `<worktree_path>${input.worktree_path}</worktree_path>`,
    `<branch>${input.branch}</branch>`,
    "",
    `<feature>${input.feature_description}</feature>`,
    "",
    `<spec_files>`,
    specFilesBlock,
    `</spec_files>`,
    "",
    `<implementation_report>`,
    input.implementation_summary || "(no implementation summary available)",
    `</implementation_report>`,
    "",
    input.verification_summary
      ? `<post_impl_verification>\n${input.verification_summary}\n</post_impl_verification>\n`
      : "",
    `<worktree_protocol>`,
    `Change into <worktree_path> — it already has <branch> checked out with the`,
    `implementation committed. Do NOT create a new worktree. Add/update tests`,
    `covering the change, run the project's test suite, and commit any test`,
    `files you add with conventional commit messages. Do NOT push.`,
    `</worktree_protocol>`,
    "",
    `<task>`,
    `Verify the implementation in <implementation_report> against`,
    `<spec_files>, grounded by <post_impl_verification> when present. Follow`,
    `<worktree_protocol> exactly.`,
    `</task>`,
    "",
    `<report_format>`,
    `End your response with a prose summary covering: what tests you`,
    `added/ran, whether they pass, and any failures or gaps found. This is`,
    `read by a code reviewer next — be specific about pass/fail state.`,
    `</report_format>`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
