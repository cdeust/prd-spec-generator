#!/usr/bin/env bash
#
# ensure-deps.sh — provision the MCP server bundle's externalised runtime
# dependencies on first launch, then exec the server.
#
# The committed bundle (mcp-server/index.js) is produced by `pnpm bundle`
# (esbuild). Three runtime dependencies are intentionally *external* to that
# bundle and must resolve from node_modules at launch:
#
#   - ajv, ajv-formats — ajv's runtime-compiled validators `require()` their
#     helpers (ajv/dist/runtime/*) via specifiers esbuild cannot statically
#     inline, so ajv must exist on disk. Static require => needed at load.
#   - better-sqlite3   — native addon; the platform-specific binary cannot be
#     bundled or committed cross-platform. Loaded via dynamic import() and
#     guarded by tryCreateEvidenceRepository => OPTIONAL: its absence only
#     disables the evidence-DB cache, it does not block startup. Declared as
#     an optionalDependency so a failed native build is non-fatal.
#
# `claude plugin install` clones repository files but runs no install step, so
# this launcher provisions `mcp-server/node_modules` next to the bundle on the
# first run, then hands off to node. Idempotent: it no-ops once the deps are
# present, so steady-state launch cost is a single directory check.
#
# Mirrors automatised-pipeline's bin/ensure-binary.sh ensure-then-exec launcher.
# source: coding-standards.md §2.2 (composition-root provisioning); follow-up to
# the MCP-startup-deadlock fix (PR #2).
#
set -euo pipefail

ROOT="${1:?usage: ensure-deps.sh <plugin-root>}"
SERVER_DIR="${ROOT}/mcp-server"

# ajv is a hard (static) dependency of the bundle; its presence is the
# provisioning sentinel. better-sqlite3 (optional) is installed in the same
# pass and, being an optionalDependency, will not fail the install if its
# native build is unavailable on the host.
if [[ ! -d "${SERVER_DIR}/node_modules/ajv" ]]; then
  echo "prd-gen: first launch — installing MCP server runtime deps…" >&2
  # --no-package-lock: the workspace pins versions via pnpm-lock.yaml; this is a
  # runtime provisioning step into an ephemeral install dir, so we don't litter
  # it with a second (npm) lockfile.
  npm install \
    --prefix "${SERVER_DIR}" \
    --omit=dev --no-audit --no-fund --no-package-lock --loglevel=error >&2
fi

exec node "${SERVER_DIR}/index.js"
