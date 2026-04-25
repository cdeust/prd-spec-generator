/**
 * Handler protocol constants.
 *
 * Shared identifiers used by handlers to address subagent invocations and
 * user prompts, AND by test/benchmark dispatchers (canned-dispatcher) to
 * route fake responses by `invocation_id` prefix.
 *
 * Centralized here so a rename in one place updates both producer (the
 * handler) and consumer (the dispatcher). Pre-fix, canned-dispatcher.ts
 * carried local copies of these constants with `// source: handlers/X.ts`
 * source comments — a shotgun-surgery smell where a rename in the handler
 * would silently desync the dispatcher.
 *
 * source: code-reviewer M4 (Phase 3+4 cross-audit, 2026-04).
 */

/** clarification.ts — question_id used to short-circuit clarification with "proceed". */
export const QUESTION_ID_CONTINUE = "clarification_continue";

/** clarification.ts — invocation_id prefix for the question-compose phase. */
export const CLARIFICATION_COMPOSE_INV_PREFIX = "clarification_compose_inv_";

/** section-generation.ts — invocation_id prefix for section-draft generation. */
export const SECTION_GENERATE_INV_PREFIX = "section_generate_";

/** self-check.ts — invocation_id prefix for the multi-judge verdict phase. */
export const SELF_CHECK_JUDGE_INV_PREFIX = "self_check_judge_";

/** jira-generation.ts — single invocation_id for the jira-ticket synthesis. */
export const JIRA_GENERATION_INV_ID = "jira_generation_engineer";

/**
 * clarification.ts — invocation_id producer for round N's compose phase.
 * Lives here so the canned dispatcher uses the SAME function the handler
 * does — preventing the handler and the dispatcher from drifting on the
 * exact format. The current format is `<prefix><round>` (round number
 * appended directly).
 */
export function clarificationComposeInvocationId(round: number): string {
  return `${CLARIFICATION_COMPOSE_INV_PREFIX}${round}`;
}
