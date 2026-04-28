/**
 * codeOracle — TypeScript compilation check via tsc subprocess.
 *
 * Precondition:  payload.snippet is a TypeScript string; payload.expected_compiles
 *                is the claim being made.
 * Postcondition: truth = (tsc exits 0 === expected_compiles).
 *                oracle_evidence is non-empty and human-readable.
 * Invariant:     The snippet is written to a temp directory and cleaned up after
 *                each call. tsc is invoked with --noEmit --strict; no output is
 *                emitted to disk beyond the temp source file.
 *
 * Hermetic-test contract (Wave-C no-skip rule):
 *   Tests do NOT skip when tsc is unavailable. Instead, `isTscAvailable()` is
 *   exported so test files can branch:
 *     - tsc present  → real subprocess invocation
 *     - tsc absent   → stub mode: oracle returns a canned result + logs a warning.
 *   This preserves CI determinism (tests always run) while giving local developers
 *   real-compilation fidelity.
 *
 * Layer: benchmark/calibration. Uses Node.js child_process (infrastructure).
 */

import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { CodePayload, OracleResult } from "./oracle-types.js";

/** Subprocess timeout in milliseconds. source: measured locally; tsc on a
 *  single-file snippet resolves in <3s on M1/M2 silicon; 10 000ms provides
 *  3× headroom for CI machines. */
const TSC_TIMEOUT_MS = 10_000;

/** Locate the tsc binary from the worktree's local node_modules first,
 *  then fall back to system PATH. Returns null if not found. */
function findTscBinary(): string | null {
  // Prefer the workspace-local tsc to avoid version mismatches.
  const candidates = [
    // pnpm hoisted location
    new URL(
      "../../../../node_modules/.bin/tsc",
      import.meta.url,
    ).pathname,
    // Fallback: tsc on PATH (resolved at call time)
    "tsc",
  ];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { timeout: 3_000, stdio: "pipe" });
      return candidate;
    } catch {
      // Not found at this location; try the next.
    }
  }
  return null;
}

/** True iff a usable tsc binary can be found. Exported for test gates. */
export function isTscAvailable(): boolean {
  return findTscBinary() !== null;
}

/**
 * Compile a TypeScript snippet under --strict --noEmit and compare the
 * compile-success result against expected_compiles.
 *
 * Precondition:  snippet is a TypeScript string (may be invalid TS).
 *                expected_compiles is the claim.
 * Postcondition: truth = (tsc exits 0 === expected_compiles).
 */
export async function codeOracle(payload: CodePayload): Promise<OracleResult> {
  const { snippet, expected_compiles } = payload;

  const tscBin = findTscBinary();

  if (tscBin === null) {
    // Stub mode: tsc unavailable. Tests will warn; CI still gets a result.
    console.warn(
      "[codeOracle] tsc binary not found. " +
      "Returning stub result (truth=false, oracle_evidence notes stub mode). " +
      "Install TypeScript to get real compilation verdicts.",
    );
    const evidence =
      `codeOracle[STUB MODE — tsc not found]: snippet="${snippetSummary(snippet)}"; ` +
      `expected_compiles=${String(expected_compiles)}; ` +
      `truth=false (stub; cannot verify claim without tsc).`;
    return { truth: false, oracle_evidence: evidence };
  }

  // Get tsc version for evidence traceability.
  let tscVersion = "unknown";
  try {
    tscVersion = execFileSync(tscBin, ["--version"], { timeout: 3_000, stdio: "pipe" })
      .toString()
      .trim();
  } catch {
    // Non-fatal; version is for evidence only.
  }

  // Write snippet to a unique temp file.
  const tempDir = mkdtempSync(join(tmpdir(), "prd-gen-code-oracle-"));
  const snippetFile = join(tempDir, "snippet.ts");

  try {
    writeFileSync(snippetFile, snippet, "utf8");

    let compilesCleanly: boolean;
    let stderr = "";

    try {
      execFileSync(
        tscBin,
        ["--noEmit", "--strict", "--target", "ES2022", "--module", "node16", "--moduleResolution", "node16", snippetFile],
        { timeout: TSC_TIMEOUT_MS, stdio: "pipe" },
      );
      compilesCleanly = true;
    } catch (err: unknown) {
      compilesCleanly = false;
      if (
        err !== null &&
        typeof err === "object" &&
        "stderr" in err
      ) {
        const rawStderr = (err as { stderr: Buffer | string }).stderr;
        const stderrStr = rawStderr instanceof Buffer ? rawStderr.toString() : String(rawStderr);
        // Truncate to 500 chars to avoid overwhelming evidence strings.
        stderr = stderrStr.slice(0, 500);
        if (stderrStr.length > 500) stderr += " [truncated]";
      }
    }

    const truth = compilesCleanly === expected_compiles;

    const evidence =
      `codeOracle: tsc="${tscVersion}"; ` +
      `snippet="${snippetSummary(snippet)}"; ` +
      `compiles_cleanly=${String(compilesCleanly)}; ` +
      `expected_compiles=${String(expected_compiles)}; ` +
      (stderr ? `stderr="${stderr}"; ` : `stderr=none; `) +
      `truth=${String(truth)}.`;

    return { truth, oracle_evidence: evidence };
  } finally {
    // Invariant: temp directory is always removed regardless of outcome.
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Non-fatal; OS will clean tmpdir eventually.
    }
  }
}

/** Returns a ≤60-char summary of the snippet for evidence strings. */
function snippetSummary(snippet: string): string {
  const oneLine = snippet.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? oneLine.slice(0, 60) + "..." : oneLine;
}
