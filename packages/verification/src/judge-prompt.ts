/**
 * Judge prompt construction.
 *
 * Builds a structured, deterministic prompt for a verification judge (genius
 * agent or team agent). The judge MUST return a single JSON object matching
 * `JudgeVerdict` — we parse it; we don't free-form synthesize.
 *
 * Lives in `@prd-gen/verification` because it is a use-case-layer concern:
 * the verification module owns the judge orchestration domain, including
 * how a judge is briefed. The infrastructure layer (ecosystem-adapters)
 * needs only to dispatch the resulting `subagent_type + prompt` to the
 * host's Agent tool.
 *
 * Origin: previously lived in `@prd-gen/ecosystem-adapters/clients/judge-prompt.ts`.
 * Moved here to fix the §2.2 layer violation surfaced by the Phase 3+4
 * cross-audit (code-reviewer H1).
 *
 * Source for verdict taxonomy: SKILL.md Rule 15 → core/domain/verdict.ts.
 *
 * source: cross-audit code-reviewer H1 (Phase 3+4, 2026-04).
 */

import { type JudgeRequest, agentSubagentType } from "@prd-gen/core";

export interface BuiltJudgePrompt {
  readonly description: string;
  readonly subagent_type: string;
  readonly prompt: string;
}

const VERDICT_TAXONOMY = `
| Verdict | Meaning | When to use |
|---------|---------|-------------|
| PASS | Claim is structurally complete AND verifiable from the document | FR traceability, AC completeness, SP arithmetic, structural checks |
| SPEC-COMPLETE | A test or measurement method is specified, but runtime data is needed to confirm | NFR performance targets (latency, fps, throughput), scalability limits |
| NEEDS-RUNTIME | Claim cannot be verified at design time at all | Load test results, p95 latency under prod traffic, real-world storage usage |
| INCONCLUSIVE | Claim depends on an unresolved open question or external factor | Claims referencing OQ-XXX, vendor SLA, regulatory interpretation |
| FAIL | Claim is structurally invalid or contradicts other claims | Arithmetic errors, orphan references, circular dependencies |

NFR claims about latency, fps, throughput, or storage MUST NOT receive PASS.
They receive SPEC-COMPLETE (if a test method is specified) or NEEDS-RUNTIME.
`.trim();

const RESPONSE_SCHEMA = `
{
  "verdict": "PASS" | "SPEC-COMPLETE" | "NEEDS-RUNTIME" | "INCONCLUSIVE" | "FAIL",
  "rationale": "<one paragraph: why you reached this verdict>",
  "caveats": ["<short caveat>", "..."],
  "confidence": <number in [0, 1]>
}
`.trim();

export function buildJudgePrompt(req: JudgeRequest): BuiltJudgePrompt {
  const { judge, claim, context } = req;
  const judgeDescription =
    judge.kind === "genius"
      ? `Apply the ${judge.name} reasoning pattern to evaluate the claim.`
      : `Apply your ${judge.name} role expertise to evaluate the claim.`;

  const prdExcerpt = context.prd_excerpt
    ? `<prd_excerpt>\n${context.prd_excerpt}\n</prd_excerpt>\n\n`
    : "";

  const codebaseSection = context.codebase_excerpts.length
    ? `<codebase_context>\n${context.codebase_excerpts.join("\n---\n")}\n</codebase_context>\n\n`
    : "";

  const memorySection = context.memory_excerpts.length
    ? `<memory_context>\n${context.memory_excerpts.join("\n---\n")}\n</memory_context>\n\n`
    : "";

  const prompt = [
    `You are acting as a verification judge for a PRD.`,
    judgeDescription,
    "",
    `<claim>`,
    `id: ${claim.claim_id}`,
    `type: ${claim.claim_type}`,
    `source_section: ${claim.source_section ?? "(unspecified)"}`,
    `text: ${claim.text}`,
    `</claim>`,
    "",
    `<evidence>`,
    claim.evidence,
    `</evidence>`,
    "",
    prdExcerpt + codebaseSection + memorySection,
    `<verdict_taxonomy>`,
    VERDICT_TAXONOMY,
    `</verdict_taxonomy>`,
    "",
    `Return EXACTLY ONE JSON object matching this schema and nothing else (no prose before or after, no markdown fences):`,
    "",
    RESPONSE_SCHEMA,
    "",
    `Constraints:`,
    `- Do NOT default to PASS. If you would assign PASS to every claim of this type, you are not doing your job.`,
    `- NFR claims (latency, throughput, fps, storage) MUST NOT receive PASS. Use SPEC-COMPLETE or NEEDS-RUNTIME.`,
    `- "rationale" must be specific to THIS claim, not a generic rubric.`,
    `- "confidence" reflects how sure you are about the verdict, not how confident you are about the claim.`,
  ].join("\n");

  return {
    description: `Judge ${claim.claim_id} (${judge.kind}:${judge.name})`,
    subagent_type: agentSubagentType(judge),
    prompt,
  };
}
