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
import { type ConsensusReliabilityProvider } from "@prd-gen/core";
import type { ReliabilityRepository } from "@prd-gen/core";
/**
 * Lazy-init the SqliteReliabilityRepository.
 *
 * Precondition: none (gracefully returns null when better-sqlite3 is absent).
 * Postcondition:
 *   - Returns the same instance on subsequent calls (lazy singleton).
 *   - Returns null if better-sqlite3 is not available or the DB cannot be opened.
 */
export declare function getReliabilityRepo(): ReliabilityRepository | null;
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
export declare function getConsensusReliabilityProvider(): ConsensusReliabilityProvider | null;
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
export declare function closeReliabilityRepo(): void;
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
export declare function checkReliabilityHealth(): ReliabilityHealthResult;
//# sourceMappingURL=reliability-wiring.d.ts.map