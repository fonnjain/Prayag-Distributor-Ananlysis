// Regression tests for the Secondary Order Booking uploaded-copy fallback when
// the LIVE source is unavailable because the Drive folder listing itself fails
// (a live-source failure that must not short-circuit the fallback). Covers:
//   (1) folder listing throws + an uploaded xlsx copy exists  -> load succeeds
//       from the uploaded source via the same content-based parser.
//   (2) folder listing throws + no uploaded copy              -> status detail
//       surfaces the real folder-listing reason (not a generic no-file).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/registers/sheetsApi.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/registers/sheetsApi.js")>();
  return { ...actual, getGoogleAccessToken: vi.fn(async () => "fake-token") };
});

import ExcelJS from "exceljs";
import {
  loadOrderFile,
  getOrderLoadStatus,
  invalidateOrderCache,
  orderUploadPath,
} from "../lib/mgmt/orders.js";

// 2026-27 has a blank configured id in config, so resolveOrderFileId falls
// through to the Drive folder listing (which we force to fail).
const FY = "2026-27";

async function writeUploadXlsx(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Data Sheet");
  ws.addRow([
    "Date",
    "Team Member Name",
    "Retailer Id",
    "Retailer Name",
    "Order Id",
    "Segment",
    "Sub Total",
    "Distributor",
  ]);
  ws.addRow([new Date(Date.UTC(2026, 4, 10)), "Debasish Adhikary", "R001", "Alpha Traders", "O1", "HARDWARE", 125000, "Direct"]);
  ws.addRow([new Date(Date.UTC(2026, 4, 11)), "Debasish Adhikary", "R002", "Beta Stores", "O2", "PLYWOOD", 64000, "Direct"]);
  ws.addRow([new Date(Date.UTC(2026, 5, 2)), "Debasish Adhikary", "R001", "Alpha Traders", "O3", "HARDWARE", 31000, "Direct"]);
  await wb.xlsx.writeFile(path);
}

describe("order file upload fallback when the Drive folder listing fails", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "order-upload-"));
    process.env.ORDER_UPLOAD_DIR = tmp;
    invalidateOrderCache();
    // Force the Drive folder listing in resolveOrderFileId to throw.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ORDER_UPLOAD_DIR;
    rmSync(tmp, { recursive: true, force: true });
    invalidateOrderCache();
  });

  it("loads from an uploaded copy when the folder listing throws", async () => {
    await writeUploadXlsx(orderUploadPath(FY));

    const agg = await loadOrderFile(FY);

    expect(agg).not.toBeNull();
    expect(agg?.totalAmount).toBe(220000);
    expect(agg?.spreadsheetId).toMatch(/^uploaded:/);

    const st = getOrderLoadStatus(FY);
    expect(st?.status).toBe("ok");
  });

  it("surfaces the folder-listing failure reason when no uploaded copy exists", async () => {
    const agg = await loadOrderFile(FY);

    expect(agg).toBeNull();
    const st = getOrderLoadStatus(FY);
    expect(st?.status).toBe("error");
    expect(st?.detail).toContain("Could not list the order-booking Drive folder");
    // The real underlying reason (HTTP 500) is preserved, not masked as no-file.
    expect(st?.detail).toContain("500");
  });
});
