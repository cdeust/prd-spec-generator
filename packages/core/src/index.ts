// Domain types
export {
  PRDContextSchema,
  PRD_CONTEXT_DEFAULT,
  PRD_CONTEXT_CONFIGS,
  type PRDContext,
  type PRDContextConfig,
} from "./domain/prd-context.js";

export {
  SectionTypeSchema,
  SECTION_DISPLAY_NAMES,
  SECTION_ORDER,
  type SectionType,
} from "./domain/section-type.js";

export {
  HardOutputRuleSchema,
  isCriticalRule,
  scorePenalty,
  isDeterministicRule,
  type HardOutputRule,
} from "./domain/hard-output-rule.js";

export {
  ThinkingStrategySchema,
  STRATEGY_TIERS,
  getStrategyTier,
  type ThinkingStrategy,
  type StrategyTier,
} from "./domain/thinking-strategy.js";

export {
  ClarificationAnswerSchema,
  ClarificationStateSchema,
  getAnswersByPriority,
  type ClarificationAnswer,
  type ClarificationState,
} from "./domain/clarification.js";

export {
  VerdictSchema,
  EXPECTED_VERDICT_DISTRIBUTION,
  isDistributionSuspicious,
  type Verdict,
} from "./domain/verdict.js";

export {
  LicenseTierSchema,
  TIER_CAPABILITIES,
  type LicenseTier,
  type TierCapabilities,
} from "./domain/license-tier.js";

export {
  PRDSectionSchema,
  PRDDocumentSchema,
  type PRDSection,
  type PRDDocument,
} from "./domain/prd-document.js";

export {
  HardOutputRuleViolationSchema,
  ValidationReportSchema,
  CrossRefValidationResultSchema,
  type HardOutputRuleViolation,
  type ValidationReport,
  type CrossRefValidationResult,
} from "./domain/validation-result.js";

// Agent / judge domain
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
} from "./domain/agent.js";

// Utils
export { extractJsonObject } from "./utils/json-extract.js";

// Persistence
export {
  EvidenceRepository,
  tryCreateEvidenceRepository,
  type StrategyExecution,
  type PRDQualityScore,
  type AdaptiveThreshold,
  type StrategyPerformanceSummary,
} from "./persistence/evidence-repository.js";
