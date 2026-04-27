/**
 * Reliability wiring — composition-root helpers for the
 * ConsensusReliabilityProvider port (Wave D2).
 *
 * Responsibilities:
 *   1. Construct SqliteReliabilityRepository pointing at ~/.prd-gen/reliability.db.
 *   2. Wrap it in BenchmarkConsensusReliabilityProvider.
 *   3. Provide a startup health check that verifies the DB is openable and
 *      schema_version matches RELIABILITY_SCHEMA_VERSION.
 *
 * Layer contract (§2.2):
 *   mcp-server (composition root) → benchmark (adapter) → core (port)
 *   This is the ONLY file in mcp-server that imports @prd-gen/benchmark.
 *
 * DIP (§1.5): core declares the interface; benchmark implements it; this
 * composition-root module wires them at startup.
 *
 * source: docs/PHASE_4_PLAN.md §4.1; Wave D2 deliverable D2.4 / D2.6.
 * source: coding-standards §2.3 (composition roots wire adapters).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import {
  tryCreateReliabilityRepository,
  RELIABILITY_SCHEMA_VERSION,
  type ConsensusReliabilityProvider,
} from "@prd-gen/core";
import type { ReliabilityRepository } from "@prd-gen/core";
import { BenchmarkConsensusReliabilityProvider } from "@prd-gen/benchmark";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Default path for the reliability SQLite DB.
 * source: docs/PHASE_4_PLAN.md §4.1 Persistence — "~/.prd-gen/reliability.db"
 */
const DEFAULT_RELIABILITY_DB_PATH = join(homedir(), ".prd-gen", "reliability.db");

// ─── Lazy singleton ───────────────────────────────────────────────────────────

let _reliabilityRepo: ReliabilityRepository | null | undefined = undefined;
let _reliabilityProvider: ConsensusReliabilityProvider | null | undefined = undefined;

/**
 * Lazy-init the SqliteReliabilityRepository.
 *
 * Precondition: none (gracefully returns null when better-sqlite3 is absent).
 * Postcondition:
 *   - Returns the same instance on subsequent calls (lazy singleton).
 *   - Returns null if better-sqlite3 is not available or the DB cannot be opened.
 */
export function getReliabilityRepo(): ReliabilityRepository | null {
  if (_reliabilityRepo === undefined) {
    _reliabilityRepo = tryCreateReliabilityRepository(DEFAULT_RELIABILITY_DB_PATH);
  }
  return _reliabilityRepo;
}

/**
 * Lazy-init the BenchmarkConsensusReliabilityProvider.
 *
 * Precondition: none (returns null when the repository is unavailable).
 * Postcondition:
 *   - Returns the same instance on subsequent calls.
 *   - Returns null when better-sqlite3 is absent or the DB failed to open.
 * Backward-compat invariant: when null is returned, consensus falls back to
 *   the Beta(7,3) prior mean for all (judge × claim_type) cells.
 *
 * source: ConsensusConfig.reliabilityProvider doc — "when absent, all weights
 *   fall back to the prior (identical to pre-Wave-D behaviour)."
 */
export function getConsensusReliabilityProvider(): ConsensusReliabilityProvider | null {
  if (_reliabilityProvider === undefined) {
    const repo = getReliabilityRepo();
    _reliabilityProvider =
      repo !== null ? new BenchmarkConsensusReliabilityProvider(repo) : null;
  }
  // After the undefined check above, _reliabilityProvider is always null or a provider.
  return _reliabilityProvider as ConsensusReliabilityProvider | null;
}

/**
 * Release the reliability DB connection on graceful shutdown.
 *
 * Precondition: may be called at any time, including before init.
 * Postcondition: DB connection is closed; subsequent calls to getReliabilityRepo()
 *   will re-open it.
 *
 * Idempotent — safe to call multiple times or before first use.
 *
 * source: Wave D2.C step 4 — teardown path.
 * source: ReliabilityRepository.close() — "Idempotent. Release the DB connection."
 */
export function closeReliabilityRepo(): void {
  if (_reliabilityRepo !== null && _reliabilityRepo !== undefined) {
    _reliabilityRepo.close();
  }
  _reliabilityRepo = null;
  _reliabilityProvider = null;
}

// ─── Health check (D2.6) ─────────────────────────────────────────────────────

export interface ReliabilityHealthResult {
  readonly healthy: boolean;
  readonly schemaVersion: number | null;
  readonly recordCount: number | null;
  readonly message: string;
}

/**
 * Startup health check for the reliability DB.
 *
 * Checks:
 *   1. DB is openable (better-sqlite3 available + file accessible).
 *   2. schema_version matches RELIABILITY_SCHEMA_VERSION (= 2).
 *   3. If DB is empty, emits a one-time log line about prior fallback.
 *
 * Postcondition:
 *   - healthy: true  → DB is ready for reads/writes.
 *   - healthy: false → composition root should NOT wire the provider and MUST
 *     operate in prior-fallback mode; the message describes why.
 *
 * FAILS_ON: better-sqlite3 not installed (native module missing).
 * FAILS_ON: schema_version mismatch (pre-rename DB with version 1).
 * FAILS_ON: DB file is locked by another process longer than the busy_timeout.
 *
 * source: Wave D2 deliverable D2.6.
 * source: RELIABILITY_SCHEMA_VERSION doc — "throws a CLEAR error pointing at
 *   the README note about deletion" when schema_version is wrong.
 */
export function checkReliabilityHealth(): ReliabilityHealthResult {
  const repo = getReliabilityRepo();

  if (repo === null) {
    return {
      healthy: false,
      schemaVersion: null,
      recordCount: null,
      message:
        "reliability.db unavailable: better-sqlite3 not installed or DB failed to open. " +
        "Consensus will use Beta(7,3) prior fallback for all (judge × claim_type) cells.",
    };
  }

  let schemaVersion: number;
  try {
    schemaVersion = repo.getSchemaVersion();
  } catch (err) {
    return {
      healthy: false,
      schemaVersion: null,
      recordCount: null,
      message:
        `reliability.db schema check failed: ${String(err)}. ` +
        "If schema_version is 1 (pre-rename DB), delete ~/.prd-gen/reliability.db " +
        "and restart — see README §reliability-db for migration instructions.",
    };
  }

  if (schemaVersion !== RELIABILITY_SCHEMA_VERSION) {
    return {
      healthy: false,
      schemaVersion,
      recordCount: null,
      message:
        `reliability.db schema version mismatch: DB has version ${schemaVersion}, ` +
        `implementation expects version ${RELIABILITY_SCHEMA_VERSION}. ` +
        "Delete ~/.prd-gen/reliability.db and restart — see README §reliability-db.",
    };
  }

  const records = repo.getAllRecords();
  const recordCount = records.length;

  if (recordCount === 0) {
    // One-time informational log: cold start, using prior for everything.
    // Not a failure — the DB is healthy, just empty.
    console.error(
      "[prd-gen] reliability.db: no calibrated reliabilities yet — " +
        "consensus using Beta(7,3) prior fallback for all (judge × claim_type) cells.",
    );
  }

  return {
    healthy: true,
    schemaVersion,
    recordCount,
    message:
      recordCount === 0
        ? "reliability.db is empty — consensus using Beta(7,3) prior fallback."
        : `reliability.db healthy: ${recordCount} calibrated (judge × claim_type × direction) cells.`,
  };
}
