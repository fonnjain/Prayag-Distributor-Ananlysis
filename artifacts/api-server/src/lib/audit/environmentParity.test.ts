import { describe, expect, it } from "vitest";
import {
  compareEnvironmentParity,
  type EnvironmentParitySnapshot,
} from "./environmentParity.js";

function snapshot(environment: string, masterPopulation: number, rows = 20_000): EnvironmentParitySnapshot {
  return {
    environment,
    database: "PostgreSQL",
    queriedAt: "2026-09-17T00:00:00.000Z",
    metrics: [{
      table: "canonical_item_category_registry",
      rowCount: rows,
      distinctKeys: 10_000,
      populatedKeys: rows,
      materialColumn: "master_category",
      populatedMaterial: masterPopulation,
      distinctMaterial: masterPopulation === 0 ? 0 : 6,
    }],
  };
}

describe("environment parity comparison", () => {
  it("fails a zero-versus-populated key-column divergence", () => {
    const checks = compareEnvironmentParity(snapshot("development", 0), snapshot("production", 10_417));
    expect(checks.find((check) => check.key.endsWith("master_category.population"))?.status).toBe("fail");
  });

  it("reports material row drift", () => {
    const checks = compareEnvironmentParity(snapshot("development", 10_417, 9_758), snapshot("production", 10_417, 20_116));
    expect(checks.find((check) => check.key.endsWith("row_count"))?.status).toBe("warn");
  });

  it("passes equal snapshots", () => {
    expect(compareEnvironmentParity(snapshot("development", 10_417), snapshot("production", 10_417))
      .every((check) => check.status === "pass")).toBe(true);
  });

  it("fails closed when either environment is unavailable", () => {
    expect(compareEnvironmentParity(snapshot("development", 10_417), null)[0]).toMatchObject({
      status: "fail",
      production: null,
    });
  });
});