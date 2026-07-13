// Secondary Order Booking upload — parse, validate, confirm, and GCS persistence.
//
// Flow:
//   1. Browser GETs a presigned PUT URL (from /mgmt/secondary-upload/upload-url)
//   2. Browser PUTs the xlsx/csv directly to GCS
//   3. POST /mgmt/secondary-upload/parse  → validates WITHOUT committing
//   4. POST /mgmt/secondary-upload/confirm → commits to local uploads/ + GCS permanent
//   5. DELETE /mgmt/secondary-upload/:fy  → removes committed upload
//
// Precedence: Drive file (discovered by orders.ts) always wins over an upload.
// The upload only fills the gap when Drive has no file for that FY.
//
// Startup: restoreSecondaryUploadsFromGcs() re-downloads any GCS copy to local
// disk so findUploadedOrderFile() (in orders.ts) works without any changes.

import { join, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { logger } from "../logger.js";
import { objectStorageClient } from "../objectStorage.js";
import { normName } from "./names.js";
import { orderUploadPath, invalidateOrderCache } from "./orders.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SecondaryValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
  preview: {
    rowsRead: number;
    dateRange: string | null;
    teamMemberCount: number;
    retailerCount: number;
    distributorCount: number;
    totalAmount: number;
    orderIdCount: number;
  } | null;
  validation: {
    columnsFound: string[];
    columnsMissing: string[];
    outOfRangeDateRows: number;
    nonNumericSubTotalRows: number;
    duplicateOrderIds: number;
    matchedMemberCount: number;
    unmatchedMembers: Array<{ name: string; amount: number }>;
    matchPctByRows: number;
    matchPctByValue: number;
  } | null;
};

export type SecondaryUploadStatus = {
  fy: string;
  fileName: string;
  uploadedAt: string;
  rowsRead: number;
  dateRange: string | null;
  teamMemberCount: number;
  totalAmount: number;
  source: "upload";
};

// ── GCS path helpers ──────────────────────────────────────────────────────────

