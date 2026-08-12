// FY2026-27 secondary register load — 181-file PSCode_3 xlsx drop.
// Rules from the load prompt:
//   - NET = Sub Total (col M); Order Total (N) never summed
//   - "Total:" footer rows excluded
//   - merged Order ID / Segment resolved (ExcelJS returns master values)
//   - 16 duplicate-export groups: load ONE file per group
//   - target table: secondary_sku_line (item-code detail), source='pscode3_xlsx'
import ExcelJS from "exceljs";
import crypto from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db, secondarySkuLines, type InsertSecSkuLine } from "@workspace/db";
import { canonGroupFromMap } from "../src/lib/sku/catalogue.js";
import { assertSkuWipeGuard, WipeGuardAbortError } from "../src/lib/sku/skuWipeGuard.js";

const DIR = "/tmp/pscode3/PSCODE 3 NEW REPORT";
const FY = "2026-27";
const SOURCE = "pscode3_xlsx";
// Destructive replace of the whole FY — writes require an explicit --write flag.
const DRY = !process.argv.includes("--write");
// Skip the wipe guard for legitimate small loads (single-month re-sync, new-FY
// bootstrap). Must be passed explicitly — never defaulted, never from env vars.
const SKIP_GUARD = process.argv.includes("--skip-guard");

// One winner per duplicate-export group (identical Order IDs verified in the
// analysis pass). Winner = the name that matches the FY2026-27 SOBR dashboard
// roster; where both/neither match, the first listed. The losers' files are
// byte-identical business content under a different salesperson name.
//
// CONFIRMED correct by business review (Aug 2026):
//   - SANDEEP DADHEECH is a State Head (74 members), not a field rep. The file
//     under that name is a mislabelled export of SANDEEP AMRUT SANWANE's data —
//     confirmed by row profile (455 rows, 30 retailers, 3 distributors, ₹0.22 Cr;
//     consistent with a typical rep, not a roll-up). Mislabelling is at the
//     export-tool level; report to whoever generates these files.
//   - SASHIKANT PRASAD kept above (correct rep); spelling corrected via NAME_OVERRIDE
//     to "Sasikant Prasad" to match the SOBR dashboard roster. Override is applied
//     before any key derivation so re-runs stay consistent.
//   - SUJIT DAS is on Sandeep Dadheech's team but marked LEFT. Loading his
//     historical data is correct; he is excluded from current-period performance
//     and low-performer counts by the isLeft flag in stateDashboard.ts.
//   - RAVI (FARIDABAD) is confirmed correct; RAVI KANT MAHATO is not on any roster.
const DUP_DROP = new Set<string>([
  // group → dropped copies
  "SANTOSH KUMAR KV",          // keep SANTANU KALITA
  "Ravindera",                 // keep RAVINDER PURI
  "AJOY BORAH",                // keep AJEET YADAV
  "SASIKUMAR A",               // keep SASHIKANT PRASAD (normalised → Sasikant Prasad via NAME_OVERRIDE)
  "OP KALRA",                  // keep NITIN PRASAD BAGHEL
  "Ilesh Vyash",               // keep HRUSIKESH SATAPATHY
  "SUMIT PAREEK",              // keep SUMANTA SINGHA
  "Test",                      // keep TEJAS LUNAWAT
  "HARDEEP KHINDA",            // keep GULAB SINGH
  "AMIT HARIDASJI BELONKAR",   // keep AMIT DAMODHAR JADHAV
  "SANDEEP DADHEECH",          // keep SANDEEP AMRUT SANWANE (DADHEECH is a State Head, not a rep — mislabelled export)
  "L.SELVAGANAPATHY",          // keep KUNAL SANJAY SAASNE
  "MANOKARAN",                 // keep MANOJ YADAV
  "KANISH KHANNA",             // keep KANHAIYA LAL SALVI (3-copy group)
  "KAPIL THAKUR",              // keep KANHAIYA LAL SALVI (3-copy group)
  "SUKANTA SEN",               // keep SUJIT DAS (LEFT; loaded for history, excluded from current-period metrics)
  "RAVI KANT MAHATO",          // keep RAVI (FARIDABAD) — confirmed; RAVI KANT MAHATO not on any roster
]);

