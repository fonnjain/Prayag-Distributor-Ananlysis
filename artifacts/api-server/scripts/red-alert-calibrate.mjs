#!/usr/bin/env node
// Red Alert calibration wrapper.
// Builds the TypeScript source then runs the calibration entry point.
// Direct DB access — no running server required.
//
// Usage:
//   node artifacts/api-server/scripts/red-alert-calibrate.mjs

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const artifactDir = path.resolve(__dirname, "..");

console.log("▶  Building api-server…");
execSync("node build.mjs", { cwd: artifactDir, stdio: "inherit" });
console.log("✓  Build complete.\n");

console.log("▶  Running Red Alert calibration…\n");
execSync("node --enable-source-maps dist/redAlertCalibrate.mjs", {
  cwd: artifactDir,
  stdio: "inherit",
  env: { ...process.env },
});
