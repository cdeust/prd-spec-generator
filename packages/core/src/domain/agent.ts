/**
 * Domain types for genius reasoning patterns and zetetic team subagents.
 *
 * These are pure domain entities — they describe WHAT a judge / claim /
 * verdict IS, independent of HOW they are spawned (Agent tool, MCP, etc.).
 *
 * Origin: previously lived in `@prd-gen/ecosystem-adapters/contracts/subagent.ts`,
 * which placed pure domain types in the infrastructure layer. The Phase 3+4
 * cross-audit (code-reviewer H1) flagged this as a §2.2 layer violation:
 * use-case packages (verification, orchestration) had to import from
 * infrastructure (ecosystem-adapters) to access these contracts. Moving
 * them to core inverts the dependency correctly per Clean Architecture
 * Ch. 22 (Martin 2017): infrastructure depends on core, never the reverse.
 *
 * source: cross-audit code-reviewer H1 (Phase 3+4, 2026-04).
 */

import { z } from "zod";
import { VerdictSchema } from "./verdict.js";

// ─── Agent identity ─────────────────────────────────────────────────────────

/**
 * Genius agent IDs — must match the `subagent_type` accepted by the Agent tool.
 *
 * source: zetetic-team-subagents/agents/genius/*.md (one entry per file).
 * The list is the canonical inventory of reasoning-pattern agents available
 * to the judge panel; adding a new pattern requires updating both the agent
 * file in zetetic-team-subagents AND this enum, in lockstep.
 */
export const GeniusAgentSchema = z.enum([
  "alexander", "alkhwarizmi", "altshuller", "archimedes", "arendt",
  "aristotle", "bateson", "beer", "borges", "boyd", "braudel", "bruner",
  "carnot", "champollion", "coase", "cochrane", "curie", "darwin",
  "deming", "dijkstra", "eco", "einstein", "ekman", "engelbart", "erdos",
  "erlang", "euler", "feinstein", "fermi", "feynman", "fisher", "fleming",
  "foucault", "gadamer", "galileo", "geertz", "ginzburg", "godel",
  "hamilton", "hart", "hopper", "ibnalhaytham", "ibnkhaldun", "jobs",
  "kahneman", "kauffman", "kay", "kekule", "knuth", "lamport", "laplace",
  "lavoisier", "leguin", "lem", "liskov", "mandelbrot", "margulis",
  "maxwell", "mcclintock", "meadows", "mendeleev", "midgley", "mill",
  "nagarjuna", "noether", "ostrom", "panini", "pearl", "peirce",
  "poincare", "polya", "popper", "propp", "ramanujan", "ranganathan",
  "rawls", "rejewski", "rogerfisher", "rogers", "schelling", "schon",
  "semmelweis", "shannon", "simon", "snow", "strauss", "taleb",
  "thompson", "toulmin", "turing", "varela", "ventris", "vonneumann",
  "vygotsky", "wittgenstein", "wu", "zhuangzi",
]);
export type GeniusAgent = z.infer<typeof GeniusAgentSchema>;

/**
 * Zetetic team agent IDs — must match the `subagent_type` accepted by the Agent tool.
 *
 * source: zetetic-team-subagents/agents/*.md (top-level, excluding /genius).
 */
export const TeamAgentSchema = z.enum([
  "architect",
  "code-reviewer",
  "data-scientist",
  "dba",
  "devops-engineer",
  "engineer",
  "experiment-runner",
  "frontend-engineer",
  "latex-engineer",
  "mlops",
  "orchestrator",
  "paper-writer",
  "professor",
  "refactorer",
  "research-scientist",
  "reviewer-academic",
  "security-auditor",
  "test-engineer",
  "ux-designer",
]);
export type TeamAgent = z.infer<typeof TeamAgentSchema>;

export const AgentIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("genius"), name: GeniusAgentSchema }),
  z.object({ kind: z.literal("team"), name: TeamAgentSchema }),
]);
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

/**
 * Map an AgentIdentity to the host's `subagent_type` string.
 *
 * Pure function — no I/O. Lives in core because the mapping is part of the
 * domain contract: a judge identity has a canonical host-tool type. The
 * specific prefix (`zetetic-team-subagents:`) is a convention from the
 * upstream agent registry; if that registry renames, this function changes
 * in lockstep.
 */
export function agentSubagentType(identity: AgentIdentity): string {
  return identity.kind === "genius"
    ? `zetetic-team-subagents:genius:${identity.name}`
    : `zetetic-team-subagents:${identity.name}`;
}

// ─── Verification judge contract ────────────────────────────────────────────

/**
 * A claim extracted from a PRD section, sent to a judge for evaluation.
 * Claims are atomic — one assertion per claim — so judges can return one verdict.
 */
export const ClaimSchema = z.object({
  claim_id: z.string().describe("Stable ID, e.g., FR-001, AC-005, NFR-LATENCY"),
  claim_type: z.enum([
    "architecture",
    "performance",
    "correctness",
    "security",
    "data_model",
    "test_coverage",
    "story_point_arithmetic",
    "fr_traceability",
    "risk",
    "acceptance_criteria_completeness",
    "cross_file_consistency",
  ]),
  text: z.string().describe("The claim being verified, in plain language"),
  evidence: z.string().describe("Section content / surrounding context"),
  source_section: z.string().optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const JudgeVerdictSchema = z.object({
  judge: AgentIdentitySchema,
  claim_id: z.string(),
  verdict: VerdictSchema,
  rationale: z.string(),
  caveats: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export const JudgeRequestSchema = z.object({
  judge: AgentIdentitySchema,
  claim: ClaimSchema,
  context: z
    .object({
      prd_excerpt: z.string().optional(),
      codebase_excerpts: z.array(z.string()).default([]),
      memory_excerpts: z.array(z.string()).default([]),
    })
    .default({ prd_excerpt: undefined, codebase_excerpts: [], memory_excerpts: [] }),
});
export type JudgeRequest = z.infer<typeof JudgeRequestSchema>;

// ─── Subagent invocation (general — beyond verification) ────────────────────

/**
 * For non-verification uses: e.g., asking the engineer to draft a section,
 * or the dba to design a schema. Free-form text response.
 */
export const SubagentInvocationSchema = z.object({
  agent: AgentIdentitySchema,
  task_description: z.string().describe("Short title for the task"),
  prompt: z.string().describe("Full self-contained prompt — agent has no prior context"),
  expected_format: z.enum(["freeform", "json", "markdown"]).default("freeform"),
  isolation: z.enum(["worktree", "none"]).default("none"),
});
export type SubagentInvocation = z.infer<typeof SubagentInvocationSchema>;

export const SubagentResponseSchema = z.object({
  agent: AgentIdentitySchema,
  text: z.string(),
  duration_ms: z.number().int().nonnegative().optional(),
});
export type SubagentResponse = z.infer<typeof SubagentResponseSchema>;
