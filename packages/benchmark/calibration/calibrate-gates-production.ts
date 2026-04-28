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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { measurePipelineAsync } from "../src/pipeline-kpis-async.js";
import { KPI_GATES, type PipelineKpis } from "../src/pipeline-kpis.js";
import {
  makeProductionDispatcher,
  type AgentInvoker,
  type ProductionDispatcher,
} from "@prd-gen/orchestration";
import { detectMachineClass, type MachineClass } from "./machine-class.js";
import { computeGateStats } from "./gate-stats.js";
import {
  type GateCalibrationK100,
  type GateCalibrationEntry,
  type EventRateK50,
  type XmRRecord,
} from "./calibration-outputs.js";
import { computePipelineKpisContentHash } from "./frozen-baseline.js";
import {
  buildProductionEventRateArtefact,
  persistProductionArtefacts,
  resolveHeadCommit,
  buildProductionSummary,
} from "./production-artefacts-io.js";

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

/**
 * Deterministic uniform-[0,1) PRNG. 32-bit state; passes BigCrush; portable
 * across V8 / SpiderMonkey / JSC because it uses only `Math.imul` + bitshifts
 * (both ECMAScript-precise) and unsigned-right-shift normalization.
 *
 * source: bryc/code, "PRNGs.md#mulberry32" —
 *   https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32
 *   (variant of Vigna's xorshift derivation; 0x6d2b79f5 is the published
 *   increment constant; 0x100000000 is the uint32 normalization divisor).
 * source: aligned with the matching mulberry32 implementations used in
 *   `paired-bootstrap.ts` and `seal-reliability-corpus.mjs` so the
 *   reproducibility pin holds across calibration / sealing / bootstrap.
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

// ─── Run-driver (async) ──────────────────────────────────────────────────────

interface ProductionRunDriverInput {
  readonly k: number;
  readonly seed: number;
  readonly runIdPrefix: string;
  readonly featureDescription: string;
  readonly codebasePath: string | undefined;
  readonly dispatch: ProductionDispatcher;
}

export async function driveProductionRuns(
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

export interface XmrFile {
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

// I/O + summary helpers extracted to ./production-artefacts-io.ts (Wave F
// remediation, §4.1 LOC cap). They're imported above and re-exported below
// for any caller that imports them from this file (back-compat).

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
  validateProductionOptions(options);
  const dispatch = makeProductionDispatcher({
    agentInvoker: options.agentInvoker,
    cannedOptions: {
      freeform_answer: "production-mode-answer",
      graph_path: "/tmp/benchmark-production/graph",
    },
  });
  const nowIso = new Date().toISOString();
  const headCommit = resolveHeadCommit();
  const { gateCalibration, xmrFiles } = await assembleGateCalibration(
    options,
    dispatch,
    nowIso,
    headCommit,
  );
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

/** Throws if the production options are inconsistent. */
function validateProductionOptions(options: ProductionRunnerOptions): void {
  if (options.k < 2) {
    throw new Error(`runProductionCalibration: k must be ≥ 2 (got ${options.k})`);
  }
  if (options.eventRateK < 1) {
    throw new Error(
      `runProductionCalibration: eventRateK must be ≥ 1 (got ${options.eventRateK})`,
    );
  }
}

/**
 * Drive K production runs and assemble the `ProductionGateCalibration`
 * envelope (including XmR sidecar files). Extracted from
 * `runProductionCalibration` to keep that function under the §4.2 50-LOC
 * cap (Wave F code-reviewer remediation).
 */
async function assembleGateCalibration(
  options: ProductionRunnerOptions,
  dispatch: ProductionDispatcher,
  nowIso: string,
  headCommit: string,
): Promise<{ gateCalibration: ProductionGateCalibration; xmrFiles: ReadonlyArray<XmrFile> }> {
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
  return { gateCalibration, xmrFiles };
}

/**
 * Re-export of `mulberry32` for the CLI module. The PRNG is module-private
 * to keep the public surface narrow; the CLI needs it to seed the stub
 * AgentInvoker. Wave F final remediation extracted CLI to a sibling file
 * (calibrate-gates-production-cli.ts) per coding-standards §4.1.
 */
export const mulberry32ForCli = mulberry32;
