import ExcelJS from "exceljs";
import crypto from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db, pool, secondarySkuLines, type InsertSecSkuLine } from "@workspace/db";
import { canonGroupFromMap } from "../sku/catalogue.js";
import { checkOpenFyWipeGuard, priorLikeMonthLabel, priorFyLabel } from "./skuLoader.js";

export const JUL26_PSCODE3 = {
  fy: "2026-27",
  month: "Jul-26",
  skuSource: "pscode3_xlsx",
  brandSource: "pscode3_brand_rollup",
} as const;

/** SHA-256 of the one approved archive; any revised export needs a separate reviewed loader. */
export const JUL26_PSCODE3_APPROVED_ARCHIVE_SHA256 =
  "d9030146be8c34be9cfcb16c5f6930e5778e9cdfac0b96e93b95628a42f4e161";

const DUP_DROP = new Set([
  "AJOY BORAH", "ASHUTOSH KUAMR", "O.P. KALRA", "SUMIT PAREEK", "SASIKUMAR A",
  "AMIT HARIDASJI BELONKAR", "ILESH VYAS", "HARDEEP KHINDA", "SANDEEP DADHEECH",
  "L.SELVAGANAPATHY", "MANOKARAN", "KANISH KHANNA", "KAPIL THAKUR", "RAVI KANT MAHATO",
]);

const NAME_OVERRIDE: Record<string, string> = {
  "NITIN PARASAD BAGHEL": "NITIN PRASAD BAGHEL",
  "KUNAL SANJAY SASANE": "KUNAL SANJAY SAASNE",
  "SASIKANT PRASAD": "SASHIKANT PRASAD",
  "ARVIND KUAMR": "ARVIND KUMAR",
  "ROHIT KUAMR": "ROHIT KUMAR",
  "PAWAN KUAMR": "PAWAN KUMAR",
  "RONI GUPATA": "RONI GUPTA",
  "PRABHAKR PRATAP SINGH": "PRABHAKAR PRATAP SINGH",
  "ASHUTOSH KUMAR(RUDRAPUR)": "ASHUTOSH KUMAR (RUDRAPUR)",
};

export type Jul26LoadControls = {
  filesFound: number;
  filesDropped: number;
  filesLoading: number;
  rawRows: number;
  rawNet: number;
  rows: number;
  net: number;
  gross: number;
  discountPct: number | null;
  footerRows: number;
  noItemCode: number;
  noMonth: number;
  skippedNoValue: number;
  wrongMonth: number;
  months: string[];
  ashutoshMainRows: number;
  ashutoshRudrapurRows: number;
};

export type PreparedJul26Load = {
  rows: InsertSecSkuLine[];
  controls: Jul26LoadControls;
};

export type Jul26LoadProvenance = {
  sourceNote: string;
  uploadedBy: string;
  uploadedAt: string;
  archiveSha256: string;
};

export type Jul26RecordedProvenance = Jul26LoadProvenance & {
  fy: string;
  month: string;
  rows: number;
  net: number;
};

type MonthSummary = { monthLabel: string; rows: number; net: number };

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && "result" in (v as Record<string, unknown>)) {
    return String((v as { result?: unknown }).result ?? "").trim();
  }
  return String(v).trim();
};

