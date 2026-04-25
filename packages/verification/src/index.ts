// Judge selection
export {
  PANELS,
  selectJudges,
  getPanel,
  type JudgePanel,
} from "./judge-selector.js";

// Claim extraction
export {
  extractClaims,
  extractClaimsFromDocument,
} from "./claim-extractor.js";

// Consensus
export {
  consensus,
  agentKey,
  type ConsensusVerdict,
  type ConsensusStrategy,
  type ConsensusConfig,
} from "./consensus.js";

// Orchestrator
export {
  planSectionVerification,
  planDocumentVerification,
  concludeSection,
  concludeDocument,
  type VerificationPlan,
  type VerificationReport,
  type PlanOptions,
} from "./orchestrator.js";

// Judge prompt construction
export {
  buildJudgePrompt,
  type BuiltJudgePrompt,
} from "./judge-prompt.js";
