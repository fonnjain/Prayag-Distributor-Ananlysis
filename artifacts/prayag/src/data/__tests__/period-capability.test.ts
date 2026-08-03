// Regression guard: Regional and Coverage are current-FY snapshot pages.
// Their data sources (order-book / roster aggregates) have no FY dimension,
// so they must stay NONE (FY selector hidden) and their filter trees must be
// pinned to DEFAULT_FY — otherwise a historical FY selection would combine
// that FY's filter options with current data.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getCapabilityForPath } from "../period-capability";

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

describe("snapshot-only report pages", () => {
  it("Regional and Coverage are not FY-selectable", () => {
    expect(getCapabilityForPath("/regional")).toBe("NONE");
    expect(getCapabilityForPath("/resources")).toBe("NONE");
  });

  it("their filter trees are pinned to DEFAULT_FY, not the global FY", () => {
    for (const rel of ["components/dashboard/Regional.tsx", "components/dashboard/Resources.tsx"]) {
      const code = src(rel);
      expect(code, rel).toMatch(/fy=\{DEFAULT_FY\}/);
      expect(code, rel).not.toMatch(/useGlobalFilter/);
    }
  });
});
