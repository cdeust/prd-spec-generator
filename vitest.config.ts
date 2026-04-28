import { defineConfig } from "vitest/config";

// Vitest v4 root config with explicit projects list. Replaces the legacy
// `vitest.workspace.ts` (which v4 no longer auto-discovers). Listing the
// projects explicitly also prevents glob-based discovery from reaching
// into `.claude/worktrees/agent-*/packages/*/vitest.config.ts` when an
// orchestrator agent is running.
export default defineConfig({
  test: {
    projects: [
      "./packages/benchmark/vitest.config.ts",
      "./packages/core/vitest.config.ts",
      "./packages/ecosystem-adapters/vitest.config.ts",
      "./packages/meta-prompting/vitest.config.ts",
      "./packages/mcp-server/vitest.config.ts",
      "./packages/orchestration/vitest.config.ts",
      "./packages/validation/vitest.config.ts",
      "./packages/verification/vitest.config.ts",
    ],
  },
});
