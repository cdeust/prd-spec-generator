#!/usr/bin/env bash
# publish-mcp-registry.sh — Publish runbook for prd-spec-generator to the MCP ecosystem.
#
# NOTE (#23, since release.yml's "Commit and push patched server.json to
# main" step): the release workflow now patches server.json's
# packages[0].file_sha256 with the real .mcpb checksum automatically on
# every tag push and commits it to main. Steps 1-4 below are a MANUAL
# FALLBACK — use them only if a release's CI run skipped or failed that
# step (e.g. because the auto-push was rejected as non-fast-forward, or
# for a tag cut before #23 landed). Steps 5-8 (mcp-publisher submission)
# are still manual regardless.
#
# USAGE:
#   ./scripts/publish-mcp-registry.sh <tag>
#   ./scripts/publish-mcp-registry.sh v0.4.0
#
# WHAT THIS SCRIPT DOES:
#   1. Downloads the released prd-spec-generator.mcpb from GitHub Releases.
#   2. Computes its SHA-256 and writes it into server.json .packages[0].file_sha256.
#   3. Prints the mcp-publisher commands you must run manually to submit to all three
#      registries (MCP Registry, Glama, Anthropic MCP Directory).
#
# WHAT THIS SCRIPT DOES NOT DO:
#   - It does NOT run mcp-publisher itself.
#   - It does NOT git commit or push.
#   - It does NOT create a GitHub Release (that is done by the CI workflow).
#
# PRE-REQUISITES:
#   - jq installed (brew install jq / apt-get install jq)
#   - curl installed
#   - shasum available (macOS built-in; on Linux: sha256sum)
#   - mcp-publisher installed: npm install -g mcp-publisher  (or npx -y mcp-publisher)
#   - GitHub CLI authenticated: gh auth login
#
# FULL PUBLISH RUNBOOK
# ════════════════════
#
# Step 1  — Tag and push the release (triggers CI, which builds the .mcpb):
#             git tag v0.4.0
#             git push origin v0.4.0
#
# Step 2  — Wait for the CI release job to complete. Confirm the .mcpb and
#             .sha256 artifacts appear on the GitHub release page.
#
# Step 3  — Run this script to patch server.json with the real SHA-256:
#             ./scripts/publish-mcp-registry.sh v0.4.0
#
# Step 4  — Commit the updated server.json:
#             git add server.json
#             git commit -m "chore: update server.json sha256 for v0.4.0"
#             git push origin main
#
# Step 5  — Authenticate with mcp-publisher (GitHub OAuth):
#             mcp-publisher login github
#
# Step 6  — Submit to MCP Registry (uses server.json):
#             mcp-publisher publish
#
# Step 7  — Submit to Glama (uses glama.json; may be automatic on registry merge):
#             # Glama crawls repos that have glama.json — typically no manual step needed.
#             # If Glama provides a CLI: mcp-publisher publish --registry glama
#
# Step 8  — Submit to Anthropic MCP Directory / Claude Desktop bundle:
#             # The Anthropic directory indexes servers listed in the MCP Registry.
#             # No separate submission is required once Step 6 is approved.
#
# ════════════════════

set -euo pipefail

TAG="${1:-}"
if [ -z "${TAG}" ]; then
  echo "Usage: $0 <tag>  (e.g. $0 v0.4.0)" >&2
  exit 1
fi

REPO="cdeust/prd-spec-generator"
BUNDLE_NAME="prd-spec-generator.mcpb"
RELEASE_URL="https://github.com/${REPO}/releases/download/${TAG}/${BUNDLE_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVER_JSON="${REPO_ROOT}/server.json"

echo "==> Downloading ${BUNDLE_NAME} from ${RELEASE_URL} ..."
TMP_FILE="$(mktemp /tmp/prd-spec-generator-XXXXXX.mcpb)"
curl -fSL "${RELEASE_URL}" -o "${TMP_FILE}"

echo "==> Computing SHA-256 ..."
if command -v shasum >/dev/null 2>&1; then
  SHA256="$(shasum -a 256 "${TMP_FILE}" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA256="$(sha256sum "${TMP_FILE}" | awk '{print $1}')"
else
  echo "ERROR: neither shasum nor sha256sum found." >&2
  exit 1
fi
rm -f "${TMP_FILE}"

echo "==> SHA-256: ${SHA256}"

echo "==> Patching server.json ..."
PATCHED="$(jq --arg sha "${SHA256}" '.packages[0].file_sha256 = $sha' "${SERVER_JSON}")"
echo "${PATCHED}" > "${SERVER_JSON}"
echo "    server.json updated."

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  NEXT STEPS (run these commands manually after reviewing)"
echo "══════════════════════════════════════════════════════════"
echo ""
echo "  # Commit the updated server.json:"
echo "  git add server.json"
echo "  git commit -m 'chore: update server.json sha256 for ${TAG}'"
echo "  git push origin main"
echo ""
echo "  # Authenticate and publish to MCP Registry:"
echo "  mcp-publisher login github"
echo "  mcp-publisher publish"
echo ""
echo "══════════════════════════════════════════════════════════"
