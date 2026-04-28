/**
 * Phase 4.5 KPI-gate calibration runner — Wave D / D3.1.
 *
 * Drives K≥100 runs of `measurePipeline` against the frozen canned baseline
 * with the pre-registered RNG seed `0x4_05_C3` and emits:
 *
 *   1. `data/gate-calibration-K100.json`         — per-gate calibrated values.
 *   2. `data/gate-calibration-K100.xmr/<g>.json` — XmR record per gate.
 *   3. `data/event-rate-K50.json`                — §4.2 event_rate measurement.
 *
 * Invocation:
 *   pnpm --filter @prd-gen/benchmark run calibrate:gates
 *
 *
 * source: docs/PHASE_4_PLAN.md §4.5 Implementation gates.
 * source: D3.1 brief — Wave D K≥100 calibration runner.
 *
 * Layer contract (§2.2): script-only — top-level await, FS writes,
 * child_process for `git rev-parse`. Imports `measurePipeline` + `KPI_GATES`
 * from `../src/pipeline-kpis.js` (allowed: same package).
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import {
  measurePipeline,
  KPI_GATES,
  type PipelineKpis,
  type PipelineKpiInput,
} from "../src/pipeline-kpis.js";
import { clopperPearson } from "./clopper-pearson.js";
import { detectMachineClass, type MachineClass } from "./machine-class.js";
import { computeGateStats } from "./gate-stats.js";
import { measureEventRate } from "./event-rate.js";
import {
  writeGateCalibrationK100,
  writeEventRateK50,
  type GateCalibrationK100,
  type GateCalibrationEntry,
  type EventRateK50,
  type XmRRecord,
} from "./calibration-outputs.js";
import {
  computePipelineKpisContentHash,
  resolveFrozenBaselineCommit,
} from "./frozen-baseline.js";
import {
  PRE_REGISTERED_SEED_45,
  PRE_REGISTERED_SEED_42,
  DEFAULT_K,
  DEFAULT_EVENT_RATE_K,
  EVENT_RATE_TOLERANCE,
  PROVISIONAL_EVENT_RATE,
} from "./calibrate-gates-constants.js";
import { parseFlag, hasFlag, buildSummary } from "./calibrate-gates-cli.js";

// ─── Per-gate config ─────────────────────────────────────────────────────────

/**
 * Per-gate estimand selection per the §4.5 PRE-REGISTRATION table:
 *
 *   - `p95`           : 95th-percentile of the canned-baseline distribution.
 *   - `xmr_3sigma_ucl`: 3σ UCL on per-batch means (Wheeler XmR baseline).
 *
 * source: docs/PHASE_4_PLAN.md §4.5 per-gate table (rows 1-9).
 */
const GATE_ESTIMAND: Readonly<Record<string, "p95" | "xmr_3sigma_ucl">> = {
  iteration_count_max: "p95",
  wall_time_ms_max: "p95",
  section_fail_count_max: "p95",
  error_count_max: "p95",
  mean_section_attempts_max: "p95",
  cortex_recall_empty_count_max: "p95",
};

/**
 * Map gate name → numeric KPI extractor. `null` = boolean defect / suspended
 * gate (no calibration against canned baseline).
 */
const GATE_EXTRACTORS: Readonly<
  Record<string, ((k: PipelineKpis) => number) | null>
> = {
  iteration_count_max: (k) => k.iteration_count,
  wall_time_ms_max: (k) => k.wall_time_ms,
  section_fail_count_max: (k) => k.section_fail_count,
  error_count_max: (k) => k.error_count,
  mean_section_attempts_max: (k) => k.mean_section_attempts,
  cortex_recall_empty_count_max: (k) => k.cortex_recall_empty_count,
  distribution_pass_rate_max: null,
  safety_cap_hit_allowed: null,
  structural_error_count_max: null,
};

// ─── Seeded PRNG (mulberry32) ────────────────────────────────────────────────

/**
 * Mulberry32 — deterministic 32-bit-state PRNG. Sufficient for run-id
 * permutation; not cryptographic.
 *
 * source: Tommy Ettinger, "Mulberry32" (2017). Period 2^32.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// ─── Run-driver ──────────────────────────────────────────────────────────────

interface RunDriverInput {
  readonly k: number;
  readonly seed: number;
  readonly runIdPrefix: string;
  readonly featureDescription: string;
  readonly codebasePath: string | undefined;
}

/**
 * Drive K canned-baseline runs with deterministic run_ids.
 *
 * The canned dispatcher is deterministic, so iteration_count and section
 * outcomes are identical across runs; wall_time_ms varies due to
 * `performance.now()` jitter — the natural variance source for the
 * wall-time gate calibration.
 *
 * Precondition: k ≥ 1.
 * Postcondition: returns an array of length k.
 */
