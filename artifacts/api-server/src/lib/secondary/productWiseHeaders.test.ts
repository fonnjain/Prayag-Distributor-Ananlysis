import ExcelJS from "exceljs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
  "Date", "Order ID", "Sales User Name", "Employee ID", "Reporting Manager",
  "Customer Name", "Dealer ID", "Dealer Mobile", "Channel Partner Name",
  "CP Code", "State", "District", "City", "Pincode", "Category Name",
  "Product Code", "GST Type", "GST (%)", "GST Amount", "Qty", "Discount (%)",
  "Discount Amount", "Dealer Order Value", "Basic Order Value", "Order Status",
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

function findProtectedAugustFixture(): string | null {
  if (process.env.AUGUST_PRODUCT_WISE_XLSX && fs.existsSync(process.env.AUGUST_PRODUCT_WISE_XLSX)) {
    return process.env.AUGUST_PRODUCT_WISE_XLSX;
  }
  for (const dir of [
    path.resolve(process.cwd(), "attached_assets"),
    path.resolve(process.cwd(), "../../attached_assets"),
  ]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.includes("Aug_month_order_booking_") || !name.endsWith(".xlsx")) continue;
      const candidate = path.join(dir, name);
      const sha256 = crypto.createHash("sha256").update(fs.readFileSync(candidate)).digest("hex");
      if (sha256 === "cd3df6cc6cf0ff264b9e2611e357df893f67c71c35e66b53823f5df125a98c51") {
        return candidate;
      }
    }
  }
  return null;
}

const protectedAugustFixture = findProtectedAugustFixture();

describe("Product-Wise header contract", () => {
  it("accepts the reviewed August workbook shape", async () => {
    const file = await syntheticWorkbook(AUGUST, [
      "02-08-2026 00:00:00", "SORD-A", "USER", "PRG-001", "MANAGER",
      "Retailer", "RET#1", "1", "Distributor", "DIST#1", "State", "District",
      "City", "1", "CP", "100", "GST EXTRA", 18, 180, 1, 50, 100, 1180,
      1000, "APPROVED",
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
    expect(resolved?.basicOrderValue).toBe(23);
    expect(resolved?.dealerOrderValueIncl).toBe(22);
    expect(resolved?.gstType).toBe(16);
    expect(validateProductWiseValues([{ basicOrderValue: 1000, dealerOrderValueIncl: 1180, gstAmount: 180 }]).ratio).toBe(1);
  });

  it.skipIf(!protectedAugustFixture)("accepts the protected real 28,185-row August fixture", async () => {
    const workbook = new ExcelJS.stream.xlsx.WorkbookReader(protectedAugustFixture!, {
      worksheets: "emit", entries: "emit", sharedStrings: "cache", styles: "ignore",
    });
    let columns: ReturnType<typeof resolveProductWiseHeaders> | null = null;
    let rows = 0;
    let basic = 0;
    const orders = new Set<string>();
    const retailers = new Set<string>();
    const distributors = new Set<string>();
    const codes = new Set<string>();
    const users = new Set<string>();
    for await (const worksheet of workbook) {
      for await (const row of worksheet) {
        const values = ((row.values as unknown[]) ?? []).slice(1);
        if (!columns) {
          columns = resolveProductWiseHeaders(values.map((value) => String(value ?? "")));
          continue;
        }
        rows++;
        const text = (index: number) => String(values[index] ?? "").trim();
        const number = (index: number) => Number(text(index).replace(/,/g, "")) || 0;
        basic += number(columns.basicOrderValue!);
        orders.add(text(columns.orderId!));
        retailers.add(text(columns.retailerId!));
        distributors.add(text(columns.distributorCode!));
        codes.add(text(columns.productCode!));
        users.add(text(columns.salesUserName!));
      }
      break;
    }
    expect({
      rows,
      basic,
      orders: orders.size,
      retailers: retailers.size,
      distributors: distributors.size,
      codes: codes.size,
      users: users.size,
    }).toEqual({
      rows: 28_185,
      basic: 195_788_289,
      orders: 4_000,
      retailers: 2_832,
      distributors: 169,
      codes: 2_380,
      users: 149,
    });
  }, 120_000);

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
      employeeId: `EMP-${index % 116}`,
      reportingManager: `MANAGER-${index % 32}`,
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
      employeeIds: 116,
      reportingManagers: 32,
      employeeIdNulls: 0,
      reportingManagerNulls: 0,
      cityUnavailableLiterals: 160,
      blankGstTypes: 110,
    });
    expect(() => assertPrompt121Sep26Controls(
      rows.map((row, index) => index === 0 ? { ...row, employeeId: null } : row),
      8437, 0,
      "14ac994927c3137db0354fb654afca3946057d7dfd26b0dfeb48b59e7a0800f4",
    )).toThrow(/employee\/reporting-manager controls/);
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
    expect(() => resolveProductWiseHeaders(AUGUST.filter((header) => header !== "Employee ID")))
      .toThrow(/missing required headers: employeeId/);
    expect(() => resolveProductWiseHeaders(AUGUST.filter((header) => header !== "Reporting Manager")))
      .toThrow(/missing required headers: reportingManager/);
  });
});