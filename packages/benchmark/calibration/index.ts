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
