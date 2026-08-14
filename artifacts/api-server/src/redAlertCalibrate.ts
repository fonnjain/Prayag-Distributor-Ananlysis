// Red Alert calibration CLI entry point.
//
// Runs the detection logic against FY2025-26 (complete) and FY2026-27 (YTD)
// and prints the 8-section calibration report.
//
// Run via: pnpm --filter @workspace/api-server exec node --enable-source-maps ./dist/redAlertCalibrate.mjs
// Or via the wrapper: node artifacts/api-server/scripts/red-alert-calibrate.mjs
//
// NO routes created. NO UI. NO persisted tables. NO stored alerts.

import { pool } from "@workspace/db";
import { execSync } from "node:child_process";
import { buildDetectionContext } from "./lib/redAlert/context.js";
import { detectAlerts, fyMonthLabels } from "./lib/redAlert/detectAlerts.js";
import type { RawAlert, CalibrationResult, AlertCode } from "./lib/redAlert/types.js";

// ── FYs under analysis ───────────────────────────────────────────────────────
const FY_COMPLETE = "2025-26";
const FY_YTD     = "2026-27";

// ── Formatting helpers ────────────────────────────────────────────────────────
function cr(v: number): string {
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
}

function pct(v: number | null | undefined, dp = 1): string {
  if (v == null) return "—";
  return `${v.toFixed(dp)}%`;
}

function sep(char = "─", width = 72): string {
  return char.repeat(width);
}

function printHeader(title: string): void {
  console.log();
  console.log(sep("═"));
  console.log(`  ${title}`);
  console.log(sep("═"));
}

function printSection(n: number, title: string): void {
  console.log();
  console.log(sep());
  console.log(`  Section ${n}: ${title}`);
  console.log(sep());
}

// ── Section 1: Alert count by code ────────────────────────────────────────────
function printSection1(results: CalibrationResult[]): void {
  printSection(1, "Alert count by code, per period");
  const codes: AlertCode[] = ["A1","A2","A3","B1","B2","B3","B4","B5","C1","C2","C3","C4","C5"];
  const header = "Code  " + results.map((r) => r.fy.padEnd(12)).join("  ");
  console.log(header);
  console.log(sep("-", 60));

  for (const code of codes) {
    const cols = results.map((r) => {
      const b = r.byCode[code];
      if (b.count === 0) return "0".padEnd(12);
      return `${b.count} (${cr(b.rupeesAtStake)})`.padEnd(20);
    });
    console.log(`${code.padEnd(6)}${cols.join("  ")}`);
  }
  console.log();
  for (const r of results) {
    const total = r.alerts.length;
    const totalRs = r.alerts.reduce((s, a) => s + a.rupeesAtStake, 0);
    console.log(`  ${r.fy}: TOTAL ${total} alerts, ${cr(totalRs)} at stake`);
  }
}

// ── Section 2: Total count and threshold guidance ─────────────────────────────
function printSection2(results: CalibrationResult[]): void {
  printSection(2, "Total count and threshold assessment");
  const PAGE_CAP = 20;

  for (const r of results) {
    const total = r.alerts.length;
    console.log(`\n  ${r.fy}  →  ${total} alerts (page cap = ${PAGE_CAP})`);
    if (total > PAGE_CAP) {
      const excess = total - PAGE_CAP;
      console.log(`  ⚠  Exceeds cap by ${excess}. Suggested tightening to reach ≤ 20:`);
      // Find codes with the most alerts as candidates to tighten
      const codes: AlertCode[] = ["A1","A2","A3","B1","B2","B3","B4","B5","C1","C2","C3","C4","C5"];
      const byCnt = codes
        .map((c) => ({ c, cnt: r.byCode[c].count }))
        .filter((x) => x.cnt > 0)
        .sort((a, b) => b.cnt - a.cnt);
      for (const { c, cnt } of byCnt.slice(0, 5)) {
        console.log(`    ${c}: ${cnt} alerts — consider raising threshold or floor`);
      }
    } else {
      console.log(`  ✓  Within cap.`);
    }
  }
}

// ── Section 3: Suppression by guard ───────────────────────────────────────────
function printSection3(results: CalibrationResult[]): void {
  printSection(3, "Count suppressed by each guard");
  const guardNames: Record<number, string> = {
    0: "Cross-suppression (B3→B1/B2/B4/B5 or C5→team)",
    1: "Channel reclassification",
    2: "Like months only",
    3: "Complete months only",
    4: "Identity resolution",
    5: "Distributor reassignment",
    6: "Territory only",
    7: "No target, no alert",
    8: "Partial tenure",
    9: "Sheet-read failure",
    10: "Cost data gate",
  };

  for (const r of results) {
    console.log(`\n  ${r.fy}:`);
    let anyFired = false;
    // Combine guard suppressed + cross suppressed counts
    const allCounts: Record<number, number> = { ...r.suppressedByGuard };
    allCounts[0] = (allCounts[0] ?? 0) + r.crossSuppressed;

    for (let g = 0; g <= 10; g++) {
      const cnt = allCounts[g] ?? 0;
      const flag = cnt === 0 ? "  " : "▶ ";
      console.log(`    ${flag}Guard ${String(g).padStart(2)}: ${cnt.toString().padStart(3)} suppressed  — ${guardNames[g] ?? "?"}`);
      if (cnt > 0) anyFired = true;
    }
    if (!anyFired) console.log("    (no suppressions)");
  }
}

