import ExcelJS from "exceljs";
import crypto from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { pool, type InsertSecSkuLine } from "@workspace/db";
import { canonGroupFromMap } from "../sku/catalogue.js";

export const APR_JUN26_PSCODE3 = {
  fy: "2026-27",
  months: ["Apr-26", "May-26", "Jun-26"],
  skuSource: "pscode3_xlsx",
  brandSource: "pscode3_brand_rollup",
  archiveSha256:
    "965f9cc18da465f1cf4e2fecfdff71f612fb7499788cf3e42d86806256bae2a4",
} as const;
export const APR_JUN_DROP = new Set([
  "SANTOSH KUMAR KV",
  "Ravindera",
  "AJOY BORAH",
  "SASIKUMAR A",
  "OP KALRA",
  "Ilesh Vyash",
  "SUMIT PAREEK",
  "Test",
  "HARDEEP KHINDA",
  "AMIT HARIDASJI BELONKAR",
  "SANDEEP DADHEECH",
  "L.SELVAGANAPATHY",
  "MANOKARAN",
  "KANISH KHANNA",
  "KAPIL THAKUR",
  "SUKANTA SEN",
  "RAVI KANT MAHATO",
]);
const NAME_OVERRIDE: Record<string, string> = {
  "SASHIKANT PRASAD": "Sasikant Prasad",
};
export const APR_JUN_ANCHORS = {
  "Apr-26": { rows: 21613, net: 131087397 },
  "May-26": { rows: 31266, net: 210078126 },
  "Jun-26": { rows: 36300, net: 249037679 },
} as const;
export type AprJunControls = {
  filesFound: number;
  filesDropped: number;
  filesLoading: number;
  rows: number;
  net: number;
  months: string[];
  footerRows: number;
  noItemCode: number;
  noMonth: number;
  skippedNoValue: number;
  wrongMonth: number;
};
export type PreparedAprJunLoad = {
  rows: InsertSecSkuLine[];
  controls: AprJunControls;
  byMonth: Record<string, { rows: number; net: number }>;
};
export type AprJunProvenance = {
  sourceNote: string;
  uploadedBy: string;
  uploadedAt: string;
  archiveSha256: string;
};
export type AprJunMonthState = {
  month: string;
  skuBefore: { rows: number; net: number };
  mirrorBefore: { rows: number; net: number };
  skuAfter: { rows: number; net: number };
  mirrorAfter: { rows: number; net: number };
  mode: "verify-and-skip";
  provenance: unknown;
};
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n =
    typeof v === "number" ? v : parseFloat(String(v).replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown) =>
  v == null
    ? ""
    : v instanceof Date
      ? v.toISOString()
      : typeof v === "object" && v && "result" in v
        ? String((v as any).result ?? "").trim()
        : String(v).trim();
