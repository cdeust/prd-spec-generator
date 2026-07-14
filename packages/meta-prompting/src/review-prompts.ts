/**
 * Review-stage prompt (design-phases-3-5.md §3, PR 4b).
 *
 * Composes a self-contained prompt for the `code-reviewer` subagent, invoked
 * from orchestration handlers/review.ts to render a verdict on the
 * implementation + verification + testing evidence. Mirrors
 * implementation-prompts.ts's shape.
 *
 * The trailing `<report_format>` block is a CONTRACT, not a suggestion: the
 * caller (review.ts's parseReviewReport) parses the VERDICT:/FINDINGS:
 * footer with a fixed regex — same strategy as
 * implementation-prompts.ts's BRANCH:/WORKTREE:/FILES: footer. Both sides of
 * this contract are owned by review.ts's PR.
 */

export interface ReviewPromptInput {
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
  /**
   * Findings from a PRIOR failed review attempt, when this call is a
   * re-review after a retry (review.ts's bounded retry loop). Empty on the
   * first attempt.
   */
  readonly prior_findings?: readonly string[];
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const specFilesBlock =
    input.spec_files.length > 0
      ? input.spec_files.map((p) => `- ${p}`).join("\n")
      : "(no spec files were exported for this run)";
  const priorFindingsBlock =
    input.prior_findings && input.prior_findings.length > 0
      ? `<prior_findings>\nThis is a RE-review after a fix attempt. The previous review raised:\n${input.prior_findings.map((f) => `- ${f}`).join("\n")}\n</prior_findings>\n`
      : "";

  return [
    `<role>You are a code reviewer. Evaluate the implementation below against the spec, the automated verification gates, and the test report, then render a PASS/FAIL verdict.</role>`,
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
    priorFindingsBlock,
    `<task>`,
    `Review the change on <worktree_path>/<branch> against <spec_files>,`,
    `<implementation_report>, <post_impl_verification>, and`,
    `<testing_report>. Render FAIL if the implementation deviates from the`,
    `spec, the verification gates did not pass, the tests are missing or`,
    `failing, or any prior finding was not addressed.`,
    `</task>`,
    "",
    `<report_format>`,
    `End your final response with a short prose rationale, followed by`,
    `EXACTLY this footer, each field on its own line, values filled in (no`,
    `placeholders, no surrounding markdown/code fences):`,
    "",
    `VERDICT: PASS or FAIL (exactly one of these two words)`,
    `FINDINGS:`,
    `- <one specific, actionable finding per line>`,
    "",
    `Omit the FINDINGS: block entirely on a PASS verdict with no concerns.`,
    `On FAIL, FINDINGS: is mandatory — at least one specific, actionable`,
    `line the engineer can act on. VERDICT is mandatory — the caller cannot`,
    `proceed without it.`,
    `</report_format>`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
