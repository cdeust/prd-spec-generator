/**
 * `implementation` — the engineer spawn (design-phases-3-5.md §3, PR 4a).
 *
 * One `spawn_subagents` (purpose "implement" — additive enum value, see
 * actions.ts SpawnSubagentsActionSchema), `subagent_type: "engineer"`,
 * `isolation: "worktree"` (the schema's own documented, previously-
 * unexercised value — subagent-client.ts:59 PendingFreeformInvocation).
 * The engineer creates its own worktree/branch per worktree-protocol.md,
 * exactly as this session's own contract.
 *
 * `pre_impl_grounding` always transitions here once its (optional) blast-
 * radius loop settles — grounding is best-effort context for the engineer's
 * prompt, not a gate on reaching implementation.
 *
 * Report contract: the prompt (buildImplementationPrompt,
 * @prd-gen/meta-prompting) instructs the engineer to end its response with a
 * machine-readable `BRANCH:`/`WORKTREE:`/`SHA:`/`FILES:` footer. This
 * handler owns BOTH sides of that contract (prompt + parser), so a strict
 * regex parse over the footer is a reasonable ask of a prose-reporting
 * subagent rather than a fragile inference over free text. The SHA is
 * requested for audit purposes and is preserved verbatim inside the (bounded)
 * `raw_report`; `PostSpecsStateSchema.implementation` (design §2.1) has no
 * dedicated `sha` field, so it is not extracted into a separate typed field —
 * extending that already-shipped schema is out of scope for this PR.
 *
 * Failure policy (design §4, "implementation" row): a subagent error/empty
 * response, or a response that does not carry a parsable BRANCH:/WORKTREE:
 * footer, ABORTS straight to `finalize` (structural/upstream_failure) —
 * nothing to verify without code, so there is nothing left for
 * `post_impl_verification` to do.
 *
 * Loop-guard placement (Phase 2 git-historian lesson, restated in
 * pre-impl-grounding.ts / post-impl-verification.ts / design §3):
 * result-processing for the current batch is evaluated FIRST, before the
 * "already recorded" idempotency guard — a replayed subagent_batch_result is
 * never dropped, and a replay after `post_specs.implementation` is already
 * set never re-spawns the engineer.
 *
 * source: design-phases-3-5.md §3, §4, §5 PR 4a.
 */

import type { HandlerAction } from "../types/actions.js";
import type { StepHandler } from "../runner.js";
import { appendError, type PipelineState } from "../types/state.js";
import {
  initialPostSpecs,
  type ImplementationState,
  type PostSpecsState,
} from "../types/state/post-specs-state.js";
import { buildImplementationPrompt } from "@prd-gen/meta-prompting";
import { IMPLEMENTATION_INV_ID } from "./protocol-ids.js";

/** Single-invocation batch — mirrors GIT_HISTORY_INV_ID's convention (see protocol-ids.ts). */
export const IMPLEMENTATION_BATCH_ID = IMPLEMENTATION_INV_ID;

type HandlerStep = { state: PipelineState; action: HandlerAction };

function ensurePostSpecs(state: PipelineState): PostSpecsState {
  return state.post_specs ?? initialPostSpecs();
}

/**
 * Defensive char cap for the stored raw_report, mirroring
 * input-analysis/git-history.ts's GIT_HISTORY_TRUNCATE_CHARS derivation
 * basis (chars/token ≈ 4, per cortex-recall-summary.ts's RECALL_RESULT_
 * TRUNCATE_CHARS). The prompt requests a "few sentences" summary (≈100
 * words ⇒ ≈75 tokens ⇒ ≈300 chars) plus a BRANCH/WORKTREE/SHA footer (≈150
 * chars) plus up to ~50 FILES: bullet lines (≈60 chars each ⇒ ≈3,000 chars)
 * ⇒ ≈3,450 chars; rounded up to 4,000 for headroom.
 * source: same derivation basis as git-history.ts:GIT_HISTORY_TRUNCATE_CHARS.
 */
const RAW_REPORT_TRUNCATE_CHARS = 4_000;
const RAW_REPORT_TRUNCATION_MARKER = "...";

function truncateRawReport(text: string): string {
  return text.length > RAW_REPORT_TRUNCATE_CHARS
    ? text.slice(0, RAW_REPORT_TRUNCATE_CHARS) + RAW_REPORT_TRUNCATION_MARKER
    : text;
}

/**
 * precondition:  none.
 * postcondition: a compact per-symbol blast-radius line for each
 *                pre_impl_grounding result, or "" when no grounding was
 *                collected. Tolerates the opaque get_impact payload shape
 *                (z.record passthrough) the same way
 *                post-impl-verification.ts's extractChangedSymbols does —
 *                missing/malformed array fields count as zero rather than
 *                throwing.
 */
function summarizeBlastRadius(postSpecs: PostSpecsState): string {
  const results = postSpecs.impact_queries.results;
  if (results.length === 0) return "";

  function arrayLen(data: Record<string, unknown> | undefined, key: string): number {
    const value = data?.[key];
    return Array.isArray(value) ? value.length : 0;
  }

  return results
    .map((r) => {
      if (!r.success) {
        return `- ${r.qualified_name}: grounding failed (${r.error ?? "unknown"})`;
      }
      const data = r.data;
      return (
        `- ${r.qualified_name}: ${arrayLen(data, "callers")} caller(s), ` +
        `${arrayLen(data, "importers")} importer(s), ${arrayLen(data, "users")} user(s), ` +
        `${arrayLen(data, "implementors")} implementor(s)`
      );
    })
    .join("\n");
}

