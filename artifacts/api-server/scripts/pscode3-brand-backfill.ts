// FY2026-27 brand-level backfill.
//
// NOTE: as of Aug 2026 pscode3-load.ts refreshes this mirror automatically in
// the same transaction as the sku load, so a fresh drop never needs this script.
// It remains as a standalone repair tool (mapping must stay identical to the
// mirror step in pscode3-load.ts).
//
// The PSCode_3 xlsx drop was loaded at item-code level into secondary_sku_line
// (source='pscode3_xlsx'). Distributor segment spread (D3), win-back and the
// effective-discount step of the investment view read the brand-level table
// secondary_register_line, which was empty for FY2026-27. This script mirrors
// the FY2026-27 sku lines into secondary_register_line 1:1:
//   - brand_raw / brand_canon = segment_raw (verified Aug 2026: every FY2026-27
//     Segment value matches the prior-FY brand_canon vocabulary exactly)
//   - customer = retailer, head_canon = head_raw (register convention stores
//     raw names; consumers normalise via regexp_replace)
//   - line_uid = 'brl-' || sku line_uid (namespaced, collision-free)
//   - source = 'pscode3_brand_rollup' so the rows are distinguishable and the
//     backfill is idempotent (delete-by-source + reinsert).
//
// No double-counting: no analytics sums secondary_sku_line and
// secondary_register_line together — item-code features gate on the sku table,
// brand-level features on the register table.
//
// Dry-run by default; pass --write to load.
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

const FY = "2026-27";
const SOURCE = "pscode3_brand_rollup";
const DRY = !process.argv.includes("--write");

const src = await db.execute(sql`
  SELECT month_label, count(*)::int AS n, sum(net_amount)::numeric AS net
  FROM   secondary_sku_line
  WHERE  fy = ${FY}
  GROUP BY 1 ORDER BY 1
`);
const cr = (n: number) => (n / 1e7).toFixed(4);
let totalRows = 0, totalNet = 0;
console.log("source (secondary_sku_line):");
for (const r of src.rows as any[]) {
  totalRows += r.n; totalNet += parseFloat(r.net);
  console.log(`  ${r.month_label}: ${r.n} rows, NET ${cr(parseFloat(r.net))} Cr`);
}
console.log(`  total: ${totalRows} rows, NET ${cr(totalNet)} Cr (expect ~59.02 Cr)`);

if (DRY) { console.log("DRY RUN — no DB writes (pass --write to load)"); process.exit(0); }

if (totalRows < 50_000) throw new Error(`abort: only ${totalRows} source rows — refusing backfill`);

await db.transaction(async (tx) => {
  await tx.execute(sql`DELETE FROM secondary_register_line WHERE fy = ${FY} AND source = ${SOURCE}`);
  await tx.execute(sql`
    INSERT INTO secondary_register_line
      (line_uid, fy, month_label, head_raw, head_canon, customer,
       brand_raw, brand_canon, qty, source, gross_amount, net_amount, discount_pct)
    SELECT 'brl-' || line_uid, fy, month_label, head_raw, head_raw, retailer,
           segment_raw, segment_raw, qty, ${SOURCE}, gross_amount, net_amount, discount_pct
    FROM   secondary_sku_line
    WHERE  fy = ${FY}
  `);
});

const check = await db.execute(sql`
  SELECT month_label, count(*)::int AS n, sum(net_amount)::numeric AS net
  FROM   secondary_register_line
  WHERE  fy = ${FY}
  GROUP BY 1 ORDER BY 1
`);
console.log("DB after backfill (secondary_register_line):");
for (const r of check.rows as any[]) console.log(`  ${r.month_label}: ${r.n} rows, NET ${cr(parseFloat(r.net))} Cr`);
process.exit(0);
