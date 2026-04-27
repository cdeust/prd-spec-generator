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
