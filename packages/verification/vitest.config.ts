import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const PKG_ROOT = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    name: "@prd-gen/verification",
    root: PKG_ROOT,
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", "**/.claude/**"],
  },
});