const BRANCH_FOOTER_RE = /^\s*BRANCH:\s*(\S+)\s*$/im;
const WORKTREE_FOOTER_RE = /^\s*WORKTREE:\s*(\S+)\s*$/im;
const FILES_HEADER_RE = /^\s*FILES:\s*$/im;
const FILE_BULLET_RE = /^-\s+(\S.*)$/;

interface ParsedImplementationReport {
  readonly branch: string;
  readonly worktree_path: string;
  readonly changed_files: string[];
}

/**
 * precondition:  none — safe on any string.
 * postcondition: returns the parsed {branch, worktree_path, changed_files}
 *                iff BOTH a BRANCH: and a WORKTREE: footer line are present
 *                with a non-empty value; null otherwise (caller treats null
 *                as an unparsable report — design §4's "rapport sans
 *                worktree/branche → abort"). FILES: is optional — its
 *                absence yields an empty changed_files list, not a parse
 *                failure, since BRANCH/WORKTREE are the only fields this
 *                handler's precondition (a code location to verify) needs.
 */
function parseImplementationReport(rawText: string): ParsedImplementationReport | null {
  const branchMatch = BRANCH_FOOTER_RE.exec(rawText);
  const worktreeMatch = WORKTREE_FOOTER_RE.exec(rawText);
  if (!branchMatch?.[1] || !worktreeMatch?.[1]) return null;

  const changed_files: string[] = [];
  const filesHeaderMatch = FILES_HEADER_RE.exec(rawText);
  if (filesHeaderMatch) {
    const afterHeaderStart = filesHeaderMatch.index + filesHeaderMatch[0].length;
    const body = rawText.slice(afterHeaderStart).split("\n");
    for (const line of body) {
      if (line.trim() === "") continue;
      const bulletMatch = FILE_BULLET_RE.exec(line);
      if (!bulletMatch) break; // end of the FILES: block
      changed_files.push(bulletMatch[1].trim());
    }
  }

  return {
    branch: branchMatch[1],
    worktree_path: worktreeMatch[1],
    changed_files,
  };
}

function emitImplementationSpawn(
  state: PipelineState,
  postSpecs: PostSpecsState,
): HandlerStep {
  return {
    state: { ...state, post_specs: postSpecs },
    action: {
      kind: "spawn_subagents",
      purpose: "implement",
      batch_id: IMPLEMENTATION_BATCH_ID,
      invocations: [
        {
          invocation_id: IMPLEMENTATION_INV_ID,
          subagent_type: "engineer",
          description: "Implement the validated PRD/specs",
          prompt: buildImplementationPrompt({
            feature_description: state.feature_description,
            codebase_path: state.codebase_path ?? "",
            spec_files: state.written_files,
            blast_radius_summary: summarizeBlastRadius(postSpecs),
            git_history_summary: state.git_history_summary ?? undefined,
          }),
          isolation: "worktree",
        },
      ],
    },
  };
}

function abortToFinalize(
  state: PipelineState,
  postSpecs: PostSpecsState,
  message: string,
  errorKind: "structural" | "upstream_failure",
): HandlerStep {
  return {
    state: appendError(
      { ...state, current_step: "finalize", post_specs: postSpecs },
      message,
      errorKind,
    ),
    action: { kind: "emit_message", message, level: "warn" },
  };
}

function processImplementationResult(
  state: PipelineState,
  postSpecs: PostSpecsState,
  result: Extract<
    import("../types/actions.js").ActionResult,
    { kind: "subagent_batch_result" }
  >,
): HandlerStep {
  const response = result.responses.find(
    (r) => r.invocation_id === IMPLEMENTATION_INV_ID,
  );
  if (!response || response.error || !response.raw_text?.trim()) {
    return abortToFinalize(
      state,
      postSpecs,
      `implementation subagent failed: ${response?.error ?? "no response"}; aborting — nothing to verify without code`,
      "upstream_failure",
    );
  }

  const parsed = parseImplementationReport(response.raw_text);
  if (!parsed) {
    return abortToFinalize(
      state,
      postSpecs,
      "implementation subagent report did not include a parsable BRANCH:/WORKTREE: footer; aborting — nothing to verify without code",
      "structural",
    );
  }

  const implementation: ImplementationState = {
    branch: parsed.branch,
    worktree_path: parsed.worktree_path,
    changed_files: parsed.changed_files,
    raw_report: truncateRawReport(response.raw_text.trim()),
  };

  return {
    state: {
      ...state,
      current_step: "post_impl_verification",
      post_specs: { ...postSpecs, implementation },
    },
    action: {
      kind: "emit_message",
      message: `Implementation complete: branch '${implementation.branch}' at ${implementation.worktree_path} (${implementation.changed_files.length} file(s) changed).`,
    },
  };
}

export const handleImplementation: StepHandler = ({ state, result }) => {
  const postSpecs = ensurePostSpecs(state);

  // Result-processing FIRST (Phase 2 git-historian loop-ordering lesson).
  if (result?.kind === "subagent_batch_result" && result.batch_id === IMPLEMENTATION_BATCH_ID) {
    return processImplementationResult(state, postSpecs, result);
  }

  // Idempotency guard AFTER result-processing (Phase 2 lesson): a replay
  // after implementation already recorded must not re-spawn the engineer.
  if (postSpecs.implementation) {
    return {
      state: {
        ...state,
        current_step: "post_impl_verification",
        post_specs: postSpecs,
      },
      action: {
        kind: "emit_message",
        message: "Implementation already recorded; proceeding to verification.",
      },
    };
  }

  return emitImplementationSpawn(state, postSpecs);
};
