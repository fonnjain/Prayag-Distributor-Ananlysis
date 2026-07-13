// Parser for the STATE HEAD DASHBOARD xlsx files.
//
// These files contain MANUAL data (targets, CTC, designation, emp-code, DOJ,
// Active/Left) that exists nowhere else in any system. They are uploaded once
// per FY and the parsed JSON is written to uploads/ so it survives restarts.
//
// Two FY-specific rules:
//   FY2025-26 — targets are ANNUAL (col "Target" = full-year secondary target)
//   FY2026-27 — targets are QUARTERLY Q1 (Apr-Jun); store as monthly[0..2] = target/3
//                and leave annual = null.
//
// Header detection: scan up to 10 rows for the row containing BOTH a "Name"
// column and a "State Head" column — no hardcoded row number.
//
// Column matching: by header text (case-insensitive), never by index.
// The approximate positions from the spec are listed for reference only.
import { resolve, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { normName } from "./names.js";
import { logger } from "../logger.js";
import { objectStorageClient } from "../objectStorage.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type DashboardXlsxRecord = {
  /** Display name exactly as it appears in the xlsx */
  name: string;
  /** Normalised key for join with roster / order-file perTm */
  normKey: string;
  /** State head name from the xlsx */
  stateHead: string;
  /** State / Working State */
  state: string;
  headquarter: string;
  /** Primary target — annual for FY2025-26, Q1 total for FY2026-27 */
  primaryTarget: number | null;
  /**
   * Secondary target.
   * null when the xlsx cell contains "Primary" (→ no secondary target).
   * Annual for FY2025-26; Q1 total for FY2026-27.
   */
  secondaryTarget: number | null;
  /**
   * Per-month secondary target for the 12 fiscal months (Apr=0 … Mar=11).
   * For FY2026-27 Q1: [target/3, target/3, target/3, null, …, null].
   * For FY2025-26 annual: all null (auto-split is handled by the report renderer).
   */
  secondaryMonthly: (number | null)[];
  /** Direct Dealer Primary Target (annual / Q1) */
  directDealerTarget: number | null;
  /** Total target (annual / Q1) */
  totalTarget: number | null;
  /** "Target monthly" column value — as-is from the file */
  targetMonthly: number | null;
  ctcMonthly: number | null;
  ctc: number | null;
  designation: string | null;
  empCode: string | null;
  doj: string | null;
  activeLeft: "Active" | "Left" | null;
};

export type DashboardXlsxStatus = {
  fy: string;
  parsedAt: string;
  fileName: string;
  totalRecords: number;
  activeRecords: number;
  leftRecords: number;
  isQuarterly: boolean;
  targetPeriod: string;
  headerRow: number;
  unmatchedSample: string[];
};

export type DashboardXlsxData = {
  status: DashboardXlsxStatus;
  records: DashboardXlsxRecord[];
};

// ── Storage paths ─────────────────────────────────────────────────────────────

function uploadDir(): string {
  return resolve(process.env.ORDER_UPLOAD_DIR ?? join(process.cwd(), "uploads"));
}
export function dashboardXlsxPath(fy: string): string {
  return join(uploadDir(), `dashboard-state-head-${fy}.xlsx`);
}
export function dashboardJsonPath(fy: string): string {
  return join(uploadDir(), `dashboard-state-head-${fy}.json`);
}

// ── Object Storage (GCS) persistence ─────────────────────────────────────────
// The local uploads/ dir is cwd-relative and may not survive production
// restarts. We also write/read the parsed JSON from GCS so it persists
// across deployments. Errors are logged but never thrown — local disk
// remains the fast path; GCS is only the durable fallback.

