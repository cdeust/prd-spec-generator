/**
 * Phase 4.3 — Plan-mismatch fire-rate calibration analysis script.
 *
 * Procedure (matches the pre-registration block in
 * docs/PHASE_4_PLAN.md §4.3):
 *
 *   1. Read JSONL run records from
 *      packages/benchmark/calibration/data/mismatch-fire-rate.*.jsonl.
 *      Each row has shape:
 *        {
 *          "run_id": string,
 *          "prd_context": one of the 8 PRDContext values,
 *          "mismatch_fired": boolean,
 *          "mismatch_kinds": MismatchKind[]
 *        }
 *      Rows are produced by the calibration runner (separate, not committed
 *      yet — see "Remaining gaps" in the calibration README).
 *
 *   2. Compute overall and per-kind fire counts. Exact 95% Clopper-Pearson
 *      CI for each.
 *
 *   3. Stratify by prd_context; report per-cell counts. Verify each cell
 *      meets the floor of K/8 runs.
 *
 *   4. Build XmR control chart on per-batch fire rate (n=20 runs/batch).
 *      Lock limits on the first 12 batches, scan the full series.
 *
 *   5. Apply pre-registered decision rule:
 *        - upper CI < 0.01 ⇒ "fallback path demonstrably unreached"
 *        - fire_count ≥ 1 ⇒ "investigate root cause"
 *
 * Measurement-only: this script does not modify any pipeline state, does
 * not call MCP tools, and does not write to the EvidenceRepository.
 *
 * source: PHASE_4_PLAN.md §4.3 (Phase 3+4 cross-audit, 2026-04).
 *         Pre-registered before any data row is collected.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  clopperPearson,
  type ClopperPearsonInterval,
} from "./clopper-pearson.js";
import { xmrAnalyze, type XmRReport } from "./xmr.js";
import {
  MISMATCH_KINDS,
  type MismatchKind,
} from "../src/instrumentation.js";

// source: PHASE_4_PLAN.md §4.3 RNG-seed pre-registration. Constant must not
// change after first data collection — assertion below enforces this.
export const PRE_REGISTERED_SEED = 0xc0ffee0403;

// source: PHASE_4_PLAN.md §4.3 stratification. Round-robin over
// PRDContextSchema (packages/core/src/domain/prd-context.ts).
export const PRD_CONTEXT_DOMAIN = [
  "proposal",
  "feature",
  "bug",
  "incident",
  "poc",
  "mvp",
  "release",
  "cicd",
] as const;

// source: PHASE_4_PLAN.md §4.3 sample-size calculation. K=460 ⇒ upper bound
// at 0 fires ≈ 0.80% (clears the 1% H0 ceiling).
export const PRIMARY_K = 460;
// source: PHASE_4_PLAN.md §4.3 stratification floor.
export const PER_CONTEXT_FLOOR = Math.ceil(PRIMARY_K / PRD_CONTEXT_DOMAIN.length);
// source: PHASE_4_PLAN.md §4.3 CC-4 control chart spec.
export const XMR_BATCH_SIZE = 20;
export const XMR_BASELINE_BATCHES = 12;
// source: PHASE_4_PLAN.md §4.3 pre-registered H0 ceiling.
export const FIRE_RATE_CEILING = 0.01;

export interface CalibrationRun {
  readonly run_id: string;
  readonly prd_context: (typeof PRD_CONTEXT_DOMAIN)[number];
  readonly mismatch_fired: boolean;
  readonly mismatch_kinds: ReadonlyArray<MismatchKind>;
}

export interface PerContextStats {
  readonly context: (typeof PRD_CONTEXT_DOMAIN)[number];
  readonly trials: number;
  readonly fires: number;
  readonly meetsFloor: boolean;
}

export interface FireRateReport {
  readonly trials: number;
  readonly fires: number;
  readonly overallCI: ClopperPearsonInterval;
  readonly perKindCI: Record<MismatchKind, ClopperPearsonInterval>;
  readonly perContext: ReadonlyArray<PerContextStats>;
  readonly xmr: XmRReport | null;
  readonly decision:
    | "fallback_unreached_delete_candidate"
    | "investigate_root_cause"
    | "underpowered";
  readonly decisionRationale: string;
}

function loadDataset(dataDir: string): ReadonlyArray<CalibrationRun> {
  if (!existsSync(dataDir)) return [];
  const files = readdirSync(dataDir).filter(
    (f) => f.startsWith("mismatch-fire-rate.") && f.endsWith(".jsonl"),
  );
  const out: CalibrationRun[] = [];
  for (const f of files) {
    const text = readFileSync(join(dataDir, f), "utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = JSON.parse(trimmed) as CalibrationRun;
      out.push(row);
    }
  }
  return out;
}

function computePerContext(
  runs: ReadonlyArray<CalibrationRun>,
): PerContextStats[] {
  const buckets = new Map<
    (typeof PRD_CONTEXT_DOMAIN)[number],
    { trials: number; fires: number }
  >();
  for (const ctx of PRD_CONTEXT_DOMAIN) {
    buckets.set(ctx, { trials: 0, fires: 0 });
  }
  for (const r of runs) {
    const b = buckets.get(r.prd_context);
    if (!b) continue;
    b.trials += 1;
    if (r.mismatch_fired) b.fires += 1;
  }
  return PRD_CONTEXT_DOMAIN.map((ctx) => {
    const b = buckets.get(ctx)!;
    return {
      context: ctx,
      trials: b.trials,
      fires: b.fires,
      meetsFloor: b.trials >= PER_CONTEXT_FLOOR,
    };
  });
}

function computePerKind(
  runs: ReadonlyArray<CalibrationRun>,
): Record<MismatchKind, ClopperPearsonInterval> {
  const trials = runs.length;
  const out = {} as Record<MismatchKind, ClopperPearsonInterval>;
  for (const k of MISMATCH_KINDS) {
    const fires = runs.filter((r) => r.mismatch_kinds.includes(k)).length;
    out[k] = clopperPearson(fires, Math.max(trials, 1));
  }
  return out;
}

function computeBatchedFireRates(
  runs: ReadonlyArray<CalibrationRun>,
): number[] {
  const rates: number[] = [];
  for (let i = 0; i + XMR_BATCH_SIZE <= runs.length; i += XMR_BATCH_SIZE) {
    const slice = runs.slice(i, i + XMR_BATCH_SIZE);
    const fires = slice.filter((r) => r.mismatch_fired).length;
    rates.push(fires / XMR_BATCH_SIZE);
  }
  return rates;
}

function decide(
  fires: number,
  ci: ClopperPearsonInterval,
  trials: number,
): { decision: FireRateReport["decision"]; rationale: string } {
  if (trials < PRIMARY_K) {
    return {
      decision: "underpowered",
      rationale: `K=${trials} < pre-registered minimum K=${PRIMARY_K}`,
    };
  }
  if (fires === 0 && ci.upper < FIRE_RATE_CEILING) {
    return {
      decision: "fallback_unreached_delete_candidate",
      rationale: `0 fires in K=${trials}; CP-95 upper ${ci.upper.toFixed(4)} < ${FIRE_RATE_CEILING}`,
    };
  }
  if (fires >= 1) {
    return {
      decision: "investigate_root_cause",
      rationale: `${fires} fires observed; root-cause analysis required before threshold change`,
    };
  }
  return {
    decision: "underpowered",
    rationale: `0 fires but CP-95 upper ${ci.upper.toFixed(4)} ≥ ${FIRE_RATE_CEILING}`,
  };
}

export function analyze(
  runs: ReadonlyArray<CalibrationRun>,
): FireRateReport {
  const trials = runs.length;
  const fires = runs.filter((r) => r.mismatch_fired).length;
  const overallCI = clopperPearson(fires, Math.max(trials, 1));
  const perKindCI = computePerKind(runs);
  const perContext = computePerContext(runs);
  const batchedRates = computeBatchedFireRates(runs);
  const xmr =
    batchedRates.length >= XMR_BASELINE_BATCHES
      ? xmrAnalyze(batchedRates, XMR_BASELINE_BATCHES)
      : null;
  const { decision, rationale } = decide(fires, overallCI, trials);
  return {
    trials,
    fires,
    overallCI,
    perKindCI,
    perContext,
    xmr,
    decision,
    decisionRationale: rationale,
  };
}

function formatReport(r: FireRateReport): string {
  const lines: string[] = [
    "# Plan-mismatch fire-rate (Phase 4.3) — analysis report",
    "",
    `K (trials):            ${r.trials}`,
    `Fires (any kind):      ${r.fires}`,
    `Overall fire rate:     ${r.overallCI.pointEstimate.toFixed(4)}`,
    `  CP-95 lower:         ${r.overallCI.lower.toFixed(4)}`,
    `  CP-95 upper:         ${r.overallCI.upper.toFixed(4)}`,
    `  H0 ceiling (p=${FIRE_RATE_CEILING}): ${r.overallCI.upper < FIRE_RATE_CEILING ? "REJECTED" : "NOT REJECTED"}`,
    "",
    "## Per mismatch_kind (CP-95)",
  ];
  for (const k of MISMATCH_KINDS) {
    const ci = r.perKindCI[k];
    lines.push(
      `  ${k.padEnd(22)} fires=${ci.successes}/${ci.trials}  rate=${ci.pointEstimate.toFixed(4)}  upper=${ci.upper.toFixed(4)}`,
    );
  }
  lines.push("", "## Stratification (per prd_context)");
  for (const c of r.perContext) {
    const flag = c.meetsFloor ? "OK" : `FLOOR-MISS (need ${PER_CONTEXT_FLOOR})`;
    lines.push(
      `  ${c.context.padEnd(10)} trials=${c.trials.toString().padStart(4)}  fires=${c.fires.toString().padStart(3)}  ${flag}`,
    );
  }
  lines.push("", "## XmR control chart");
  if (!r.xmr) {
    lines.push(
      `  not yet computable — need ≥ ${XMR_BASELINE_BATCHES} batches of ${XMR_BATCH_SIZE} runs`,
    );
  } else {
    lines.push(
      `  centerline:           ${r.xmr.limits.centerline.toFixed(4)}`,
      `  UCL:                  ${r.xmr.limits.upperControlLimit.toFixed(4)}`,
      `  LCL:                  ${r.xmr.limits.lowerControlLimit.toFixed(4)}`,
      `  in-control:           ${r.xmr.inControl}`,
      `  signals:              ${r.xmr.signals.length}`,
    );
    for (const s of r.xmr.signals) {
      lines.push(
        `    batch[${s.index}] value=${s.value.toFixed(4)} rule=${s.rule}`,
      );
    }
  }
  lines.push(
    "",
    "## Decision",
    `  outcome:    ${r.decision}`,
    `  rationale:  ${r.decisionRationale}`,
    "",
  );
  return lines.join("\n");
}

// CLI entry point — `node dist/calibration/mismatch-fire-rate.js [data-dir]`.
async function main(): Promise<void> {
  // Pre-registered seed assertion (Fisher Fi-A): if this constant has been
  // mutated between data collection and analysis, abort.
  if (PRE_REGISTERED_SEED !== 0xc0ffee0403) {
    throw new Error(
      "PRE_REGISTERED_SEED has been mutated post-registration — refuse to analyze.",
    );
  }
  const dataDir =
    process.argv[2] ??
    join(
      process.cwd(),
      "packages/benchmark/calibration/data",
    );
  const runs = loadDataset(dataDir);
  if (runs.length === 0) {
    console.log(
      `[mismatch-fire-rate] no data rows found under ${dataDir}; ` +
        "run the calibration runner first.",
    );
    return;
  }
  const report = analyze(runs);
  console.log(formatReport(report));
}

if (
  process.argv[1]?.endsWith("mismatch-fire-rate.js") ||
  process.argv[1]?.endsWith("mismatch-fire-rate.ts")
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
