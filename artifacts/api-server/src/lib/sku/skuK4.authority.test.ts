import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
describe("K4 authoritative MRP source isolation", () => {
  it("does not read uploaded item_master MRP in either K4 price path", () => {
    const source = readFileSync(new URL("./skuK4.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bim\.mrp\b/);
    expect(source).not.toMatch(/item_master.*mrp/s);
    expect(source).toContain("authoritativeCurrentMrpRows");
    expect(source).toContain("mrp_history");
  });

  it("selects the active source only for the open FY and an as-of history otherwise", () => {
    const source = readFileSync(new URL("./skuK4.ts", import.meta.url), "utf8");
    expect(source).toContain("fy === currentOpenFy()");
    expect(source).toContain("SELECT item_code, segment, mrp FROM current_mrp");
    expect(source).toContain("SELECT item_code, segment, mrp FROM historical_mrp");
    expect(source).toContain("h.effective_from <= ${historicalAsOf}");
  });
});