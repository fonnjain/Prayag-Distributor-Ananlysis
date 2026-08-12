// FY2026-27 secondary register — July 2026 PSCode_3 xlsx drop.
// Month-only replace: only Jul-26 rows are touched; Apr/May/Jun remain intact.
//
// Same structure as the Apr-Jun load (pscode3-load.ts):
//   - Sheet1, header rows 1-2, data from row 3
//   - "Total:" footer rows excluded
//   - ExcelJS returns master values for merged cells (Date, Order ID, Segment)
//   - NET = Sub Total (col M); Order Total (col N) never summed
//   - 13 duplicate-export groups resolved by Order ID match (verified pre-load)
//   - target: secondary_sku_line + secondary_register_line mirror
//
// Usage:
//   node dist/pscode3-load-jul26.mjs          <- dry run (default)
//   node dist/pscode3-load-jul26.mjs --write  <- commit to DB
import ExcelJS from "exceljs";
import crypto from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db, secondarySkuLines, type InsertSecSkuLine } from "@workspace/db";
import { canonGroupFromMap } from "../src/lib/sku/catalogue.js";
import { checkOpenFyWipeGuard, priorLikeMonthLabel, priorFyLabel } from "../src/lib/secondary/skuLoader.js";

const DIR = "/tmp/jul26/PSCode 3 NEW REPORTS JULY2026";
const FY = "2026-27";
const MONTH = "Jul-26";
const SOURCE = "pscode3_xlsx";
const BRAND_SOURCE = "pscode3_brand_rollup";
const DRY = !process.argv.includes("--write");

// One winner per duplicate-export group.
// Drop list = files to discard. Same convention as the Apr-Jun load so
// each person's Jul rows carry the same head_canon as their Apr-Jun rows.
//
// April-Jun keeper → July decision:
//   AJEET YADAV kept          (AJOY BORAH dropped)
//   ASHUTOSH KUMAR kept       (ASHUTOSH KUAMR dropped — typo pair)
//   OM DUTT DWIVEDI kept      (O.P. KALRA dropped — Apr-Jun used OM DUTT DWIVEDI)
//   SUMANTA SINGHA kept       (SUMIT PAREEK dropped)
//   SASHIKANT PRASAD kept     (SASIKUMAR A dropped — normalised via NAME_OVERRIDE)
//   AMIT DAMODHAR JADHAV kept (AMIT HARIDASJI BELONKAR dropped)
//   HRUSIKESH SATAPATHY kept  (ILESH VYAS dropped)
//   GULAB SINGH kept          (HARDEEP KHINDA dropped)
//   SANDEEP AMRUT SONAWANE    (SANDEEP DADHEECH dropped — Dadheech is a State Head)
//   KUNAL SANJAY SAASNE kept  (L.SELVAGANAPATHY dropped — normalised via NAME_OVERRIDE)
//   MANOJ YADAV kept          (MANOKARAN dropped)
//   KANHAIYA LAL SALVI kept   (KANISH KHANNA + KAPIL THAKUR dropped — 3-way)
//   RAVI FARIDABAD kept       (RAVI KANT MAHATO dropped)
const DUP_DROP = new Set<string>([
  "AJOY BORAH",
  "ASHUTOSH KUAMR",
  "O.P. KALRA",
  "SUMIT PAREEK",
  "SASIKUMAR A",
  "AMIT HARIDASJI BELONKAR",
  "ILESH VYAS",
  "HARDEEP KHINDA",
  "SANDEEP DADHEECH",
  "L.SELVAGANAPATHY",
  "MANOKARAN",
  "KANISH KHANNA",
  "KAPIL THAKUR",
  "RAVI KANT MAHATO",
]);

