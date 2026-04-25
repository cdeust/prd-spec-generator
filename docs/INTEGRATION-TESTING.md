# Integration testing

The `pnpm test` suite is hermetic by default — 258 tests run in ~1 second
with no network access, no filesystem dependencies beyond the workspace,
and no external processes. **Two integration tests are deliberately skipped
unless you opt in.** This document explains how to run them.

---

## Why integration tests are gated

The MCP protocol is a contract between this project and three other
ecosystem services (`automatised-pipeline`, `Cortex`, `zetetic-team-subagents`).
Mocked tests prove the protocol matches what THIS project expects; they
do not prove the live counterparties send what THIS project expects.

The integration tests close that gap by spawning a real binary or
connecting to a real service and round-tripping at least one canonical
tool call. They run when you explicitly point the test runner at the
real dependency.

---

## Live `automatised-pipeline` test

**File:** `packages/ecosystem-adapters/src/__tests__/automatised-pipeline.integration.test.ts`

**What it proves:**

- The protocol contract claimed in `handleInputAnalysis` (sends
  `{ path, output_dir, language }`, expects `{ graph_path, ... }` back)
  matches what the live Rust MCP returns.
- The stdio transport (`StdioMcpClient`) connects, calls a tool, and
  parses a real response without crashing.

**What it does NOT prove:**

- Performance, memory, or behaviour at scale.
- Failure-mode handling (only the happy path is exercised).
- Any tool other than `index_codebase` + `health_check`.

### Setup

Build the Rust binary from the companion repo:

```bash
git clone https://github.com/cdeust/automatised-pipeline.git
cd automatised-pipeline
cargo build --release
# First build: ~5 minutes (compiles LadybugDB C++ core).
# Resulting binary: target/release/ai-architect-mcp
```

### Run

```bash
cd /path/to/prd-spec-generator
AIPRD_PIPELINE_BIN=/absolute/path/to/automatised-pipeline/target/release/ai-architect-mcp \
  pnpm test
```

**Optional override:** `AIPRD_PIPELINE_FIXTURE=/path/to/some/codebase` to
index a different directory. Defaults to this repo's own
`packages/core/src` (small, real, parseable by the pipeline's tree-sitter
extractors).

### Expected output

When `AIPRD_PIPELINE_BIN` points to a valid binary:

```
✓ live automatised-pipeline integration > health_check returns a non-empty status
✓ live automatised-pipeline integration > index_codebase returns a graph_path
```

When the env var is missing or the binary doesn't exist:

```
↓ live automatised-pipeline integration (skipped)
```

The skip is deliberate. `vitest`'s `describe.skipIf` predicate evaluates
at test-collection time, so unset → skipped, not failed.

### Failure modes

| Symptom | Likely cause |
|---|---|
| `Error: connect ECONNREFUSED` | Binary started but exited before stdio handshake. Check binary's stderr. |
| `Error: tool not found: index_codebase` | Binary version predates Stage-3a tool implementation. Build a newer release tag. |
| `Error: cannot parse response as JSON` | The pipeline emitted non-JSON-RPC traffic on stdout (typically a panic or log line). File a bug against automatised-pipeline. |
| Test hangs > 30s | The pipeline is stuck on a large-codebase index. Set `AIPRD_PIPELINE_FIXTURE` to a smaller directory. |

---

## Live `Cortex` test (planned, not yet wired)

**Status:** No live Cortex integration test exists in the suite today.
The `call_cortex_tool` action shape is exercised through the canned
dispatcher in smoke + KPI tests, but no test spawns a real Cortex MCP.

**Why:** Cortex requires PostgreSQL + pgvector + a running Cortex MCP
server (Python `uvx` + native dependencies). Standing that up in CI
adds significant complexity for marginal additional coverage — the
`tool_result` shape is already structurally tested and the canned
dispatcher returns the canonical Cortex response shape.

If you want to prove the Cortex contract end-to-end:

1. Install Cortex per its README (`claude plugin install cortex` +
   `cortex-doctor` to verify).
2. Run the prd-spec-generator MCP server with Cortex registered in your
   `.mcp.json`.
3. Drive a real `/generate-prd` session — the section-generation step
   calls `cortex.recall` for each section. Inspect the returned
   `tool_result.data` shape against the parser in
   `packages/orchestration/src/handlers/section-generation.ts:summarizeRecall`.

A proper integration test would spawn a Cortex MCP via stdio, populate
it with seed memories, and assert the recall response. Tracked as a
follow-up item; PRs welcome.

---

## CI policy

**Hermetic suite (always runs):** `pnpm test` — 258 tests + 2 integration
skipped. Mandatory pass on every PR.

**Integration suite (opt-in):** the `AIPRD_PIPELINE_BIN`-gated test.
Currently NOT run in CI because:

- The Rust binary build is ~5 minutes cold (LadybugDB C++ core compile).
- The dependency lives in a separate repo on a different release cadence.

**Roadmap:** add a separate `integration.yml` workflow that runs nightly
against the latest `automatised-pipeline` release tag. Tracked as
follow-up. PRs welcome.

---

## Adding a new integration test

The pattern is `describe.skipIf(!SHOULD_RUN)` where `SHOULD_RUN` derives
from an env var pointing to the real dependency. Keep these conventions:

- **Skip by default.** Never let an integration test fail when the
  dependency isn't installed. The hermetic suite is the contract for
  contributors who don't have the full ecosystem set up.
- **Document the env var in this file.** If you add `AIPRD_FOO_BIN`,
  add a section here describing how to obtain a `foo` binary.
- **Pin a fixture.** Use a small, real artifact in this repo as the
  default test input. Don't depend on absolute paths outside the repo.
- **Time-bound the test.** Cap each `it` at a generous-but-finite
  timeout (10–60s). Hung tests block the whole suite.
- **Document failure modes.** Add a table like the one above. Operators
  diagnosing failures need to distinguish "my setup is wrong" from
  "the upstream contract changed."
