// MRP workbook parser + DB loader.
//
// Reads the 6 segment workbooks from config/mrp_files/ and upserts
// mrp_master + mrp_history. The load is idempotent (full replace):
//   1. Delete all mrp_history rows (CASCADE from mrp_master)
//   2. Delete all mrp_master rows
//   3. Insert fresh rows from the xlsx files
//
// OLD MRP / NEW MRP pair logic (per the spec):
//   - If OLD MRP is blank OR equals NEW MRP → write only the current row
//   - Otherwise → write OLD row (is_current=false, effective_to=wef)
//                 AND NEW row (is_current=true,  effective_from=wef)
//
// Composite key: mrp_master PK is (item_code, segment).
// is_ambiguous_code = TRUE for every (item_code, segment) row when that
// item_code appears in more than one segment. Register lookups for those
// codes MUST supply a segment; no fallback is attempted.
import ExcelJS from "exceljs";
import { existsSync } from "fs";
import { join } from "path";
import { pool } from "@workspace/db";

// ── Path resolution ────────────────────────────────────────────────────────
function findMrpDir(): string {
  const candidates = [
    join(process.cwd(), "config/mrp_files"),
    join(process.cwd(), "artifacts/api-server/config/mrp_files"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

// ── Cell value extraction ─────────────────────────────────────────────────
type CellValue = ExcelJS.CellValue;

function cellStr(v: CellValue): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("").trim();
    if ("result" in v) return cellStr((v as ExcelJS.CellFormulaValue).result as CellValue);
    if ("text" in v) return (v as ExcelJS.CellHyperlinkValue).text.trim();
  }
  return String(v).trim();
}

function cellNum(v: CellValue): number | null {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v === "object" && "result" in v) return cellNum((v as ExcelJS.CellFormulaValue).result as CellValue);
  const n = parseFloat(String(v));
  return isFinite(n) ? n : null;
}

// ── Parsed row ────────────────────────────────────────────────────────────
interface MrpRow {
  itemCode: string;
  itemName: string;
  segment: string;
  series: string | null;
  packing: string | null;
  oldMrp: number | null;
  newMrp: number;
  oldEffectiveFrom: string;   // ISO date — the OLD row's effective_from
  effectiveFrom: string;       // ISO date — the w.e.f. date (NEW row's effective_from)
  sourceFile: string;
}

// ── Per-file parse functions ──────────────────────────────────────────────

async function parsePtmt(filePath: string): Promise<MrpRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet("MASTER");
  if (!ws) throw new Error("PTMT: MASTER tab not found");
  const rows: MrpRow[] = [];
  const wef = "2026-03-05";
  ws.eachRow({ includeEmpty: false }, (row, ri) => {
    if (ri === 1) return; // header
    const v = row.values as CellValue[];
    const code = cellStr(v[3]); // CAT No.
    const newMrp = cellNum(v[6]); // NEW MRP
    if (!code || newMrp == null || newMrp <= 0) return;
    const type = cellStr(v[1]); // TYPE — must be non-empty to skip section dividers
    if (!type) return;
    rows.push({
      itemCode: code,
      itemName: cellStr(v[4]),
      segment: "PTMT",
      series: cellStr(v[2]) || null,
      packing: cellStr(v[7]) || null,
      oldMrp: cellNum(v[5]),
      newMrp,
      oldEffectiveFrom: "1970-01-01",
      effectiveFrom: wef,
      sourceFile: "PTMT MRP w.e.f. List as on 05th March, 2026.xlsx",
    });
  });
  return rows;
}

async function parsePipeAndFitting(filePath: string): Promise<MrpRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet("MASTER");
  if (!ws) throw new Error("Pipe & Fitting: MASTER tab not found");
  const rows: MrpRow[] = [];
  const wef = "2026-02-01";
  ws.eachRow({ includeEmpty: false }, (row, ri) => {
    if (ri === 1) return; // header
    const v = row.values as CellValue[];
    const code = cellStr(v[3]); // CODE
    const newMrp = cellNum(v[7]); // NEW MRP
    if (!code || newMrp == null || newMrp <= 0) return;
    // Skip rows where S.NO. is missing (section dividers)
    if (v[1] == null) return;
    rows.push({
      itemCode: code,
      itemName: cellStr(v[4]),
      segment: "Pipe & Fitting",
      series: cellStr(v[2]) || null, // GROUP
      packing: null,
      oldMrp: cellNum(v[6]),
      newMrp,
      oldEffectiveFrom: "1970-01-01",
      effectiveFrom: wef,
      sourceFile: "MRP w.e.f. 01st Feb, 2026 Pipe & Fitting.xlsx",
    });
  });
  return rows;
}