// Canonical name overrides — applied before key derivation so re-runs are
// stable and head_canon matches the Apr-Jun load for the same person.
const NAME_OVERRIDE: Record<string, string> = {
  "NITIN PARASAD BAGHEL":    "NITIN PRASAD BAGHEL",    // typo in filename
  "KUNAL SANJAY SASANE":     "KUNAL SANJAY SAASNE",    // match Apr-Jun spelling
  "SASIKANT PRASAD":         "SASHIKANT PRASAD",        // match Apr-Jun spelling
  "ARVIND KUAMR":            "ARVIND KUMAR",            // typo in filename
  "ROHIT KUAMR":             "ROHIT KUMAR",             // typo in filename
  "PAWAN KUAMR":             "PAWAN KUMAR",             // typo in filename
  "RONI GUPATA":             "RONI GUPTA",              // typo in filename
  "PRABHAKR PRATAP SINGH":   "PRABHAKAR PRATAP SINGH",  // typo in filename
  "ASHUTOSH KUMAR(RUDRAPUR)":"ASHUTOSH KUMAR (RUDRAPUR)", // add space, match DB
};

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && "result" in (v as any)) return String((v as any).result ?? "").trim();
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
  if (!d || isNaN(d.getTime())) return null;
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${M[d.getUTCMonth()]}-${String(d.getUTCFullYear() % 100).padStart(2, "0")}`;
}
const normKey = (raw: string) => raw.toLowerCase().replace(/\s+/g, " ").trim();

const allFiles = readdirSync(DIR).filter(
  (f) => f.startsWith("PSCode_3_New_Report ") && f.endsWith(".xlsx"),
);
const files = allFiles.filter((f) => {
  const raw = f.replace(/^PSCode_3_New_Report /, "").replace(/\.xlsx$/, "").trim();
  return !DUP_DROP.has(raw);
});
console.log(`Files found:   ${allFiles.length}  (expected 163)`);
console.log(`Files dropped: ${allFiles.length - files.length}  (expected 14 — 13 groups + KANISH KHANNA + KAPIL THAKUR as 3-way)`);
console.log(`Files loading: ${files.length}  (expected 149)`);

const rows: InsertSecSkuLine[] = [];
const occurrenceMap = new Map<string, number>();
let footerRows = 0, noItemCode = 0, noMonth = 0, skippedNoValue = 0, wrongMonth = 0;
const rawTotals = { rows: 0, net: 0 };  // before dedup (all 163)

// Raw totals pass — count all files including dropped ones for control verification
for (const f of allFiles) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(DIR, f));
  wb.worksheets[0].eachRow((row, rn) => {
    if (rn <= 2) return;
    const c = (i: number) => row.getCell(i).value as unknown;
    if (str(c(1)).toUpperCase().startsWith("TOTAL")) return;
    const net = num(c(13));
    const gross = num(c(10));
    if (gross == null && net == null) return;
    rawTotals.rows++;
    rawTotals.net += net ?? 0;
  });
}
console.log(`\nRAW TOTALS (all 163 files):`);
console.log(`  rows: ${rawTotals.rows}  (expected 36,805)`);
console.log(`  NET:  ₹${(rawTotals.net/1e7).toFixed(2)} Cr  (expected 23.93)`);

// Main parse pass — deduped files only
for (const f of files) {
  const rawMember = f.replace(/^PSCode_3_New_Report /, "").replace(/\.xlsx$/, "").trim();
  const member = NAME_OVERRIDE[rawMember] ?? rawMember;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(DIR, f));
  wb.worksheets[0].eachRow((row, rn) => {
    if (rn <= 2) return;
    const c = (i: number) => row.getCell(i).value as unknown;
    if (str(c(1)).toUpperCase().startsWith("TOTAL")) { footerRows++; return; }
    const gross = num(c(10));
    const net = num(c(13));
    const retailer = str(c(4));
    if (gross == null && net == null) { if (retailer) skippedNoValue++; return; }
    const itemCode = str(c(7));
    if (!itemCode) { noItemCode++; return; }
    const ml = monthLabel(c(2));
    if (!ml) { noMonth++; return; }
    if (ml !== MONTH) { wrongMonth++; return; }
    const distributor = str(c(11));
    const segmentRaw = str(c(6)) || null;
    const grossStr = gross != null ? String(gross) : "";
    const natKey = `${FY}|${ml}|${member}|${retailer}|${distributor}|${itemCode}|${grossStr}`;
    const occ = (occurrenceMap.get(natKey) ?? 0) + 1;
    occurrenceMap.set(natKey, occ);
    const lineUid = crypto.createHash("sha1")
      .update([FY, ml, member, retailer, distributor, itemCode, grossStr, occ].join("|"))
      .digest("hex");
    rows.push({
      lineUid,
      fy: FY,
      monthLabel: ml,
      headRaw: member,
      headCanon: normKey(member),
      stateRaw: null,
      stateCanon: null,
      retailer: retailer || null,
      retailerId: str(c(3)) || null,
      distributor: distributor || null,
      itemCode,
      segmentRaw,
      segmentCanon: segmentRaw ? (canonGroupFromMap(segmentRaw) ?? null) : null,
      qty: num(c(8)) != null ? String(num(c(8))) : null,
      mrp: num(c(9)) != null ? String(num(c(9))) : null,
      netAmount: net != null ? String(net) : null,
      grossAmount: gross != null ? String(gross) : null,
      discountPct: num(c(12)) != null ? String(num(c(12))) : null,
      source: SOURCE,
    } as InsertSecSkuLine);
  });
}

const deduped = { net: 0, gross: 0 };
for (const r of rows) {
  deduped.net += parseFloat(String(r.netAmount ?? 0));
  deduped.gross += parseFloat(String(r.grossAmount ?? 0));
}
const disc = ((1 - deduped.net / deduped.gross) * 100).toFixed(1);

console.log(`\nDEDUPED TOTALS (${files.length} files, Jul-26 only):`);
console.log(`  rows:     ${rows.length}  (expected 34,147)`);
console.log(`  NET:      ₹${(deduped.net/1e7).toFixed(2)} Cr  (expected 22.34)`);
console.log(`  discount: ${disc}%  (expected ~49.5%)`);
console.log(`  footer rows excluded: ${footerRows} | noItemCode: ${noItemCode} | noMonth: ${noMonth} | wrongMonth: ${wrongMonth}`);

// ASHUTOSH KUMAR vs ASHUTOSH KUMAR (RUDRAPUR) — confirm they are separate
const ashutosh = rows.filter(r => r.headCanon?.startsWith("ashutosh kumar"));
const ashMain = ashutosh.filter(r => r.headCanon === "ashutosh kumar");
const ashRudrapur = ashutosh.filter(r => r.headCanon?.includes("rudrapur"));
console.log(`\nASHUTOSH check:`);
console.log(`  ASHUTOSH KUMAR rows:          ${ashMain.length}  (Sandeep Dadheech team)`);
console.log(`  ASHUTOSH KUMAR (RUDRAPUR) rows: ${ashRudrapur.length}  (Anant Singh team)`);

// Distinct months — must be Jul-26 only
const months = new Set(rows.map(r => r.monthLabel));
console.log(`\nMonths in deduped load: ${[...months].join(", ")}  (must be Jul-26 only)`);

if (DRY) {
  console.log("\nDRY RUN — no DB writes. Pass --write to load.");
  process.exit(0);
}

// Safety gates before destructive replace of Jul-26
if (rows.length < 30_000) throw new Error(`abort: only ${rows.length} deduped rows — too few`);
if (Math.abs(deduped.net - 223_400_000) > 2_000_000) throw new Error(`abort: NET ₹${(deduped.net/1e7).toFixed(4)} Cr deviates from ₹22.34 Cr — refusing to load`);
if (months.size !== 1 || !months.has(MONTH)) throw new Error(`abort: unexpected months ${[...months]} in load`);

await db.transaction(async (tx) => {
  // ── Wipe guard: runs BEFORE the DELETE, inside the transaction ─────────────
  // Compares Jul-26 incoming row count against prior-FY Jul-25 row count.
  // A batch below 60% of the prior like-month rolls back the transaction —
  // no data is ever deleted.
  const PRIOR_FY = priorFyLabel(FY);
  const priorMonthLbl = priorLikeMonthLabel(MONTH); // "Jul-25"
  const priorRes = await tx.execute<{ rows: string }>(
    sql`SELECT COUNT(*)::text AS rows FROM secondary_sku_line WHERE fy = ${PRIOR_FY} AND month_label = ${priorMonthLbl}`,
  );
  const priorRows = parseInt(((priorRes.rows[0] as { rows: string }) ?? { rows: "0" }).rows, 10);
  const priorByMonth = new Map([[priorMonthLbl, priorRows]]);
  const incomingByMonth = new Map([[MONTH, rows.length]]);
  const guard = checkOpenFyWipeGuard(incomingByMonth, priorByMonth);
  if (!guard.ok) {
    throw new Error(`pscode3-load-jul26: wipe guard triggered — ${guard.reason}`);
  }
  console.log(`Wipe guard passed: ${MONTH} incoming=${rows.length} vs prior ${priorMonthLbl}=${priorRows}`);

  // Remove Jul-26 from both tables (leave Apr/May/Jun intact)
  await tx.execute(sql`DELETE FROM secondary_sku_line WHERE fy = ${FY} AND month_label = ${MONTH}`);
  await tx.execute(sql`DELETE FROM secondary_register_line WHERE fy = ${FY} AND month_label = ${MONTH} AND source = ${BRAND_SOURCE}`);

  // Insert sku detail
  for (let i = 0; i < rows.length; i += 1000) {
    await tx.insert(secondarySkuLines).values(rows.slice(i, i + 1000));
  }

  // Mirror into secondary_register_line (brand rollup)
  await tx.execute(sql`
    INSERT INTO secondary_register_line
      (line_uid, fy, month_label, head_raw, head_canon, customer,
       brand_raw, brand_canon, qty, source, gross_amount, net_amount, discount_pct)
    SELECT 'brl-' || line_uid, fy, month_label, head_raw, head_raw, retailer,
           segment_raw, segment_raw, qty, ${BRAND_SOURCE}, gross_amount, net_amount, discount_pct
    FROM   secondary_sku_line
    WHERE  fy = ${FY} AND month_label = ${MONTH}
  `);
});

// Post-load verification
const sku = await db.execute(sql`
  SELECT month_label, count(*)::int AS n, sum(net_amount)::numeric AS net
  FROM secondary_sku_line WHERE fy = ${FY} GROUP BY 1 ORDER BY 1`);
console.log("\nDB after load (secondary_sku_line):");
for (const r of sku.rows as any[])
  console.log(`  ${r.month_label}: ${r.n} rows  NET ₹${(parseFloat(r.net)/1e7).toFixed(2)} Cr`);

const reg = await db.execute(sql`
  SELECT month_label, count(*)::int AS n, sum(net_amount)::numeric AS net
  FROM secondary_register_line WHERE fy = ${FY} AND source = ${BRAND_SOURCE} GROUP BY 1 ORDER BY 1`);
console.log("DB after load (secondary_register_line brand mirror):");
for (const r of reg.rows as any[])
  console.log(`  ${r.month_label}: ${r.n} rows  NET ₹${(parseFloat(r.net)/1e7).toFixed(2)} Cr`);

const apjul = await db.execute(sql`
  SELECT sum(net_amount)::numeric AS net FROM secondary_register_line
  WHERE fy = ${FY} AND source = ${BRAND_SOURCE}`);
console.log(`\nFY2026-27 Apr-Jul running total: ₹${(parseFloat((apjul.rows[0] as any).net)/1e7).toFixed(2)} Cr  (expected 81.36)`);

process.exit(0);
