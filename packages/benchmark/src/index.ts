/**
 * Benchmark infrastructure for measuring PRD generation quality.
 * Runs golden fixtures through the validation engine and reports metrics.
 *
 * Quality gate: HOR pass rate must be >= 80% with zero critical violations.
 */
export {
  runBenchmark,
  type BenchmarkScenario,
  type BenchmarkResult,
  type BenchmarkSummary,
} from "./runner.js";