// Canonical name overrides: applied to the member name derived from the filename
// before any key derivation (headRaw, headCanon, natKey, lineUid).
// Use when the export file is named differently from the SOBR dashboard roster.
const NAME_OVERRIDE: Record<string, string> = {
  "SASHIKANT PRASAD": "Sasikant Prasad",  // roster spelling (Sandeep Dadheech team, Active)
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

const files = readdirSync(DIR)
  .filter((f) => f.startsWith("PSCode_3_New_Report ") && f.endsWith(".xlsx"))
  .filter((f) => !DUP_DROP.has(f.replace(/^PSCode_3_New_Report /, "").replace(/\.xlsx$/, "").trim()));
console.log(`files after dedupe: ${files.length} (dropped ${DUP_DROP.size} duplicate exports)`);

const rows: InsertSecSkuLine[] = [];
const occurrenceMap = new Map<string, number>();
let noItemCode = 0, noMonth = 0, skippedNoValue = 0, totalRows = 0;

for (const f of files) {
  const rawMember = f.replace(/^PSCode_3_New_Report /, "").replace(/\.xlsx$/, "").trim();
  const member = NAME_OVERRIDE[rawMember] ?? rawMember;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(DIR, f));
  wb.worksheets[0].eachRow((row, rn) => {
    if (rn <= 2) return;
    const c = (i: number) => row.getCell(i).value as unknown;
    if (str(c(1)).toUpperCase().startsWith("TOTAL")) { totalRows++; return; }
    const gross = num(c(10));
    const net = num(c(13));
    const retailer = str(c(4));
    if (gross == null && net == null) { if (retailer) skippedNoValue++; return; }
    const itemCode = str(c(7));
    if (!itemCode) { noItemCode++; return; }
    const ml = monthLabel(c(2));
    if (!ml) { noMonth++; return; }
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

const cr = (n: number) => (n / 1e7).toFixed(4);
const byM = new Map<string, { n: number; net: number; gross: number }>();
for (const r of rows) {
  const e = byM.get(r.monthLabel) ?? { n: 0, net: 0, gross: 0 };
  e.n++; e.net += parseFloat(String(r.netAmount ?? 0)); e.gross += parseFloat(String(r.grossAmount ?? 0));
  byM.set(r.monthLabel, e);
}
console.log(`parsed rows: ${rows.length} | footer rows excluded: ${totalRows} | noItemCode: ${noItemCode} | noMonth: ${noMonth} | skippedNoValue: ${skippedNoValue}`);
for (const [m, e] of [...byM.entries()].sort())
  console.log(`  ${m}: lines=${e.n} NET=${cr(e.net)}Cr gross=${cr(e.gross)}Cr disc=${((1 - e.net / e.gross) * 100).toFixed(1)}%`);
const prasunNet = rows.filter((r) => r.headCanon === "prasun chatterjee").reduce((s, r) => s + parseFloat(String(r.netAmount ?? 0)), 0);
console.log(`Prasun control: ₹${prasunNet.toFixed(0)} (expect 1834504±2)`);
const segNull = rows.filter((r) => !r.segmentCanon).length;
console.log(`segment_canon unmapped: ${segNull} of ${rows.length}`);

if (DRY) { console.log("DRY RUN — no DB writes (pass --write to load)"); process.exit(0); }

// Safety gate before the destructive full-FY replace: the Prasun control and a
// sane row count must hold, or the run aborts with nothing deleted.
if (rows.length < 50_000) throw new Error(`abort: only ${rows.length} rows parsed — refusing to replace FY${FY}`);
if (Math.abs(prasunNet - 1_834_504) > 5) throw new Error(`abort: Prasun control failed (₹${prasunNet.toFixed(0)}) — refusing to replace FY${FY}`);

// The brand-level mirror (secondary_register_line, source='pscode3_brand_rollup')
// feeds segment-spread, win-back and effective-discount views. It is refreshed in
// the SAME transaction as the sku load so the two tables can never disagree.
const BRAND_SOURCE = "pscode3_brand_rollup";

await db.transaction(async (tx) => {
  // ── Wipe guard: must run BEFORE the DELETE, inside this transaction ────────
  // Throws WipeGuardAbortError on ratio violation — Drizzle rolls back.
  await assertSkuWipeGuard({
    tx: tx as any,
    fy: FY,
    incoming: rows.map((r) => ({ monthLabel: r.monthLabel, distributor: r.distributor ?? null })),
    skipGuard: SKIP_GUARD,
    callerLabel: "pscode3-load.ts --skip-guard flag",
  });
  await tx.execute(sql`DELETE FROM secondary_sku_line WHERE fy = ${FY}`);
  for (let i = 0; i < rows.length; i += 1000) {
    await tx.insert(secondarySkuLines).values(rows.slice(i, i + 1000));
  }
  // Mirror into secondary_register_line (same mapping as pscode3-brand-backfill.ts):
  // brand = segment_raw, customer = retailer, head_canon = head_raw (register
  // convention), line_uid namespaced with 'brl-'.
  await tx.execute(sql`DELETE FROM secondary_register_line WHERE fy = ${FY} AND source = ${BRAND_SOURCE}`);
  await tx.execute(sql`
    INSERT INTO secondary_register_line
      (line_uid, fy, month_label, head_raw, head_canon, customer,
       brand_raw, brand_canon, qty, source, gross_amount, net_amount, discount_pct)
    SELECT 'brl-' || line_uid, fy, month_label, head_raw, head_raw, retailer,
           segment_raw, segment_raw, qty, ${BRAND_SOURCE}, gross_amount, net_amount, discount_pct
    FROM   secondary_sku_line
    WHERE  fy = ${FY}
  `);
});
const check = await db.execute(sql`SELECT month_label, count(*)::int AS n, sum(net_amount)::numeric AS net FROM secondary_sku_line WHERE fy = ${FY} GROUP BY 1 ORDER BY 1`);
console.log("DB after load:");
for (const r of check.rows as any[]) console.log(`  ${r.month_label}: ${r.n} rows, NET ${cr(parseFloat(r.net))} Cr`);
const mirror = await db.execute(sql`SELECT month_label, count(*)::int AS n, sum(net_amount)::numeric AS net FROM secondary_register_line WHERE fy = ${FY} AND source = ${BRAND_SOURCE} GROUP BY 1 ORDER BY 1`);
console.log("DB after load (brand mirror, secondary_register_line):");
for (const r of mirror.rows as any[]) console.log(`  ${r.month_label}: ${r.n} rows, NET ${cr(parseFloat(r.net))} Cr`);
process.exit(0);