function driveRuns(args: RunDriverInput): ReadonlyArray<PipelineKpis> {
  const rng = mulberry32(args.seed);
  const out: PipelineKpis[] = [];
  for (let i = 0; i < args.k; i++) {
    const runId = `${args.runIdPrefix}-${i}-${Math.floor(rng() * 0xffffffff)
      .toString(16)
      .padStart(8, "0")}`;
    const input: PipelineKpiInput = {
      run_id: runId,
      feature_description: args.featureDescription,
      codebase_path: args.codebasePath,
    };
    out.push(measurePipeline(input));
  }
  return out;
}

// ─── Per-gate calibration entries ────────────────────────────────────────────

interface BuildEntriesInput {
  readonly kpis: ReadonlyArray<PipelineKpis>;
  readonly machineClass: MachineClass;
  readonly outputDir: string;
}

interface XmrFile {
  readonly path: string;
  readonly record: XmRRecord;
}

function buildSuspendedEntry(
  gateName: string,
  k: number,
): GateCalibrationEntry {
  const v = (KPI_GATES as Readonly<Record<string, number | boolean>>)[gateName];
  const numericV = typeof v === "boolean" ? (v ? 1 : 0) : v;
  return {
    gate_name: gateName,
    estimand_type: "p95",
    k_observed: k,
    provisional: numericV,
    calibrated: numericV,
    ci_upper: null,
    ci_lower: null,
    would_tighten: false,
    would_loosen: false,
    passes_threshold: false,
    xmr_path: null,
    machine_class: null,
  };
}

function buildNumericEntry(args: {
  gateName: string;
  values: ReadonlyArray<number>;
  machineClass: MachineClass;
  outputDir: string;
}): { entry: GateCalibrationEntry; xmrFile: XmrFile } {
  const { gateName, values, machineClass, outputDir } = args;
  if (values.length < 2) {
    throw new Error(
      `buildNumericEntry: ${gateName} has <2 observations (K=${values.length})`,
    );
  }
  const isWallTime = gateName === "wall_time_ms_max";
  const provisional = (KPI_GATES as unknown as Readonly<Record<string, number>>)[gateName];
  const stats = computeGateStats(values);
  const calibrated = stats.p95;
  const xmrFileName = isWallTime
    ? `${gateName}.${machineClass}.json`
    : `${gateName}.json`;
  const xmrPath = join(outputDir, "gate-calibration-K100.xmr", xmrFileName);
  const entry: GateCalibrationEntry = {
    gate_name: gateName,
    estimand_type: GATE_ESTIMAND[gateName] ?? "p95",
    k_observed: values.length,
    provisional,
    calibrated,
    ci_upper: stats.ci_upper,
    ci_lower: stats.ci_lower,
    would_tighten: calibrated < provisional,
    would_loosen: calibrated > provisional,
    // §4.5 promotion criterion: 95% CI excludes the provisional value AND
    // the calibrated value departs by ≥5% relative.
    passes_threshold:
      (stats.ci_upper < provisional || stats.ci_lower > provisional) &&
      Math.abs(calibrated - provisional) / Math.max(provisional, 1e-9) >= 0.05,
    xmr_path: xmrPath,
    machine_class: isWallTime ? machineClass : null,
  };
  return { entry, xmrFile: { path: xmrPath, record: stats.xmr } };
}

/**
 * Walk every key in KPI_GATES and build a calibration entry. Per-bucket
 * machine-class qualification is applied to `wall_time_ms_max`.
 */
function buildCalibrationEntries(args: BuildEntriesInput): {
  entries: ReadonlyArray<GateCalibrationEntry>;
  xmrFiles: ReadonlyArray<XmrFile>;
} {
  const entries: GateCalibrationEntry[] = [];
  const xmrFiles: XmrFile[] = [];
  for (const gateName of Object.keys(KPI_GATES)) {
    const extractor = GATE_EXTRACTORS[gateName];
    if (extractor == null) {
      entries.push(buildSuspendedEntry(gateName, args.kpis.length));
      continue;
    }
    const values = args.kpis.map((k) => extractor(k));
    const { entry, xmrFile } = buildNumericEntry({
      gateName,
      values,
      machineClass: args.machineClass,
      outputDir: args.outputDir,
    });
    entries.push(entry);
    xmrFiles.push(xmrFile);
  }
  return { entries, xmrFiles };
}

