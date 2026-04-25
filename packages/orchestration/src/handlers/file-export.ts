/**
 * File export — write 9 files (6 core + 3 companion) per SKILL.md Phase 4.
 *
 * Protocol:
 *   - On entry with no result: emit write_file for the first un-written file.
 *   - On file_written result: append to state.written_files, emit the next.
 *   - When state.written_files covers every file in the set → transition to self_check.
 *
 * Progress is tracked in `state.written_files` (a dedicated field). It is
 * NOT folded into `state.errors`; that field is reserved for genuine errors.
 */

import type { StepHandler } from "../runner.js";
import { appendError, type PipelineState } from "../types/state.js";
import {
  SECTION_DISPLAY_NAMES,
  SECTION_ORDER,
  type SectionType,
} from "@prd-gen/core";

const OUTPUT_DIR = "prd-output";

interface PrdFile {
  readonly path: string;
  readonly content: () => string;
}

function joinSections(
  state: PipelineState,
  types: readonly SectionType[],
): string {
  return state.sections
    .filter((s) => types.includes(s.section_type) && s.content)
    .sort(
      (a, b) =>
        SECTION_ORDER[a.section_type] - SECTION_ORDER[b.section_type],
    )
    .map(
      (s) =>
        `## ${SECTION_DISPLAY_NAMES[s.section_type]}\n\n${s.content!.trim()}`,
    )
    .join("\n\n");
}

function jiraContent(state: PipelineState): string {
  const last = [...state.sections]
    .reverse()
    .find((s) => s.section_type === "jira_tickets" && s.content);
  return last?.content?.trim() ?? "";
}

function buildFileSet(state: PipelineState): readonly PrdFile[] {
  const slug = state.run_id.slice(0, 8);
  const base = `${OUTPUT_DIR}/${slug}`;

  return [
    {
      path: `${base}/01-prd.md`,
      content: () =>
        [
          `# PRD: ${state.feature_description}`,
          "",
          `Run ID: ${state.run_id}`,
          `Context: ${state.prd_context ?? "unknown"}`,
          "",
          joinSections(state, [
            "overview",
            "goals",
            "requirements",
            "user_stories",
            "technical_specification",
            "acceptance_criteria",
          ]),
        ].join("\n"),
    },
    {
      path: `${base}/02-data-model.md`,
      content: () =>
        joinSections(state, ["data_model"]) || "_No data model section._",
    },
    {
      path: `${base}/03-api-spec.md`,
      content: () =>
        joinSections(state, ["api_specification"]) || "_No API spec section._",
    },
    {
      path: `${base}/04-security.md`,
      content: () =>
        joinSections(state, [
          "security_considerations",
          "performance_requirements",
        ]) || "_No security/performance sections._",
    },
    {
      path: `${base}/05-testing.md`,
      content: () =>
        joinSections(state, ["testing", "acceptance_criteria"]) ||
        "_No testing section._",
    },
    {
      path: `${base}/06-deployment.md`,
      content: () =>
        joinSections(state, ["deployment", "timeline", "risks"]) ||
        "_No deployment section._",
    },
    {
      path: `${base}/07-jira-tickets.md`,
      content: () => jiraContent(state) || "_No JIRA tickets generated._",
    },
    {
      path: `${base}/08-source-code.md`,
      content: () =>
        joinSections(state, ["source_code"]) ||
        "_Source code section not generated in this run._",
    },
    {
      path: `${base}/09-test-code.md`,
      content: () =>
        joinSections(state, ["test_code"]) ||
        "_Test code section not generated in this run._",
    },
  ];
}

export const handleFileExport: StepHandler = ({ state, result }) => {
  let nextState: PipelineState = state;

  // Host-protocol invariant: each `write_file` action expects a `file_written`
  // result. Other result kinds are protocol violations — log to errors and
  // re-issue the current write instead of silently advancing.
  if (result && result.kind !== "file_written") {
    nextState = appendError(
      state,
      `[file_export] unexpected result kind '${result.kind}'; re-issuing write`,
      "structural", // protocol violation — handler bug, not a section validator failure
    );
  }

  // Record a successful write.
  if (result?.kind === "file_written") {
    if (!state.written_files.includes(result.path)) {
      nextState = {
        ...state,
        written_files: [...state.written_files, result.path],
      };
    }
  }

  const files = buildFileSet(nextState);
  const done = new Set(nextState.written_files);
  const remaining = files.filter((f) => !done.has(f.path));

  if (remaining.length === 0) {
    return {
      state: { ...nextState, current_step: "self_check" },
      action: {
        kind: "emit_message",
        message: `All ${files.length} files written. Running self-check.`,
      },
    };
  }

  const next = remaining[0];
  return {
    state: nextState,
    action: {
      kind: "write_file",
      path: next.path,
      content: next.content(),
    },
  };
};
