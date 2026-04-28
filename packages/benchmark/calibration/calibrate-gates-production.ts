/**
 * Phase 4.5 KPI-gate calibration runner — PRODUCTION MODE (Wave F sub-stream F2).
 *
 * Mirrors `calibrate-gates.ts` but drives `measurePipelineAsync` via a
 * production dispatcher (real subagents through {@link AgentInvoker}) instead
 * of the canned synthetic baseline. Output is written to a parallel artefact
 * (`gate-calibration-K100-production.json`) so the canned baseline at
 * `gate-calibration-K100.json` is NEVER overwritten.
 *
 * Why a separate runner (vs a flag on the canned runner):
 *   - The dispatcher contract differs (sync `craftResult` → async dispatch);
 *     forcing async on the canned path would tax every existing test for no
 *     calibration benefit.
 *   - The output filename, the `data_source` tag, and the held-gate
 *     promotion criteria differ between canned and production batches.
 *
 * source: PHASE_4_PLAN.md §4.5 — wall_time_ms_max + cortex_recall_empty_count_max
 *   are tagged `hold_provisional=true` until a production-mode K=100 batch
 *   re-calibrates them on real-LLM behaviour. This runner is the on-ramp.
 *
 * Layer contract (§2.2): script-only — top-level await, FS writes,
 * child_process for `git rev-parse`. Imports `measurePipelineAsync` +
 * `KPI_GATES` from `../src/`. No imports from `dist/`.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { measurePipelineAsync } from "../src/pipeline-kpis-async.js";
import { KPI_GATES, type PipelineKpis } from "../src/pipeline-kpis.js";
import {
  makeProductionDispatcher,
  makeStubAgentInvoker,
  type AgentInvoker,
  type ProductionDispatcher,
} from "@prd-gen/orchestration";
import { clopperPearson } from "./clopper-pearson.js";
import { detectMachineClass, type MachineClass } from "./machine-class.js";
import { computeGateStats } from "./gate-stats.js";
import { measureEventRate } from "./event-rate.js";
import {
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
  PRE_REGISTERED_SEED_42,
  EVENT_RATE_TOLERANCE,
  PROVISIONAL_EVENT_RATE,
} from "./calibrate-gates-constants.js";
import { parseFlag, hasFlag } from "./calibrate-gates-cli.js";

// ─── Production-mode pre-registered constants ───────────────────────────────

/**
 * Pre-registered RNG seed for the production-mode batch. DELIBERATELY
 * different from `PRE_REGISTERED_SEED_45 = 0x4_05_C3` so production
 * artefacts cannot be confused with the canned-baseline series.
 *
 * 0x4_05_C3_FF — "phase 4.5 calibration, full (production)".
 *
 * source: PHASE_4_PLAN.md §4.5 — production-mode promotion requires a
 *   distinct seed lineage to keep the canned baseline cryptographically
 *   separable. Wave F2 brief reserves this seed.
 */
export const PRE_REGISTERED_SEED_45_PRODUCTION = 0x4_05_c3_ff;

/**
 * Production-mode default K. Matches the canned-baseline K=100 so the
 * two distributions are directly comparable per-gate.
 */
export const DEFAULT_K_PRODUCTION = 100;

/** Output filename for the production-mode artefact. */
export const PRODUCTION_OUTPUT_BASENAME = "gate-calibration-K100-production.json";

// ─── Per-gate config ─────────────────────────────────────────────────────────

const GATE_ESTIMAND: Readonly<Record<string, "p95" | "xmr_3sigma_ucl">> = {
  iteration_count_max: "p95",
  wall_time_ms_max: "p95",
  section_fail_count_max: "p95",
  error_count_max: "p95",
  mean_section_attempts_max: "p95",
  cortex_recall_empty_count_max: "p95",
};

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

// ─── Run-driver (async) ──────────────────────────────────────────────────────

interface ProductionRunDriverInput {
  readonly k: number;
  readonly seed: number;
  readonly runIdPrefix: string;
  readonly featureDescription: string;
  readonly codebasePath: string | undefined;
  readonly dispatch: ProductionDispatcher;
}

async function driveProductionRuns(
  args: ProductionRunDriverInput,
): Promise<ReadonlyArray<PipelineKpis>> {
  const rng = mulberry32(args.seed);
  const out: PipelineKpis[] = [];
  for (let i = 0; i < args.k; i++) {
    const runId = `${args.runIdPrefix}-${i}-${Math.floor(rng() * 0xffffffff)
      .toString(16)
      .padStart(8, "0")}`;
    const kpis = await measurePipelineAsync({
      run_id: runId,
      feature_description: args.featureDescription,
      codebase_path: args.codebasePath,
      dispatch: args.dispatch,
    });
    out.push(kpis);
  }
  return out;
}

// ─── Per-gate calibration entries ────────────────────────────────────────────

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

