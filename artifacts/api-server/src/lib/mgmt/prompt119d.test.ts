import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { aggregateAugustSecondaryHeadRows, resolveProductWiseRows, type MemberKpis } from "./deepDiveData.js";
import { buildDeepDiveExport } from "./deepDiveExport.js";
import { CRM_USER_HEAD_MAP_AUTHORITY } from "../../../../../lib/db/src/seed/crmUserHeadAuthority.js";

const people = [
  { canonical_name: "Alice Code", employee_code: "353", norm_key: "alicecode", person_id: 1, state_head: "Head" },
  { canonical_name: "Alice Duplicate", employee_code: "353", norm_key: "alicealias", person_id: 1, state_head: "Head" },
  { canonical_name: "Bob Name", employee_code: null, norm_key: "bobname", person_id: 2, state_head: "Head" },
  { canonical_name: "Collision One", employee_code: "DUP", norm_key: "collisionone", person_id: 3, state_head: "Head" },
  { canonical_name: "Collision Two", employee_code: "DUP", norm_key: "collisiontwo", person_id: 4, state_head: "Head" },
];

describe("Prompt 119 D Product-Wise identity controls", () => {
  it("contains the reviewed 152 full-ID/name keys and canonical head spellings", () => {
    expect(CRM_USER_HEAD_MAP_AUTHORITY).toHaveLength(152);
    const keys = CRM_USER_HEAD_MAP_AUTHORITY.map((row) =>
      `${row.employeeId.toUpperCase()}|${row.salesUserName.toLowerCase().replace(/[^a-z0-9]+/g, "")}`,
    );
    expect(new Set(keys).size).toBe(152);
    expect(new Set(CRM_USER_HEAD_MAP_AUTHORITY.map((row) => row.stateHead))).toEqual(
      new Set([
        "Sandeep Dadheech", "Syed Aqil Rizvi", "Lalan Kumar", "Anant Singh",
        "Biju C.O", "Pawan Kumar Sharma", "Sunil Patel", "Sulinder Pal",
        "Nasir Hussain Khan",
      ]),
    );
    const totals = new Map<string, number>();
    for (const row of CRM_USER_HEAD_MAP_AUTHORITY) {
      totals.set(row.stateHead, (totals.get(row.stateHead) ?? 0) + row.augValue);
    }
    expect(Object.fromEntries(totals)).toEqual({
      "Sandeep Dadheech": 123742880,
      "Syed Aqil Rizvi": 37557506,
      "Lalan Kumar": 11240415,
      "Anant Singh": 8646568,
      "Biju C.O": 6725577,
      "Pawan Kumar Sharma": 3511104,
      "Sunil Patel": 1722676,
      "Sulinder Pal": 1404844,
      "Nasir Hussain Khan": 1236719,
    });
    expect(totals.has("[Unresolved]")).toBe(false);
  });

  it("uses the authority map before registry, requires the full exact pair, and marks misses NEW", () => {
    const authority = [{
      employee_id: "PRG-001",
      sales_user_name: "Mapped User",
      state_head: "Syed Aqil Rizvi",
      effective_from: "2026-08-01",
      effective_to: null,
    }];
    const registry = [
      { canonical_name: "Conflicting Registry", employee_code: "PRG-001", norm_key: "conflict", person_id: 1, state_head: "Sunil Patel" },
      { canonical_name: "Fallback User", employee_code: "PRG-002", norm_key: "fallback", person_id: 2, state_head: "Pawan Kumar Sharma" },
    ];
    const result = resolveProductWiseRows([
      { employee_id: "PRG-001", sales_user_name: "Mapped User", basic_order_value: 10, order_datetime: "2026-08-01T00:00:00+05:30" },
      { employee_id: "001", sales_user_name: "Mapped User", basic_order_value: 20, order_datetime: "2026-08-02T00:00:00+05:30" },
      { employee_id: "PRG-002", sales_user_name: "Fallback User", basic_order_value: 30, order_datetime: "2026-08-02T00:00:00+05:30" },
      { employee_id: "PRG-999", sales_user_name: "Unknown User", basic_order_value: 40, order_datetime: "2026-08-02T00:00:00+05:30" },
    ], registry, new Map(), authority);
    expect(result.productWiseByStateHead.get("syedaqilrizvi")).toBe(10);
    expect(result.productWiseByStateHead.get("pawankumarsharma")).toBe(30);
    expect(result.newUsers).toEqual(expect.arrayContaining([
      expect.objectContaining({ employeeId: "PRG-002", resolution: "registry_fallback", value: 30 }),
      expect.objectContaining({ employeeId: "PRG-999", resolution: "unresolved", value: 40 }),
    ]));
    expect(result.values.get("mappeduser")).toBe(10);
  });

  it("does not apply an authority row before its effective date", () => {
    const result = resolveProductWiseRows([
      { employee_id: "PRG-001", sales_user_name: "Mapped User", basic_order_value: 10, order_datetime: "2026-07-31T23:59:59+05:30" },
      { employee_id: "PRG-001", sales_user_name: "Mapped User", basic_order_value: 20, order_datetime: "2026-08-01T00:00:00+05:30" },
    ], [
      { canonical_name: "Fallback User", employee_code: "PRG-001", norm_key: "fallback", person_id: 1, state_head: "Pawan Kumar Sharma" },
    ], new Map(), [{
      employee_id: "PRG-001", sales_user_name: "Mapped User", state_head: "Syed Aqil Rizvi",
      effective_from: "2026-08-01", effective_to: null,
    }]);
    expect(result.productWiseByStateHead.get("pawankumarsharma")).toBe(10);
    expect(result.productWiseByStateHead.get("syedaqilrizvi")).toBe(20);
  });
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