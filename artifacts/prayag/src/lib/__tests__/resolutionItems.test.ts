import { describe, expect, it } from "vitest";
import {
  buildResolutionExportDocument, buildResolutionExportLayout, filterResolutionItems, groupResolutionItems, normalizeResolutionItem, sortResolutionItems, toResolutionExportRows,
  type ResolutionItem,
} from "@/lib/resolutionItems";

const base = {
  code: "R-1", type: "HOLD" as const, title: "Small hold", category: "commercial",
  fiscalYear: "2025-26", month: "May", scopeProduct: "SKU A", scopeMeasure: "sales",
  reason: "r", evidence: "e", valueAtStake: 1000, raisedOn: "2025-05-01", raisedBy: "Asha",
  owner: "Asha", priority: "medium" as const, status: "open" as const, blocksApi: true, daysOpen: 4,
};
const items: ResolutionItem[] = [
  { ...base, id: 1, title: "Small hold" },
  { ...base, id: 2, code: "R-2", type: "PENDING", title: "Large pending", category: "data quality", owner: "Ravi", status: "open", blocksApi: false, scopeMeasure: null, daysOpen: 12, valueAtStake: 9000 },
  { ...base, id: 3, code: "R-3", title: "Resolved", owner: "Asha", status: "resolved", blocksApi: true, daysOpen: 30, valueAtStake: 500, resolutionNote: "Decision recorded" },
];

describe("resolution item transformations", () => {
  it("normalizes nullable API fields and preserves statuses", () => {
    const item = normalizeResolutionItem({ ...base, id: 10, valueAtStake: null, status: "accepted-as-is" });
    expect(item.valueAtStake).toBeNull();
    expect(item.status).toBe("accepted-as-is");
  });

  it("puts open items first, then supports days and value sorting", () => {
    expect(sortResolutionItems(items).map((item) => item.id)).toEqual([2, 1, 3]);
    expect(sortResolutionItems(items, "value-at-stake").map((item) => item.id)).toEqual([2, 1, 3]);
  });

  it("sorts urgent before lower priorities while retaining days-open tie breaking", () => {
    const prioritized = [
      { ...items[0], id: 4, priority: "high" as const, daysOpen: 20 },
      { ...items[1], id: 5, priority: "urgent" as const, daysOpen: 2 },
      { ...items[1], id: 6, priority: "urgent" as const, daysOpen: 10 },
    ];
    expect(sortResolutionItems(prioritized, "priority").map((item) => item.id)).toEqual([6, 5, 4]);
    expect(sortResolutionItems(prioritized, "days-open").map((item) => item.id)).toEqual([4, 6, 5]);
  });

  it("applies owner, category, and type filters without mutating input", () => {
    expect(filterResolutionItems(items, { owner: "Asha", category: "commercial", type: "HOLD" }).map((item) => item.id)).toEqual([1, 3]);
    expect(items.map((item) => item.id)).toEqual([1, 2, 3]);
  });

  it("exports open rows with evidence and groups them by category", () => {
    const rows = toResolutionExportRows(items);
    expect(rows.map((row) => row.title)).toEqual(["Small hold", "Large pending"]);
    expect(rows[0].evidence).toBe("e");
    expect(groupResolutionItems(items).map((group) => `${group.partition}:${group.category}`))
      .toEqual(["open:commercial", "open:data quality", "closed:commercial"]);
  });

  it("keeps every open category section before every closed category section", () => {
    const grouped = groupResolutionItems([
      ...items,
      { ...items[2], id: 4, category: "access" },
    ]);
    expect(grouped.slice(0, 2).every((group) => group.partition === "open")).toBe(true);
    expect(grouped.slice(2).every((group) => group.partition === "closed")).toBe(true);
  });

  it("builds send-as-is export metadata and category sections", () => {
    const report = buildResolutionExportDocument(items, {
      owner: "Asha", category: "all", type: "HOLD", search: "hold",
      sort: "value-at-stake", generatedAt: "Jan 1, 2026, 10:00 am",
    });
    expect(report.title).toBe("Open resolution items");
    expect(report.generatedAt).toContain("Jan 1");
    expect(report.filterContext).toContain("Owner: Asha");
    expect(report.filterContext).toContain("Sort: Value at stake");
    expect(report.sections[0].rows[0]).toMatchObject({ title: "Small hold", evidence: "e" });
  });

  it("keeps the selected value sort within a category section", () => {
    const rows = toResolutionExportRows([
      { ...items[0], id: 5, title: "Lower value", valueAtStake: 10 },
      { ...items[0], id: 6, title: "Higher value", valueAtStake: 100 },
    ], "value-at-stake");
    expect(rows.map((row) => row.title)).toEqual(["Higher value", "Lower value"]);
  });

  it("keeps export title in the first layout row before category headers", () => {
    const report = buildResolutionExportDocument(items, {
      owner: "all", category: "all", type: "all", search: "", sort: "days-open", generatedAt: "Jan 1, 2026",
    });
    const layout = buildResolutionExportLayout(report);
    expect(layout[0]).toEqual(["Open resolution items"]);
    expect(layout.some((row) => row[0] === "Category: commercial")).toBe(true);
    expect(layout.some((row) => row.includes("Evidence") && row.includes("Days open"))).toBe(true);
  });
});