async function parseCp(filePath: string): Promise<MrpRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet("MASTER");
  if (!ws) throw new Error("CP: MASTER tab not found");
  const rows: MrpRow[] = [];
  const wef = "2026-08-01";
  ws.eachRow({ includeEmpty: false }, (row, ri) => {
    if (ri === 1) return; // header
    const v = row.values as CellValue[];
    const code = cellStr(v[3]); // ITEM CODE
    const newMrp = cellNum(v[6]); // New MRP as on 01st Aug, 2026
    if (!code || newMrp == null || newMrp <= 0) return;
    rows.push({
      itemCode: code,
      itemName: cellStr(v[4]),
      segment: "CP",
      series: cellStr(v[1]) || null, // RANGE
      packing: null,
      oldMrp: cellNum(v[5]), // MRP as on 01st May, 2026
      newMrp,
      oldEffectiveFrom: "2026-05-01",
      effectiveFrom: wef,
      sourceFile: "New CP MRP w.e.f. 01st Aug, 2026.xlsx",
    });
  });
  return rows;
}

async function parseSanitaryware(filePath: string): Promise<MrpRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.getWorksheet("Old MRP VS New MRP");
  if (!ws) throw new Error("Sanitaryware: 'Old MRP VS New MRP' tab not found");
  const rows: MrpRow[] = [];
  const wef = "2026-05-01";
  // Rows 1+2 are merged headers; data starts at row 3.
  // Col layout (1-based values[]): [1]=S.No [2]=Series [3]=Cat No. [4]=Item Name
  //   [5]=Size [6]=OLD White [7]=OLD Ivory [8]=OLD Jet [9]=OLD Pink
  //   [10]=NEW White [11]=NEW Ivory [12]=NEW Jet [13]=NEW Pink
  ws.eachRow({ includeEmpty: false }, (row, ri) => {
    if (ri <= 2) return;
    const v = row.values as CellValue[];
    const code = cellStr(v[3]); // Cat No.
    const newMrp = cellNum(v[10]); // NEW MRP White
    if (!code || newMrp == null || newMrp <= 0) return;
    rows.push({
      itemCode: code,
      itemName: cellStr(v[4]),
      segment: "Sanitaryware",
      series: cellStr(v[2]) || null,
      packing: null,
      oldMrp: cellNum(v[6]), // OLD MRP White
      newMrp,
      oldEffectiveFrom: "1970-01-01",
      effectiveFrom: wef,
      sourceFile: "SANITARYWARE NEW MRP w.e.f. 01st May, 2026.xlsx",
    });
  });
  return rows;
}

async function parseHardware(filePath: string): Promise<MrpRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const rows: MrpRow[] = [];
  const wef = "2026-03-01";
  const oldEff = "2024-06-01";
  const srcFile = "NEW HARDWARE Price List as on 01st Mar, 2026.xlsx";

  // HW FG: S.NO. | Product Code | Material Grade | Product Name | OLD | NEW
  const fg = wb.getWorksheet("HW FG");
  if (fg) {
    fg.eachRow({ includeEmpty: false }, (row, ri) => {
      if (ri === 1) return;
      const v = row.values as CellValue[];
      const code = cellStr(v[2]); // Product Code
      const newMrp = cellNum(v[6]);
      if (!code || newMrp == null || newMrp <= 0) return;
      rows.push({
        itemCode: code,
        itemName: cellStr(v[4]),
        segment: "Hardware",
        series: null,
        packing: null,
        oldMrp: cellNum(v[5]),
        newMrp,
        oldEffectiveFrom: oldEff,
        effectiveFrom: wef,
        sourceFile: srcFile,
      });
    });
  }

  // HW TRD FG: S.NO. | ITEM CODE | UOM | Product Name | OLD | NEW
  const trd = wb.getWorksheet("HW TRD FG");
  if (trd) {
    trd.eachRow({ includeEmpty: false }, (row, ri) => {
      if (ri === 1) return;
      const v = row.values as CellValue[];
      const code = cellStr(v[2]); // ITEM CODE
      const newMrp = cellNum(v[6]);
      if (!code || newMrp == null || newMrp <= 0) return;
      rows.push({
        itemCode: code,
        itemName: cellStr(v[4]),
        segment: "Hardware",
        series: null,
        packing: null,
        oldMrp: cellNum(v[5]),
        newMrp,
        oldEffectiveFrom: oldEff,
        effectiveFrom: wef,
        sourceFile: srcFile,
      });
    });
  }

  return rows;
}

