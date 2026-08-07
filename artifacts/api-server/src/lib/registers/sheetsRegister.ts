// Reads a sale register spreadsheet through the chunked Sheets API and feeds
// rows through the same header-detection/normalization path as the xlsx
// backfill, so both sources produce identical line_uids.
//
// The order-register workbooks use monthly tabs (Apr-26, May-26, …). This
// reader lists all tabs, selects every monthly-pattern tab, and reads each
// one with independent header detection (header is row 1 of each tab).
//
// fyOverride: the fiscal year implied by the spreadsheet itself (e.g. "2026-27").
// The order-register sheets have no FY column, so callers must supply it so
// parseRegisterRow can fill in row.fy and generate stable line_uids.
import {
  isHeaderRow,
  mapRegisterColumns,
  normHeader,
  toMonthLabel,
  type CellValue,
  type RegisterColumns,
} from "./normalize.js";
import { listSheetTabs, readTabRowsChunked, type SheetCellValue, type SheetTab } from "./sheetsApi.js";
import { classifyTabName } from "./tabAudit.js";
import { logger } from "../logger.js";

// Monthly tab name pattern. Handles abbreviated and full month names, with or
// without a two-digit year suffix: "Apr", "April", "Apr-26", "July", "Jul-26".
const MONTHLY_TAB_RE =
  /^(Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|May|Jun(e)?|Jul(y)?|Aug(ust)?|Sep(tember)?|Oct(ober)?|Nov(ember)?|Dec(ember)?)(-\d{2})?$/i;

// Fallback tab name for single-sheet layouts.
export const REGISTER_TAB = "Sheet1";

export type RegisterReadResult = {
  columns: RegisterColumns;
  rowsScanned: number;
  tabsRead: string[];
  /** Tabs present in the workbook that were NOT read as sales data: non-month
   *  names (Sheet11, WT, INDEX, …) and month tabs whose calendar month has not
   *  started yet. Callers on the sync path feed these into auditRegisterTabs. */
  tabsNotRead: SheetTab[];
};

// Streams all register data tabs of a live spreadsheet.
//
// Detection strategy:
//   1. List all tabs.
//   2. If any tabs match the monthly pattern (Apr-26…), read all of them.
//   3. Otherwise fall back to "Sheet1" (single-tab layout).
//
// Per-tab header detection runs within the first 20 rows. Tabs with no
// detected header are silently skipped. An error is thrown only when zero
// tabs produced a header.
export async function readRegisterFromSheets(
  spreadsheetId: string,
  fyOverride: string,
  onRow: (values: CellValue[], columns: RegisterColumns, tabMonthLabel?: string) => void,
): Promise<RegisterReadResult> {
  const tabs = await listSheetTabs(spreadsheetId);
  // A month tab is selected by PARSING its name against the FY — not just the
  // regex — and only when its calendar month has started. A 'Sep' tab
  // appearing in August is therefore NOT read (it surfaces in tabsNotRead for
  // the audit to propose); a scratch tab like 'Sheet11' never parses to a
  // month and is never read.
  const monthlyTabs = tabs
    .filter(
      (t) =>
        MONTHLY_TAB_RE.test(t.title) &&
        classifyTabName(t.title, fyOverride).kind === "month-started",
    )
    .sort((a, b) => a.title.localeCompare(b.title));

  const tabsToRead =
    monthlyTabs.length > 0
      ? monthlyTabs.map((t) => t.title)
      : [REGISTER_TAB];

  const readSet = new Set(tabsToRead);
  const tabsNotRead = tabs.filter((t) => !readSet.has(t.title));

  let totalRowsScanned = 0;
  let lastColumns: RegisterColumns | null = null;
  const tabsRead: string[] = [];

  for (const tabTitle of tabsToRead) {
    let columns: RegisterColumns | null = null;
    let skipTab = false;
    // Derive a month label from the tab name for sheets that have no MONTH
    // column (e.g. FY2024-25 whose tabs are named "APR-24", "Aug", etc.).
    // toMonthLabel handles "APR-24" → "Apr-24" and "Aug" → "Aug-24" when
    // combined with fyOverride. Passed to onRow so callers can use it as a
    // fallback when cols.month === -1.
    const tabMonthLabelDerived: string | undefined =
      toMonthLabel(tabTitle, fyOverride) ?? undefined;

    await readTabRowsChunked(spreadsheetId, tabTitle, (rows, startRow) => {
      if (skipTab) return;
      for (let i = 0; i < rows.length; i++) {
        if (skipTab) break;
        const rowNumber = startRow + i;
        const values = rows[i] as CellValue[];
        if (!columns) {
          if (isHeaderRow(values)) {
            columns = mapRegisterColumns(values, rowNumber);
            lastColumns = columns;
            logger.info(
              {
                spreadsheetId,
                tab: tabTitle,
                headerRow: rowNumber,
                rawHeaders: values.slice(0, 20).map((v) => normHeader(v)).filter(Boolean),
                cols: {
                  code: columns.code,
                  qty: columns.qty,
                  amount: columns.amount,
                  fy: columns.fy,
                  invoiceNo: columns.invoiceNo,
                  customer: columns.customer,
                  head: columns.head,
                  month: columns.month,
                },
              },
              "sheetsRegister: header detected",
            );
            continue;
          }
          if (rowNumber > 20) {
            skipTab = true;
            break;
          }
          continue;
        }
        totalRowsScanned++;
        onRow(values, columns, tabMonthLabelDerived);
      }
    });

    if (columns) tabsRead.push(tabTitle);
  }

  if (!lastColumns) {
    throw new Error(
      `No header row detected in spreadsheet ${spreadsheetId}. ` +
        `Tabs checked: ${tabsToRead.join(", ")}. ` +
        `Header must contain (CODE or ITEMCODE) + (QTY or QUANTITY) + (AMOUNT or TAXABLE VALUE).`,
    );
  }

  return { columns: lastColumns, rowsScanned: totalRowsScanned, tabsRead, tabsNotRead };
}

export type { SheetCellValue };
