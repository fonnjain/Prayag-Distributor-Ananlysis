import { describe, expect, it } from "vitest";
import { normalizeGraphNode, resolvePath } from "./resolvers.js";
import { runNumericGuard } from "../../../routes/analyze.js";
import type { GraphNode } from "./types.js";
import { PROMPT114_QUESTIONS, PROMPT115_SAFE_FAILURES } from "./prompt115Verification.js";

const node = (measures: GraphNode["measures"]): GraphNode => ({
  path: "test/2026-27", level: "gap", fy: "2026-27", name: "test",
  measures, population: "test", source: "test", cutoff: "test",
  flags: [], parent: null, children: [], childrenSumToParent: null, isGap: false,
});

describe("Prompt 115 graph contract", () => {
  it("strips a held value at the resolver boundary", () => {
    const safe = normalizeGraphNode(node([{
      measure: "gross_margin", label: "PTMT margin", unit: "pct",
      availability: "held", hold: { code: "H1", category: "data quality", reason: "cost hold" },
    }]));
    expect(safe.readTime).toBeTruthy();
    expect(safe.category).toBe("Unmapped");
    expect(safe.measures[0]).not.toHaveProperty("value");
    expect(safe.measures[0].availability).toBe("held");
  });

  it("removes nested numeric metadata and residuals when a nested hold is present", () => {
    const unsafe = {
      ...node([{ measure: "gross_margin", label: "held", unit: "pct", availability: "unavailable",
        basis: { numerator: "n", denominator: "d", population: "p", period: "t", source: "s" } }]),
      detail: { source: { hold: { code: "H1" }, blockedValue: 12345, display: "₹1 Cr" },
        nested: [9, "7"], typed: { measure: "primary_sale", label: "sale", value: 42,
          unit: "INR", availability: "measured" } },
      residual: { value: 12345, description: "blocked residual" },
    };
    const safe = normalizeGraphNode(unsafe);
    expect(JSON.stringify(safe)).not.toContain("12345");
    expect(JSON.stringify(safe)).not.toContain("₹1 Cr");
    expect(safe.residual).toBeNull();
  });

  it("preserves nested typed measures while stripping arbitrary metadata numbers", () => {
    const safe = normalizeGraphNode({
      ...node([]),
      detail: { typed: { measure: "primary_sale", label: "sale", value: 42, unit: "INR", availability: "measured" }, arbitrary: 42 },
    });
    expect(JSON.stringify(safe.detail)).toContain('"value":42');
    expect((safe.detail as Record<string, unknown>).arbitrary).toBeNull();
  });

  it("rejects malformed bounded surface paths instead of falling through to a blanket gap", async () => {
    const result = await resolvePath("penetration/2026-27", "2026-27");
    expect(result.node).toBeNull();
    expect(result.error).toContain("Invalid bounded path contract");
  });

  it("rejects a fabricated crore figure instead of warning", () => {
    const result = runNumericGuard(
      "The answer is Rs 9.99 Cr.",
      [node([{ measure: "primary_sale", label: "dispatch", value: 1_000_000, unit: "INR", availability: "measured" }])],
    );
    expect(result.status).toBe("unmatched");
    expect(result.unmatched).toContain("Rs 9.99 Cr");
  });

  it("accepts only figures present in resolved nodes", () => {
    const result = runNumericGuard(
      "The answer is Rs 1.00 Cr.",
      [node([{ measure: "primary_sale", label: "dispatch", value: 10_000_000, unit: "INR", availability: "measured" }])],
    );
    expect(result.status).toBe("clean");
  });

  it("rejects fabricated percentage, count and plain INR forms", () => {
    const resolved = [node([
      {
        measure: "gross_margin", label: "margin", value: 12.5, unit: "pct",
        availability: "measured",
        basis: { numerator: "n", denominator: "d", population: "p", period: "t", source: "s" },
      },
      { measure: "secondary_ob", label: "count", value: 7, unit: "count", availability: "measured" },
      { measure: "primary_sale", label: "dispatch", value: 1000, unit: "INR", availability: "measured" },
    ])];
    const result = runNumericGuard("Margin 12.6%, 8 customers and Rs 1,001.", resolved);
    expect(result.status).toBe("unmatched");
    expect(result.unmatched).toHaveLength(3);
  });

  it("keeps INR, percentage and count approval sets isolated", () => {
    const resolved = [node([
      { measure: "primary_sale", label: "sale", value: 10_000_000, unit: "INR", availability: "measured" },
      { measure: "gross_margin", label: "margin", value: 1, unit: "pct", availability: "measured",
        basis: { numerator: "n", denominator: "d", population: "p", period: "t", source: "s" } },
      { measure: "secondary_ob", label: "count", value: 1, unit: "count", availability: "measured" },
    ])];
    expect(runNumericGuard("Rs 1.00 Cr", resolved).status).toBe("clean");
    expect(runNumericGuard("1%", [node([{ measure: "primary_sale", label: "sale", value: 1, unit: "INR", availability: "measured" }])]).status).toBe("unmatched");
    expect(runNumericGuard("₹1", [node([{ measure: "secondary_ob", label: "count", value: 1, unit: "count", availability: "measured" }])]).status).toBe("unmatched");
  });

  it("ignores ranking, textual dates and ordered-list markers without weakening figure checks", () => {
    const resolved = [node([
      { measure: "secondary_ob", label: "retailers", value: 7, unit: "count", availability: "measured" },
    ])];
    const metadata =
      "Top 10 retailers. PSCode3 ended on 31 July 2026 and Product-Wise began on 1 August 2026.\n" +
      "August 2026 is complete.\n1) Measured retailers: 7.\n### **2.** Source seam retained.\n" +
      "| Rank | Retailer |\n|---|---|\n| 1 | A |\n| 2 | B |\n- **3** C";
    expect(runNumericGuard(metadata, resolved).status).toBe("clean");

    for (const fabricated of [
      `${metadata}\nThere are 11 retailers.`,
      `${metadata}\nValue is ₹31 Lakh.`,
      `${metadata}\nChange is 2%.`,
      `${metadata}\nUnsupported count: 999.`,
    ]) {
      expect(runNumericGuard(fabricated, resolved).status).toBe("unmatched");
    }
  });

  it("keeps the complete Prompt-114 question and safe-failure inventory", () => {
    expect(PROMPT114_QUESTIONS).toHaveLength(14);
    expect(new Set(PROMPT114_QUESTIONS).size).toBe(14);
    expect(PROMPT115_SAFE_FAILURES).toHaveLength(3);
    expect(PROMPT115_SAFE_FAILURES.every((failure) => failure.expectation.length > 0)).toBe(true);
  });

  it("keeps adapter contracts explicit", async () => {
    const result = await resolvePath("company-report/8/2026-27", "2026-27");
    expect(result.node).toBeNull();
    expect(result.error).toContain("Invalid bounded path contract");
  });
});
