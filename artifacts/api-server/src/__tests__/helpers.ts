import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ExcelJS from "exceljs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ITEMWISE_FIXTURE = join(
  __dirname,
  "fixtures/itemwise-sales-fy2425.xlsx",
);
export const ORDER_BOOK_FIXTURE = join(
  __dirname,
  "fixtures/order-book-fy2627.xlsx",
);

// Control totals for the fixture workbooks (snapshots of the live sheets).
// FY24-25 grand total is the exact control number the transform must
// reproduce; any drift means the tab/column mapping broke.
export const FY2425_CONTROL_TOTAL = 3_417_311_917;
export const EXPECTED_ORDERS_YTD_CR = 79.17;

// The Drive file IDs the sync reads (mirrors src/lib/dashboard/sync.ts) so
// tests can map a requested file to the right fixture.
export const ITEMWISE_SALES_FILE_ID =
  "1HgWelwHy73Ybc-1fBQMXhKxo2ctJToxgZLDWwJPmqz8";
export const ORDER_BOOK_FILE_ID =
  "1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A";

export async function loadFixtureWorkbook(
  path: string,
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  return workbook;
}

export async function fixtureForFileId(
  fileId: string,
): Promise<ExcelJS.Workbook> {
  if (fileId === ITEMWISE_SALES_FILE_ID) {
    return loadFixtureWorkbook(ITEMWISE_FIXTURE);
  }
  if (fileId === ORDER_BOOK_FILE_ID) {
    return loadFixtureWorkbook(ORDER_BOOK_FIXTURE);
  }
  throw new Error(`No fixture for file id ${fileId}`);
}
