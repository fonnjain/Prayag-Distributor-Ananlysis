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
export const ROSTER_FILE_ID = "1EbWoXm-LC9L_nsh4JUzMU7v0H6Q3Lq8FEmKgFT9FXHc";
export const STATE_HEAD_DASH_FILE_ID =
  "1E1jEY_yO8LmpqBDpcesS_fu2SBPEQ0eKO5xN29XyTEM";

export async function loadFixtureWorkbook(
  path: string,
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  return workbook;
}

// Minimal in-memory roster workbook: one distributor and two retailers.
function makeRosterFixture(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const dist = wb.addWorksheet("Distributor");
  dist.getRow(1).values = ["ID", "Name"];
  dist.getRow(2).values = ["DIST#1", "Test Distributor", "", "", "", "", "", "MADHYA PRADESH"];
  const ret = wb.addWorksheet("Retailer");
  ret.getRow(1).values = ["ID"];
  ret.getRow(2).values = ["RET#1", "", "", "", "", "", "", "", "", "MADHYA PRADESH", "INDORE", "INDORE"];
  ret.getRow(3).values = ["RET#2", "", "", "", "", "", "", "", "", "MADHYA PRADESH", "BHOPAL", "BHOPAL"];
  return wb;
}

// Minimal in-memory state-head dashboard workbook: one head covering one
// state, one team member with dealers and secondary order value.
function makeStateHeadDashFixture(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const data = wb.addWorksheet("Data");
  data.getRow(4).values = ["TEST HEAD", "MADHYA PRADESH"];
  const sec = wb.addWorksheet("SECONDARY ORDER BOOKING REPORT");
  sec.getRow(7).values = ["1", "TEST HEAD", "Test Member", "", "", "", "", "", "", "", 5, "", 100000];
  return wb;
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
  if (fileId === ROSTER_FILE_ID) {
    return makeRosterFixture();
  }
  if (fileId === STATE_HEAD_DASH_FILE_ID) {
    return makeStateHeadDashFixture();
  }
  throw new Error(`No fixture for file id ${fileId}`);
}