function monthLabel(v: unknown): string | null {
  let d: Date | null = null;
  if (v instanceof Date) d = v;
  else if (typeof v === "number" && v > 20000)
    d = new Date((v - 25569) * 86400000);
  else if (typeof v === "string") {
    const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(v.trim());
    if (m) d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}-${String(d.getUTCFullYear() % 100).padStart(2, "0")}`;
}
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
export function assertApprovedAprJunArchive(sha: string) {
  if (sha !== APR_JUN26_PSCODE3.archiveSha256)
    throw new Error(
      "This route accepts only the approved April-June 2026 PSCode_3 archive.",
    );
}
export function assertAprJunControls(p: PreparedAprJunLoad) {
  const e: string[] = [];
  if (p.controls.filesFound !== 179)
    e.push(`filesFound=${p.controls.filesFound}; expected 179`);
  if (p.controls.filesDropped !== 17)
    e.push(`filesDropped=${p.controls.filesDropped}; expected 17`);
  if (p.controls.filesLoading !== 162)
    e.push(`filesLoading=${p.controls.filesLoading}; expected 162`);
  if (p.controls.rows !== 89179)
    e.push(`rows=${p.controls.rows}; expected 89179`);
  if (p.controls.net !== 590203202)
    e.push(`net=${p.controls.net}; expected 590203202`);
  if (p.controls.footerRows !== 162)
    e.push(`footerRows=${p.controls.footerRows}; expected 162`);
  if (
    p.controls.noItemCode ||
    p.controls.noMonth ||
    p.controls.skippedNoValue ||
    p.controls.wrongMonth
  )
    e.push(
      `invalidRows=${p.controls.noItemCode}/${p.controls.noMonth}/${p.controls.skippedNoValue}/${p.controls.wrongMonth}`,
    );
  for (const m of APR_JUN26_PSCODE3.months) {
    const a = p.byMonth[m],
      e2 = APR_JUN_ANCHORS[m as keyof typeof APR_JUN_ANCHORS];
    if (!a || a.rows !== e2.rows || a.net !== e2.net)
      e.push(`${m}=${a?.rows}/${a?.net}; expected ${e2.rows}/${e2.net}`);
  }
  if (e.length)
    throw new Error(`Apr-Jun PSCode_3 controls refused: ${e.join("; ")}`);
}
export async function prepareAprJunPsCode3Load(
  directory: string,
): Promise<PreparedAprJunLoad> {
  const all = readdirSync(directory).filter((f) =>
    /^PSCode_3_New_Report .*\.xlsx$/i.test(f),
  );
  const files = all.filter(
    (f) =>
      !APR_JUN_DROP.has(
        f
          .replace(/^PSCode_3_New_Report /, "")
          .replace(/\.xlsx$/i, "")
          .trim(),
      ),
  );
  const rows: InsertSecSkuLine[] = [];
  const occ = new Map<string, number>();
  const byMonth: Record<string, { rows: number; net: number }> = {};
  let footerRows = 0,
    noItemCode = 0,
    noMonth = 0,
    skippedNoValue = 0,
    wrongMonth = 0;
  for (const file of files) {
    const raw = file
        .replace(/^PSCode_3_New_Report /, "")
        .replace(/\.xlsx$/i, "")
        .trim(),
      member = NAME_OVERRIDE[raw] ?? raw,
      w = new ExcelJS.Workbook();
    await w.xlsx.readFile(path.join(directory, file));
    w.worksheets[0]?.eachRow((r, rn) => {
      if (rn <= 2) return;
      const c = (i: number) => r.getCell(i).value as unknown;
      if (str(c(1)).toUpperCase().startsWith("TOTAL")) {
        footerRows++;
        return;
      }
      const gross = num(c(10)),
        net = num(c(13)),
        retailer = str(c(4));
      if (gross == null && net == null) {
        if (retailer) skippedNoValue++;
        return;
      }
      const item = str(c(7));
      if (!item) {
        noItemCode++;
        return;
      }
      const m = monthLabel(c(2));
      if (!m) {
        noMonth++;
        return;
      }
      if (!APR_JUN26_PSCODE3.months.includes(m as any)) {
        wrongMonth++;
        return;
      }
      const distributor = str(c(11)),
        seg = str(c(6)) || null,
        grossStr = gross == null ? "" : String(gross),
        key = `${APR_JUN26_PSCODE3.fy}|${m}|${member}|${retailer}|${distributor}|${item}|${grossStr}`,
        n = (occ.get(key) ?? 0) + 1;
      occ.set(key, n);
      const uid = crypto
        .createHash("sha1")
        .update(
          [
            APR_JUN26_PSCODE3.fy,
            m,
            member,
            retailer,
            distributor,
            item,
            grossStr,
            n,
          ].join("|"),
        )
        .digest("hex");
      rows.push({
        lineUid: uid,
        fy: APR_JUN26_PSCODE3.fy,
        monthLabel: m,
        headRaw: member,
        headCanon: norm(member),
        stateRaw: null,
        stateCanon: null,
        retailer: retailer || null,
        retailerId: str(c(3)) || null,
        distributor: distributor || null,
        itemCode: item,
        segmentRaw: seg,
        segmentCanon: seg ? (canonGroupFromMap(seg) ?? null) : null,
        qty: num(c(8)) == null ? null : String(num(c(8))),
        mrp: num(c(9)) == null ? null : String(num(c(9))),
        netAmount: net == null ? null : String(net),
        grossAmount: gross == null ? null : String(gross),
        discountPct: num(c(12)) == null ? null : String(num(c(12))),
        source: APR_JUN26_PSCODE3.skuSource,
      } as InsertSecSkuLine);
      const x = byMonth[m] ?? { rows: 0, net: 0 };
      x.rows++;
      x.net += net ?? 0;
      byMonth[m] = x;
    });
  }
  return {
    rows,
    byMonth,
    controls: {
      filesFound: all.length,
      filesDropped: all.length - files.length,
      filesLoading: files.length,
      rows: rows.length,
      net: rows.reduce((a, r) => a + Number(r.netAmount ?? 0), 0),
      months: [...new Set(rows.map((r) => r.monthLabel))].sort(),
      footerRows,
      noItemCode,
      noMonth,
      skippedNoValue,
      wrongMonth,
    },
  };
}
async function totals(
  client: any,
  table: "secondary_sku_line" | "secondary_register_line",
  month: string,
  source?: string,
) {
  const r = await client.query(
    `SELECT count(*)::int rows,coalesce(sum(net_amount),0)::numeric::text net FROM ${table} WHERE fy=$1 AND month_label=$2 ${source ? "AND source=$3" : ""}`,
    source
      ? [APR_JUN26_PSCODE3.fy, month, source]
      : [APR_JUN26_PSCODE3.fy, month],
  );
  return {
    rows: Number(r.rows[0]?.rows ?? 0),
    net: Number(r.rows[0]?.net ?? 0),
  };
}
export async function preflightAprJun(p: PreparedAprJunLoad) {
  const out: Record<string, any> = {};
  for (const m of APR_JUN26_PSCODE3.months) {
    const [s, b] = await Promise.all([
      totals(pool, "secondary_sku_line", m),
      totals(pool, "secondary_register_line", m, APR_JUN26_PSCODE3.brandSource),
    ]);
    out[m] = {
      skuBefore: s,
      mirrorBefore: b,
      operation: "verify-and-skip SKU; replace brand mirror; append provenance",
    };
    if (
      s.rows !== APR_JUN_ANCHORS[m as keyof typeof APR_JUN_ANCHORS].rows ||
      s.net !== APR_JUN_ANCHORS[m as keyof typeof APR_JUN_ANCHORS].net
    )
      throw new Error(
        `${m} existing SKU does not match anchor; refusing commit`,
      );
  }
  return out;
}
export async function commitAprJunPsCode3Load(
  p: PreparedAprJunLoad,
  prov: AprJunProvenance,
) {
  assertAprJunControls(p);
  assertApprovedAprJunArchive(prov.archiveSha256);
  if (!prov.sourceNote.trim() || prov.sourceNote.length > 2_000)
    throw new Error(
      "source_note is required and must be 2,000 characters or fewer",
    );
  if (!prov.uploadedBy.trim() || prov.uploadedBy.length > 200)
    throw new Error(
      "uploaded_by is required and must be 200 characters or fewer",
    );
  if (!Number.isFinite(Date.parse(prov.uploadedAt)))
    throw new Error("uploadedAt must be a valid ISO timestamp");
  await preflightAprJun(p);
  const states: AprJunMonthState[] = [];
  for (const m of APR_JUN26_PSCODE3.months) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${APR_JUN26_PSCODE3.brandSource}-${m}`,
      ]);
      const s = await totals(client, "secondary_sku_line", m);
      const b = await totals(
        client,
        "secondary_register_line",
        m,
        APR_JUN26_PSCODE3.brandSource,
      );
      const a = APR_JUN_ANCHORS[m as keyof typeof APR_JUN_ANCHORS];
      if (s.rows !== a.rows || s.net !== a.net)
        throw new Error(`${m} SKU changed or mismatches anchor`);
      await client.query(
        "DELETE FROM secondary_register_line WHERE fy=$1 AND month_label=$2 AND source=$3",
        [APR_JUN26_PSCODE3.fy, m, APR_JUN26_PSCODE3.brandSource],
      );
      await client.query(
        `INSERT INTO secondary_register_line
        (line_uid,fy,month_label,head_raw,head_canon,customer,brand_raw,brand_canon,qty,source,gross_amount,net_amount,discount_pct)
        SELECT 'brl-'||line_uid,fy,month_label,head_raw,head_raw,retailer,segment_raw,segment_raw,qty,$3,gross_amount,net_amount,discount_pct
          FROM secondary_sku_line WHERE fy=$1 AND month_label=$2`,
        [APR_JUN26_PSCODE3.fy, m, APR_JUN26_PSCODE3.brandSource],
      );
      const ba = await totals(
        client,
        "secondary_register_line",
        m,
        APR_JUN26_PSCODE3.brandSource,
      );
      if (ba.rows !== a.rows || ba.net !== a.net)
        throw new Error(`${m} brand mirror does not match anchor`);
      const verifiedAt = new Date();
      const controls = {
        archive: APR_JUN26_PSCODE3.archiveSha256,
        prepared: p.byMonth[m],
        anchor: a,
        mode: "verify-and-skip",
      };
      await client.query(
        `INSERT INTO secondary_sku_load_provenance
        (fy,month_label,source_note,uploaded_by,uploaded_at,archive_sha256,row_count,net_amount,source,controls,verified_at,source_file)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
        [
          APR_JUN26_PSCODE3.fy,
          m,
          prov.sourceNote.trim(),
          prov.uploadedBy.trim(),
          new Date(prov.uploadedAt),
          prov.archiveSha256,
          a.rows,
          a.net,
          APR_JUN26_PSCODE3.skuSource,
          JSON.stringify(controls),
          verifiedAt,
          "PSCODE_3_NEW_REPORT_1785584202460.zip",
        ],
      );
      await client.query("COMMIT");
      states.push({
        month: m,
        skuBefore: s,
        mirrorBefore: b,
        skuAfter: s,
        mirrorAfter: ba,
        mode: "verify-and-skip",
        provenance: {
          archiveSha256: prov.archiveSha256,
          verifiedAt: verifiedAt.toISOString(),
          source: APR_JUN26_PSCODE3.skuSource,
        },
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  return states;
}
export async function latestAprJunProvenance() {
  const r = await pool.query(
    `SELECT DISTINCT ON (month_label) month_label,source_note,uploaded_by,uploaded_at::text,
      archive_sha256,row_count,net_amount,source,controls,verified_at::text,source_file
    FROM secondary_sku_load_provenance
    WHERE fy=$1 AND month_label=ANY($2)
    ORDER BY month_label,uploaded_at DESC,id DESC`,
    [APR_JUN26_PSCODE3.fy, [...APR_JUN26_PSCODE3.months]],
  );
  return r.rows;
}
