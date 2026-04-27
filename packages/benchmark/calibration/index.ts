/**
 * Calibration scripts (Phase 4 — pre-registered analysis only).
 *
 * Each script in this directory has a matching pre-registration block in
 * docs/PHASE_4_PLAN.md. Scripts are executed against committed JSONL data
 * under ./data/; the analysis is deterministic given a fixed dataset.
 */
export {
  analyze as analyzeMismatchFireRate,
  PRIMARY_K,
  PER_CONTEXT_FLOOR,
  XMR_BATCH_SIZE,
  XMR_BASELINE_BATCHES,
  FIRE_RATE_CEILING,
  PRE_REGISTERED_SEED,
  PRD_CONTEXT_DOMAIN,
  type CalibrationRun,
  type FireRateReport,
  type PerContextStats,
} from "./mismatch-fire-rate.js";

export {
  clopperPearson,
  betaiRegularized,
  type ClopperPearsonInterval,
} from "./clopper-pearson.js";

export {
  xmrAnalyze,
  computeLimits,
  scanSeries,
  type XmRLimits,
  type XmRReport,
  type XmRSignal,
} from "./xmr.js";

// Phase 4.2 — MAX_ATTEMPTS calibration math (Wave C1).
export {
  kmEstimate,
  kmMedianAttempts,
  logRankTest,
  schoenfeldRequiredEvents,
  type SurvivalEvent,
  type KmCurve,
  type KmMedian,
  type LogRankResult,
  type SchoenfeldInput,
  type SchoenfeldOutput,
} from "./kaplan-meier.js";

// Phase 4.2 — retry-ablation + closed-loop control-arm seams (Wave C1).
export {
  getRetryArmForRun,
  getMaxAttemptsForRun,
  MAX_ATTEMPTS_BASELINE,
  type RetryArm,
} from "./calibration-seams.js";

// Phase 4.5 — KPI gate tuning seams + machine-class detection (Wave C3).
export {
  detectMachineClass,
  getWallTimeMsGateForMachine,
  MACHINE_CLASSES,
  WALL_TIME_MS_GATE_BY_CLASS,
  WALL_TIME_MS_GATE_FALLBACK,
  GATE_BLOCKED_LOG_PATH,
  type MachineClass,
  type GateBlockedLogEntry,
} from "./machine-class.js";

export {
  appendGateBlockedEntry,
  getKpiGatesForRun,
} from "./gate-tuning-seams.js";

// Phase 4.1 / Wave D2 — ConsensusReliabilityProvider adapter.
// Layer: benchmark implements the port declared in @prd-gen/core.
// Consumed only by the composition root (@prd-gen/mcp-server).
export { BenchmarkConsensusReliabilityProvider } from "./consensus-reliability-adapter.js";
