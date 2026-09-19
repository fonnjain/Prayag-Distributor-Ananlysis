import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  resolveProductWiseHeaders,
  validateProductWiseValues,
} from "./productWiseHeaders.js";
import { prepareProductWiseAug26Load, prepareProductWiseRangeLoad } from "./productWiseAug26.js";
import {
  assertPrompt121Sep26Controls,
  normalizeProductWiseNullableText,
} from "../secondaryOrders/loader.js";

const AUGUST = [
  "Date", "Order ID", "Sales User Name", "Customer Name", "Dealer ID",
  "Dealer Mobile", "Channel Partner Name", "CP Code", "State", "District",
  "City", "Pincode", "Category Name", "Product Code", "GST (%)",
  "GST Amount", "Qty", "Discount (%)", "Discount Amount",
  "Dealer Order Value", "Basic Order Value", "Order Status",
];
const SEPTEMBER = [
  "Date", "Order ID", "Sales User Name", "Employee ID", "Reporting Manager",
  "Retailer Company Name", "Retailer ID", "Retailer Mobile", "Distributor",
  "Distributor Code", "State", "District", "City", "Pincode", "Segment",
  "Product Code", "GST Type", "GST (%)", "GST Amount", "Qty", "Discount (%)",
  "Discount Amount", "Sub Total", "Retailer Net Amount", "Order Status",
];

async function syntheticWorkbook(headers: string[], values: unknown[]): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(headers);
  sheet.addRow(values);
  const file = `/tmp/product-wise-header-contract-${process.pid}-${headers.length}.xlsx`;
  await workbook.xlsx.writeFile(file);
  return file;
}

