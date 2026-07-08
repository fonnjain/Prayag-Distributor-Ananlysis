import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Test files share the isolated dashboard_test schema; run them one at a
    // time so truncates in one file cannot race inserts in another.
    fileParallelism: false,
    setupFiles: ["./src/__tests__/setup-db.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
