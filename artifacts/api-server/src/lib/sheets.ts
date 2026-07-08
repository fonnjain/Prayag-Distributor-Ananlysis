// Reads Google Sheets through the Sheets API in chunked value ranges.
//
// This used to export whole workbooks via Drive `files.export`, which fails
// for spreadsheets over ~10 MB. All reads now go through
// `spreadsheets.values.get` (see registers/sheetsApi.ts), which works for any
// sheet size. This module presents the fetched data behind a minimal
// workbook/worksheet/cell surface compatible with the previous exceljs-based
// consumers (transform.ts), so downstream code is unchanged.
import {
  listSheetTabs,
  readAllTabRows,
  type SheetCellValue,
} from "./registers/sheetsApi.js";

export type CellLike = { value: unknown };

export type RowLike = {
  getCell(col1Based: number): CellLike;
};

export type WorksheetLike = {
  name: string;
  eachRow(cb: (row: RowLike, rowNumber: number) => void): void;
};

export type WorkbookLike = {
  worksheets: WorksheetLike[];
  getWorksheet(name: string): WorksheetLike | undefined;
};

function isEmptyRow(cells: SheetCellValue[]): boolean {
  return cells.every((c) => c == null || c === "");
}

function makeWorksheet(name: string, rows: SheetCellValue[][]): WorksheetLike {
  return {
    name,
    // Mirrors exceljs eachRow: skips empty rows, keeps 1-based sheet row
    // numbers, and getCell is 1-based.
    eachRow(cb) {
      for (let i = 0; i < rows.length; i++) {
        const cells = rows[i] ?? [];
        if (isEmptyRow(cells)) continue;
        const row: RowLike = {
          getCell(col1Based: number): CellLike {
            return { value: cells[col1Based - 1] ?? null };
          },
        };
        cb(row, i + 1);
      }
    },
  };
}

// Fetches a spreadsheet as a lightweight workbook. Values are UNFORMATTED
// (numbers stay numbers, dates are Excel serials). Pass tabFilter to fetch
// only the tabs a consumer actually reads — each tab costs at least one
// Sheets API read, and the per-minute read quota is small.
export async function fetchWorkbook(
  fileId: string,
  tabFilter?: (title: string) => boolean,
): Promise<WorkbookLike> {
  const tabs = await listSheetTabs(fileId);
  const wanted = tabFilter ? tabs.filter((t) => tabFilter(t.title)) : tabs;
  const worksheets: WorksheetLike[] = [];
  for (const tab of wanted) {
    const rows = await readAllTabRows(fileId, tab.title);
    worksheets.push(makeWorksheet(tab.title, rows));
  }
  return {
    worksheets,
    getWorksheet(name: string): WorksheetLike | undefined {
      return worksheets.find((w) => w.name === name);
    },
  };
}

// Cell value helpers. Numeric cells in these sheets are often stored as
// strings; these helpers normalize that.
function rawValue(cell: CellLike): unknown {
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

export function cellNumber(cell: CellLike): number {
  const v = rawValue(cell);
  if (v == null || v === "" || v instanceof Date) return 0;
  const n =
    typeof v === "number" ? v : Number(String(v).replace(/[,\s₹]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function cellString(cell: CellLike): string {
  const v = rawValue(cell);
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}