async function parseQuaaFern(filePath: string): Promise<MrpRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const rows: MrpRow[] = [];
  const wef = "2024-02-15";
  const srcFile = "MRP w.e.f. 15th Feb, 2024 QUAA & FERN.xlsx";

  const tabs: Array<{ name: string; series: string; oldEff: string }> = [
    { name: "QUAA", series: "QUAA", oldEff: "2022-01-01" },
    { name: "FERN", series: "FERN", oldEff: "2017-12-01" },
  ];

  for (const { name, series, oldEff } of tabs) {
    const ws = wb.getWorksheet(name);
    if (!ws) continue;
    // Row 1 = header labels, row 2 = brand names (Phoenix / Ryan / Polo), data from row 3
    ws.eachRow({ includeEmpty: false }, (row, ri) => {
      if (ri <= 2) return;
      const v = row.values as CellValue[];
      const code = cellStr(v[2]); // CODE
      const newMrp = cellNum(v[5]); // MRP as on 15th Feb, 2024
      if (!code || newMrp == null || newMrp <= 0) return;
      rows.push({
        itemCode: code,
        itemName: cellStr(v[3]),
        segment: "QUAA & FERN",
        series,
        packing: null,
        oldMrp: cellNum(v[4]), // prior MRP column
        newMrp,
        oldEffectiveFrom: oldEff,
        effectiveFrom: wef,
        sourceFile: srcFile,
      });
    });
  }
  return rows;
}

// ── Collision report ──────────────────────────────────────────────────────
export interface AmbiguousCodeEntry {
  itemCode: string;
  segment1: string;
  itemName1: string;
  currentMrp1: number;
  segment2: string;
  itemName2: string;
  currentMrp2: number;
}

// ── Stats ─────────────────────────────────────────────────────────────────
export interface LoadStats {
  rowsPerFile: Record<string, number>;
  totalMasterRows: number;   // distinct (item_code, segment) pairs
  totalHistoryRows: number;
  intraDuplicatesDropped: number;   // duplicate (item_code, segment) within the same file
  ambiguousCodesCount: number;      // item_codes appearing in 2+ segments
  collisions: AmbiguousCodeEntry[]; // side-by-side comparison for price-list owners
}

