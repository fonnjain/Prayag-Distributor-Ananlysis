import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { JULY_PSCODE3_CONTROL, reconcileIndependentJulyProductWise } from "./julyReconciliation.js";

describe("isolated July Product-Wise reconciliation gate", () => {
  it("reports BLOCKED without an independent July file", async () => {
    const report = await reconcileIndependentJulyProductWise(null);
    expect(report.status).toBe("BLOCKED");
    expect(report.reason).toContain("cannot be measured");
  });

  it("keeps the PSCode3 control as a target and the gate read-only", () => {
    expect(JULY_PSCODE3_CONTROL).toEqual({ rows: 34147, net: 223436806, gross: 442326730.10 });
    const source = readFileSync(new URL("./julyReconciliation.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
    expect(source).not.toContain("secondary_sku_line");
  });
});