/**
 * CLI entry point for the production-mode gate calibration runner.
 *
 * Extracted from `calibrate-gates-production.ts` in the Wave F final
 * remediation (2026-04-28) to keep that file under the §4.1 500-LOC cap.
 * The runner core (the actual K-trial loop, mulberry32, build-entries
 * helpers, and `runProductionCalibration` itself) remains in the parent
 * file; this module owns argv parsing + invoker selection + direct-invoke
 * detection only.
 *
 * source: Wave F code-reviewer extraction; coding-standards.md §4.1.
 */

import {
  runProductionCalibration,
  DEFAULT_K_PRODUCTION,
  PRE_REGISTERED_SEED_45_PRODUCTION,
  mulberry32ForCli,
} from "./calibrate-gates-production.js";
import { makeStubAgentInvoker } from "@prd-gen/orchestration";
import { resolveFrozenBaselineCommit } from "./frozen-baseline.js";
import { parseFlag, hasFlag } from "./calibrate-gates-cli.js";

interface CliEntryOptions {
  readonly argv: ReadonlyArray<string>;
}

/**
 * CLI entry for the production-mode runner. Invoked when the unified CLI
 * (`calibrate-gates-cli-entry.ts`) detects `--mode=production`, or directly
 * when this file is the script entry.
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
  // PILOT artefact, not a promotable production batch — see runbook
  // §"Pilot vs promotable".
  const useStub = !hasFlag(args.argv, "real-host");
  const agentInvoker = useStub
    ? makeStubAgentInvoker({ rng: mulberry32ForCli(PRE_REGISTERED_SEED_45_PRODUCTION) })
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
      (process.argv[1].endsWith("calibrate-gates-production-cli.js") ||
        process.argv[1].endsWith("calibrate-gates-production-cli.ts"))
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
