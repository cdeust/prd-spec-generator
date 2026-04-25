/**
 * Subagent client.
 *
 * The Agent tool is a Claude Code HOST primitive — it cannot be invoked via
 * MCP from a child process. Therefore the client does NOT execute subagents
 * itself. Instead it produces structured invocation requests that the host
 * (Claude Code session, or a future direct-API runner) executes.
 *
 * Two implementations are provided:
 *
 *   - `HostQueueSubagentClient`: returns invocations as pending work; the host
 *     drains the queue, runs each agent via the Agent tool, and feeds results
 *     back via `submitResponse`.
 *
 *   - `MockSubagentClient`: deterministic responses for tests.
 *
 * Multi-judge verification: callers ask `enqueueJudgeRequests(requests)`,
 * receive a batch ID, then later collect `JudgeVerdict[]` once the host has
 * fed responses back. This decouples orchestration from execution and lets
 * the host issue all judge calls in parallel.
 */

// Direct import from @prd-gen/core (canonical home for these domain types
// since the layer-violation fix). Pre-fix, this file imported through the
// back-compat shim at "../contracts/subagent.js"; that shim is now unused
// internally (cross-audit dijkstra H2, Phase 3+4 follow-up, 2026-04).
import {
  type JudgeRequest,
  type JudgeVerdict,
  type SubagentInvocation,
  type SubagentResponse,
  JudgeVerdictSchema,
  ClaimSchema,
  VerdictSchema,
  extractJsonObject,
} from "@prd-gen/core";
import { buildJudgePrompt } from "@prd-gen/verification";
import { z } from "zod";

// ─── Pending invocation envelope ────────────────────────────────────────────

export interface PendingJudgeInvocation {
  readonly invocation_id: string;
  readonly batch_id: string;
  readonly claim_id: string;
  readonly subagent_type: string;
  readonly description: string;
  readonly prompt: string;
  readonly expected: "judge_verdict";
  readonly judge: JudgeRequest["judge"];
}

export interface PendingFreeformInvocation {
  readonly invocation_id: string;
  readonly subagent_type: string;
  readonly description: string;
  readonly prompt: string;
  readonly expected: "freeform" | "json" | "markdown";
  readonly isolation: "worktree" | "none";
}

export type PendingInvocation =
  | PendingJudgeInvocation
  | PendingFreeformInvocation;

// ─── Public interface ───────────────────────────────────────────────────────

export interface SubagentClient {
  /** Enqueue judge requests; returns a batch id used to collect results. */
  enqueueJudgeRequests(requests: readonly JudgeRequest[]): {
    batch_id: string;
    pending: readonly PendingJudgeInvocation[];
  };

  /** Enqueue a freeform subagent task. */
  enqueueInvocation(invocation: SubagentInvocation): PendingFreeformInvocation;

  /** Host calls this with a raw text response from the Agent tool. */
  submitResponse(invocationId: string, rawText: string): void;

  /** Host calls this to mark an invocation as failed. */
  submitError(invocationId: string, error: string): void;

  /** Returns true once every invocation in the batch has a response or error. */
  isBatchComplete(batchId: string): boolean;

  /** Drains a complete batch of judge verdicts. Throws if not complete. */
  collectJudgeVerdicts(batchId: string): readonly JudgeVerdict[];

  /** Returns the freeform response (or throws if not yet submitted). */
  collectFreeformResponse(invocationId: string): SubagentResponse;
}

// ─── Implementation: in-memory host queue ───────────────────────────────────

interface JudgeSlot {
  pending: PendingJudgeInvocation;
  rawText?: string;
  error?: string;
  parsed?: JudgeVerdict;
}

interface FreeformSlot {
  pending: PendingFreeformInvocation;
  rawText?: string;
  error?: string;
}

export class HostQueueSubagentClient implements SubagentClient {
  private nextId = 0;
  private readonly judgeSlots = new Map<string, JudgeSlot>();
  private readonly freeformSlots = new Map<string, FreeformSlot>();
  private readonly batches = new Map<string, Set<string>>();

  enqueueJudgeRequests(requests: readonly JudgeRequest[]): {
    batch_id: string;
    pending: readonly PendingJudgeInvocation[];
  } {
    const batchId = this.makeId("batch");
    const pending: PendingJudgeInvocation[] = [];
    const ids = new Set<string>();

    for (const req of requests) {
      const validatedClaim = ClaimSchema.parse(req.claim);
      const built = buildJudgePrompt({ ...req, claim: validatedClaim });
      const invocationId = this.makeId("judge");
      const inv: PendingJudgeInvocation = {
        invocation_id: invocationId,
        batch_id: batchId,
        claim_id: validatedClaim.claim_id,
        subagent_type: built.subagent_type,
        description: built.description,
        prompt: built.prompt,
        expected: "judge_verdict",
        judge: req.judge,
      };
      this.judgeSlots.set(invocationId, { pending: inv });
      ids.add(invocationId);
      pending.push(inv);
    }

    this.batches.set(batchId, ids);
    return { batch_id: batchId, pending };
  }