function parseGcsPath(path: string): { bucketName: string; objectName: string } {
  const p = path.startsWith("/") ? path : `/${path}`;
  const parts = p.split("/");
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

function privateDir(): string | null {
  return process.env.PRIVATE_OBJECT_DIR?.replace(/\/$/, "") ?? null;
}

function gcsXlsxPath(fy: string): string | null {
  const d = privateDir();
  return d ? `${d}/secondary-booking/${fy}.xlsx` : null;
}

function gcsMetaPath(fy: string): string | null {
  const d = privateDir();
  return d ? `${d}/secondary-booking/${fy}-meta.json` : null;
}

// Build the temp GCS path from the normalised object path returned by
// ObjectStorageService.normalizeObjectEntityPath().
function tempGcsPath(objectPath: string): string | null {
  const d = privateDir();
  if (!d) return null;
  // objectPath is either "/objects/uploads/<uuid>" or a presigned GCS URL
  const parts = objectPath.replace(/^\/objects\//, "");
  return `${d}/uploads/${parts}`;
}

// ── Column detection ──────────────────────────────────────────────────────────

type ColMap = {
  date: number;
  subTotal: number;
  teamMember: number;
  retailerId: number;
  distributor: number;
  orderId: number;
};

function detectCols(
  row: unknown[],
): { cols: ColMap | null; found: string[]; missing: string[] } {
  const idx: Record<string, number> = {};
  row.forEach((c, i) => {
    const label = String(c ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (label && !(label in idx)) idx[label] = i;
  });
  const find = (...names: string[]): number => {
    for (const n of names) if (n in idx) return idx[n];
    return -1;
  };

  const date = find("DATE", "ORDERDATE");
  const subTotal = find("SUBTOTAL", "ORDERVALUE");
  const teamMember = find("TEAMMEMBERNAME", "TEAMMEMBER");
  const retailerId = find(
    "RETAILERID",
    "RETAILER",
    "RETAILERNAME",
    "PARTYNAME",
    "PARTY",
  );
  const distributor = find("DISTRIBUTOR", "DISTRIBUTORNAME");
  const orderId = find("ORDERID", "ORDERNO");

  const REQUIRED: Array<[string, number]> = [
    ["Date", date],
    ["Sub Total", subTotal],
    ["Team Member Name", teamMember],
    ["Retailer", retailerId],
    ["Distributor", distributor],
  ];
  const found = REQUIRED.filter(([, i]) => i >= 0).map(([n]) => n);
  const missing = REQUIRED.filter(([, i]) => i < 0).map(([n]) => n);

  if (missing.length > 0) return { cols: null, found, missing };
  return {
    cols: { date, subTotal, teamMember, retailerId, distributor, orderId },
    found,
    missing,
  };
}

// ── Date helpers ───────────────────────────────────────────────────────────────

function fyDateRange(fy: string): { start: Date; end: Date } {
  const startYear = parseInt(fy.split("-")[0], 10);
  return {
    start: new Date(startYear, 3, 1),           // Apr 1
    end: new Date(startYear + 1, 2, 31, 23, 59, 59), // Mar 31
  };
}

function parseDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "number" && v > 40_000) {
    return new Date((v - 25_569) * 86_400_000);
  }
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v.trim());
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

// ── Core parse logic (shared by parse and confirm) ────────────────────────────

type ParseStats = {
  rowsRead: number;
  outOfRange: number;
  nonNumeric: number;
  totalAmount: number;
  dateRange: string | null;
  teamMembers: Map<string, number>;
  retailers: Set<string>;
  distributors: Set<string>;
  orderIds: Set<string>;
  duplicateOrderIds: Set<string>;
};

async function parseBufferStats(buf: Buffer, fy: string): Promise<ParseStats | string> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } catch {
    return "File could not be read as xlsx. Ensure the file is a valid Excel workbook.";
  }

  const ws =
    wb.worksheets.find((w) => /data/i.test(w.name)) ??
    wb.worksheets[0];
  if (!ws) return "No worksheet found in the uploaded file.";

  const { start: fyStart, end: fyEnd } = fyDateRange(fy);

  let cols: ColMap | null = null;
  let colsFound: string[] = [];
  let colsMissing: string[] = [];
  let rowsRead = 0;
  let outOfRange = 0;
  let nonNumeric = 0;
  let totalAmount = 0;
  const teamMembers = new Map<string, number>();
  const retailers = new Set<string>();
  const distributors = new Set<string>();
  const orderIds = new Set<string>();
  const duplicateOrderIds = new Set<string>();
  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  const carry = {
    date: null as unknown,
    teamMember: "",
    retailerId: "",
    distributor: "",
    orderId: "",
  };
  const blank = (v: unknown) => v == null || String(v ?? "").trim() === "";
  const str = (v: unknown) => String(v ?? "").trim();

  ws.eachRow({ includeEmpty: true }, (row) => {
    const raw = Array.isArray(row.values) ? row.values.slice(1) : [];
    rowsRead++;

    // Coerce exceljs cell objects to primitives
    const r = raw.map((c): unknown => {
      if (c == null) return null;
      if (typeof c === "number" || typeof c === "boolean" || typeof c === "string") return c;
      if (c instanceof Date) return c;
      const o = c as unknown as Record<string, unknown>;
      if ("result" in o) return o.result;
      if ("text" in o) return o.text;
      if (Array.isArray(o.richText)) {
        return (o.richText as Array<{ text?: string }>).map((t) => t?.text ?? "").join("");
      }
      return String(c);
    });

    if (!cols) {
      const detected = detectCols(r);
      colsFound = detected.found;
      colsMissing = detected.missing;
      if (detected.cols) cols = detected.cols;
      return;
    }

    if (!blank(r[cols.date])) carry.date = r[cols.date];
    if (!blank(r[cols.teamMember])) carry.teamMember = str(r[cols.teamMember]);
    if (!blank(r[cols.retailerId])) carry.retailerId = str(r[cols.retailerId]);
    if (cols.distributor >= 0 && !blank(r[cols.distributor])) carry.distributor = str(r[cols.distributor]);
    if (cols.orderId >= 0 && !blank(r[cols.orderId])) carry.orderId = str(r[cols.orderId]);

    if (!carry.teamMember) return;

    const d = parseDate(carry.date);
    if (d) {
      if (d < fyStart || d > fyEnd) outOfRange++;
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }

    const rawAmt = r[cols.subTotal];
    const amtStr = String(rawAmt ?? "").replace(/[,\s₹]/g, "");
    const amt = Number(amtStr);
    if (rawAmt == null || rawAmt === "" || !Number.isFinite(amt)) {
      nonNumeric++;
    } else {
      totalAmount += amt;
      teamMembers.set(carry.teamMember, (teamMembers.get(carry.teamMember) ?? 0) + amt);
    }

    if (carry.retailerId) retailers.add(carry.retailerId);
    if (carry.distributor) distributors.add(carry.distributor);
    if (carry.orderId) {
      if (orderIds.has(carry.orderId)) duplicateOrderIds.add(carry.orderId);
      orderIds.add(carry.orderId);
    }
  });

  if (!cols) {
    // Return special object carrying missing-column info
    return JSON.stringify({ __noHeader: true, colsFound, colsMissing });
  }

  const minD = minDate as unknown;
  const maxD = maxDate as unknown;
  const dateRange =
    minD instanceof Date && maxD instanceof Date
      ? `${minD.toLocaleDateString("en-IN")} – ${maxD.toLocaleDateString("en-IN")}`
      : null;

  return {
    rowsRead,
    outOfRange,
    nonNumeric,
    totalAmount,
    dateRange,
    teamMembers,
    retailers,
    distributors,
    orderIds,
    duplicateOrderIds,
  };
}

