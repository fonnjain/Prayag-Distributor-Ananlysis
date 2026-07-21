import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Unit tests that mock all I/O — no DB schema setup needed.
    setupFiles: [],
    testTimeout: 15_000,
  },
});
