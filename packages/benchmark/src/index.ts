/**
 * Benchmark infrastructure for measuring PRD generation quality.
 *
 * Two surfaces:
 *   - runner.ts: static document quality (HOR pass rate, cross-ref integrity)
 *     against golden fixtures. Quality gate: HOR pass rate >= 80%, zero critical.
 *   - pipeline-kpis.ts: dynamic pipeline-execution KPIs (iteration count,
 *     wall time, judge dispatch, distribution suspicion, error count).
 */
export {
  runBenchmark,
  type BenchmarkScenario,
  type BenchmarkResult,
  type BenchmarkSummary,
} from "./runner.js";

export {
  measurePipeline,
  evaluateGates,
  KPI_GATES,
  type PipelineKpiInput,
  type PipelineKpis,
  type KpiGateReport,
} from "./pipeline-kpis.js";
export {
  extractMismatchEvents,
  tallyByKind,
  MISMATCH_KINDS,
  MISMATCH_DIAGNOSTIC_PREFIX,
  type MismatchKind,
  type MismatchEvent,
  type MismatchExtraction,
} from "./instrumentation.js";

// Phase 4.1 / Wave D2 — ConsensusReliabilityProvider adapter.
// Lives in src/ so it is included in the compiled benchmark package.
// The calibration/ copy (consensus-reliability-adapter.ts) is used only
// by calibration/__tests__/ which run via vitest without tsc compilation.
export { BenchmarkConsensusReliabilityProvider } from "./consensus-reliability-adapter.js";

// Phase 4.1 / Wave D2 — Observation audit log helpers.
// Re-exported here for the composition root's observation flush hook.
// source: calibration-seams.ts (via heldout-seals.ts).
export {
  appendObservationLog,
  JUDGE_OBSERVATION_LOG_PATH,
  type JudgeObservationLogEntry,
} from "../calibration/heldout-seals.js";

// Phase 4.5 / Wave D3 — calibrated gates loader.
export {
  loadCalibratedGates,
  getActiveKpiGates,
  CALIBRATED_GATES_DEFAULT_PATH,
} from "./calibrated-gates-loader.js";