// ─── Frozen-baseline pre-flight ──────────────────────────────────────────────

/**
 * Compare the current `pipeline-kpis.ts` content hash against the hash
 * recorded in any pre-existing artefact. Abort on sealed mismatch.
 *
 * source: docs/PHASE_4_PLAN.md §4.5 frozen-baseline + Popper AP-1 protection.
 */
function preflightFrozenBaselineCheck(
  outputDir: string,
  skipCheck: boolean,
): string {
  const currentHash = computePipelineKpisContentHash();
  if (skipCheck) return currentHash;
  const existingPath = join(outputDir, "gate-calibration-K100.json");
  if (!existsSync(existingPath)) return currentHash;
  let existing: { gates?: unknown[]; frozen_baseline_content_hash?: string };
  try {
    existing = JSON.parse(readFileSync(existingPath, "utf8")) as typeof existing;
  } catch {
    return currentHash;
  }
  if (
    existing.gates &&
    existing.gates.length > 0 &&
    existing.frozen_baseline_content_hash &&
    existing.frozen_baseline_content_hash !== currentHash
  ) {
    throw new Error(
      `frozen-baseline content hash mismatch:\n` +
        `  recorded:  ${existing.frozen_baseline_content_hash}\n` +
        `  current:   ${currentHash}\n` +
        `Per docs/PHASE_4_PLAN.md §4.5 (Popper AP-1 ratchet protection): ` +
        `re-run requires committing to a frozen baseline. Either revert ` +
        `pipeline-kpis.ts to the recorded hash or accept that calibration ` +
        `must be re-done from scratch (delete the existing JSON and re-run ` +
        `with --skip-frozen-baseline-check on the first new run).`,
    );
  }
  return currentHash;
}

// ─── Top-level orchestration ─────────────────────────────────────────────────

interface RunnerOptions {
  readonly k: number;
  readonly eventRateK: number;
  readonly outputDir: string;
  readonly frozenBaselineCommit: string;
  readonly skipFrozenBaselineCheck: boolean;
  readonly featureDescription: string;
  readonly codebasePath: string;
  /** When true, skip writing artefacts to disk (used by tests). */
  readonly inMemoryOnly: boolean;
}

export interface RunnerResult {
  readonly gateCalibration: GateCalibrationK100;
  readonly eventRate: EventRateK50;
  readonly xmrFiles: ReadonlyArray<XmrFile>;
  readonly summary: ReadonlyArray<string>;
}

function buildEventRateArtefact(
  options: RunnerOptions,
  headCommit: string,
  nowIso: string,
): EventRateK50 {
  const eventRateKpis = driveRuns({
    k: options.eventRateK,
    seed: PRE_REGISTERED_SEED_42,
    runIdPrefix: "phase42-eventrate",
    featureDescription: options.featureDescription,
    codebasePath: options.codebasePath,
  });
  const { totalAttempts, events } = measureEventRate(eventRateKpis);
  const measuredRate = totalAttempts > 0 ? events / totalAttempts : 0;
  const cp =
    totalAttempts > 0
      ? clopperPearson(events, totalAttempts, 0.95)
      : { lower: 0, upper: 0, pointEstimate: 0 };
  const diverges =
    Math.abs(measuredRate - PROVISIONAL_EVENT_RATE) > EVENT_RATE_TOLERANCE;
  return {
    schema_version: 1,
    commit_hash: headCommit,
    seed_used: PRE_REGISTERED_SEED_42,
    timestamp: nowIso,
    k_target: options.eventRateK,
    k_observed: eventRateKpis.length,
    total_attempts: totalAttempts,
    total_events: events,
    measured_event_rate: measuredRate,
    ci95_clopper_pearson: { lower: cp.lower, upper: cp.upper },
    provisional_anchor: PROVISIONAL_EVENT_RATE,
    diverges_beyond_tolerance: diverges,
    recompute_recommended: diverges,
  };
}

function persistArtefacts(
  result: {
    gateCalibration: GateCalibrationK100;
    eventRate: EventRateK50;
    xmrFiles: ReadonlyArray<XmrFile>;
  },
  outputDir: string,
): void {
  writeGateCalibrationK100(
    result.gateCalibration,
    join(outputDir, "gate-calibration-K100.json"),
  );
  writeEventRateK50(result.eventRate, join(outputDir, "event-rate-K50.json"));
  for (const xmr of result.xmrFiles) {
    const dir = dirname(xmr.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      xmr.path,
      JSON.stringify(xmr.record, null, 2) + "\n",
      "utf8",
    );
  }
}

function resolveHeadCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Programmatic runner. The CLI entry point invokes this; tests invoke it
 * directly with a small K against a temp output-dir.
 *
 * Precondition: `options.k ≥ 2`; `options.eventRateK ≥ 1`.
 * Postcondition: returns a `RunnerResult` whose JSON artefacts have already
 *   been validated against their Zod schemas.
 */
export function runCalibration(options: RunnerOptions): RunnerResult {
  if (options.k < 2) {
    throw new Error(`runCalibration: k must be ≥ 2 (got ${options.k})`);
  }
  if (options.eventRateK < 1) {
    throw new Error(
      `runCalibration: eventRateK must be ≥ 1 (got ${options.eventRateK})`,
    );
  }
  const currentHash = preflightFrozenBaselineCheck(
    options.outputDir,
    options.skipFrozenBaselineCheck,
  );
  const kpis = driveRuns({
    k: options.k,
    seed: PRE_REGISTERED_SEED_45,
    runIdPrefix: "phase45-calib",
    featureDescription: options.featureDescription,
    codebasePath: options.codebasePath,
  });
  const machineClass = detectMachineClass();
  const { entries, xmrFiles } = buildCalibrationEntries({
    kpis,
    machineClass,
    outputDir: options.outputDir,
  });
  const nowIso = new Date().toISOString();
  const headCommit = resolveHeadCommit();
  const gateCalibration: GateCalibrationK100 = {
    schema_version: 1,
    commit_hash: headCommit,
    seed_used: PRE_REGISTERED_SEED_45,
    timestamp: nowIso,
    k_target: options.k,
    k_achieved: kpis.length,
    frozen_baseline_commit: options.frozenBaselineCommit,
    frozen_baseline_content_hash: currentHash,
    gates: [...entries],
  };
  const eventRate = buildEventRateArtefact(options, headCommit, nowIso);
  const summary = buildSummary(gateCalibration, eventRate);
  if (!options.inMemoryOnly) {
    persistArtefacts(
      { gateCalibration, eventRate, xmrFiles },
      options.outputDir,
    );
  }
  return { gateCalibration, eventRate, xmrFiles, summary };
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

async function main(argv: ReadonlyArray<string>): Promise<void> {
  // --mode flag (Wave F2): dispatches between the canned baseline runner
  // (default, backward-compatible) and the production-mode runner that
  // drives real subagents through an AgentInvoker.
  // source: PHASE_4_PLAN.md §4.5 production-mode disposition.
  const mode = parseFlag(argv, "mode") ?? "canned";
  if (mode === "production") {
    const { runProductionFromCli } = await import(
      "./calibrate-gates-production.js"
    );
    await runProductionFromCli({ argv });
    return;
  }
  if (mode !== "canned") {
    throw new Error(
      `calibrate-gates: --mode must be "canned" or "production" (got "${mode}")`,
    );
  }
  const k = Number(parseFlag(argv, "k") ?? DEFAULT_K);
  const eventRateK = Number(
    parseFlag(argv, "event-rate-k") ?? DEFAULT_EVENT_RATE_K,
  );
  const outputDir =
    parseFlag(argv, "output-dir") ??
    "packages/benchmark/calibration/data";
  const skipFrozenBaselineCheck = hasFlag(argv, "skip-frozen-baseline-check");
  const frozenBaselineCommit =
    parseFlag(argv, "frozen-baseline-commit") ??
    resolveFrozenBaselineCommit();
  const result = runCalibration({
    k,
    eventRateK,
    outputDir,
    frozenBaselineCommit,
    skipFrozenBaselineCheck,
    featureDescription: "build a feature for OAuth login",
    codebasePath: "/tmp/benchmark",
    inMemoryOnly: false,
  });
  for (const line of result.summary) console.log(line);
}

/**
 * Pure-function variant of `main()` exposed for tests. Returns the chosen
 * mode without performing any I/O. Tests assert the dispatch logic on
 * arbitrary argv without spawning real runners.
 */
export function selectModeFromArgv(
  argv: ReadonlyArray<string>,
): "canned" | "production" {
  const m = parseFlag(argv, "mode") ?? "canned";
  if (m === "canned" || m === "production") return m;
  throw new Error(
    `calibrate-gates: --mode must be "canned" or "production" (got "${m}")`,
  );
}

const invokedDirectly = (() => {
  try {
    return (
      typeof process !== "undefined" &&
      Array.isArray(process.argv) &&
      process.argv[1] !== undefined &&
      (process.argv[1].endsWith("calibrate-gates.js") ||
        process.argv[1].endsWith("calibrate-gates.ts"))
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