interface BuildEntriesInput {
  readonly kpis: ReadonlyArray<PipelineKpis>;
  readonly machineClass: MachineClass;
  readonly outputDir: string;
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
    ? `${gateName}.${machineClass}.production.json`
    : `${gateName}.production.json`;
  const xmrPath = join(
    outputDir,
    "gate-calibration-K100-production.xmr",
    xmrFileName,
  );
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
    passes_threshold:
      (stats.ci_upper < provisional || stats.ci_lower > provisional) &&
      Math.abs(calibrated - provisional) / Math.max(provisional, 1e-9) >= 0.05,
    xmr_path: xmrPath,
    machine_class: isWallTime ? machineClass : null,
  };
  return { entry, xmrFile: { path: xmrPath, record: stats.xmr } };
}

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

// ─── Production artefact envelope ───────────────────────────────────────────

/**
 * Production-mode output extends `GateCalibrationK100` with:
 *   - `data_source`: identifies the dispatcher class so a downstream
 *     consumer never confuses canned and production data.
 *   - `agent_invoker_class`: stub vs real-host vs other.
 *
 * The schema is a superset of `GateCalibrationK100Schema`, so the
 * canonical loader still parses it (extra fields are stripped).
 */
export interface ProductionGateCalibration extends GateCalibrationK100 {
  readonly data_source: string;
  readonly agent_invoker_class: string;
}

// ─── Top-level orchestration ─────────────────────────────────────────────────

export interface ProductionRunnerOptions {
  readonly k: number;
  readonly eventRateK: number;
  readonly outputDir: string;
  readonly frozenBaselineCommit: string;
  readonly featureDescription: string;
  readonly codebasePath: string;
  readonly inMemoryOnly: boolean;
  /**
   * Required: the agent invoker. Tests pass a deterministic stub; production
   * passes a real subagent-backed invoker.
   */
  readonly agentInvoker: AgentInvoker;
  /**
   * Identifier persisted in the output JSON's `agent_invoker_class` field.
   * Examples: "stub-pilot-K5", "host-claude-code", "stub-deterministic-test".
   */
  readonly agentInvokerClass: string;
}

export interface ProductionRunnerResult {
  readonly gateCalibration: ProductionGateCalibration;
  readonly eventRate: EventRateK50;
  readonly xmrFiles: ReadonlyArray<XmrFile>;
  readonly summary: ReadonlyArray<string>;
}

function buildProductionEventRateArtefact(
  options: ProductionRunnerOptions,
  headCommit: string,
  nowIso: string,
  dispatch: ProductionDispatcher,
): Promise<EventRateK50> {
  return driveProductionRuns({
    k: options.eventRateK,
    seed: PRE_REGISTERED_SEED_42,
    runIdPrefix: "phase42-eventrate-prod",
    featureDescription: options.featureDescription,
    codebasePath: options.codebasePath,
    dispatch,
  }).then((eventRateKpis) => {
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
  });
}

