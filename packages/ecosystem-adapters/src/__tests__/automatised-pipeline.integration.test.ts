/**
 * Live integration test against the automatised-pipeline MCP server.
 *
 * Spawns the real Rust binary at
 *   /Users/cdeust/Developments/anthropic/ai-automatised-pipeline/target/release/ai-architect-mcp
 * via stdio, calls index_codebase against this repository's own
 * packages/core directory, and asserts the response shape matches what
 * handleInputAnalysis expects (graph_path string, no critical errors).
 *
 * What this PROVES:
 *   ✓ The protocol contract claimed in handleInputAnalysis (sends
 *     `{ path, output_dir, language }`, expects `{ graph_path, ... }`)
 *     actually matches what the live Rust MCP returns.
 *   ✓ The stdio transport (StdioMcpClient) connects, calls a tool, and
 *     parses a real response without crashing.
 *
 * What this does NOT prove:
 *   ✗ Performance, memory, or behaviour at scale.
 *   ✗ Failure-mode handling (the test only exercises the happy path).
 *   ✗ Any tool other than index_codebase + health_check.
 *
 * GATING:
 *   The test is SKIPPED unless the AIPRD_PIPELINE_BIN env var points to a
 *   built ai-architect-mcp binary. This keeps CI hermetic; the test fires
 *   only when a developer explicitly opts into integration mode.
 *
 *   Run locally with:
 *     AIPRD_PIPELINE_BIN=/path/to/ai-architect-mcp pnpm test
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomatisedPipelineClient } from "../index.js";

const PIPELINE_BIN = process.env.AIPRD_PIPELINE_BIN;
const FIXTURE_PATH =
  process.env.AIPRD_PIPELINE_FIXTURE ??
  // Default fixture: this repo's own core package source — small, real, indexed
  // by the same tree-sitter parsers the pipeline supports.
  "/Users/cdeust/Developments/prd-spec-generator/packages/core/src";

const SHOULD_RUN =
  PIPELINE_BIN !== undefined &&
  PIPELINE_BIN.length > 0 &&
  existsSync(PIPELINE_BIN);

// Explicit skip-with-reason: a silent skip would hide misconfigured CI from
// the developer. The log line below surfaces when the binary is absent so
// the developer knows WHY the tests did not run rather than assuming they
// passed.
// source: test-engineer TE3 (Phase 3+4 cross-audit, 2026-04) — existsSync
// gate must be loud, not silent.
if (!SHOULD_RUN) {
  const reason = PIPELINE_BIN === undefined || PIPELINE_BIN.length === 0
    ? "AIPRD_PIPELINE_BIN is not set"
    : `AIPRD_PIPELINE_BIN binary not found at: ${PIPELINE_BIN}`;
  console.warn(
    `[integration skip] live automatised-pipeline tests NOT running: ${reason}. ` +
    "To enable: AIPRD_PIPELINE_BIN=/path/to/ai-architect-mcp pnpm test",
  );
}

describe.skipIf(!SHOULD_RUN)(
  "live automatised-pipeline integration",
  () => {
    let client: AutomatisedPipelineClient;
    let tmpOutputDir: string;

    beforeAll(async () => {
      tmpOutputDir = mkdtempSync(join(tmpdir(), "prd-gen-pipeline-"));
      client = new AutomatisedPipelineClient({
        command: PIPELINE_BIN!,
        args: [],
      });
      await client.connect();
    }, 30_000);

    afterAll(async () => {
      await client.close();
      rmSync(tmpOutputDir, { recursive: true, force: true });
    });

    it("health_check returns a non-empty status", async () => {
      const health = await client.healthCheck();
      expect(health.status).toBeDefined();
      expect(typeof health.status).toBe("string");
      expect(health.status.length).toBeGreaterThan(0);
    }, 10_000);

    it(
      "index_codebase returns graph_path on real source",
      async () => {
        const response = await client.indexCodebase({
          path: FIXTURE_PATH,
          output_dir: tmpOutputDir,
          language: "auto",
          refresh: false,
        });

        // Match the contract handleInputAnalysis depends on. The smoke
        // harness FAKES this shape; this test verifies it against the real
        // server.
        const data = response as unknown as {
          graph_path?: string;
          symbols_indexed?: number;
          files_parsed?: number;
        };
        // The response field is `graph_path` on the live server (per
        // tool_schemas.rs), even though our IndexCodebaseResponseSchema
        // currently expects `graph_id` — verifying this exposes the
        // schema/server divergence.
        expect(typeof data.graph_path).toBe("string");
        expect(data.graph_path!.length).toBeGreaterThan(0);
      },
      60_000,
    );
  },
);
