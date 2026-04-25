/**
 * Canned-response dispatcher: shared between the smoke harness, the
 * pipeline-KPI benchmark, and any future integration test that needs to drive
 * the reducer end-to-end without real LLM/MCP/host wiring.
 *
 * source: code-reviewer B1 (Phase 3 cross-audit, 2026-04). Three-use rule
 * met (smoke + KPI + future integration tests). Pre-extraction the dispatch
 * was duplicated with subtle behavioural drift (different freeform answers,
 * graph_paths, missing JIRA invocation path on the KPI side).
 *
 * Dispatch is by `action.kind` ONLY. Subagent routing within
 * `spawn_subagents` is by `invocation_id` prefix — NEVER by `purpose`, which
 * is an observability label per actions.ts SpawnSubagentsActionSchema and
 * MUST NOT be consumed by the host.
 *
 * The `default: never` exhaustiveness arm makes adding a new NextAction kind
 * a compile error rather than a silent runtime miss.
 *
 * Usage:
 *   const dispatch = makeCannedDispatcher();           // sensible defaults
 *   const dispatch = makeCannedDispatcher({            // smoke-test labels
 *     freeform_answer: "smoke-test-answer",
 *     graph_path: "/tmp/smoke/.prd-gen/graphs/smoke/graph",
 *     fake_section_draft: customDraftFn,
 *   });
 */

import type { ActionResult, NextAction } from "./types/actions.js";
import {
  QUESTION_ID_CONTINUE as CLARIFICATION_CONTINUE_QID,
  CLARIFICATION_COMPOSE_INV_PREFIX,
  SECTION_GENERATE_INV_PREFIX,
  SELF_CHECK_JUDGE_INV_PREFIX,
  JIRA_GENERATION_INV_ID,
} from "./handlers/protocol-ids.js";

export interface CannedDispatcherOptions {
  /**
   * Freeform fallback for ask_user when the question carries no enumerated
   * options. Smoke tests use "smoke-test-answer"; benchmark uses
   * "benchmark-answer". Default: "canned-answer".
   */
  readonly freeform_answer?: string;
  /**
   * Synthetic graph_path returned for index_codebase. Some tests assert on
   * the exact value, so callers may want to pin it. Default:
   * "/tmp/canned/graph".
   */
  readonly graph_path?: string;
  /**
   * Custom draft producer for section_generate_* invocations. The argument
   * is the section_type extracted from the invocation_id suffix.
   * Default: synthetic markdown with claim-extractor-friendly content per
   * section (FR/AC tables, NFR sentences, security/architecture keywords)
   * so planDocumentVerification yields claims and the judge phase fires.
   */
  readonly fake_section_draft?: (section_type: string) => string;
}

export type CannedDispatcher = (action: NextAction) => ActionResult | undefined;

/**
 * Default per-section draft producer. Each branch emits content the claim
 * extractors recognise (FR_LINE_RE, AC_LINE_RE, ARCH_PATTERNS, NFR_PATTERNS,
 * SECURITY_KEYWORDS). Without claims the verifier returns zero judge_requests
 * and the self-check phase silently bypasses the judge round.
 *
 * source: curie cross-audit pass-2 (2026-04) — fake drafts must be claim-rich.
 */
export function defaultFakeSectionDraft(section_type: string): string {
  const heading = `## ${section_type}`;
  switch (section_type) {
    case "requirements":
      return [
        heading,
        "",
        "- FR-001: The system supports OAuth login via Google and GitHub.",
        "- FR-002: The system stores session tokens in HttpOnly cookies.",
      ].join("\n");
    case "acceptance_criteria":
      return [
        heading,
        "",
        "- AC-001: A user with valid Google credentials can sign in.",
        "- AC-002: A user with invalid credentials sees an error message.",
      ].join("\n");
    case "technical_specification":
      return [
        heading,
        "",
        "We use ports-and-adapters architecture. The OAuth domain port is",
        "implemented by Google and GitHub adapters at the infrastructure layer.",
      ].join("\n");
    case "performance_requirements":
      return [
        heading,
        "",
        "p95 < 250ms for token validation under nominal load.",
      ].join("\n");
    case "security_considerations":
      return [
        heading,
        "",
        "All session tokens use AES-256-GCM. Authentication uses OAuth 2.0.",
      ].join("\n");
    default:
      return [heading, "", "Canned synthetic content."].join("\n");
  }
}

function fakeJudgeVerdict(): string {
  return JSON.stringify({
    verdict: "PASS",
    rationale: "Canned synthetic verdict.",
    caveats: [],
    confidence: 0.9,
  });
}

