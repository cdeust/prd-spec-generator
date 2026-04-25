import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@prd-gen/benchmark",
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
