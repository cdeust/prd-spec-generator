#!/usr/bin/env bash
# dispatch-engineer.sh — atomic worktree spawn for parallel engineer agents
# Usage: scripts/dispatch-engineer.sh <agent-id> <branch-name> [base-branch]
# Exits non-zero if any precondition fails. Prints worktree path to stdout on success.
# Source: COASE_DISPATCH_POLICY_2026-05-04.md §5

set -euo pipefail

AGENT_ID="${1:?agent-id required}"
BRANCH="${2:?branch-name required}"
BASE="${3:-main}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_PATH="${REPO_ROOT}/.claude/worktrees/${AGENT_ID}"

# 1. Assert working tree is clean (ignore untracked .claude/ directory)
DIRTY=$(git -C "${REPO_ROOT}" status --porcelain | grep -v '^?? \.claude/' || true)
if [[ -n "${DIRTY}" ]]; then
  echo "ERROR: working tree is dirty — cannot dispatch agent ${AGENT_ID}" >&2
  echo "${DIRTY}" >&2
  exit 1
fi

# 2. Assert target worktree slot does not already exist
if git -C "${REPO_ROOT}" worktree list --porcelain | grep -q "worktree ${WORKTREE_PATH}$"; then
  echo "ERROR: worktree ${WORKTREE_PATH} already exists — is a previous agent still running?" >&2
  exit 1
fi

# 3. Create worktree on a new branch
git -C "${REPO_ROOT}" worktree add "${WORKTREE_PATH}" -b "${BRANCH}" "${BASE}"

# 4. Install dependencies inside the worktree
if [[ -f "${REPO_ROOT}/pnpm-lock.yaml" ]]; then
  (cd "${WORKTREE_PATH}" && pnpm install --frozen-lockfile --silent)
fi

# 5. Install per-worktree pre-push hook
HOOK_PATH="${WORKTREE_PATH}/.git/hooks/pre-push"
# Note: git worktree shares .git — hook lives at the shared hooks path but we
# inject a worktree-scoped check via a GIT_DIR-aware wrapper.
HOOKS_DIR="${REPO_ROOT}/.git/hooks"
cat > "${HOOKS_DIR}/pre-push" <<'HOOK'
#!/usr/bin/env bash
# pre-push: verify agent has not written outside its assigned worktree
# Installed by dispatch-engineer.sh per COASE_DISPATCH_POLICY_2026-05-04
set -euo pipefail

WORKTREE=$(git rev-parse --show-toplevel)
VIOLATIONS=$(git -C "${WORKTREE}" status --porcelain | awk '{print $2}' | while read -r f; do
  REAL=$(realpath "${WORKTREE}/${f}" 2>/dev/null || true)
  if [[ -n "${REAL}" && "${REAL}" != "${WORKTREE}"* ]]; then
    echo "ISOLATION VIOLATION: ${f} resolves outside worktree root"
  fi
done)

if [[ -n "${VIOLATIONS}" ]]; then
  echo "${VIOLATIONS}" >&2
  exit 1
fi
HOOK
chmod +x "${HOOKS_DIR}/pre-push"

# 6. Emit worktree path for orchestrator capture
echo "${WORKTREE_PATH}"