describe("Product-Wise header contract", () => {
  it("accepts the reviewed August workbook shape", async () => {
    const file = await syntheticWorkbook(AUGUST, [
      "02-08-2026 00:00:00", "SORD-A", "USER", "Retailer", "RET#1", "1",
      "Distributor", "DIST#1", "State", "District", "City", "1", "CP",
      "100", 18, 180, 1, 50, 100, 1180, 1000, "APPROVED",
    ]);
    const prepared = await prepareProductWiseAug26Load(file);
    expect(prepared.controls.rows).toBe(1);
    expect(prepared.controls.semanticValidation?.ratio).toBe(1);
    const workbook = new ExcelJS.stream.xlsx.WorkbookReader(file, { worksheets: "emit", entries: "emit", sharedStrings: "cache" });
    let resolved: ReturnType<typeof resolveProductWiseHeaders> | undefined;
    for await (const worksheet of workbook) {
      for await (const row of worksheet) {
        const values = ((row.values as unknown[]) ?? []).slice(1).map((value) => String(value ?? ""));
        if (!resolved) resolved = resolveProductWiseHeaders(values);
      }
    }
    expect(resolved?.basicOrderValue).toBe(20);
    expect(resolved?.dealerOrderValueIncl).toBe(19);
    expect(resolved?.gstType).toBeUndefined();
    expect(validateProductWiseValues([{ basicOrderValue: 1000, dealerOrderValueIncl: 1180, gstAmount: 180 }]).ratio).toBe(1);
  });

  it("accepts September aliases and reversed value positions", async () => {
    const file = await syntheticWorkbook(SEPTEMBER, [
      "01-09-2026 00:00:00", "SORD-S", "USER", "EMP", "MANAGER", "Retailer",
      "RET#1", "1", "Distributor", "DIST#1", "State", "District", "City", "1",
      "CP", "100", "GST EXTRA", 18, 180, 1, 50, 100, 1000, 1180, "APPROVED",
    ]);
    const prepared = await prepareProductWiseRangeLoad(file);
    expect(prepared.controls.rows).toBe(1);
    expect(prepared.controls.months).toEqual(["Sep-26"]);
    expect(prepared.controls.semanticValidation?.ratio).toBe(1);
    const workbook = new ExcelJS.stream.xlsx.WorkbookReader(file, { worksheets: "emit", entries: "emit", sharedStrings: "cache" });
    let resolved: ReturnType<typeof resolveProductWiseHeaders> | undefined;
    for await (const worksheet of workbook) {
      for await (const row of worksheet) {
        const values = ((row.values as unknown[]) ?? []).slice(1).map((value) => String(value ?? ""));
        if (!resolved) resolved = resolveProductWiseHeaders(values);
      }
    }
    expect(resolved?.basicOrderValue).toBe(22);
    expect(resolved?.dealerOrderValueIncl).toBe(23);
    expect(validateProductWiseValues([{ basicOrderValue: 1000, dealerOrderValueIncl: 1180, gstAmount: 180 }]).ratio).toBe(1);
  });

  it("normalizes source unavailable markers without turning NA into a city", () => {
    expect(normalizeProductWiseNullableText("NA")).toBeNull();
    expect(normalizeProductWiseNullableText(" na ")).toBeNull();
    expect(normalizeProductWiseNullableText("")).toBeNull();
    expect(normalizeProductWiseNullableText("PURNEA")).toBe("PURNEA");
  });

  it("rejects a workbook whose value columns contain swapped semantics", () => {
    expect(() => validateProductWiseValues([
      { basicOrderValue: 1180, dealerOrderValueIncl: 1000, gstAmount: 180 },
      { basicOrderValue: 2360, dealerOrderValueIncl: 2000, gstAmount: 360 },
    ])).toThrow(/appear swapped/);
  });

  it("fails closed when a semantic value is missing", () => {
    expect(() => validateProductWiseValues([
      { basicOrderValue: 1000, dealerOrderValueIncl: null, gstAmount: 180 },
    ])).toThrow(/semantic check failed/);
  });

  it("accepts the exact reviewed Sep-26 controls", () => {
    const rows = Array.from({ length: 8437 }, (_, index) => ({
      orderId: `SORD-${161783 + (index % 1338)}`,
      orderDatetime: new Date(index === 0 ? "2026-08-31T18:30:26.000Z" : index === 8436 ? "2026-09-17T18:16:26.000Z" : "2026-09-05T12:00:00.000Z"),
      dealerId: `RET#${index % 1094}`,
      cpCode: `DIST#${index % 119}`,
      productCode: String(index % 1545),
      salesUserName: `USER-${index % 116}`,
      orderStatus: "APPROVED",
      discountPct: index === 0 ? 6 : index === 8436 ? 70.8 : 47.46,
      basicOrderValue: index === 0 ? 61305811 : 0,
      dealerOrderValueIncl: index === 0 ? 72137897.6878 : 0,
      gstAmount: index === 0 ? 10974385.4472 : 0,
      city: null,
      cityRaw: index < 160 ? "NA" : "CITY",
      gstType: index < 110 ? null : "GST EXTRA",
      gstTypeRaw: index < 110 ? "" : "GST EXTRA",
    }));
    expect(assertPrompt121Sep26Controls(
      rows, 8437, 0,
      "14ac994927c3137db0354fb654afca3946057d7dfd26b0dfeb48b59e7a0800f4",
    )).toMatchObject({
      rows: 8437,
      orders: 1338,
      retailers: 1094,
      distributors: 119,
      cityUnavailableLiterals: 160,
      blankGstTypes: 110,
    });
  });

  it("rejects a synthetic September workbook with swapped value semantics", async () => {
    const file = await syntheticWorkbook(SEPTEMBER, [
      "02-09-2026 00:00:00", "SORD-BAD", "USER", "EMP", "MANAGER", "Retailer",
      "RET#1", "1", "Distributor", "DIST#1", "State", "District", "City", "1",
      "CP", "100", "GST EXTRA", 18, 180, 1, 50, 100, 1180, 1000, "APPROVED",
    ]);
    await expect(prepareProductWiseRangeLoad(file)).rejects.toThrow(/appear swapped/);
  });

  it("rejects unknown and duplicate headers", () => {
    expect(() => resolveProductWiseHeaders([...AUGUST, "Unexpected"])).toThrow(/unknown headers/);
    const duplicate = [...AUGUST];
    duplicate[4] = "Customer Name";
    expect(() => resolveProductWiseHeaders(duplicate)).toThrow(/duplicates canonical field/);
  });
});