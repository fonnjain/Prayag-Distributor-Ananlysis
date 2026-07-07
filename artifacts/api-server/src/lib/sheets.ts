// Reads Google Sheets by exporting them as XLSX through the "google-drive"
// connector proxy, then parsing with exceljs.
//
// Why export instead of the Sheets API: the connector proxy only exposes the
// Drive API surface, and no raw Google OAuth token is available to call the
// Sheets API directly. Drive export works for the sheets we read here.
import { ReplitConnectors } from "@replit/connectors-sdk";
import ExcelJS from "exceljs";
import type { Cell } from "exceljs";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function exportWorkbook(fileId: string): Promise<ExcelJS.Workbook> {
  const connectors = new ReplitConnectors();
  const response = await connectors.proxy(
    "google-drive",
    `/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`,
    { method: "GET" },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Google Drive export failed for ${fileId} (${response.status}): ${body.slice(0, 300)}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  type LoadInput = Parameters<typeof workbook.xlsx.load>[0];
  await workbook.xlsx.load(arrayBuffer as unknown as LoadInput);
  return workbook;
}

// Cell value helpers. exceljs cells can hold plain values, formula results
// ({ result }), or rich text ({ text }); numeric cells in these sheets are often
// stored as strings. These helpers normalize all of that.
function rawValue(cell: Cell): unknown {
  let v: unknown = cell?.value;
  if (v && typeof v === "object") {
    if ("result" in (v as Record<string, unknown>)) {
      v = (v as Record<string, unknown>).result;
    } else if ("text" in (v as Record<string, unknown>)) {
      v = (v as Record<string, unknown>).text;
    }
  }
  return v;
}

export function cellNumber(cell: Cell): number {
  const v = rawValue(cell);
  if (v == null || v === "" || v instanceof Date) return 0;
  const n =
    typeof v === "number" ? v : Number(String(v).replace(/[,\s₹]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function cellString(cell: Cell): string {
  const v = rawValue(cell);
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}
