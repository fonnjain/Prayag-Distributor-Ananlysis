import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { aggregateAugustSecondaryHeadRows, resolveProductWiseRows, type MemberKpis } from "./deepDiveData.js";
import { buildDeepDiveExport } from "./deepDiveExport.js";

const people = [
  { canonical_name: "Alice Code", employee_code: "353", norm_key: "alicecode", person_id: 1, state_head: "Head" },
  { canonical_name: "Alice Duplicate", employee_code: "353", norm_key: "alicealias", person_id: 1, state_head: "Head" },
  { canonical_name: "Bob Name", employee_code: null, norm_key: "bobname", person_id: 2, state_head: "Head" },
  { canonical_name: "Collision One", employee_code: "DUP", norm_key: "collisionone", person_id: 3, state_head: "Head" },
  { canonical_name: "Collision Two", employee_code: "DUP", norm_key: "collisiontwo", person_id: 4, state_head: "Head" },
];

describe("Prompt 119 D Product-Wise identity controls", () => {
  it("sums every August head-month row for reconciliation (162 rows / Rs 14.41 Cr fixture)", () => {
    const rows = Array.from({ length: 162 }, (_, i) => ({
      head_canon: `head-${i}`, state_head: i < 81 ? "West" : "East",
      ordered_amount: i < 161 ? 890000 : 810000,
    }));
    const result = aggregateAugustSecondaryHeadRows(rows);
    expect(result.rowCount).toBe(162);
    expect(result.total).toBe(14_410_0000);
    expect(result.byStateHead.get("west")).toBe(81 * 890000);
    expect(result.byStateHead.get("east")).toBe(80 * 890000 + 810000);
  });

  it("merges approved head-name variants in both E-table sources", () => {
    const headMonth = aggregateAugustSecondaryHeadRows([
      { head_canon: "Member A", state_head: "Aqil Rizvi", ordered_amount: 10 },
      { head_canon: "Member B", state_head: "Syed Aqil Rizvi", ordered_amount: 20 },
      { head_canon: "Member C", state_head: "Pawan Sharma", ordered_amount: 30 },
      { head_canon: "Member D", state_head: "Pawan Kumar Sharma", ordered_amount: 40 },
      { head_canon: "Member E", state_head: "Narendra Sharma", ordered_amount: 50 },
      { head_canon: "Member F", state_head: "Narendra Kumar Sharma", ordered_amount: 60 },
    ]);
    expect(headMonth.byStateHead.get("syedaqilrizvi")).toBe(30);
    expect(headMonth.byStateHead.get("pawankumarsharma")).toBe(70);
    expect(headMonth.byStateHead.get("narendrakumarsharma")).toBe(110);

    const productWise = resolveProductWiseRows([
      { employee_id: "A", sales_user_name: null, basic_order_value: 10 },
      { employee_id: "B", sales_user_name: null, basic_order_value: 20 },
    ], [
      { canonical_name: "Member A", employee_code: "A", norm_key: "membera", person_id: 10, state_head: "Aqil Rizvi" },
      { canonical_name: "Member B", employee_code: "B", norm_key: "memberb", person_id: 11, state_head: "Syed Aqil Rizvi" },
    ]);
    expect(productWise.productWiseByStateHead.get("syedaqilrizvi")).toBe(30);
  });

  it("uses employee code first and keeps name fallback only for absent/unresolved code", () => {
    const result = resolveProductWiseRows([
      { employee_id: "PRG-353", sales_user_name: "Wrong Name", basic_order_value: 100 },
      { employee_id: null, sales_user_name: "Bob Name", basic_order_value: 25 },
      { employee_id: "UNKNOWN", sales_user_name: "Bob Name", basic_order_value: 10 },
    ], people);
    expect(result.values.get("alicecode")).toBe(100);
    expect(result.values.get("bobname")).toBe(35);
    expect(result.mappedCount).toBe(3);
    expect(result.unmappedCount).toBe(0);
    expect(result.productWiseByStateHead.get("head")).toBe(135);
  });

  it("withholds ambiguous codes and never lets a conflicting name override them", () => {
    const result = resolveProductWiseRows([
      { employee_id: "DUP", sales_user_name: "Alice Code", basic_order_value: 90 },
      { employee_id: null, sales_user_name: "Collision One", basic_order_value: 20 },
      { employee_id: null, sales_user_name: "Not Registered", basic_order_value: 5 },
    ], people);
    expect(result.mappedCount).toBe(1);
    expect(result.unmappedCount).toBe(2);
    expect(result.values.has("alicecode")).toBe(false);
    expect(result.reasonCounts.employee_code_ambiguous).toBe(1);
    expect(result.reasonCounts.employee_code_absent).toBe(1);
  });

  it("uses a unique HR roster name to resolve only a matching ambiguous registry candidate", () => {
    const result = resolveProductWiseRows([
      { employee_id: "DUP", sales_user_name: "Unrelated Name", basic_order_value: 90 },
    ], people, new Map([["DUP", "Collision Two"]]));
    expect(result.values.get("collisiontwo")).toBe(90);
    expect(result.mappedCount).toBe(1);
    expect(result.unmappedCount).toBe(0);
    expect(result.reasonCounts.employee_code_hr_deterministic).toBe(1);
  });

  it("does not rescue an ambiguous code when HR has no unique matching candidate", () => {
    const result = resolveProductWiseRows([
      { employee_id: "DUP", sales_user_name: "Collision One", basic_order_value: 90 },
    ], people, new Map([["DUP", "Not In Registry"]]));
    expect(result.mappedCount).toBe(0);
    expect(result.unmappedCount).toBe(1);
    expect(result.reasonCounts.employee_code_ambiguous).toBe(1);
  });

  it("preserves separate measures and labels Product-Wise ex-GST in workbook", async () => {
    const kpis = {
      stateHead: "Head", name: "Alice Code", normKey: "alicecode",
      hq: null, designation: null, contact: null, primaryTarget: 1,
      secondaryTarget: 2, monthlyTarget: 1, primaryTargetMonthly: 1,
      secondaryTargetMonthly: 0, totalTargetToDate: 2, elapsedMonths: 1,
      elapsedMonthsFromSheet: 1, isLeft: false, orderBooking: 100,
      directDealersOrder: 0, newPartyOrderBooking: 0, sale: 1,
      achievementPct: 50, achievementSecondary: 5000,
      achievementDirectDealer: 0, achievementTotal: 5000, achievementSale: 50,
      lastYearQ1: null, lastYearQ2: null, lastYearQ3: null, lastYearQ4: null,
      ctcMonthly: null, ctcAnnual: null, taBillStCost: null, costRatio: null,
      workingDaysActual: null, totalOldRetailers: null, visitedRetailers: null,
      nonVisitedRetailers: null,
      businessPerRetailer: null, totalRetailers: null, directDealersCount: null,
      totalVisitsYtd: null, productWiseOrderValue: 35, augustSecondaryHeadOrdered: 12, extra: {},
    } satisfies MemberKpis;
    const workbook = await buildDeepDiveExport({
      fy: "2026-27", kpis, monthlyRows: [], skuSpreadIncluded: false,
      winBackIncluded: false,
    });
    const parsed = new ExcelJS.Workbook();
    await parsed.xlsx.load(workbook as any);
    const sheet = parsed.getWorksheet("Targets and Achievement")!;
    const labels = sheet.getColumn(1).values.map((v: unknown) => String(v));
    expect(labels).toContain("Product-Wise order value (ex-GST)");
    expect(labels).toContain("August secondary_head_month ordered (separate)");
    expect(labels).toContain("Retailer / party order booking");
  });
});