// ── Download a file from GCS via an objectPath ────────────────────────────────

async function downloadFromObjectPath(objectPath: string): Promise<Buffer> {
  const full = tempGcsPath(objectPath);
  if (!full) throw new Error("PRIVATE_OBJECT_DIR not configured");
  const { bucketName, objectName } = parseGcsPath(full);
  const file = objectStorageClient.bucket(bucketName).file(objectName);
  const [exists] = await file.exists();
  if (!exists) throw new Error("Uploaded file not found in object storage");
  const [buf] = await file.download();
  return buf;
}

// ── Parse (validate only, no commit) ─────────────────────────────────────────

export async function parseSecondaryFile(
  objectPath: string,
  fy: string,
): Promise<SecondaryValidationResult> {
  let buf: Buffer;
  try {
    buf = await downloadFromObjectPath(objectPath);
  } catch (err) {
    return {
      valid: false,
      errors: [`Could not read uploaded file: ${err instanceof Error ? err.message : String(err)}`],
      warnings: [],
      preview: null,
      validation: null,
    };
  }

  const result = await parseBufferStats(buf, fy);

  if (typeof result === "string") {
    // Check if it's the no-header sentinel
    try {
      const parsed = JSON.parse(result) as {
        __noHeader?: boolean;
        colsFound?: string[];
        colsMissing?: string[];
      };
      if (parsed.__noHeader) {
        return {
          valid: false,
          errors: [
            `Header row not detected. Required columns: ${(parsed.colsMissing ?? []).join(", ")}. ` +
              `Ensure the file has a header row containing "Team Member Name" and "Sub Total".`,
          ],
          warnings: [],
          preview: null,
          validation: {
            columnsFound: parsed.colsFound ?? [],
            columnsMissing: parsed.colsMissing ?? [],
            outOfRangeDateRows: 0,
            nonNumericSubTotalRows: 0,
            duplicateOrderIds: 0,
            matchedMemberCount: 0,
            unmatchedMembers: [],
            matchPctByRows: 0,
            matchPctByValue: 0,
          },
        };
      }
    } catch { /* fall through */ }
    return {
      valid: false,
      errors: [result],
      warnings: [],
      preview: null,
      validation: null,
    };
  }

  // Load roster for name matching (best-effort — skip if roster fails)
  let rosterKeys = new Set<string>();
  try {
    const { loadRoster } = await import("./roster.js");
    const roster = await loadRoster();
    rosterKeys = new Set(roster.members.map((m) => normName(m.name)));
  } catch { /* skip roster matching */ }

  const matched: string[] = [];
  const unmatched: Array<{ name: string; amount: number }> = [];
  let matchedAmount = 0;

  for (const [name, amount] of result.teamMembers) {
    if (rosterKeys.size === 0 || rosterKeys.has(normName(name))) {
      matched.push(name);
      matchedAmount += amount;
    } else {
      unmatched.push({ name, amount });
    }
  }

  const totalMembers = result.teamMembers.size;
  const matchPctByRows = totalMembers > 0 ? (matched.length / totalMembers) * 100 : 100;
  const matchPctByValue = result.totalAmount > 0 ? (matchedAmount / result.totalAmount) * 100 : 100;

  const warnings: string[] = [];
  if (result.outOfRange > 0) {
    warnings.push(
      `${result.outOfRange.toLocaleString()} rows have dates outside FY ${fy}. They are still imported but excluded from FY totals.`,
    );
  }
  if (result.nonNumeric > 0) {
    warnings.push(
      `${result.nonNumeric.toLocaleString()} rows have non-numeric Sub Total (counted as zero).`,
    );
  }
  if (result.duplicateOrderIds.size > 0) {
    warnings.push(`${result.duplicateOrderIds.size.toLocaleString()} duplicate Order IDs detected.`);
  }
  if (unmatched.length > 0 && rosterKeys.size > 0) {
    warnings.push(
      `${unmatched.length} team member name(s) not in roster ` +
        `(${(100 - matchPctByRows).toFixed(1)}% of members, ${(100 - matchPctByValue).toFixed(1)}% of value). ` +
        `They will still be imported — their revenue is counted and they are marked "not in roster".`,
    );
  }

  return {
    valid: true,
    errors: [],
    warnings,
    preview: {
      rowsRead: result.rowsRead,
      dateRange: result.dateRange,
      teamMemberCount: result.teamMembers.size,
      retailerCount: result.retailers.size,
      distributorCount: result.distributors.size,
      totalAmount: result.totalAmount,
      orderIdCount: result.orderIds.size,
    },
    validation: {
      columnsFound: ["Date", "Sub Total", "Team Member Name", "Retailer", "Distributor"],
      columnsMissing: [],
      outOfRangeDateRows: result.outOfRange,
      nonNumericSubTotalRows: result.nonNumeric,
      duplicateOrderIds: result.duplicateOrderIds.size,
      matchedMemberCount: matched.length,
      unmatchedMembers: unmatched.sort((a, b) => b.amount - a.amount),
      matchPctByRows,
      matchPctByValue,
    },
  };
}

