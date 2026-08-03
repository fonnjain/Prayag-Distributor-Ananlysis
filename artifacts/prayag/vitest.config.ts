// Standalone unit-test config — deliberately NOT reusing vite.config.ts,
// which requires PORT and dev-server plugins that unit tests don't need.
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
  },
});
