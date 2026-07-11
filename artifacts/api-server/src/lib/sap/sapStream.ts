// Streaming reader for the uploaded SAP primary-sales workbook. The file is
// streamed from object storage (never buffered whole). The header row is
// detected by content within the first 20 rows; only columns A–M are kept.
import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { plainCellValue } from "../registers/xlsxStream.js";
import type { CellValue } from "../registers/normalize.js";

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

export type SapRow = {
  invoiceNo: string | null;
  date: Date | null;
  customer: string | null;
  city: string | null;
  code: string | null;
  qty: number | null;
  mrp: number | null;
  saleRate: number | null;
  taxable: number; // revenue
};

type SapColumns = {
  invoiceNo: number;
  date: number;
  customer: number;
  city: number;
  code: number;
  qty: number;
  mrp: number;
  saleRate: number;
  taxable: number;
};

function normHeader(v: CellValue): string {
  return String(v ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function findCol(cells: string[], ...aliases: string[]): number {
  for (const a of aliases) {
    const idx = cells.indexOf(a);
    if (idx >= 0) return idx;
  }
  return -1;
}

// A header row must expose an item code, a quantity, and the taxable value —
// the three columns the pipeline cannot work without.
function detectColumns(values: CellValue[]): SapColumns | null {
  const cells = values.map(normHeader);
  const code = findCol(cells, "ITEMCODE", "CODE", "MATERIAL", "MATERIALCODE");
  const qty = findCol(cells, "QTY", "QUANTITY", "BILLQTY", "BILLINGQTY");
  const taxable = findCol(
    cells,
    "TAXABLEVALUE",
    "TAXABLEAMOUNT",
    "TAXABLE",
    "ASSESSABLEVALUE",
    "NETVALUE",
    "AMOUNT",
  );
  if (code < 0 || qty < 0 || taxable < 0) return null;
  return {
    invoiceNo: findCol(cells, "INVOICENO", "INVOICENUMBER", "BILLINGDOCUMENT", "INVOICE", "BILLNO"),
    date: findCol(cells, "DATE", "INVOICEDATE", "BILLINGDATE", "BILLDATE"),
    customer: findCol(cells, "CUSTOMER", "CUSTOMERNAME", "PARTY", "PARTYNAME", "SOLDTOPARTY", "BILLTOPARTY", "NAME"),
    city: findCol(cells, "CITY", "PLACE", "DESTINATION"),
    code,
    qty,
    mrp: findCol(cells, "MRP"),
    saleRate: findCol(cells, "SALERATE", "RATE", "UNITPRICE", "PRICE"),
    taxable,
  };
}

function toNum(v: CellValue): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function toText(v: CellValue): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function toDate(v: CellValue): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v;
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v > 20_000 && v < 80_000) {
      return new Date(EXCEL_EPOCH_MS + Math.round(v) * MS_PER_DAY);
    }
    return null;
  }
  const s = String(v).trim();
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const day = Number(m[1]);
    const mon = Number(m[2]);
    let yr = Number(m[3]);
    if (m[3].length === 2) yr += 2000;
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      return new Date(Date.UTC(yr, mon - 1, day));
    }
  }
  const iso = new Date(s);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

export type SapStreamResult = { rowsScanned: number };

// Streams the first worksheet. onRow is called for every data row after the
// detected header. Rows with no item code or a non-positive taxable value are
// skipped (blank/subtotal residue).
export async function streamSapWorkbook(
  input: Readable | string,
  onRow: (row: SapRow) => void,
): Promise<SapStreamResult> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(input, {
    entries: "emit",
    sharedStrings: "cache",
    styles: "ignore",
    hyperlinks: "ignore",
    worksheets: "emit",
  });

  let cols: SapColumns | null = null;
  let rowsScanned = 0;

  for await (const worksheet of workbook) {
    for await (const row of worksheet) {
      const values = ((row.values as unknown[]) ?? []).map(plainCellValue);
      if (!cols) {
        cols = detectColumns(values);
        if (!cols && row.number > 20) {
          throw new Error("No SAP header row found in the first 20 rows");
        }
        continue;
      }
      const at = (i: number): CellValue => (i >= 0 ? values[i] : null);
      const code = toText(at(cols.code));
      const taxable = toNum(at(cols.taxable));
      if (!code || taxable == null) continue;
      rowsScanned++;
      onRow({
        invoiceNo: toText(at(cols.invoiceNo)),
        date: toDate(at(cols.date)),
        customer: toText(at(cols.customer)),
        city: toText(at(cols.city)),
        code,
        qty: toNum(at(cols.qty)),
        mrp: toNum(at(cols.mrp)),
        saleRate: toNum(at(cols.saleRate)),
        taxable,
      });
    }
    break; // SAP export keeps all lines on the first worksheet
  }

  if (!cols) throw new Error("No SAP header row detected in the workbook");
  return { rowsScanned };
}

// 'Apr-26' style label from a real invoice date.
const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
export function dateToMonthLabel(d: Date): string {
  return `${MONTH_ABBR[d.getUTCMonth()]}-${String(d.getUTCFullYear() % 100).padStart(2, "0")}`;
}
