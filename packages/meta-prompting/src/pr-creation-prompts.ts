/**
 * PR-creation prompt (design-phases-3-5.md §3, PR 5).
 *
 * Composes a self-contained prompt for the `engineer` subagent, invoked from
 * orchestration handlers/pr-creation.ts AFTER the human has explicitly
 * approved the push at `pr_gate` (design §3: "mandatory, non-skippable ...
 * this is the trust-seam gate"). Mirrors implementation-prompts.ts's shape.
 *
 * The trailing `<report_format>` block is a CONTRACT, not a suggestion: the
 * caller (pr-creation.ts's parsePrCreationReport) parses the `PR_URL:`
 * footer with a fixed regex — same strategy as implementation-prompts.ts's
 * BRANCH:/WORKTREE:/FILES: footer and review-prompts.ts's VERDICT:/FINDINGS:
 * footer. Both sides of this contract are owned by pr-creation.ts's PR.
 *
 * `<prohibited>` is load-bearing, not decorative: design §3 explicitly
 * refuses `run_command` in favor of a supervised `spawn_subagents` call
 * PRECISELY because every tool call inside it is logged per-turn — that
 * safety property only holds if the subagent is told, explicitly, what it
 * must never do (merge, force-push, `--admin`). The human already approved
 * "push + open PR" at `pr_gate`; nothing beyond that is authorized.
 */

export interface PrCreationPromptInput {
  readonly feature_description: string;
  readonly worktree_path: string;
  readonly branch: string;
  readonly spec_files: readonly string[];
  /** implementation.ts's (truncated) raw_report. */
  readonly implementation_summary: string;
  /** post_impl_verification's gates_passed + a short verdict summary. */
  readonly verification_summary: string;
  /** testing.ts's (truncated) raw_report. */
  readonly testing_summary: string;
  /** review.ts's final verdict + findings (advisory FAIL is possible — the
   *  PR body must surface it honestly, not hide it). */
  readonly review_summary: string;
}

export function buildPrCreationPrompt(input: PrCreationPromptInput): string {
  const specFilesBlock =
    input.spec_files.length > 0
      ? input.spec_files.map((p) => `- ${p}`).join("\n")
      : "(no spec files were exported for this run)";

  return [
    `<role>You are an engineer. Push the branch below and open a pull request for it. A human has ALREADY approved this push — you are executing an explicitly authorized action, not requesting one.</role>`,
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
    `<post_impl_verification>`,
    input.verification_summary || "(no post-implementation verification available)",
    `</post_impl_verification>`,
    "",
    `<testing_report>`,
    input.testing_summary || "(no testing report available)",
    `</testing_report>`,
    "",
    `<review_verdict>`,
    input.review_summary || "(no review verdict available)",
    `</review_verdict>`,
    "",
    `<task>`,
    `On <worktree_path>/<branch>: push the branch to its remote`,
    `(\`git push -u origin <branch>\`), then open a pull request`,
    `(\`gh pr create\`) with a conventional title and a body summarizing`,
    `<feature>, <implementation_report>, <post_impl_verification>,`,
    `<testing_report>, and <review_verdict> — including an HONEST report of`,
    `the review verdict even if it is an advisory FAIL. Link <spec_files>`,
    `in the body.`,
    `</task>`,
    "",
    `<prohibited>`,
    `Do NOT merge the pull request. Do NOT use \`--admin\`. Do NOT`,
    `force-push. Do NOT run \`gh pr merge\` under any circumstance. Your job`,
    `ends when the PR is opened — a human reviews and merges it.`,
    `</prohibited>`,
    "",
    `<report_format>`,
    `End your final response with a short prose summary (a few sentences),`,
    `followed by EXACTLY this footer, on its own line, value filled in (no`,
    `placeholders, no surrounding markdown/code fences):`,
    "",
    `PR_URL: <the full URL of the pull request you opened>`,
    "",
    `PR_URL is mandatory — the caller cannot proceed without it.`,
    `</report_format>`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