// ── Section 4: Top-5 named alerts ─────────────────────────────────────────────
function printTop5(result: CalibrationResult, code: AlertCode): void {
  const alerts = result.alerts.filter((a) => a.code === code)
    .sort((a, b) => b.rupeesAtStake - a.rupeesAtStake)
    .slice(0, 5);

  if (alerts.length === 0) {
    console.log(`  (no ${code} alerts in ${result.fy})`);
    return;
  }

  console.log(`\n  ${code} — ${result.fy} (top ${alerts.length}):`);
  for (const a of alerts) {
    const n = a.numbers;
    let detail = "";
    if (code === "A1") {
      detail = `${pct(n.achievementPct)} YTD achievement (target ${cr(n.cumulativeTarget ?? 0)}), `
        + `months ${a.extraForReport?.sustainedFromMonth ?? "?"}–${a.extraForReport?.sustainedToMonth ?? "?"}`;
    } else if (code === "B1") {
      detail = `real growth ${pct(n.realGrowthPct)} (nominal ${pct(n.valueGrowthPct)}, MRP+${pct(n.mrpIncreasePct)}), `
        + `prior ${cr(n.priorValue ?? 0)}`;
    } else if (code === "B2") {
      detail = `decline ${pct(n.declinePct)}, prior ${cr(n.priorValue ?? 0)}, current ${cr(n.currentValue ?? 0)}`;
    } else if (code === "B3") {
      detail = `zero now, prior ${cr(n.priorValue ?? 0)}`;
    }
    console.log(`    • ${a.entity}: ${detail}`);
  }
}

function printSection4(results: CalibrationResult[]): void {
  printSection(4, "Top-5 named alerts for A1, B1, B2, B3");
  for (const r of results) {
    printTop5(r, "A1");
    printTop5(r, "B1");
    printTop5(r, "B2");
    printTop5(r, "B3");
  }
}

// ── Section 5: B1 discount-leakage split ─────────────────────────────────────
function printSection5(results: CalibrationResult[]): void {
  printSection(5, "B1 — MRP-index vs realised-price real growth (discount-leakage split)");
  console.log("  Interpretation:");
  console.log("    Real decline on BOTH bases      → genuine volume loss");
  console.log("    Real decline on MRP basis only  → discount leakage (avg price fell more than MRP)");
  console.log();

  for (const r of results) {
    const b1s = r.alerts.filter((a) => a.code === "B1")
      .sort((a, b) => (a.numbers.realGrowthPct ?? 0) - (b.numbers.realGrowthPct ?? 0))
      .slice(0, 5);

    if (b1s.length === 0) {
      console.log(`  ${r.fy}: no B1 alerts.`);
      continue;
    }

    console.log(`  ${r.fy}:`);
    console.log(`  ${"Customer".padEnd(32)} ${"Nominal".padStart(9)} ${"MRP-real".padStart(10)} ${"Realised-real".padStart(14)} ${"Cause"}`);
    console.log(`  ${sep("-", 70)}`);

    for (const a of b1s) {
      const n = a.numbers;
      const nominal = pct(n.valueGrowthPct);
      const mrpReal = pct(n.realGrowthPct);
      const realisedReal = pct(n.realisedRealGrowthPct);
      const mrpDecline = (n.realGrowthPct ?? 0) < -5;
      const realisedDecline = (n.realisedRealGrowthPct ?? 0) < -5;
      const cause = mrpDecline && realisedDecline ? "Volume loss"
        : mrpDecline ? "Discount leakage"
        : "Pricing effect";
      const name = a.entity.length > 30 ? a.entity.slice(0, 29) + "…" : a.entity;
      console.log(`  ${name.padEnd(32)} ${nominal.padStart(9)} ${mrpReal.padStart(10)} ${realisedReal.padStart(14)}  ${cause}`);
    }
  }
}

// ── Section 6: Guard 2 failure audit ──────────────────────────────────────────
function printSection6(results: CalibrationResult[]): void {
  printSection(6, "Guard 2 failure audit (mismatched month counts — should be zero)");
  let anyFailed = false;
  for (const r of results) {
    const g2Fails = r.suppressed.filter((s) => s.guard === 2);
    if (g2Fails.length > 0) {
      anyFailed = true;
      console.log(`  ⚠  ${r.fy}: ${g2Fails.length} alerts suppressed by Guard 2 — INVESTIGATE:`);
      for (const s of g2Fails.slice(0, 5)) {
        console.log(`    • ${s.alert.code} — ${s.alert.entity}: ${s.reason}`);
      }
    }
  }
  if (!anyFailed) {
    console.log("  ✓  Guard 2 fired 0 times. All compared windows have equal month counts.");
  }
}

