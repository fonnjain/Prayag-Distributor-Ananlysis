import ExcelJS from "exceljs";
import { existsSync } from "node:fs";
import crypto from "node:crypto";

export const JULY_PSCODE3_CONTROL = {
  rows: 34_147,
  net: 223_436_806,
  gross: 442_326_730.10,
} as const;

export type JulyComparisonRow = {
  orderId: string;
  date: string;
  dealerId: string;
  productCode: string;
  qty: number;
  basicOrderValueExGst: number;
  status: string;
};

export type JulyReconciliationReport = {
  status: "BLOCKED" | "MEASURED";
  source: "productwise_xlsx";
  valueBasis: "basic_order_value_ex_gst";
  sourceFile: string | null;
  sourceSha256: string | null;
  reason?: string;
  controls?: {
    productWiseRows: number;
    productWiseNet: number;
    productWiseQty: number;
    itemGroups: number;
    retailerGroups: number;
    rowMatches: number;
    rowMismatches: number;
    itemMismatches: number;
    retailerMismatches: number;
    rowValueDelta: number;
    itemValueDelta: number;
    retailerValueDelta: number;
    totalNetDeltaAgainstPsCode3: number;
    inclusionRules: {
      statuses: string[];
      missingIdentityRows: number;
      missingValueRows: number;
      commercialBasisEquivalent: "unproven";
      exclusionRulesEquivalent: "unproven";
    };
  };
};

const HEADERS = ["Date", "Order ID", "Sales User Name", "Customer Name", "Dealer ID", "Dealer Mobile",
  "Channel Partner Name", "CP Code", "State", "District", "City", "Pincode", "Category Name",
  "Product Code", "GST (%)", "GST Amount", "Qty", "Discount (%)", "Discount Amount",
  "Dealer Order Value", "Basic Order Value", "Order Status"];