function fakeClarificationQuestion(): string {
  return JSON.stringify({
    question: "What is the primary success metric?",
    options: null,
    rationale: "Canned placeholder.",
  });
}

/**
 * Build a canned dispatcher with the given options. Returns a function that
 * maps NextAction → ActionResult (or undefined for terminal actions, which
 * the loop driver treats as the cue to stop).
 */
export function makeCannedDispatcher(
  opts: CannedDispatcherOptions = {},
): CannedDispatcher {
  const freeform_answer = opts.freeform_answer ?? "canned-answer";
  const graph_path = opts.graph_path ?? "/tmp/canned/graph";
  const fake_section_draft = opts.fake_section_draft ?? defaultFakeSectionDraft;

  function pickFakeAgentResponse(invocation_id: string): string {
    if (invocation_id.startsWith(SELF_CHECK_JUDGE_INV_PREFIX)) {
      return fakeJudgeVerdict();
    }
    if (invocation_id.startsWith(CLARIFICATION_COMPOSE_INV_PREFIX)) {
      return fakeClarificationQuestion();
    }
    if (invocation_id.startsWith(SECTION_GENERATE_INV_PREFIX)) {
      const section_type = invocation_id.slice(
        SECTION_GENERATE_INV_PREFIX.length,
      );
      return fake_section_draft(section_type);
    }
    if (invocation_id === JIRA_GENERATION_INV_ID) {
      return "## JIRA Tickets\n\nCanned JIRA placeholder.";
    }
    return "Canned synthetic response.";
  }

  function craftUserAnswer(
    action: Extract<NextAction, { kind: "ask_user" }>,
  ): ActionResult {
    if (action.question_id === CLARIFICATION_CONTINUE_QID) {
      return {
        kind: "user_answer",
        question_id: action.question_id,
        selected: ["proceed"],
      };
    }
    if (action.options && action.options.length > 0) {
      return {
        kind: "user_answer",
        question_id: action.question_id,
        selected: [action.options[0].label],
      };
    }
    return {
      kind: "user_answer",
      question_id: action.question_id,
      selected: [],
      freeform: freeform_answer,
    };
  }

  function craftPipelineToolResult(
    action: Extract<NextAction, { kind: "call_pipeline_tool" }>,
  ): ActionResult {
    if (action.tool_name === "index_codebase") {
      return {
        kind: "tool_result",
        correlation_id: action.correlation_id,
        success: true,
        data: {
          graph_path,
          symbols_indexed: 0,
          files_parsed: 0,
          duration_ms: 1,
        },
      };
    }
    return {
      kind: "tool_result",
      correlation_id: action.correlation_id,
      success: true,
      data: {},
    };
  }

  function craftCortexToolResult(
    action: Extract<NextAction, { kind: "call_cortex_tool" }>,
  ): ActionResult {
    if (action.tool_name === "recall") {
      return {
        kind: "tool_result",
        correlation_id: action.correlation_id,
        success: true,
        data: { results: [], total: 0 },
      };
    }
    return {
      kind: "tool_result",
      correlation_id: action.correlation_id,
      success: true,
      data: {},
    };
  }

  function craftSubagentBatchResult(
    action: Extract<NextAction, { kind: "spawn_subagents" }>,
  ): ActionResult {
    const responses = action.invocations.map((inv) => ({
      invocation_id: inv.invocation_id,
      raw_text: pickFakeAgentResponse(inv.invocation_id),
    }));
    return {
      kind: "subagent_batch_result",
      batch_id: action.batch_id,
      responses,
    };
  }

  function craftFileWritten(
    action: Extract<NextAction, { kind: "write_file" }>,
  ): ActionResult {
    return {
      kind: "file_written",
      path: action.path,
      bytes: Buffer.byteLength(action.content, "utf8"),
    };
  }

  return function dispatch(action: NextAction): ActionResult | undefined {
    switch (action.kind) {
      case "ask_user":
        return craftUserAnswer(action);
      case "call_pipeline_tool":
        return craftPipelineToolResult(action);
      case "call_cortex_tool":
        return craftCortexToolResult(action);
      case "spawn_subagents":
        return craftSubagentBatchResult(action);
      case "write_file":
        return craftFileWritten(action);
      case "done":
      case "failed":
        return undefined;
      default: {
        const _exhaustive: never = action;
        throw new Error(
          `cannedDispatcher: unhandled action.kind=${(action as NextAction).kind}. ` +
            `Add a case to the dispatch switch.`,
        );
      }
    }
  };
}