// ── Confirm (commit) ───────────────────────────────────────────────────────────

function uploadDir(): string {
  return resolve(process.env.ORDER_UPLOAD_DIR ?? join(process.cwd(), "uploads"));
}

export async function confirmSecondaryUpload(
  objectPath: string,
  fy: string,
  fileName: string,
): Promise<SecondaryUploadStatus> {
  const buf = await downloadFromObjectPath(objectPath);

  // Collect stats for the status record
  const statsResult = await parseBufferStats(buf, fy);
  let rowsRead = 0;
  let dateRange: string | null = null;
  let teamMemberCount = 0;
  let totalAmount = 0;
  if (typeof statsResult !== "string") {
    rowsRead = statsResult.rowsRead;
    dateRange = statsResult.dateRange;
    teamMemberCount = statsResult.teamMembers.size;
    totalAmount = statsResult.totalAmount;
  }

  // Write to local disk (so findUploadedOrderFile works)
  const localDir = uploadDir();
  if (!existsSync(localDir)) mkdirSync(localDir, { recursive: true });
  const localPath = orderUploadPath(fy);
  await writeFile(localPath, buf);

  // Persist xlsx to GCS permanent location
  const gcsXlsx = gcsXlsxPath(fy);
  if (gcsXlsx) {
    try {
      const { bucketName, objectName } = parseGcsPath(gcsXlsx);
      await objectStorageClient.bucket(bucketName).file(objectName).save(buf, {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        resumable: false,
      });
      logger.info({ fy }, "secondary-upload: xlsx persisted to GCS");
    } catch (err) {
      logger.warn({ err, fy }, "secondary-upload: could not save xlsx to GCS");
    }
  }

  const status: SecondaryUploadStatus = {
    fy,
    fileName,
    uploadedAt: new Date().toISOString(),
    rowsRead,
    dateRange,
    teamMemberCount,
    totalAmount,
    source: "upload",
  };

  // Persist metadata to GCS
  const gcsMeta = gcsMetaPath(fy);
  if (gcsMeta) {
    try {
      const { bucketName, objectName } = parseGcsPath(gcsMeta);
      await objectStorageClient.bucket(bucketName).file(objectName).save(
        Buffer.from(JSON.stringify(status), "utf8"),
        { contentType: "application/json", resumable: false },
      );
    } catch (err) {
      logger.warn({ err, fy }, "secondary-upload: could not save metadata to GCS");
    }
  }

  // Invalidate in-process order cache so next request loads the new file
  invalidateOrderCache();
  logger.info({ fy, fileName, rows: rowsRead }, "secondary-upload: confirmed");
  return status;
}

