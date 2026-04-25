/**
 * Re-export shim for backward compatibility.
 *
 * The agent / judge / claim domain types previously lived here. They now
 * live in `@prd-gen/core/domain/agent` (Phase 3+4 cross-audit closure,
 * code-reviewer H1 — fixing the §2.2 layer violation that put pure
 * domain types in the infrastructure package).
 *
 * This file remains so external consumers (the live MCP integration
 * test, downstream packages, etc.) keep working while imports migrate.
 * NEW code MUST import from `@prd-gen/core` directly. This shim will
 * be deleted once no internal package imports from here.
 *
 * source: cross-audit code-reviewer H1 (Phase 3+4, 2026-04).
 */

export {
  GeniusAgentSchema,
  TeamAgentSchema,
  AgentIdentitySchema,
  agentSubagentType,
  ClaimSchema,
  JudgeVerdictSchema,
  JudgeRequestSchema,
  SubagentInvocationSchema,
  SubagentResponseSchema,
  type GeniusAgent,
  type TeamAgent,
  type AgentIdentity,
  type Claim,
  type JudgeVerdict,
  type JudgeRequest,
  type SubagentInvocation,
  type SubagentResponse,
} from "@prd-gen/core";