// ── Section 7: Confirmation ────────────────────────────────────────────────────
function printSection7(): void {
  printSection(7, "Confirmation — no page, route, or stored alert created");
  console.log("  ✓  No HTTP route was registered (this script has no Express app).");
  console.log("  ✓  No UI component was created.");
  console.log("  ✓  No INSERT or CREATE TABLE was executed in this script.");
  console.log("  ✓  All alerts exist only in memory for the duration of this process.");
}

// ── Section 8: Commit provenance ──────────────────────────────────────────────
function printSection8(): void {
  printSection(8, "Commit provenance");
  try {
    const hash = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    const objType = execSync(`git cat-file -t ${hash}`, { encoding: "utf8" }).trim();
    console.log(`  HEAD commit : ${hash}`);
    console.log(`  Object type : ${objType}`);
    try {
      execSync(`git merge-base --is-ancestor ${hash} main`, { stdio: "pipe" });
      console.log(`  Is ancestor of main: yes (exit 0)`);
    } catch {
      console.log(`  Is ancestor of main: no (exit 1) — branch not yet merged`);
    }
  } catch (err) {
    console.log(`  git unavailable: ${String(err)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  printHeader("RED ALERT CALIBRATION REPORT");
  console.log(`  Run at: ${new Date().toISOString()}`);
  console.log(`  FYs: ${FY_COMPLETE} (complete), ${FY_YTD} (YTD)`);
  console.log(`  Purpose: Validate alert thresholds before building any page.`);

  console.log("\n  Fetching context from DB…");
  const ctx = await buildDetectionContext(pool, [FY_COMPLETE, FY_YTD]);
  console.log(`  ✓  Loaded ${ctx.customerSale.length.toLocaleString()} customer-sale rows, `
    + `${ctx.secHeadMonths.length.toLocaleString()} secondary head-month rows, `
    + `${ctx.mrpHistory.length.toLocaleString()} MRP history rows, `
    + `${ctx.marginFact.length.toLocaleString()} margin_fact rows.`);

  // ── Determine primary-complete months for FY2026-27 ────────────────────────
  // Use frozen months from register_month_state; fall back to all months up to
  // the current calendar month if none are recorded.
  const frozenYtd = [...(ctx.frozenMonths.get(FY_YTD) ?? [])].sort();
  console.log(`  FY${FY_YTD} primary-complete months: ${frozenYtd.length > 0 ? frozenYtd.join(", ") : "(none frozen — using all months to date)"}`);

  // For the open FY, also constrain by what secondary has (lags 1 month behind).
  // Find the latest month where ANY member has complete secondary data.
  const secYtdMonths = new Set<string>();
  for (const [, hMap] of ctx.secCompleteMonths.get(FY_YTD) ?? []) {
    for (const m of hMap) secYtdMonths.add(m);
  }
  // Use the intersection of primary-frozen and secondary-available, or whichever is smaller.
  let ytdMonths: string[];
  if (frozenYtd.length > 0 && secYtdMonths.size > 0) {
    ytdMonths = frozenYtd.filter((m) => secYtdMonths.has(m));
    if (ytdMonths.length === 0) ytdMonths = frozenYtd; // no intersection — use primary
  } else if (frozenYtd.length > 0) {
    ytdMonths = frozenYtd;
  } else {
    // Derive from fyMonthLabels up to the current month
    const now = new Date();
    const allMonths = fyMonthLabels(FY_YTD);
    const curMonth = now.toLocaleString("en-US", { month: "short" })
      + "-" + String(now.getFullYear() % 100).padStart(2, "0");
    const idx = allMonths.indexOf(curMonth);
    ytdMonths = idx > 0 ? allMonths.slice(0, idx) : allMonths.slice(0, 4);
  }
  console.log(`  FY${FY_YTD} effective analysis months: ${ytdMonths.join(", ")}`);

  console.log("\n  Running detection for FY2025-26…");
  const resultComplete = detectAlerts(ctx, { fy: FY_COMPLETE });

  console.log("  Running detection for FY2026-27 YTD…");
  const resultYtd = detectAlerts(ctx, { fy: FY_YTD, primaryCompleteMonths: ytdMonths });

  const results = [resultComplete, resultYtd];

  // ── Print all 8 sections ────────────────────────────────────────────────────
  printSection1(results);
  printSection2(results);
  printSection3(results);
  printSection4(results);
  printSection5(results);
  printSection6(results);
  printSection7();
  printSection8();

  console.log();
  console.log(sep("═"));
  console.log("  CALIBRATION COMPLETE");
  console.log(sep("═"));

  await pool.end();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