function persistProductionArtefacts(
  result: {
    gateCalibration: ProductionGateCalibration;
    eventRate: EventRateK50;
    xmrFiles: ReadonlyArray<XmrFile>;
  },
  outputDir: string,
): void {
  const gatePath = join(outputDir, PRODUCTION_OUTPUT_BASENAME);
  if (!existsSync(dirname(gatePath))) {
    mkdirSync(dirname(gatePath), { recursive: true });
  }
  writeFileSync(
    gatePath,
    JSON.stringify(result.gateCalibration, null, 2) + "\n",
    "utf8",
  );
  // Event-rate artefact also lands in a non-canned filename.
  const erPath = join(outputDir, "event-rate-K50-production.json");
  writeFileSync(
    erPath,
    JSON.stringify(result.eventRate, null, 2) + "\n",
    "utf8",
  );
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

function buildProductionSummary(args: {
  gc: ProductionGateCalibration;
  er: EventRateK50;
}): ReadonlyArray<string> {
  const { gc, er } = args;
  const lines: string[] = [
    `[production-mode] data_source=${gc.data_source}`,
    `[production-mode] agent_invoker_class=${gc.agent_invoker_class}`,
    `K achieved: ${gc.k_achieved} / ${gc.k_target}`,
    `Frozen baseline commit: ${gc.frozen_baseline_commit}`,
    `Pipeline-KPIs content hash: ${gc.frozen_baseline_content_hash}`,
    "",
    "Per-gate provisional vs calibrated (production):",
  ];
  for (const g of gc.gates) {
    const dir = g.would_tighten
      ? "tighten"
      : g.would_loosen
        ? "loosen"
        : "hold";
    lines.push(
      `  ${g.gate_name}: ${g.provisional} → ${g.calibrated.toFixed(3)} (${dir})`,
    );
  }
  lines.push(
    "",
    `Event-rate (production K=${er.k_observed}): ${er.measured_event_rate.toFixed(4)}`,
    `CI95: [${er.ci95_clopper_pearson.lower.toFixed(4)}, ${er.ci95_clopper_pearson.upper.toFixed(4)}]`,
  );
  return lines;
}

/**
 * Production-mode programmatic runner. Tests invoke this with a stub
 * AgentInvoker; the eventual K=100 production batch invokes it with a
 * host-backed real invoker.
 *
 * Precondition: `options.k ≥ 2`; `options.eventRateK ≥ 1`.
 * Postcondition: returns a `ProductionRunnerResult`. The output JSON has
 *   `data_source: "production_pilot_K=<k>"` so a reader cannot confuse it
 *   with the canned baseline.
 */
export async function runProductionCalibration(
  options: ProductionRunnerOptions,
): Promise<ProductionRunnerResult> {
  if (options.k < 2) {
    throw new Error(`runProductionCalibration: k must be ≥ 2 (got ${options.k})`);
  }
  if (options.eventRateK < 1) {
    throw new Error(
      `runProductionCalibration: eventRateK must be ≥ 1 (got ${options.eventRateK})`,
    );
  }
  const dispatch = makeProductionDispatcher({
    agentInvoker: options.agentInvoker,
    cannedOptions: {
      freeform_answer: "production-mode-answer",
      graph_path: "/tmp/benchmark-production/graph",
    },
  });
  const currentHash = computePipelineKpisContentHash();
  const kpis = await driveProductionRuns({
    k: options.k,
    seed: PRE_REGISTERED_SEED_45_PRODUCTION,
    runIdPrefix: "phase45-prod",
    featureDescription: options.featureDescription,
    codebasePath: options.codebasePath,
    dispatch,
  });
  const machineClass = detectMachineClass();
  const { entries, xmrFiles } = buildCalibrationEntries({
    kpis,
    machineClass,
    outputDir: options.outputDir,
  });
  const nowIso = new Date().toISOString();
  const headCommit = resolveHeadCommit();
  const gateCalibration: ProductionGateCalibration = {
    schema_version: 1,
    commit_hash: headCommit,
    seed_used: PRE_REGISTERED_SEED_45_PRODUCTION,
    timestamp: nowIso,
    k_target: options.k,
    k_achieved: kpis.length,
    frozen_baseline_commit: options.frozenBaselineCommit,
    frozen_baseline_content_hash: currentHash,
    gates: [...entries],
    data_source: `production_pilot_K=${kpis.length}`,
    agent_invoker_class: options.agentInvokerClass,
  };
  const eventRate = await buildProductionEventRateArtefact(
    options,
    headCommit,
    nowIso,
    dispatch,
  );
  const summary = buildProductionSummary({ gc: gateCalibration, er: eventRate });
  if (!options.inMemoryOnly) {
    persistProductionArtefacts(
      { gateCalibration, eventRate, xmrFiles },
      options.outputDir,
    );
  }
  return { gateCalibration, eventRate, xmrFiles, summary };
}

// ─── CLI helpers (re-export of the canned CLI's parser; no new module) ──────

interface CliEntryOptions {
  readonly argv: ReadonlyArray<string>;
}

/**
 * CLI entry for the production-mode runner. Invoked when the unified CLI
 * (`calibrate-gates-cli-entry.ts`) detects `--mode=production`.
 */
export async function runProductionFromCli(args: CliEntryOptions): Promise<void> {
  const k = Number(parseFlag(args.argv, "k") ?? DEFAULT_K_PRODUCTION);
  const eventRateK = Number(
    parseFlag(args.argv, "event-rate-k") ?? Math.min(50, k),
  );
  const outputDir =
    parseFlag(args.argv, "output-dir") ??
    "packages/benchmark/calibration/data";
  const frozenBaselineCommit =
    parseFlag(args.argv, "frozen-baseline-commit") ??
    resolveFrozenBaselineCommit();
  // Default invoker for CLI is the deterministic stub. A future PR wires
  // the host-backed AgentInvoker here once the Claude Code Agent-tool surface
  // is plumbed through the runner. Until then, a CLI invocation produces a
  // PILOT artefact, not a promotable production batch — see runbook §"Pilot vs
  // promotable".
  const useStub = !hasFlag(args.argv, "real-host");
  const agentInvoker = useStub
    ? makeStubAgentInvoker({ rng: mulberry32(PRE_REGISTERED_SEED_45_PRODUCTION) })
    : (() => {
        throw new Error(
          "production CLI: --real-host is reserved for the follow-up PR " +
            "that wires the host-backed AgentInvoker. Until then, omit the flag " +
            "to run the deterministic stub pilot. See production-calibration-runbook.md.",
        );
      })();
  const result = await runProductionCalibration({
    k,
    eventRateK,
    outputDir,
    frozenBaselineCommit,
    featureDescription: "build a feature for OAuth login",
    codebasePath: "/tmp/benchmark-production",
    inMemoryOnly: false,
    agentInvoker,
    agentInvokerClass: useStub ? "stub-deterministic-cli" : "host-real",
  });
  for (const line of result.summary) console.log(line);
}

const invokedDirectly = (() => {
  try {
    return (
      typeof process !== "undefined" &&
      Array.isArray(process.argv) &&
      process.argv[1] !== undefined &&
      (process.argv[1].endsWith("calibrate-gates-production.js") ||
        process.argv[1].endsWith("calibrate-gates-production.ts"))
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runProductionFromCli({ argv: process.argv.slice(2) }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
