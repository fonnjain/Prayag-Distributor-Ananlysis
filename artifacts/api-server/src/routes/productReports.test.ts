import { describe, expect, it } from "vitest";
import {
  PRODUCT_CATEGORIES,
  categorySelectionSql,
  parseProductCategory,
} from "./productReports.js";
import { PgDialect } from "drizzle-orm/pg-core";

describe("product report category validation", () => {
  it("accepts the explicit All and Unmapped tabs plus registry categories", () => {
    expect(parseProductCategory(undefined)).toBe("All");
    expect(parseProductCategory("All")).toBe("All");
    expect(parseProductCategory("Unmapped")).toBe("Unmapped");
    for (const category of PRODUCT_CATEGORIES) {
      expect(parseProductCategory(category)).toBe(category);
    }
  });

  it("rejects unrecognised, blank, and repeated category values", () => {
    expect(parseProductCategory("")).toBeNull();
    expect(parseProductCategory("UPVC ")).toBeNull();
    expect(parseProductCategory(["UPVC"])).toBeNull();
    expect(parseProductCategory("Other")).toBeNull();
  });

  it("uses half-open effective dates for named and Unmapped selections", () => {
    const dialect = new PgDialect();
    const named = dialect.sqlToQuery(categorySelectionSql("UPVC", "sl")).sql.toLowerCase();
    const unmapped = dialect.sqlToQuery(categorySelectionSql("Unmapped", "sl")).sql.toLowerCase();

    expect(named).toContain("r.effective_from <=");
    expect(named).toContain("< r.effective_to");
    expect(named).toContain("exists");
    expect(unmapped).toContain("not exists");
    expect(unmapped).toContain("< r.effective_to");
    expect(named).not.toContain("r.effective_to >=");
    expect(unmapped).not.toContain("r.effective_to >=");
  });
});