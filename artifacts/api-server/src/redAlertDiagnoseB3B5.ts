// Red Alert — B3/B5 diagnostic.
//
// Answers the four B3 questions and the B5 question from the Aug 2026 calibration
// review. Read-only. No fixes, no routes, no writes.
//
// Run: pnpm --filter @workspace/api-server exec node --enable-source-maps ./dist/redAlertDiagnoseB3B5.mjs

import { pool } from "@workspace/db";
import { buildDetectionContext } from "./lib/redAlert/context.js";
import { detectAlerts, fyMonthLabels } from "./lib/redAlert/detectAlerts.js";
import type { RawAlert } from "./lib/redAlert/types.js";

const FY_COMPLETE = "2025-26";
const FY_YTD     = "2026-27";

function cr(v: number): string {
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
}

function sep(c = "─", w = 72) { return c.repeat(w); }
function section(title: string) { console.log("\n" + sep("═")); console.log("  " + title); console.log(sep("═")); }
function sub(title: string) { console.log("\n" + sep()); console.log("  " + title); console.log(sep()); }

async function main() {
  console.log("RED ALERT — B3/B5 DIAGNOSTIC");
  console.log(`Run at: ${new Date().toISOString()}`);
  console.log("Read-only. No writes, no routes, no stored alerts.");

  console.log("\nFetching context…");
  const ctx = await buildDetectionContext(pool, [FY_COMPLETE, FY_YTD]);

  // ── FY2026-27 effective months (same logic as calibration) ─────────────────
  const frozenYtd = [...(ctx.frozenMonths.get(FY_YTD) ?? [])].sort();
  const secYtdMonths = new Set<string>();
  for (const [, hMap] of ctx.secCompleteMonths.get(FY_YTD) ?? []) {
    for (const m of hMap) secYtdMonths.add(m);
  }
  let ytdMonths: string[];
  if (frozenYtd.length > 0 && secYtdMonths.size > 0) {
    ytdMonths = frozenYtd.filter((m) => secYtdMonths.has(m));
    if (ytdMonths.length === 0) ytdMonths = frozenYtd;
  } else {
    ytdMonths = frozenYtd.length > 0 ? frozenYtd : fyMonthLabels(FY_YTD).slice(0, 4);
  }

  console.log(`\nFY${FY_YTD} effective analysis months: [${ytdMonths.join(", ")}]`);

  // ── Run detection ──────────────────────────────────────────────────────────
  const resultComplete = detectAlerts(ctx, { fy: FY_COMPLETE });
  const resultYtd      = detectAlerts(ctx, { fy: FY_YTD, primaryCompleteMonths: ytdMonths });

  const b3Complete = resultComplete.alerts.filter((a) => a.code === "B3");
  const b3Ytd      = resultYtd.alerts.filter((a) => a.code === "B3");
  const b5Complete = resultComplete.alerts.filter((a) => a.code === "B5");

  // ══════════════════════════════════════════════════════════════════
  // B3 DIAGNOSTIC — FY2026-27 (636 alerts)
  // ══════════════════════════════════════════════════════════════════
  section("B3 DIAGNOSTIC — FY2026-27");

  // ── (a) Exact comparison windows ──────────────────────────────────
  sub("(a) Exact comparison windows used by B3 in the FY2026-27 run");

  // All B3 alerts share the same months (set by detectAlerts for the whole run).
  const sample = b3Ytd[0];
  if (sample) {
    console.log(`  Current period months  (what the engine checked for zero purchase):`);
    console.log(`    ${sample.currentMonths.join(", ")}  (${sample.currentMonths.length} months)`);
    console.log(`  Prior period months    (what the engine required non-zero purchase):`);
    console.log(`    ${sample.priorMonths.join(", ")}  (${sample.priorMonths.length} months)`);
    console.log();
    console.log("  Interpretation:");
    console.log("    A retailer fires B3 if they had non-zero secondary sales in");
    console.log(`    [${sample.priorMonths.join(", ")}] (FY${FY_COMPLETE}) AND zero in`);
    console.log(`    [${sample.currentMonths.join(", ")}] (FY${FY_YTD}).`);
    console.log();
    console.log("    A retailer who bought in Jul-25/Aug-25/… in FY2025-26 but ONLY");
    console.log("    in Jul-26 in FY2026-27 does NOT fire B3, because they have no");
    console.log("    prior-window presence. Only Q1-2025-26 buyers are in scope.");
  } else {
    console.log("  No B3 alerts found for FY2026-27.");
  }

  // ── (b) Materiality floor audit ────────────────────────────────────
  sub("(b) Materiality floor audit on the 636 FY2026-27 B3 alerts");

  const RETAILER_FLOOR_CURRENT = 1_000_000;  // ₹10 L — current config
  const RETAILER_FLOOR_OLD     =   200_000;  // ₹2 L  — user asked about this
  const DIST_FLOOR             = 2_500_000;  // ₹25 L — config

  let belowCurrentFloor = 0, belowOldFloor = 0;
  for (const a of b3Ytd) {
    const pv = a.numbers.priorValue ?? 0;
    const floor = a.entityType === "distributor" ? DIST_FLOOR
                : a.entityType === "direct_dealer" ? 1_500_000
                : RETAILER_FLOOR_CURRENT;
    if (pv < floor) belowCurrentFloor++;
    if (a.entityType === "retailer" && pv < RETAILER_FLOOR_OLD) belowOldFloor++;
  }

  console.log(`  Current config floors: retailer ₹10 L · distributor ₹25 L · direct_dealer ₹15 L`);
  console.log(`  Total B3 alerts in FY2026-27: ${b3Ytd.length}`);
  console.log();
  console.log(`  Alerts whose prior-period value is below their entity's CURRENT floor:`);
  console.log(`    ${belowCurrentFloor} / ${b3Ytd.length}`);
  if (belowCurrentFloor === 0) {
    console.log("    ✓  Zero. The materiality floor IS being applied correctly.");
    console.log(`       All ${b3Ytd.length} had prior-period value ≥ their configured floor.`);
  } else {
    console.log("    ⚠  Non-zero — floor may not be applied correctly.");
  }
  console.log();
  console.log(`  Count of RETAILER B3 alerts whose prior value is below old ₹2 L floor:`);
  const retailerB3Ytd = b3Ytd.filter((a) => a.entityType === "retailer");
  console.log(`    ${belowOldFloor} / ${retailerB3Ytd.length} retailers are below ₹2 L`);
  console.log(`    (These WOULD have fired under the old ₹2 L config; they also fire`);
  console.log(`     under ₹10 L, because prior value ≥ ₹10 L implies ≥ ₹2 L.)`);

  // ── (c) Sample of 10 ──────────────────────────────────────────────
  sub("(c) Sample of 10 B3 alerts — prior value, months, FY2026-27 secondary presence");

  // Deterministic shuffle via index stride to avoid re-runs giving different samples
  const stride = Math.max(1, Math.floor(b3Ytd.length / 10));
  const tenSample: RawAlert[] = [];
  for (let i = 0; i < b3Ytd.length && tenSample.length < 10; i += stride) {
    tenSample.push(b3Ytd[i]!);
  }

  // Build a quick lookup: which retailers have ANY FY2026-27 secondary_sku_line rows
  // (across ALL months, not just the analysis window). Uses ctx.retailerSale which
  // was loaded for both FYs.
  const retailersWithAnyYtdRows = new Set<string>();
  for (const r of ctx.retailerSale) {
    if (r.fy === FY_YTD) retailersWithAnyYtdRows.add(r.retailer);
  }
  // Also check customers with FY2026-27 primary sale rows (for distributors/dealers)
  const customersWithAnyYtdRows = new Set<string>();
  for (const r of ctx.customerSale) {
    if (r.fy === FY_YTD) customersWithAnyYtdRows.add(r.customer);
  }

  // FY2026-27 months present in context (to explain what "any" means)
  const ytdMonthsInCtx = new Set<string>();
  for (const r of ctx.retailerSale) {
    if (r.fy === FY_YTD) ytdMonthsInCtx.add(r.monthLabel);
  }
  const ytdMonthsLoaded = [...ytdMonthsInCtx].sort().join(", ");
  console.log(`  Note: FY${FY_YTD} months available in loaded context: ${ytdMonthsLoaded}`);
  console.log(`  "Appears in FY2026-27" = has any secondary_sku_line rows in those months`);
  console.log(`  (a 'YES but not in window' means they bought in Jul-26+ but not Q1 2026-27)\n`);

  for (let i = 0; i < tenSample.length; i++) {
    const a = tenSample[i]!;
    const pv = a.numbers.priorValue ?? 0;
    const inYtd = a.entityType === "retailer"
      ? retailersWithAnyYtdRows.has(a.entityKey)
      : customersWithAnyYtdRows.has(a.entityKey);

    // Which FY2026-27 months does this retailer appear in (outside the analysis window)?
    const outsideWindow = new Set(ytdMonths);
    const ytdMonthsForRetailer: string[] = [];
    for (const r of ctx.retailerSale) {
      if (r.fy === FY_YTD && r.retailer === a.entityKey && !outsideWindow.has(r.monthLabel)) {
        ytdMonthsForRetailer.push(r.monthLabel);
      }
    }

    const name = a.entity.length > 28 ? a.entity.slice(0, 27) + "…" : a.entity;
    console.log(`  ${i + 1}. ${name}`);
    console.log(`     Type:          ${a.entityType}`);
    console.log(`     Prior value:   ${cr(pv)}`);
    console.log(`     Prior months:  [${a.priorMonths.join(", ")}]`);
    console.log(`     Current checked: [${a.currentMonths.join(", ")}] — zero purchase here`);
    console.log(`     In FY2026-27 at all: ${inYtd ? "YES" : "NO"}`);
    if (inYtd && ytdMonthsForRetailer.length > 0) {
      console.log(`     FY2026-27 months OUTSIDE analysis window: [${ytdMonthsForRetailer.sort().join(", ")}]`);
    } else if (inYtd) {
      console.log(`     FY2026-27 presence is only within the analysis window months (already zero there)`);
    }
    console.log();
  }

  // ── (d) Entity type breakdown ──────────────────────────────────────
  sub("(d) FY2026-27 B3: breakdown by entity type");
  const typeCount: Record<string, number> = {};
  for (const a of b3Ytd) {
    typeCount[a.entityType] = (typeCount[a.entityType] ?? 0) + 1;
  }
  for (const [type, count] of Object.entries(typeCount).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / b3Ytd.length) * 100).toFixed(1);
    console.log(`  ${type.padEnd(16)} ${count.toString().padStart(4)}  (${pct}%)`);
  }
  console.log(`  ${"TOTAL".padEnd(16)} ${b3Ytd.length.toString().padStart(4)}`);

  // ══════════════════════════════════════════════════════════════════
  // B5 DIAGNOSTIC — FY2025-26 (419 alerts)
  // ══════════════════════════════════════════════════════════════════
  section("B5 DIAGNOSTIC — FY2025-26 (code-range collapse)");

  sub("B5 floor confirmation: prior code count < 30 and < 20");

  console.log(`  Current config: B5_PRIOR_CODE_FLOOR = 30, B5_BREADTH_DROP_FLOOR_PCT = 60%`);
  console.log(`  Total B5 alerts in FY2025-26: ${b5Complete.length}`);
  console.log();

  let b5BelowFloor30 = 0, b5BelowFloor20 = 0;
  const b5PriorCodeDist: Record<string, number> = {};
  for (const a of b5Complete) {
    const cp = a.numbers.codePrior ?? 0;
    if (cp < 30) b5BelowFloor30++;
    if (cp < 20) b5BelowFloor20++;
    const bucket = cp < 20 ? "<20" : cp < 30 ? "20–29" : cp < 50 ? "30–49" : cp < 75 ? "50–74" : "75+";
    b5PriorCodeDist[bucket] = (b5PriorCodeDist[bucket] ?? 0) + 1;
  }

  console.log(`  Alerts whose prior code count is below the CURRENT 30-code floor: ${b5BelowFloor30}`);
  if (b5BelowFloor30 === 0) {
    console.log(`  ✓  Zero. The 30-code floor IS enforced — all ${b5Complete.length} had ≥ 30 prior codes.`);
  } else {
    console.log("  ⚠  Non-zero — floor may not be applied.");
  }
  console.log();
  console.log(`  Alerts whose prior code count is below the OLD 20-code floor: ${b5BelowFloor20}`);
  if (b5BelowFloor20 === 0) {
    console.log("  ✓  Zero. All alerts would have fired under the old 20-code floor too.");
  } else {
    console.log(`  ⚠  ${b5BelowFloor20} alerts had prior code count 20–29. These fired under the OLD`);
    console.log(`     20-code floor but are now caught by the 30-code floor and should NOT appear.`);
    console.log(`     If they appear here, the new floor is not being applied.`);
  }

  console.log("\n  Prior-code-count distribution of all 419 B5 alerts:");
  for (const bucket of ["<20", "20–29", "30–49", "50–74", "75+"]) {
    const cnt = b5PriorCodeDist[bucket] ?? 0;
    if (cnt > 0) {
      console.log(`    ${bucket.padEnd(8)} ${cnt.toString().padStart(4)} alerts`);
    }
  }

  // Show top 5 B5 alerts by prior code count (to confirm large-basket firms are the ones firing)
  console.log("\n  Top 10 B5 by prior code count:");
  const topB5 = [...b5Complete].sort((a, b) => (b.numbers.codePrior ?? 0) - (a.numbers.codePrior ?? 0)).slice(0, 10);
  for (const a of topB5) {
    const name = a.entity.length > 30 ? a.entity.slice(0, 29) + "…" : a.entity;
    console.log(`    ${name.padEnd(32)} prior:${String(a.numbers.codePrior ?? 0).padStart(4)} → now:${String(a.numbers.codeCurrent ?? 0).padStart(4)}   prior val: ${cr(a.numbers.priorValue ?? 0)}`);
  }

  // Also cross-check: total B3 for FY2025-26 (full year) for comparison
  section("CROSS-CHECK: FY2025-26 B3 vs FY2026-27 B3");
  console.log(`  FY2025-26 (full 12 months vs full 12 prior months): ${b3Complete.length} B3 alerts`);
  console.log(`  FY2026-27 (${ytdMonths.length} months vs ${ytdMonths.length} prior months):  ${b3Ytd.length} B3 alerts`);
  console.log();
  if (b3Complete.length > 0 && b3Ytd.length > 0) {
    const rate2526 = b3Complete.length;
    const rate2627 = b3Ytd.length;
    console.log(`  FY2025-26 had ${rate2526} zero-buyers across the FULL year (12 months of evidence).`);
    console.log(`  FY2026-27 has ${rate2627} zero-buyers across ${ytdMonths.length} months.`);
    console.log(`  If the rate were proportional: ${Math.round(rate2526 * ytdMonths.length / 12)} expected for ${ytdMonths.length} months.`);
    console.log(`  Actual is ${rate2627 > rate2526 * ytdMonths.length / 12 ? "higher" : "lower"} than proportional.`);
  }

  console.log("\n" + sep("═"));
  console.log("  DIAGNOSTIC COMPLETE — no writes performed");
  console.log(sep("═"));

  await pool.end();
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
