// Streaming reader for the attached register/rate-list xlsx exports.
// These files are 16-24 MB; never load them whole (exceljs WorkbookReader
// keeps memory flat). Backfill/verification use only — live data comes from
// the Sheets API at runtime.
import ExcelJS from "exceljs";
import {
  isHeaderRow,
  mapRegisterColumns,
  type CellValue,
  type RegisterColumns,
} from "./normalize.js";

// exceljs cell values can be rich objects (formula results, rich text).
export function plainCellValue(v: unknown): CellValue {
  if (v != null && typeof v === "object" && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    if ("result" in o) return plainCellValue(o.result);
    if ("text" in o) return plainCellValue(o.text);
    if ("richText" in o && Array.isArray(o.richText)) {
      return o.richText.map((r) => (r as { text?: string }).text ?? "").join("");
    }
    if ("error" in o) return null;
    return null;
  }
  return v as CellValue;
}

function openWorkbookStream(filePath: string): ExcelJS.stream.xlsx.WorkbookReader {
  return new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: "emit",
    sharedStrings: "cache",
    styles: "ignore",
    hyperlinks: "ignore",
    worksheets: "emit",
  });
}

export type RegisterStreamResult = {
  columns: RegisterColumns;
  rowsScanned: number;
};

// Streams the first worksheet of a register workbook. Detects the header row
// by content (spec section B) within the first 20 rows, then invokes
// `onRow` for every subsequent row.
export async function streamRegisterFile(
  filePath: string,
  onRow: (values: CellValue[], columns: RegisterColumns) => void,
): Promise<RegisterStreamResult> {
  const workbook = openWorkbookStream(filePath);
  let columns: RegisterColumns | null = null;
  let rowsScanned = 0;

  for await (const worksheet of workbook) {
    for await (const row of worksheet) {
      const values = ((row.values as unknown[]) ?? []).map(plainCellValue);
      if (!columns) {
        if (isHeaderRow(values)) {
          columns = mapRegisterColumns(values, row.number);
          continue;
        }
        if (row.number > 20) {
          throw new Error(
            `No header row found in the first 20 rows of ${filePath}`,
          );
        }
        continue;
      }
      rowsScanned++;
      onRow(values, columns);
    }
    break; // registers keep all data on the first sheet (Sheet1)
  }

  if (!columns) {
    throw new Error(`No header row detected in ${filePath}`);
  }
  return { columns, rowsScanned };
}

export type RateListItem = {
  code: string;
  itemName: string | null;
  itemGroup: string | null;
  unit: string | null;
  mrp: number | null;
};

// Streams the rate list (item master). Header is on row 3; there are two
// "Item Code" columns — the FIRST is the code, the SECOND is the item name.
// Purchase Price is a list price, NOT a cost — deliberately not read.
export async function streamRateList(
  filePath: string,
  onItem: (item: RateListItem) => void,
): Promise<{ rowsScanned: number }> {
  const workbook = openWorkbookStream(filePath);
  let rowsScanned = 0;

  for await (const worksheet of workbook) {
    let codeCol = -1;
    let nameCol = -1;
    let groupCol = -1;
    let unitCol = -1;
    let mrpCol = -1;
    let headerFound = false;

    for await (const row of worksheet) {
      const values = ((row.values as unknown[]) ?? []).map(plainCellValue);
      if (!headerFound) {
        const norm = values.map((v) =>
          String(v ?? "")
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, ""),
        );
        const codeIdxs = norm
          .map((v, i) => (v === "ITEMCODE" ? i : -1))
          .filter((i) => i >= 0);
        if (codeIdxs.length >= 1 && norm.includes("ITEMGROUP")) {
          codeCol = codeIdxs[0];
          nameCol = codeIdxs.length > 1 ? codeIdxs[1] : norm.indexOf("ITEMNAME");
          groupCol = norm.indexOf("ITEMGROUP");
          unitCol = norm.indexOf("UNIT");
          mrpCol = norm.indexOf("MRP");
          headerFound = true;
          continue;
        }
        if (row.number > 20) break;
        continue;
      }
      const code = values[codeCol];
      if (code == null || String(code).trim() === "") continue;
      rowsScanned++;
      const num = (i: number): number | null => {
        if (i < 0) return null;
        const v = values[i];
        if (v == null || v === "") return null;
        const n = Number(String(v).replace(/,/g, ""));
        return Number.isFinite(n) ? n : null;
      };
      const txt = (i: number): string | null => {
        if (i < 0) return null;
        const v = values[i];
        if (v == null) return null;
        const s = String(v).trim();
        return s === "" ? null : s;
      };
      onItem({
        code: String(code).trim(),
        itemName: txt(nameCol),
        itemGroup: txt(groupCol),
        unit: txt(unitCol),
        mrp: num(mrpCol),
      });
    }
    break; // Sheet1 holds the current item master
  }

  return { rowsScanned };
}