function parseGcsPath(path: string): { bucketName: string; objectName: string } {
  const p = path.startsWith("/") ? path : `/${path}`;
  const parts = p.split("/");
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

function gcsJsonObjectPath(fy: string): string | null {
  const dir = process.env.PRIVATE_OBJECT_DIR;
  if (!dir) return null;
  return `${dir.replace(/\/$/, "")}/dashboard-json/dashboard-state-head-${fy}.json`;
}

async function saveToGcs(fy: string, data: DashboardXlsxData): Promise<void> {
  const gcsPath = gcsJsonObjectPath(fy);
  if (!gcsPath) return;
  try {
    const { bucketName, objectName } = parseGcsPath(gcsPath);
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    await file.save(Buffer.from(JSON.stringify(data), "utf8"), {
      contentType: "application/json",
      resumable: false,
    });
    logger.info({ fy }, "dashboardXlsx: JSON persisted to object storage");
  } catch (err) {
    logger.warn({ err, fy }, "dashboardXlsx: could not save JSON to object storage");
  }
}

async function loadFromGcs(fy: string): Promise<DashboardXlsxData | null> {
  const gcsPath = gcsJsonObjectPath(fy);
  if (!gcsPath) return null;
  try {
    const { bucketName, objectName } = parseGcsPath(gcsPath);
    const file = objectStorageClient.bucket(bucketName).file(objectName);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [content] = await file.download();
    const data = JSON.parse(content.toString("utf8")) as DashboardXlsxData;
    logger.info({ fy }, "dashboardXlsx: JSON restored from object storage");
    return data;
  } catch (err) {
    logger.warn({ err, fy }, "dashboardXlsx: could not load JSON from object storage");
    return null;
  }
}

// ── Cell helpers ──────────────────────────────────────────────────────────────

type CellVal = string | number | boolean | Date | null | undefined;

function strVal(v: CellVal): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

function numVal(v: CellVal): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v !== 0 ? v : null;
  const n = Number(String(v).replace(/[,\s₹]/g, ""));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function numOrNull(v: CellVal): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[,\s₹]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function findColByText(row: CellVal[], re: RegExp): number {
  for (let i = 0; i < row.length; i++) {
    if (re.test(strVal(row[i]))) return i;
  }
  return -1;
}

function excelCellValue(v: unknown): CellVal {
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
  if (v instanceof Date) return v;
  const o = v as Record<string, unknown>;
  if ("result" in o) return excelCellValue(o.result);
  if ("text" in o && typeof o.text === "string") return o.text;
  if (Array.isArray(o.richText)) {
    return (o.richText as Array<{ text?: string }>).map((t) => t?.text ?? "").join("");
  }
  return String(v);
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Parses the "Data" tab of a STATE HEAD DASHBOARD xlsx file.
 * Returns the parsed data or throws if the header row cannot be detected.
 */
export async function parseDashboardXlsx(
  filePath: string,
  fy: string,
  fileName: string,
): Promise<DashboardXlsxData> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  // Find the "Data" tab (truncated to 31 chars in exports; try exact then prefix).
  const ws =
    wb.worksheets.find((w) => /^data$/i.test(w.name.trim())) ??
    wb.worksheets.find((w) => /^data/i.test(w.name.trim())) ??
    wb.worksheets[0];
  if (!ws) throw new Error("No worksheet found in the uploaded file.");

  const isQuarterly = fy === "2026-27";
  const targetPeriod = isQuarterly ? "Q1 (Apr-Jun)" : "Annual";

  // Collect all rows as arrays of cell values.
  const allRows: CellVal[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => {
    const raw = Array.isArray(row.values) ? row.values.slice(1) : [];
    allRows.push(raw.map((c) => excelCellValue(c)));
  });

  // Detect header row: scan up to first 10 rows for a row with "Name" AND "State Head".
  let headerRowNum = -1; // 0-based index into allRows
  const colMap = new Map<string, number>(); // header text (lower) → 0-based col index

  for (let ri = 0; ri < Math.min(10, allRows.length); ri++) {
    const row = allRows[ri];
    const nameIdx = findColByText(row, /^name$/i);
    const headIdx = findColByText(row, /state\s*head/i);
    if (nameIdx >= 0 && headIdx >= 0) {
      headerRowNum = ri;
      for (let ci = 0; ci < row.length; ci++) {
        const hdr = strVal(row[ci]).toLowerCase().trim();
        if (hdr) colMap.set(hdr, ci);
      }
      break;
    }
  }
  if (headerRowNum < 0) {
    throw new Error(
      `Header row not found in the Data tab — expected a row with both "Name" and "State Head" columns within the first 10 rows.`,
    );
  }

  // Column indices resolved by header text.
  function col(re: RegExp): number {
    for (const [key, idx] of colMap) {
      if (re.test(key)) return idx;
    }
    return -1;
  }

  const nameCol     = col(/^name$/i);
  const headCol     = col(/state\s*head/i);
  const stateCol    = col(/^(working\s*)?state$/i);
  const hqCol       = col(/head\s*quarter/i);
  const dojCol      = col(/d\.?o\.?j|date\s*of\s*join/i);
  const primTgtCol  = col(/primary\s*target/i);
  const tgtCol      = col(/^target$/i);
  const ctcMoCol    = col(/ctc\s*monthly/i);
  const ctcCol      = ctcMoCol >= 0 ? col(/^ctc$/i) : col(/ctc/i);
  const activCol    = col(/active.*left|left.*active/i);
  const tgtMoCol    = col(/target\s*monthly/i);
  const ddCol       = col(/direct\s*dealer\s*primary\s*target/i);
  const totalTgtCol = col(/^total\s*target$/i);
  const desigCol    = col(/^designation$/i);
  const empCol      = col(/^emp\s*code$/i);

  const records: DashboardXlsxRecord[] = [];

  for (let ri = headerRowNum + 1; ri < allRows.length; ri++) {
    const row = allRows[ri];
    const rawName = strVal(row[nameCol] ?? null);

    // Stop at first blank Name; skip Total rows.
    if (!rawName) break;
    if (/^total/i.test(rawName)) continue;

    // Parse secondary target: "Primary" text → null (no secondary target).
    const rawTgt = row[tgtCol] ?? null;
    let secondaryTarget: number | null = null;
    if (typeof rawTgt === "string" && /primary/i.test(rawTgt.trim())) {
      secondaryTarget = null;
    } else {
      secondaryTarget = numOrNull(rawTgt);
    }

    // Similarly "Target monthly" can hold text.
    const rawTgtMo = row[tgtMoCol] ?? null;
    const targetMonthly =
      typeof rawTgtMo === "string" ? numOrNull(rawTgtMo) : numOrNull(rawTgtMo);

    // Secondary monthly: FY2026-27 distributes Q1 across Apr/May/Jun.
    const secondaryMonthly: (number | null)[] = Array(12).fill(null);
    if (isQuarterly && secondaryTarget != null) {
      const perMonth = Math.round(secondaryTarget / 3);
      secondaryMonthly[0] = perMonth; // Apr
      secondaryMonthly[1] = perMonth; // May
      secondaryMonthly[2] = perMonth; // Jun
    }

    // Active / Left — normalise.
    const rawActive = strVal(row[activCol] ?? null).toLowerCase();
    let activeLeft: "Active" | "Left" | null = null;
    if (/active/i.test(rawActive)) activeLeft = "Active";
    else if (/left/i.test(rawActive)) activeLeft = "Left";

    records.push({
      name: rawName,
      normKey: normName(rawName),
      stateHead: strVal(row[headCol] ?? null),
      state: strVal(row[stateCol] ?? null),
      headquarter: strVal(row[hqCol] ?? null),
      primaryTarget: numOrNull(row[primTgtCol] ?? null),
      secondaryTarget: isQuarterly ? null : secondaryTarget,
      secondaryMonthly,
      directDealerTarget: numOrNull(row[ddCol] ?? null),
      totalTarget: numOrNull(row[totalTgtCol] ?? null),
      targetMonthly,
      ctcMonthly: numOrNull(row[ctcMoCol] ?? null),
      ctc: numOrNull(row[ctcCol] ?? null),
      designation: strVal(row[desigCol] ?? null) || null,
      empCode: strVal(row[empCol] ?? null) || null,
      doj: dojCol >= 0 ? strVal(row[dojCol] ?? null) || null : null,
      activeLeft,
    });
  }

  const activeRecords = records.filter((r) => r.activeLeft === "Active").length;
  const leftRecords = records.filter((r) => r.activeLeft === "Left").length;

  const status: DashboardXlsxStatus = {
    fy,
    parsedAt: new Date().toISOString(),
    fileName,
    totalRecords: records.length,
    activeRecords,
    leftRecords,
    isQuarterly,
    targetPeriod,
    headerRow: headerRowNum + 1, // 1-based for display
    unmatchedSample: [],
  };

  return { status, records };
}

// ── Persistence ───────────────────────────────────────────────────────────────

export async function storeDashboardXlsxData(data: DashboardXlsxData): Promise<void> {
  const dir = uploadDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await writeFile(dashboardJsonPath(data.status.fy), JSON.stringify(data), "utf8");
  // Also persist to Object Storage so data survives deployment restarts.
  // Non-blocking — does not delay the upload response.
  void saveToGcs(data.status.fy, data);
}

// In-process cache (cleared on upload).
const _cache = new Map<string, DashboardXlsxData>();

export function invalidateDashboardXlsxCache(fy?: string): void {
  if (fy) _cache.delete(fy);
  else _cache.clear();
}

/**
 * Loads dashboard xlsx data for a FY from the in-process cache or disk.
 * Returns null when no data has been uploaded for that FY yet.
 */
export async function loadDashboardXlsxData(fy: string): Promise<DashboardXlsxData | null> {
  const cached = _cache.get(fy);
  if (cached) return cached;

  // Fast path: local disk (written on upload, warm across in-process restarts).
  const p = dashboardJsonPath(fy);
  if (existsSync(p)) {
    try {
      const raw = await readFile(p, "utf8");
      const data = JSON.parse(raw) as DashboardXlsxData;
      _cache.set(fy, data);
      return data;
    } catch (err) {
      logger.warn({ err, fy, path: p }, "dashboardXlsx: failed to read local JSON, trying object storage");
    }
  }

  // Durable fallback: Object Storage (survives deployment restarts).
  const gcsData = await loadFromGcs(fy);
  if (gcsData) {
    _cache.set(fy, gcsData);
    // Write back to local disk so subsequent calls hit the fast path.
    try {
      const dir = uploadDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      await writeFile(p, JSON.stringify(gcsData), "utf8");
    } catch { /* non-fatal */ }
    return gcsData;
  }

  return null;
}

/**
 * Build a Map<normKey, DashboardXlsxRecord> for fast join lookup.
 * Returns an empty map when no data has been uploaded for the FY.
 */
export async function buildDashboardXlsxLookup(
  fy: string,
): Promise<Map<string, DashboardXlsxRecord>> {
  const data = await loadDashboardXlsxData(fy);
  if (!data) return new Map();
  return new Map(data.records.map((r) => [r.normKey, r]));
}
