import type { StepHandler } from "../runner.js";
import {
  PRDContextSchema,
  PRD_CONTEXT_CONFIGS,
  TIER_CAPABILITIES,
  type PRDContext,
} from "@prd-gen/core";

const TRIGGER_WORDS: Record<PRDContext, readonly string[]> = {
  proposal: ["proposal", "pitch", "stakeholder"],
  feature: ["feature", "build", "implement", "add support"],
  bug: ["bug", "fix", "broken", "regression", "defect"],
  incident: ["incident", "outage", "production issue", "p0", "p1"],
  poc: ["poc", "proof of concept", "spike", "feasibility"],
  mvp: ["mvp", "minimum viable", "v1"],
  release: ["release", "ship", "production launch"],
  cicd: ["ci", "cd", "ci/cd", "pipeline", "deploy automation"],
};

function detectFromText(text: string): PRDContext | null {
  const lower = text.toLowerCase();
  for (const [ctx, triggers] of Object.entries(TRIGGER_WORDS) as [
    PRDContext,
    readonly string[],
  ][]) {
    if (triggers.some((t) => lower.includes(t))) return ctx;
  }
  return null;
}

const QUESTION_ID = "prd_context";

export const handleContextDetection: StepHandler = ({ state, result }) => {
  // Already set — advance.
  if (state.prd_context) {
    return {
      state: { ...state, current_step: "input_analysis" },
      action: {
        kind: "emit_message",
        message: `PRD context: ${PRD_CONTEXT_CONFIGS[state.prd_context].displayName}`,
      },
    };
  }

  // User just answered our question.
  if (result?.kind === "user_answer" && result.question_id === QUESTION_ID) {
    const choice = result.selected[0] ?? result.freeform ?? "";
    const parsed = PRDContextSchema.safeParse(choice);
    if (!parsed.success) {
      return {
        state,
        action: {
          kind: "failed",
          reason: `Invalid PRD context choice: ${choice}`,
          step: "context_detection",
        },
      };
    }
    return {
      state: {
        ...state,
        prd_context: parsed.data,
        current_step: "input_analysis",
      },
      action: {
        kind: "emit_message",
        message: `PRD context: ${PRD_CONTEXT_CONFIGS[parsed.data].displayName}`,
      },
    };
  }

  // Try to detect from feature_description.
  const detected = detectFromText(state.feature_description);
  const allowed = TIER_CAPABILITIES[state.license_tier].allowedContextTypes;

  if (detected && allowed.includes(detected)) {
    return {
      state: {
        ...state,
        prd_context: detected,
        current_step: "input_analysis",
      },
      action: {
        kind: "emit_message",
        message: `PRD context detected: ${PRD_CONTEXT_CONFIGS[detected].displayName} (from trigger words)`,
      },
    };
  }

  // Ask user — restricted to tier-allowed options.
  const options = allowed.map((ctx) => ({
    label: ctx,
    description: PRD_CONTEXT_CONFIGS[ctx].description,
  }));

  return {
    state,
    action: {
      kind: "ask_user",
      question_id: QUESTION_ID,
      header: "Which kind of PRD?",
      description:
        "I couldn't infer the PRD type from your request. Pick the closest match — this configures clarification depth and section count.",
      // source: protocol constraint. AskUserActionSchema.options enforces
      // .max(4) at the schema level (types/actions.ts). Slicing here ensures
      // a tier with >4 allowed contexts doesn't fail Zod parsing on the
      // emitted action. Cross-audit code-reviewer H6 (Phase 3+4, 2026-04).
      options: options.slice(0, 4),
      multi_select: false,
    },
  };
};