  enqueueInvocation(invocation: SubagentInvocation): PendingFreeformInvocation {
    const invocationId = this.makeId("free");
    const subagentType =
      invocation.agent.kind === "genius"
        ? `zetetic-team-subagents:genius:${invocation.agent.name}`
        : `zetetic-team-subagents:${invocation.agent.name}`;

    const pending: PendingFreeformInvocation = {
      invocation_id: invocationId,
      subagent_type: subagentType,
      description: invocation.task_description,
      prompt: invocation.prompt,
      expected: invocation.expected_format,
      isolation: invocation.isolation,
    };
    this.freeformSlots.set(invocationId, { pending });
    return pending;
  }

  submitResponse(invocationId: string, rawText: string): void {
    const judgeSlot = this.judgeSlots.get(invocationId);
    if (judgeSlot) {
      judgeSlot.rawText = rawText;
      try {
        judgeSlot.parsed = parseJudgeVerdict(judgeSlot.pending, rawText);
      } catch (err) {
        judgeSlot.error = `parse_error: ${(err as Error).message}`;
      }
      return;
    }
    const free = this.freeformSlots.get(invocationId);
    if (free) {
      free.rawText = rawText;
      return;
    }
    throw new Error(`Unknown invocation id: ${invocationId}`);
  }

  submitError(invocationId: string, error: string): void {
    const judgeSlot = this.judgeSlots.get(invocationId);
    if (judgeSlot) {
      judgeSlot.error = error;
      return;
    }
    const free = this.freeformSlots.get(invocationId);
    if (free) {
      free.error = error;
      return;
    }
    throw new Error(`Unknown invocation id: ${invocationId}`);
  }

  isBatchComplete(batchId: string): boolean {
    const ids = this.batches.get(batchId);
    if (!ids) throw new Error(`Unknown batch id: ${batchId}`);
    for (const id of ids) {
      const slot = this.judgeSlots.get(id);
      if (!slot) throw new Error(`Batch ${batchId} references unknown id ${id}`);
      const hasResult = slot.parsed !== undefined || slot.error !== undefined;
      if (!hasResult) return false;
    }
    return true;
  }

  collectJudgeVerdicts(batchId: string): readonly JudgeVerdict[] {
    const ids = this.batches.get(batchId);
    if (!ids) throw new Error(`Unknown batch id: ${batchId}`);
    if (!this.isBatchComplete(batchId)) {
      throw new Error(`Batch ${batchId} is not complete`);
    }

    const verdicts: JudgeVerdict[] = [];
    for (const id of ids) {
      const slot = this.judgeSlots.get(id)!;
      if (slot.parsed) {
        verdicts.push(slot.parsed);
      } else if (slot.error) {
        // Encode the error as an INCONCLUSIVE verdict so consensus math has a
        // value to work with. Confidence 0 marks it as zero-weight.
        verdicts.push({
          judge: slot.pending.judge,
          claim_id: slot.pending.claim_id,
          verdict: "INCONCLUSIVE",
          rationale: `Judge failed to respond: ${slot.error}`,
          caveats: ["judge_invocation_failed"],
          confidence: 0,
        });
      }
    }
    return verdicts;
  }

  collectFreeformResponse(invocationId: string): SubagentResponse {
    const slot = this.freeformSlots.get(invocationId);
    if (!slot) throw new Error(`Unknown invocation id: ${invocationId}`);
    if (slot.error)
      throw new Error(`Invocation ${invocationId} failed: ${slot.error}`);
    if (slot.rawText === undefined)
      throw new Error(`Invocation ${invocationId} has no response yet`);

    return {
      agent: subagentTypeToIdentity(slot.pending.subagent_type),
      text: slot.rawText,
    };
  }

  private makeId(prefix: string): string {
    this.nextId += 1;
    return `${prefix}_${this.nextId.toString(36)}_${Date.now().toString(36)}`;
  }
}

// ─── Verdict parsing ────────────────────────────────────────────────────────

const RawVerdictSchema = z.object({
  verdict: VerdictSchema,
  rationale: z.string(),
  caveats: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

function parseJudgeVerdict(
  pending: PendingJudgeInvocation,
  rawText: string,
): JudgeVerdict {
  const json = extractJsonObject(rawText);
  const parsed = RawVerdictSchema.parse(json);
  return JudgeVerdictSchema.parse({
    judge: pending.judge,
    claim_id: pending.claim_id,
    verdict: parsed.verdict,
    rationale: parsed.rationale,
    caveats: parsed.caveats,
    confidence: parsed.confidence,
  });
}

// extractJsonObject moved to @prd-gen/core/utils/json-extract (Phase 3+4
// cross-audit, code-reviewer H1). Imported above.

function subagentTypeToIdentity(
  subagentType: string,
): SubagentResponse["agent"] {
  // "zetetic-team-subagents:genius:liskov" → genius/liskov
  // "zetetic-team-subagents:engineer"      → team/engineer
  const parts = subagentType.split(":");
  if (parts.length === 3 && parts[1] === "genius") {
    return { kind: "genius", name: parts[2] as never };
  }
  if (parts.length === 2) {
    return { kind: "team", name: parts[1] as never };
  }
  throw new Error(`Unparseable subagent_type: ${subagentType}`);
}