// ── Status ─────────────────────────────────────────────────────────────────────

export async function getSecondaryUploadStatus(
  fy: string,
): Promise<SecondaryUploadStatus | null> {
  // Check GCS metadata (most authoritative)
  const gcsMeta = gcsMetaPath(fy);
  if (gcsMeta) {
    try {
      const { bucketName, objectName } = parseGcsPath(gcsMeta);
      const file = objectStorageClient.bucket(bucketName).file(objectName);
      const [exists] = await file.exists();
      if (exists) {
        const [content] = await file.download();
        return JSON.parse(content.toString("utf8")) as SecondaryUploadStatus;
      }
    } catch (err) {
      logger.warn({ err, fy }, "secondary-upload: could not read GCS metadata");
    }
  }

  // Fallback: local file exists but predates GCS metadata
  const localPath = orderUploadPath(fy);
  if (existsSync(localPath)) {
    return {
      fy,
      fileName: `secondary-order-booking-${fy}.xlsx`,
      uploadedAt: "unknown",
      rowsRead: 0,
      dateRange: null,
      teamMemberCount: 0,
      totalAmount: 0,
      source: "upload",
    };
  }

  return null;
}

// ── Delete ─────────────────────────────────────────────────────────────────────

export async function deleteSecondaryUpload(fy: string): Promise<void> {
  const localPath = orderUploadPath(fy);
  if (existsSync(localPath)) {
    const { unlink } = await import("node:fs/promises");
    await unlink(localPath).catch(() => {});
  }

  const gcsXlsx = gcsXlsxPath(fy);
  if (gcsXlsx) {
    const { bucketName, objectName } = parseGcsPath(gcsXlsx);
    await objectStorageClient.bucket(bucketName).file(objectName)
      .delete({ ignoreNotFound: true }).catch(() => {});
  }

  const gcsMeta = gcsMetaPath(fy);
  if (gcsMeta) {
    const { bucketName, objectName } = parseGcsPath(gcsMeta);
    await objectStorageClient.bucket(bucketName).file(objectName)
      .delete({ ignoreNotFound: true }).catch(() => {});
  }

  invalidateOrderCache();
  logger.info({ fy }, "secondary-upload: deleted");
}

// ── Startup restoration ────────────────────────────────────────────────────────

export async function restoreSecondaryUploadsFromGcs(): Promise<void> {
  const fys = ["2023-24", "2024-25", "2025-26", "2026-27"];
  await Promise.allSettled(
    fys.map(async (fy) => {
      const localPath = orderUploadPath(fy);
      if (existsSync(localPath)) return; // already on disk

      const gcsXlsx = gcsXlsxPath(fy);
      if (!gcsXlsx) return;

      const { bucketName, objectName } = parseGcsPath(gcsXlsx);
      const file = objectStorageClient.bucket(bucketName).file(objectName);
      const [exists] = await file.exists();
      if (!exists) return;

      const [buf] = await file.download();
      const dir = uploadDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      await writeFile(localPath, buf);
      logger.info({ fy }, "secondary-upload: restored from GCS");
    }),
  );
}