function monthLabel(v: unknown): string | null {
  let d: Date | null = null;
  if (v instanceof Date) d = v;
  else if (typeof v === "number" && v > 20000) d = new Date((v - 25569) * 86400000);
  else if (typeof v === "string") {
    const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(v.trim());
    if (m) d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[d.getUTCMonth()]}-${String(d.getUTCFullYear() % 100).padStart(2, "0")}`;
}

const normKey = (raw: string) => raw.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Parse the known July PSCode_3 export without touching the database.
 * The input directory is expected to contain the 163 xlsx files at its root.
 */
export async function prepareJul26PsCode3Load(directory: string): Promise<PreparedJul26Load> {
  const allFiles = readdirSync(directory).filter(
    (file) => file.startsWith("PSCode_3_New_Report ") && file.endsWith(".xlsx"),
  );
  const files = allFiles.filter((file) => {
    const member = file.replace(/^PSCode_3_New_Report /, "").replace(/\.xlsx$/, "").trim();
    return !DUP_DROP.has(member);
  });

  let rawRows = 0;
  let rawNet = 0;
  for (const file of allFiles) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(directory, file));
    workbook.worksheets[0]?.eachRow((row, rowNumber) => {
      if (rowNumber <= 2) return;
      const cell = (index: number) => row.getCell(index).value as unknown;
      if (str(cell(1)).toUpperCase().startsWith("TOTAL")) return;
      const net = num(cell(13));
      const gross = num(cell(10));
      if (gross == null && net == null) return;
      rawRows++;
      rawNet += net ?? 0;
    });
  }

  const rows: InsertSecSkuLine[] = [];
  const occurrenceMap = new Map<string, number>();
  let footerRows = 0;
  let noItemCode = 0;
  let noMonth = 0;
  let skippedNoValue = 0;
  let wrongMonth = 0;

  for (const file of files) {
    const rawMember = file.replace(/^PSCode_3_New_Report /, "").replace(/\.xlsx$/, "").trim();
    const member = NAME_OVERRIDE[rawMember] ?? rawMember;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(directory, file));
    workbook.worksheets[0]?.eachRow((row, rowNumber) => {
      if (rowNumber <= 2) return;
      const cell = (index: number) => row.getCell(index).value as unknown;
      if (str(cell(1)).toUpperCase().startsWith("TOTAL")) {
        footerRows++;
        return;
      }
      const gross = num(cell(10));
      const net = num(cell(13));
      const retailer = str(cell(4));
      if (gross == null && net == null) {
        if (retailer) skippedNoValue++;
        return;
      }
      const itemCode = str(cell(7));
      if (!itemCode) {
        noItemCode++;
        return;
      }
      const resolvedMonth = monthLabel(cell(2));
      if (!resolvedMonth) {
        noMonth++;
        return;
      }
      if (resolvedMonth !== JUL26_PSCODE3.month) {
        wrongMonth++;
        return;
      }

      const distributor = str(cell(11));
      const segmentRaw = str(cell(6)) || null;
      const grossString = gross == null ? "" : String(gross);
      const naturalKey = [
        JUL26_PSCODE3.fy, resolvedMonth, member, retailer, distributor, itemCode, grossString,
      ].join("|");
      const occurrence = (occurrenceMap.get(naturalKey) ?? 0) + 1;
      occurrenceMap.set(naturalKey, occurrence);
      const lineUid = crypto.createHash("sha1")
        .update([JUL26_PSCODE3.fy, resolvedMonth, member, retailer, distributor, itemCode, grossString, occurrence].join("|"))
        .digest("hex");

      rows.push({
        lineUid,
        fy: JUL26_PSCODE3.fy,
        monthLabel: resolvedMonth,
        headRaw: member,
        headCanon: normKey(member),
        stateRaw: null,
        stateCanon: null,
        retailer: retailer || null,
        retailerId: str(cell(3)) || null,
        distributor: distributor || null,
        itemCode,
        segmentRaw,
        segmentCanon: segmentRaw ? (canonGroupFromMap(segmentRaw) ?? null) : null,
        qty: num(cell(8)) == null ? null : String(num(cell(8))),
        mrp: num(cell(9)) == null ? null : String(num(cell(9))),
        netAmount: net == null ? null : String(net),
        grossAmount: gross == null ? null : String(gross),
        discountPct: num(cell(12)) == null ? null : String(num(cell(12))),
        source: JUL26_PSCODE3.skuSource,
      } as InsertSecSkuLine);
    });
  }

  const net = rows.reduce((sum, row) => sum + Number(row.netAmount ?? 0), 0);
  const gross = rows.reduce((sum, row) => sum + Number(row.grossAmount ?? 0), 0);
  const ashutoshRows = rows.filter((row) => row.headCanon?.startsWith("ashutosh kumar"));
  const months = [...new Set(rows.map((row) => row.monthLabel))].sort();

  return {
    rows,
    controls: {
      filesFound: allFiles.length,
      filesDropped: allFiles.length - files.length,
      filesLoading: files.length,
      rawRows,
      rawNet,
      rows: rows.length,
      net,
      gross,
      discountPct: gross > 0 ? (1 - net / gross) * 100 : null,
      footerRows,
      noItemCode,
      noMonth,
      skippedNoValue,
      wrongMonth,
      months,
      ashutoshMainRows: ashutoshRows.filter((row) => row.headCanon === "ashutosh kumar").length,
      ashutoshRudrapurRows: ashutoshRows.filter((row) => row.headCanon?.includes("rudrapur")).length,
    },
  };
}

/**
 * Fixed controls for the approved July 2026 source. A different export must not
 * overwrite the month through this intentionally one-off route.
 */
export function assertJul26PsCode3Controls(prepared: PreparedJul26Load): void {
  const { controls } = prepared;
  const errors: string[] = [];
  if (controls.filesFound !== 163) errors.push(`filesFound=${controls.filesFound}; expected 163`);
  if (controls.filesDropped !== 14) errors.push(`filesDropped=${controls.filesDropped}; expected 14`);
  if (controls.filesLoading !== 149) errors.push(`filesLoading=${controls.filesLoading}; expected 149`);
  if (controls.rawRows !== 36_805) errors.push(`rawRows=${controls.rawRows}; expected 36805`);
  if (controls.rawNet !== 239_311_764) errors.push(`rawNet=${controls.rawNet}; expected 239311764`);
  if (controls.rows !== 34_147) errors.push(`rows=${controls.rows}; expected 34147`);
  if (controls.net !== 223_436_806) errors.push(`net=${controls.net}; expected 223436806`);
  if (Math.abs(controls.gross - 442_326_730.1) > 0.01) errors.push(`gross=${controls.gross}; expected 442326730.1`);
  if (controls.footerRows !== 149) errors.push(`footerRows=${controls.footerRows}; expected 149`);
  if (controls.skippedNoValue !== 0) errors.push(`skippedNoValue=${controls.skippedNoValue}; expected 0`);
  if (controls.noItemCode > 0 || controls.noMonth > 0 || controls.wrongMonth > 0) {
    errors.push(`invalidRows: noItemCode=${controls.noItemCode}, noMonth=${controls.noMonth}, wrongMonth=${controls.wrongMonth}`);
  }
  if (controls.months.length !== 1 || controls.months[0] !== JUL26_PSCODE3.month) {
    errors.push(`months=${controls.months.join(",")}; expected ${JUL26_PSCODE3.month}`);
  }
  if (controls.ashutoshMainRows !== 368) errors.push(`ashutoshMainRows=${controls.ashutoshMainRows}; expected 368`);
  if (controls.ashutoshRudrapurRows !== 98) errors.push(`ashutoshRudrapurRows=${controls.ashutoshRudrapurRows}; expected 98`);
  if (errors.length > 0) throw new Error(`Jul-26 PSCode_3 controls refused: ${errors.join("; ")}`);
}

export function assertApprovedJul26PsCode3Archive(sha256: string): void {
  if (sha256 !== JUL26_PSCODE3_APPROVED_ARCHIVE_SHA256) {
    throw new Error("This route accepts only the reviewed July 2026 PSCode_3 archive.");
  }
}

async function monthSummaries(table: "secondary_sku_line" | "secondary_register_line", source?: string): Promise<MonthSummary[]> {
  const sourceFilter = source
    ? sql`AND source = ${source}`
    : sql``;
  const result = await db.execute<{ month_label: string; rows: number; net: string }>(sql`
    SELECT month_label, COUNT(*)::int AS rows, COALESCE(SUM(net_amount), 0)::text AS net
      FROM ${sql.identifier(table)}
     WHERE fy = ${JUL26_PSCODE3.fy} ${sourceFilter}
     GROUP BY month_label
     ORDER BY month_label
  `);
  return result.rows.map((row) => ({
    monthLabel: row.month_label,
    rows: Number(row.rows),
    net: Number(row.net),
  }));
}

export type Jul26CommitResult = {
  skuMonths: MonthSummary[];
  brandMirrorMonths: MonthSummary[];
  priorLikeMonthRows: number;
  provenance: Jul26RecordedProvenance;
};

export function assertJul26UploadMetadata(
  metadata: Pick<Jul26LoadProvenance, "sourceNote" | "uploadedBy">,
): void {
  if (!metadata.sourceNote.trim()) throw new Error("source_note is required");
  if (metadata.sourceNote.length > 2_000) throw new Error("source_note must be 2,000 characters or fewer");
  if (!metadata.uploadedBy.trim()) throw new Error("uploaded_by is required");
  if (metadata.uploadedBy.length > 200) throw new Error("uploaded_by must be 200 characters or fewer");
}

export function toJul26RecordedProvenance(
  provenance: Jul26LoadProvenance,
  controls: Pick<Jul26LoadControls, "rows" | "net">,
): Jul26RecordedProvenance {
  return {
    ...provenance,
    fy: JUL26_PSCODE3.fy,
    month: JUL26_PSCODE3.month,
    rows: controls.rows,
    net: controls.net,
  };
}

/** Replace exactly Jul-26 in both raw SKU tables after all source controls pass. */
export async function commitJul26PsCode3Load(
  prepared: PreparedJul26Load,
  provenance: Jul26LoadProvenance,
): Promise<Jul26CommitResult> {
  assertJul26PsCode3Controls(prepared);
  assertJul26UploadMetadata(provenance);
  if (!Number.isFinite(Date.parse(provenance.uploadedAt))) {
    throw new Error("uploadedAt must be a valid ISO timestamp");
  }
  if (!/^[a-f0-9]{64}$/.test(provenance.archiveSha256)) {
    throw new Error("archiveSha256 must be a lowercase SHA-256 digest");
  }
  let priorLikeMonthRows = 0;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('pscode3-jul26-load'))`);
    const priorFy = priorFyLabel(JUL26_PSCODE3.fy);
    const priorMonth = priorLikeMonthLabel(JUL26_PSCODE3.month);
    const priorResult = await tx.execute<{ rows: string }>(sql`
      SELECT COUNT(*)::text AS rows
        FROM secondary_sku_line
       WHERE fy = ${priorFy} AND month_label = ${priorMonth}
    `);
    priorLikeMonthRows = Number(priorResult.rows[0]?.rows ?? 0);
    const guard = checkOpenFyWipeGuard(
      new Map([[JUL26_PSCODE3.month, prepared.rows.length]]),
      new Map([[priorMonth, priorLikeMonthRows]]),
    );
    if (!guard.ok) throw new Error(`Jul-26 PSCode_3 wipe guard refused: ${guard.reason}`);

    await tx.execute(sql`
      DELETE FROM secondary_sku_line
       WHERE fy = ${JUL26_PSCODE3.fy} AND month_label = ${JUL26_PSCODE3.month}
    `);
    await tx.execute(sql`
      DELETE FROM secondary_register_line
       WHERE fy = ${JUL26_PSCODE3.fy}
         AND month_label = ${JUL26_PSCODE3.month}
         AND source = ${JUL26_PSCODE3.brandSource}
    `);
    for (let offset = 0; offset < prepared.rows.length; offset += 1000) {
      await tx.insert(secondarySkuLines).values(prepared.rows.slice(offset, offset + 1000));
    }
    await tx.execute(sql`
      INSERT INTO secondary_register_line
        (line_uid, fy, month_label, head_raw, head_canon, customer,
         brand_raw, brand_canon, qty, source, gross_amount, net_amount, discount_pct)
      SELECT 'brl-' || line_uid, fy, month_label, head_raw, head_raw, retailer,
             segment_raw, segment_raw, qty, ${JUL26_PSCODE3.brandSource},
             gross_amount, net_amount, discount_pct
        FROM secondary_sku_line
       WHERE fy = ${JUL26_PSCODE3.fy} AND month_label = ${JUL26_PSCODE3.month}
    `);
    await tx.execute(sql`
      INSERT INTO secondary_sku_load_provenance
        (fy, month_label, source_note, uploaded_by, uploaded_at,
         archive_sha256, row_count, net_amount, source)
      VALUES
        (${JUL26_PSCODE3.fy}, ${JUL26_PSCODE3.month},
         ${provenance.sourceNote.trim()}, ${provenance.uploadedBy.trim()},
         ${new Date(provenance.uploadedAt)}, ${provenance.archiveSha256},
         ${prepared.controls.rows}, ${prepared.controls.net},
         ${JUL26_PSCODE3.skuSource})
    `);
  });

  const [skuMonths, brandMirrorMonths] = await Promise.all([
    monthSummaries("secondary_sku_line"),
    monthSummaries("secondary_register_line", JUL26_PSCODE3.brandSource),
  ]);
  const julySku = skuMonths.find((month) => month.monthLabel === JUL26_PSCODE3.month);
  const julyMirror = brandMirrorMonths.find((month) => month.monthLabel === JUL26_PSCODE3.month);
  if (!julySku || !julyMirror || julySku.rows !== prepared.rows.length || julyMirror.rows !== prepared.rows.length) {
    throw new Error("Jul-26 post-load verification failed: SKU detail and brand mirror do not both match the prepared row count");
  }
  if (Math.abs(julySku.net - prepared.controls.net) > 1 || Math.abs(julyMirror.net - prepared.controls.net) > 1) {
    throw new Error("Jul-26 post-load verification failed: SKU detail and brand mirror values do not match the prepared NET");
  }
  return {
    skuMonths,
    brandMirrorMonths,
    priorLikeMonthRows,
    provenance: toJul26RecordedProvenance(provenance, prepared.controls),
  };
}

export async function getLatestJul26LoadProvenance(): Promise<Jul26RecordedProvenance | null> {
  const result = await pool.query<{
    fy: string;
    month_label: string;
    source_note: string;
    uploaded_by: string;
    uploaded_at: string;
    archive_sha256: string;
    row_count: string;
    net_amount: string;
  }>(
    `SELECT fy, month_label, source_note, uploaded_by, uploaded_at::text,
            archive_sha256, row_count, net_amount::text
       FROM secondary_sku_load_provenance
      WHERE fy = $1 AND month_label = $2
      ORDER BY uploaded_at DESC, id DESC
      LIMIT 1`,
    [JUL26_PSCODE3.fy, JUL26_PSCODE3.month],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    sourceNote: row.source_note,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    archiveSha256: row.archive_sha256,
    fy: row.fy,
    month: row.month_label,
    rows: Number(row.row_count),
    net: Number(row.net_amount),
  };
}