// ── Main load function ────────────────────────────────────────────────────
export async function loadMrpFiles(): Promise<LoadStats> {
  const dir = findMrpDir();
  const f = (name: string) => join(dir, name);

  // Parse all 6 workbooks
  const [ptmt, pipe, cp, san, hw, qf] = await Promise.all([
    parsePtmt(f("PTMT MRP w.e.f. List as on 05th March, 2026.xlsx")),
    parsePipeAndFitting(f("MRP w.e.f. 01st Feb, 2026 Pipe & Fitting.xlsx")),
    parseCp(f("New CP MRP w.e.f. 01st Aug, 2026.xlsx")),
    parseSanitaryware(f("SANITARYWARE NEW MRP w.e.f. 01st May, 2026.xlsx")),
    parseHardware(f("NEW HARDWARE Price List as on 01st Mar, 2026.xlsx")),
    parseQuaaFern(f("MRP w.e.f. 15th Feb, 2024 QUAA & FERN.xlsx")),
  ]);

  const rowsPerFile: Record<string, number> = {
    "PTMT MRP": ptmt.length,
    "Pipe & Fitting MRP": pipe.length,
    "CP MRP": cp.length,
    "Sanitaryware MRP": san.length,
    "Hardware MRP": hw.length,
    "QUAA & FERN MRP": qf.length,
  };

  const allRows: MrpRow[] = [...ptmt, ...pipe, ...cp, ...san, ...hw, ...qf];

  // ── Step 1: Deduplicate by (item_code, segment) — first occurrence wins.
  // This handles codes that appear multiple times within the same file/tab.
  const seen = new Set<string>();
  const masterRows: MrpRow[] = [];
  let intraDuplicatesDropped = 0;
  for (const row of allRows) {
    const key = `${row.itemCode}|${row.segment}`;
    if (seen.has(key)) {
      intraDuplicatesDropped++;
      continue;
    }
    seen.add(key);
    masterRows.push(row);
  }

  // ── Step 2: Identify ambiguous codes (same item_code, different segments).
  // Build a map: item_code → Set of segments that carry it.
  const codeSegments = new Map<string, string[]>();
  for (const row of masterRows) {
    const segs = codeSegments.get(row.itemCode) ?? [];
    segs.push(row.segment);
    codeSegments.set(row.itemCode, segs);
  }
  const ambiguousCodes = new Set<string>();
  for (const [code, segs] of codeSegments) {
    if (segs.length > 1) ambiguousCodes.add(code);
  }

  // ── Step 3: Build collision report (side-by-side view for price-list owners).
  const collisions: AmbiguousCodeEntry[] = [];
  for (const code of ambiguousCodes) {
    const segs = codeSegments.get(code)!;
    // Report first two segments (all known cases are exactly 2 segments)
    const row1 = masterRows.find((r) => r.itemCode === code && r.segment === segs[0])!;
    const row2 = masterRows.find((r) => r.itemCode === code && r.segment === segs[1])!;
    collisions.push({
      itemCode: code,
      segment1: row1.segment,
      itemName1: row1.itemName,
      currentMrp1: row1.newMrp,
      segment2: row2.segment,
      itemName2: row2.itemName,
      currentMrp2: row2.newMrp,
    });
  }
  collisions.sort((a, b) => a.itemCode.localeCompare(b.itemCode));

  // ── Step 4: Build history rows (all parsed rows, not just master-unique).
  // History rows are keyed by (item_code, segment) for the FK.
  interface HistRow {
    itemCode: string;
    segment: string;
    mrp: number;
    effectiveFrom: string;
    effectiveTo: string | null;
    sourceFile: string;
    isCurrent: boolean;
  }
  const histRows: HistRow[] = [];
  // Use masterRows (already deduped by (item_code, segment)) for history too,
  // so each (item_code, segment) produces at most 2 history rows (old + current).
  for (const row of masterRows) {
    const hasOld =
      row.oldMrp != null &&
      row.oldMrp > 0 &&
      Math.abs(row.oldMrp - row.newMrp) > 0.001;
    if (hasOld) {
      histRows.push({
        itemCode: row.itemCode,
        segment: row.segment,
        mrp: row.oldMrp!,
        effectiveFrom: row.oldEffectiveFrom,
        effectiveTo: row.effectiveFrom,
        sourceFile: row.sourceFile,
        isCurrent: false,
      });
    }
    histRows.push({
      itemCode: row.itemCode,
      segment: row.segment,
      mrp: row.newMrp,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: null,
      sourceFile: row.sourceFile,
      isCurrent: true,
    });
  }

  // ── Step 5: Full replace in a single transaction.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Delete history first (FK constraint), then master.
    await client.query("DELETE FROM mrp_history");
    await client.query("DELETE FROM mrp_master");

    // Insert master rows in batches of 500.
    const BATCH = 500;
    for (let i = 0; i < masterRows.length; i += BATCH) {
      const batch = masterRows.slice(i, i + BATCH);
      const vals = batch.map((r, idx) => {
        const base = idx * 6;
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`;
      });
      const params = batch.flatMap((r) => [
        r.itemCode,
        r.itemName || null,
        r.segment,
        r.series || null,
        r.packing || null,
        ambiguousCodes.has(r.itemCode),
      ]);
      await client.query(
        `INSERT INTO mrp_master
           (item_code, item_name, segment, series, packing, is_ambiguous_code)
         VALUES ${vals.join(",")}
         ON CONFLICT (item_code, segment) DO NOTHING`,
        params,
      );
    }

    // Insert history rows in batches of 500.
    for (let i = 0; i < histRows.length; i += BATCH) {
      const batch = histRows.slice(i, i + BATCH);
      const vals = batch.map((r, idx) => {
        const base = idx * 7;
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`;
      });
      const params = batch.flatMap((r) => [
        r.itemCode,
        r.segment,
        String(r.mrp),
        r.effectiveFrom,
        r.effectiveTo,
        r.sourceFile,
        r.isCurrent,
      ]);
      await client.query(
        `INSERT INTO mrp_history
           (item_code, segment, mrp, effective_from, effective_to, source_file, is_current)
         VALUES ${vals.join(",")}`,
        params,
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return {
    rowsPerFile,
    totalMasterRows: masterRows.length,
    totalHistoryRows: histRows.length,
    intraDuplicatesDropped,
    ambiguousCodesCount: ambiguousCodes.size,
    collisions,
  };
}
