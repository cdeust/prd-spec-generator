// Strategy engine -- research evidence, claim analysis, selection, effectiveness tracking

export {
  ResearchEvidenceDatabase,
  type ResearchEvidence,
} from "./research-evidence-database.js";

export {
  selectStrategy,
  type StrategyAssignment,
  type SelectorOptions,
} from "./selector.js";

export {
  analyzeClaim,
  type ClaimAnalysisResult,
} from "./claim-analyzer.js";

export {
  EffectivenessTracker,
  type ExecutionResult,
  type EffectivenessReport,
} from "./effectiveness-tracker.js";
