import { z } from "zod";

/**
 * Structured clarification answers — FIXES the flat XML string problem
 * identified by Lavoisier (value leak #2).
 *
 * Each answer carries priority and round info so that:
 * - Later rounds (more refined) get higher priority, not lower
 * - Answers are injected per-section by relevance, not as flat string suffix
 * - Under context pressure, low-priority answers are dropped first
 */
export const ClarificationAnswerSchema = z.object({
  questionId: z.string(),
  round: z.number().int().min(1),
  question: z.string(),
  answer: z.string(),
  category: z.string(),
  priority: z.number().min(0).max(1),
  source: z.enum(["user_freeform", "user_selection", "codebase_inferred", "default"]),
});

export type ClarificationAnswer = z.infer<typeof ClarificationAnswerSchema>;

export const ClarificationStateSchema = z.object({
  answers: z.array(ClarificationAnswerSchema),
  currentRound: z.number().int().min(0),
  confidenceScore: z.number().min(0).max(1),
  isComplete: z.boolean(),
});

export type ClarificationState = z.infer<typeof ClarificationStateSchema>;

/**
 * Get answers sorted by priority (highest first) for injection into a section prompt.
 * This ensures that under context truncation, the most valuable answers survive.
 */
export function getAnswersByPriority(
  answers: readonly ClarificationAnswer[],
  maxTokenBudget?: number,
): ClarificationAnswer[] {
  const sorted = [...answers].sort((a, b) => b.priority - a.priority);
  if (!maxTokenBudget) return sorted;

  // Rough estimate: 4 chars per token
  let tokenCount = 0;
  const result: ClarificationAnswer[] = [];
  for (const answer of sorted) {
    const answerTokens = Math.ceil(
      (answer.question.length + answer.answer.length) / 4,
    );
    if (tokenCount + answerTokens > maxTokenBudget) break;
    tokenCount += answerTokens;
    result.push(answer);
  }
  return result;
}
