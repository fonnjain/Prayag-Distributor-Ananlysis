// Reads a sale register spreadsheet through the chunked Sheets API and feeds
// rows through the same header-detection/normalization path as the xlsx
// backfill, so both sources produce identical line_uids.
import {
  isHeaderRow,
  mapRegisterColumns,
  type CellValue,
  type RegisterColumns,
} from "./normalize.js";
import { readTabRowsChunked, type SheetCellValue } from "./sheetsApi.js";

export const REGISTER_TAB = "Sheet1";

export type RegisterReadResult = {
  columns: RegisterColumns;
  rowsScanned: number;
};

// Streams the register tab of a live spreadsheet. Detects the header row by
// content (spec section B) within the first 20 rows, then invokes `onRow`
// for every subsequent row.
export async function readRegisterFromSheets(
  spreadsheetId: string,
  onRow: (values: CellValue[], columns: RegisterColumns) => void,
): Promise<RegisterReadResult> {
  let columns: RegisterColumns | null = null;
  let rowsScanned = 0;

  await readTabRowsChunked(spreadsheetId, REGISTER_TAB, (rows, startRow) => {
    for (let i = 0; i < rows.length; i++) {
      const rowNumber = startRow + i;
      const values = rows[i] as CellValue[];
      if (!columns) {
        if (isHeaderRow(values)) {
          columns = mapRegisterColumns(values, rowNumber);
          continue;
        }
        if (rowNumber > 20) {
          throw new Error(
            `No header row found in the first 20 rows of spreadsheet ${spreadsheetId}`,
          );
        }
        continue;
      }
      rowsScanned++;
      onRow(values, columns);
    }
  });

  if (!columns) {
    throw new Error(`No header row detected in spreadsheet ${spreadsheetId}`);
  }
  return { columns, rowsScanned };
}

export type { SheetCellValue };
