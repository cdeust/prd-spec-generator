/**
 * Clarification prompts — generate the next clarification question for the user.
 *
 * Called by the host (via the engineer subagent) when the orchestrator's
 * clarification handler emits an `ask_user` action with `question_id =
 * clarification_answer`. The host invokes the engineer with this prompt to
 * COMPOSE a question, then asks the user via AskUserQuestion.
 */

import {
  PRD_CONTEXT_CONFIGS,
  type PRDContext,
} from "@prd-gen/core";

export interface ClarificationPromptInput {
  readonly feature_description: string;
  readonly prd_context: PRDContext;
  readonly round: number;
  readonly prior_qa: ReadonlyArray<{ question: string; answer?: string }>;
  readonly recall_summary: string;
}

export function buildClarificationPrompt(
  input: ClarificationPromptInput,
): string {
  const ctx = PRD_CONTEXT_CONFIGS[input.prd_context];
  const priorBlock = input.prior_qa.length
    ? input.prior_qa
        .map(
          (qa) =>
            `Round ${input.round - input.prior_qa.length + 1}:\nQ: ${qa.question}\nA: ${qa.answer ?? "(no answer)"}`,
        )
        .join("\n\n")
    : "(no prior questions)";

  return [
    `<role>You are eliciting requirements for a ${ctx.displayName} PRD.</role>`,
    "",
    `<feature>${input.feature_description}</feature>`,
    "",
    `<round>${input.round} of ${ctx.clarificationRange[1]}</round>`,
    "",
    `<prior_questions_and_answers>`,
    priorBlock,
    `</prior_questions_and_answers>`,
    "",
    input.recall_summary
      ? `<codebase_context>\n${input.recall_summary.slice(0, 2000)}\n</codebase_context>`
      : "",
    "",
    `<task>`,
    `Generate ONE clarification question that:`,
    `- Addresses the highest-uncertainty area not yet covered`,
    `- Cannot be answered by reading prior answers or codebase context above`,
    `- Has a concrete answer (not "tell me more about X")`,
    `</task>`,
    "",
    `<output_format>`,
    `Return EXACTLY ONE JSON object, nothing else:`,
    `{`,
    `  "question": "<the question to ask the user>",`,
    `  "options": ["<option 1>", "<option 2>", "<option 3>"] | null,`,
    `  "rationale": "<why this question now, in one sentence>"`,
    `}`,
    `If options is non-null, the user picks from a fixed set. Otherwise freeform.`,
    `</output_format>`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export interface GeneratedQuestion {
  readonly question: string;
  readonly options: readonly string[] | null;
  readonly rationale: string;
}