const cellText = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "object" && value && "result" in value) return String((value as { result?: unknown }).result ?? "").trim();
  return String(value).trim();
};
const number = (value: unknown): number | null => {
  const text = cellText(value);
  if (!text) return null;
  const parsed = Number(text.replace(/[₹,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};
const date = (value: unknown): string | null => {
  const parsed = value instanceof Date ? value : new Date(cellText(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

export async function parseIndependentJulyProductWise(filePath: string): Promise<JulyComparisonRow[]> {
  if (!existsSync(filePath)) throw new Error(`Independent July Product-Wise file does not exist: ${filePath}`);
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: "emit", sharedStrings: "cache", styles: "ignore", worksheets: "emit",
  });
  const rows: JulyComparisonRow[] = [];
  let headerSeen = false;
  for await (const worksheet of workbook) {
    for await (const row of worksheet) {
      const values = ((row.values as unknown[]) ?? []).slice(1);
      if (!headerSeen) {
        const actual = values.map(cellText);
        if (HEADERS.some((expected, index) => actual[index] !== expected)) {
          throw new Error("Independent July Product-Wise header mismatch");
        }
        headerSeen = true;
        continue;
      }
      const transactionDate = date(values[0]);
      const value = number(values[20]);
      const qty = number(values[16]);
      if (!transactionDate) throw new Error(`Independent July Product-Wise row ${row.number} has an invalid date`);
      if (!transactionDate.startsWith("2026-07")) {
        throw new Error(`Independent July Product-Wise file contains non-July row ${row.number}: ${transactionDate}`);
      }
      const orderId = cellText(values[1]);
      const dealerId = cellText(values[4]);
      const productCode = cellText(values[13]);
      if (!orderId || !dealerId || !productCode) {
        throw new Error(`Independent July Product-Wise row ${row.number} is missing order, dealer, or product identity`);
      }
      if (qty == null || value == null) {
        throw new Error(`Independent July Product-Wise row ${row.number} is missing quantity or Basic Order Value`);
      }
      rows.push({
        orderId,
        date: transactionDate,
        dealerId,
        productCode,
        qty,
        basicOrderValueExGst: value,
        status: cellText(values[21]).toUpperCase() || "UNKNOWN",
      });
    }
    break;
  }
  if (!headerSeen) throw new Error("Independent July Product-Wise header not found");
  if (rows.length === 0) throw new Error("Independent July Product-Wise file contains no July rows");
  return rows;
}

function grouped(rows: JulyComparisonRow[], key: (row: JulyComparisonRow) => string) {
  const result = new Map<string, { rows: number; qty: number; value: number }>();
  for (const row of rows) {
    const id = key(row);
    const current = result.get(id) ?? { rows: 0, qty: 0, value: 0 };
    current.rows++;
    current.qty += row.qty;
    current.value += row.basicOrderValueExGst;
    result.set(id, current);
  }
  return result;
}

/**
 * Read-only gate. Without an independently supplied July CRM file this returns
 * BLOCKED; it never calls a loader and never accesses or mutates SKU tables.
 */
export async function reconcileIndependentJulyProductWise(
  filePath: string | null,
  psCode3Rows: JulyComparisonRow[] = [],
): Promise<JulyReconciliationReport> {
  if (!filePath) {
    return {
      status: "BLOCKED", source: "productwise_xlsx", valueBasis: "basic_order_value_ex_gst",
      sourceFile: null, sourceSha256: null,
      reason: "Independent July Product-Wise export is not present; D2-D4 reconciliation cannot be measured.",
    };
  }
  const rows = await parseIndependentJulyProductWise(filePath);
  const productWiseByKey = grouped(rows, (row) => `${row.date}|${row.orderId}|${row.dealerId}|${row.productCode}`);
  const psCode3ByKey = grouped(psCode3Rows, (row) => `${row.date}|${row.orderId}|${row.dealerId}|${row.productCode}`);
  let rowMatches = 0;
  let rowMismatches = 0;
  let rowValueDelta = 0;
  for (const [key, value] of productWiseByKey) {
    const other = psCode3ByKey.get(key);
    rowValueDelta += value.value - (other?.value ?? 0);
    if (other && other.rows === value.rows && Math.abs(other.qty - value.qty) < 0.001 &&
        Math.abs(other.value - value.value) < 0.01) rowMatches++;
    else rowMismatches++;
  }
  const itemA = grouped(rows, (row) => row.productCode);
  const itemB = grouped(psCode3Rows, (row) => row.productCode);
  const retailerA = grouped(rows, (row) => row.dealerId);
  const retailerB = grouped(psCode3Rows, (row) => row.dealerId);
  const compareGroups = (a: Map<string, { rows: number; qty: number; value: number }>, b: Map<string, { rows: number; qty: number; value: number }>) => {
    let valueDelta = 0;
    const mismatches = [...new Set([...a.keys(), ...b.keys()])].filter((key) => {
      const x = a.get(key); const y = b.get(key);
      valueDelta += (x?.value ?? 0) - (y?.value ?? 0);
      return !x || !y || x.rows !== y.rows || Math.abs(x.qty - y.qty) > 0.001 ||
        Math.abs(x.value - y.value) >= 0.01;
    }).length;
    return { mismatches, valueDelta };
  };
  const itemComparison = compareGroups(itemA, itemB);
  const retailerComparison = compareGroups(retailerA, retailerB);
  const bytes = await import("node:fs/promises").then((fs) => fs.readFile(filePath));
  return {
    status: "MEASURED", source: "productwise_xlsx", valueBasis: "basic_order_value_ex_gst",
    sourceFile: filePath, sourceSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    controls: {
      productWiseRows: rows.length,
      productWiseNet: rows.reduce((sum, row) => sum + row.basicOrderValueExGst, 0),
      productWiseQty: rows.reduce((sum, row) => sum + row.qty, 0),
      itemGroups: itemA.size, retailerGroups: retailerA.size,
      rowMatches, rowMismatches,
      itemMismatches: itemComparison.mismatches,
      retailerMismatches: retailerComparison.mismatches,
      rowValueDelta,
      itemValueDelta: itemComparison.valueDelta,
      retailerValueDelta: retailerComparison.valueDelta,
      totalNetDeltaAgainstPsCode3: rows.reduce((sum, row) => sum + row.basicOrderValueExGst, 0) - JULY_PSCODE3_CONTROL.net,
      inclusionRules: {
        statuses: [...new Set(rows.map((row) => row.status))].sort(),
        missingIdentityRows: rows.filter((row) => !row.orderId || !row.dealerId || !row.productCode).length,
        missingValueRows: rows.filter((row) => !Number.isFinite(row.basicOrderValueExGst)).length,
        commercialBasisEquivalent: "unproven",
        exclusionRulesEquivalent: "unproven",
      },
    },
  };
}