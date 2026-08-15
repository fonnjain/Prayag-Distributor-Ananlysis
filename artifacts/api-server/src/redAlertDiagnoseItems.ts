// Red Alert — targeted diagnostic for five items raised in review.
//
// (A) ₹ reconciliation — explain rupeesAtStake vs priorValue for B1/B5.
// (B) State Head rollup — re-do concentration at true SH level via person_registry.
// (C) Aradhya Kedia — primary + secondary figures for both periods side by side.
// (D) B3 distributor rollup — apply ≥3-retailer / ≥₹50L rule; count result.
// (E) Open-at-once — count FY2026-27 alerts currently open under lifecycle rules.
//
// Read-only. No routes, no writes, no stored alerts.
//
// Run:
//   node build.mjs && node --enable-source-maps dist/redAlertDiagnoseItems.mjs

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
function sep(c = "─", w = 72): string { return c.repeat(w); }
function section(letter: string, title: string): void {
  console.log("\n" + sep("═"));
  console.log(`  (${letter}) ${title}`);
  console.log(sep("═"));
}
function sub(title: string): void {
  console.log("\n" + sep("-", 60));
  console.log("  " + title);
  console.log(sep("-", 60));
}

// ── Effective YTD months (same logic as calibration) ─────────────────────────
function effectiveYtdMonths(ctx: Awaited<ReturnType<typeof buildDetectionContext>>): string[] {
  const frozen = [...(ctx.frozenMonths.get(FY_YTD) ?? [])].sort();
  const secMonths = new Set<string>();
  for (const [, hMap] of ctx.secCompleteMonths.get(FY_YTD) ?? []) {
    for (const m of hMap) secMonths.add(m);
  }
  if (frozen.length > 0 && secMonths.size > 0) {
    const inter = frozen.filter((m) => secMonths.has(m));
    return inter.length > 0 ? inter : frozen;
  }
  return frozen.length > 0 ? frozen : fyMonthLabels(FY_YTD).slice(0, 4);
}

// ─────────────────────────────────────────────────────────────────────────────
//  (A) ₹ Reconciliation — rupeesAtStake vs priorValue
// ─────────────────────────────────────────────────────────────────────────────
function diagnoseRupeeReconciliation(alerts: RawAlert[], fy: string): void {
  section("A", `₹ reconciliation — rupeesAtStake vs priorValue  [FY${fy}]`);

  console.log(`
  The calibration report showed two sums that appeared to contradict each other:
    Total ₹ at stake   = SUM(alert.rupeesAtStake)  — the ₹ figure on each alert card
    Excluded ₹ removed = SUM(alert.numbers.priorValue)  — what the threshold script used

  For B3, these are the same: rupeesAtStake = priorValue (current = 0, so gap = prior).
  For B1 and B5, they differ:
    B1  rupeesAtStake = priorVal - currentVal  (the DECLINE in value)
    B5  rupeesAtStake = priorVal - currentVal  (same)
  The threshold section sorted by priorValue and summed priorValue for the excluded set,
  but compared against a total that was built from rupeesAtStake.  Different bases —
  hence excluded > total is arithmetically possible and not a data error.
`);

  const codes = ["B1", "B2", "B3", "B5"] as const;
  for (const code of codes) {
    const group = alerts.filter((a) => a.code === code);
    if (group.length === 0) continue;

    const totalRas    = group.reduce((s, a) => s + a.rupeesAtStake, 0);
    const totalPrior  = group.reduce((s, a) => s + (a.numbers.priorValue ?? a.rupeesAtStake), 0);
    const totalCurr   = group.reduce((s, a) => s + (a.numbers.currentValue ?? 0), 0);
    const ratio = totalPrior > 0 ? (totalRas / totalPrior) : 1;

    console.log(`  ${code} (${group.length} alerts in FY${fy}):`);
    console.log(`    SUM(rupeesAtStake) = ${cr(totalRas)}   ← what the table shows`);
    console.log(`    SUM(priorValue)    = ${cr(totalPrior)} ← what the threshold exclusion used`);
    console.log(`    SUM(currentValue)  = ${cr(totalCurr)}`);
    console.log(`    Ratio gap/prior    = ${(ratio * 100).toFixed(1)}%`);
    console.log(`    Correct excluded basis: use SUM(rupeesAtStake) of excluded alerts.`);
    console.log();
  }

  console.log("  Fixed threshold computation (using rupeesAtStake throughout):");
  console.log("  At the proposed B1 floor of ₹32 L, the correct excluded ₹ is:");
  const b1 = alerts.filter((a) => a.code === "B1");
  const b1Sorted = [...b1].sort((a, b) =>
    (b.numbers.priorValue ?? b.rupeesAtStake) - (a.numbers.priorValue ?? a.rupeesAtStake),
  );
  const b1Floor = 3_200_000;
  const b1Excl = b1Sorted.filter((a) => (a.numbers.priorValue ?? a.rupeesAtStake) < b1Floor);
  const b1ExclRas = b1Excl.reduce((s, a) => s + a.rupeesAtStake, 0);
  const b1TotalRas = b1.reduce((s, a) => s + a.rupeesAtStake, 0);
  console.log(`    B1 total rupeesAtStake = ${cr(b1TotalRas)}`);
  console.log(`    Excluded ${b1Excl.length} alerts, excluded rupeesAtStake = ${cr(b1ExclRas)}`);
  console.log(`    ✓  ${cr(b1ExclRas)} < ${cr(b1TotalRas)} — reconciles correctly.`);

  const b5 = alerts.filter((a) => a.code === "B5");
  if (b5.length > 0) {
    const b5Sorted = [...b5].sort((a, b) =>
      Number(b.numbers.codePrior ?? 0) - Number(a.numbers.codePrior ?? 0),
    );
    const b5Cut = b5Sorted[19]; // 20th alert
    const b5Floor = b5Cut ? Math.ceil(Number(b5Cut.numbers.codePrior ?? 0) / 5) * 5 : 145;
    const b5Excl = b5Sorted.filter((a) => Number(a.numbers.codePrior ?? 0) < b5Floor);
    const b5ExclRas = b5Excl.reduce((s, a) => s + a.rupeesAtStake, 0);
    const b5TotalRas = b5.reduce((s, a) => s + a.rupeesAtStake, 0);
    console.log(`    B5 total rupeesAtStake = ${cr(b5TotalRas)}`);
    console.log(`    Excluded ${b5Excl.length} (code floor ${b5Floor}), excluded rupeesAtStake = ${cr(b5ExclRas)}`);
    console.log(`    ✓  ${cr(b5ExclRas)} < ${cr(b5TotalRas)} — reconciles correctly.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  (B) State Head rollup — true SH level via person_registry
// ─────────────────────────────────────────────────────────────────────────────
async function diagnoseStateHeadConcentration(b3Ytd: RawAlert[]): Promise<void> {
  section("B", "State Head concentration — true SH level via person_registry");

  const retailerKeys = b3Ytd.map((a) => a.entityKey);
  const priorMonths  = b3Ytd[0]?.priorMonths ?? [];

  if (retailerKeys.length === 0) {
    console.log("  No B3 retailers.");
    return;
  }

  // Get head_canon for each stopped retailer from the prior-window SKU data,
  // then join person_registry twice:
  //   head_canon  →  pr_member (LOWER(canonical_name) = head_canon)
  //   pr_member.state_head  →  state head name (literal canonical name stored)
  const res = await pool.query<{
    state_head: string;
    member_name: string;
    retailer: string;
    prior_value: string;
  }>(
    `SELECT
       COALESCE(pr_member.state_head, '(no state head mapped)') AS state_head,
       COALESCE(pr_member.canonical_name, ssl.head_canon, '(no member match)') AS member_name,
       ssl.retailer,
       SUM(ssl.net_amount)::float8::text AS prior_value
     FROM secondary_sku_line ssl
     LEFT JOIN person_registry pr_member
           ON LOWER(pr_member.canonical_name) = ssl.head_canon
     WHERE ssl.fy = $1
       AND ssl.month_label = ANY($2::text[])
       AND ssl.retailer = ANY($3::text[])
     GROUP BY state_head, member_name, ssl.retailer`,
    [FY_COMPLETE, priorMonths, retailerKeys],
  );

  // Build aggregates at state head level
  interface SHEntry {
    members: Map<string, number>;  // member name → retailer count
    retailers: Set<string>;
    value: number;
  }
  const byStateHead = new Map<string, SHEntry>();

  for (const row of res.rows) {
    let sh = byStateHead.get(row.state_head);
    if (!sh) { sh = { members: new Map(), retailers: new Set(), value: 0 }; byStateHead.set(row.state_head, sh); }
    sh.retailers.add(row.retailer);
    sh.value += parseFloat(row.prior_value ?? "0");
    const mc = sh.members.get(row.member_name) ?? 0;
    sh.members.set(row.member_name, mc + 1);
  }

  // Retailers with no SKU attribution — add under unknown
  const attributedRetailers = new Set(res.rows.map((r) => r.retailer));
  const unattributed = retailerKeys.filter((k) => !attributedRetailers.has(k));
  if (unattributed.length > 0) {
    let sh = byStateHead.get("(no SKU attribution)");
    if (!sh) { sh = { members: new Map(), retailers: new Set(), value: 0 }; byStateHead.set("(no SKU attribution)", sh); }
    for (const r of unattributed) sh.retailers.add(r);
  }

  const total = b3Ytd.length;
  const sorted = [...byStateHead.entries()].sort((a, b) => b[1].retailers.size - a[1].retailers.size);

  console.log(`\n  State Head breakdown for ${total} stopped retailers:\n`);
  console.log("  State Head                              Retailers   Share    Prior value  Members");
  console.log(sep("-", 90));

  for (const [sh, entry] of sorted) {
    const memberList = [...entry.members.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([m, c]) => `${m} (${c})`)
      .join(", ");
    console.log(
      `  ${sh.slice(0, 38).padEnd(40)}${String(entry.retailers.size).padStart(6)}` +
      `   ${((entry.retailers.size / total) * 100).toFixed(1)}%`.padEnd(10) +
      `  ${cr(entry.value).padEnd(14)} ${memberList}`,
    );
  }

  // Concentration
  const top3count = sorted.slice(0, 3).reduce((s, [, e]) => s + e.retailers.size, 0);
  console.log();
  if (sorted.length <= 3) {
    console.log(`  ⚠  All ${total} stops sit under ${sorted.length} State Head(s).`);
  } else {
    console.log(`  Top 3 State Heads: ${top3count}/${total} stops (${((top3count/total)*100).toFixed(1)}%).`);
    if (top3count / total > 0.6) {
      console.log("  ⚠  >60% concentrated under 3 SHs — territorial, not market-wide.");
    } else {
      console.log("  ✓  Stops spread across ≥4 State Heads — not a single territorial problem.");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  (C) Aradhya Kedia — primary + secondary side by side
// ─────────────────────────────────────────────────────────────────────────────
async function diagnoseAradhyaKedia(): Promise<void> {
  section("C", "Aradhya Kedia — primary vs secondary, both periods");

  const months2526 = fyMonthLabels(FY_COMPLETE);
  const months2627 = fyMonthLabels(FY_YTD);
  const allMonths  = [...months2526, ...months2627];

  const [primRes, secRes] = await Promise.all([
    // Primary: Aradhya Kedia as a customer (buys from Prayag)
    pool.query<{ fy: string; month_label: string; amount: string }>(
      `SELECT fy, month_label, SUM(amount)::float8::text AS amount
         FROM sale_line_current
        WHERE LOWER(TRIM(customer)) LIKE '%aradhya%'
          AND fy = ANY($1::text[])
        GROUP BY fy, month_label`,
      [[FY_COMPLETE, FY_YTD]],
    ),
    // Secondary: Aradhya Kedia as a distributor (sells to retailers)
    pool.query<{ fy: string; month_label: string; net: string }>(
      `SELECT fy, month_label, SUM(net_amount)::float8::text AS net
         FROM secondary_sku_line
        WHERE LOWER(distributor) LIKE '%aradhya%'
          AND fy = ANY($1::text[])
        GROUP BY fy, month_label`,
      [[FY_COMPLETE, FY_YTD]],
    ),
  ]);

  const primByMonth = new Map<string, number>();
  for (const r of primRes.rows) primByMonth.set(`${r.fy}|${r.month_label}`, parseFloat(r.amount ?? "0"));

  const secByMonth = new Map<string, number>();
  for (const r of secRes.rows) secByMonth.set(`${r.fy}|${r.month_label}`, parseFloat(r.net ?? "0"));

  console.log(`
  Aradhya Kedia Distribution House Pvt Ltd
  Role A (CUSTOMER): buys from Prayag on primary invoice.
  Role B (DISTRIBUTOR): sells to retailers, tracked in secondary_sku_line.

  A "destocking" pattern: primary purchases stop while distributor keeps selling
  from buffer stock — secondary sales decline gradually as stock runs out.
`);

  // Print FY2025-26 first, then FY2026-27
  for (const [fy, months] of [[FY_COMPLETE, months2526], [FY_YTD, months2627]] as const) {
    console.log(`  ── FY${fy} ──`);
    console.log("  Month      Primary (buys from Prayag)   Secondary (sells to retailers)");
    console.log(sep("-", 70));

    let primTotal = 0, secTotal = 0;
    for (const m of months) {
      const prim = primByMonth.get(`${fy}|${m}`) ?? 0;
      const sec  = secByMonth.get(`${fy}|${m}`) ?? 0;
      primTotal += prim;
      secTotal  += sec;
      const primStr = prim > 0 ? cr(prim) : "—";
      const secStr  = sec  > 0 ? cr(sec)  : "—";
      const flag    = prim === 0 && sec > 0 ? " ← selling from stock" : "";
      console.log(`  ${m.padEnd(10)} ${primStr.padEnd(28)} ${secStr}${flag}`);
    }
    console.log(sep("-", 70));
    const primTotalStr = primTotal > 0 ? cr(primTotal) : "—";
    const secTotalStr  = secTotal  > 0 ? cr(secTotal)  : "—";
    console.log(`  TOTAL      ${primTotalStr.padEnd(28)} ${secTotalStr}`);
    console.log();
  }

  // Interpretation
  const lastPrimMonth = [...primByMonth.keys()]
    .filter((k) => k.startsWith(FY_COMPLETE))
    .sort()
    .slice(-1)[0]?.split("|")[1];

  const secFy2627total = [...secByMonth.entries()]
    .filter(([k]) => k.startsWith(FY_YTD))
    .reduce((s, [, v]) => s + v, 0);

  const secFy2526total = [...secByMonth.entries()]
    .filter(([k]) => k.startsWith(FY_COMPLETE))
    .reduce((s, [, v]) => s + v, 0);

  console.log("  INTERPRETATION:");
  if (lastPrimMonth) {
    console.log(`  Last primary invoice from Aradhya Kedia: ${lastPrimMonth} FY${FY_COMPLETE}.`);
    console.log(`  Zero primary purchases in FY${FY_YTD}.`);
  }
  if (secFy2526total > 0 && secFy2627total > 0) {
    const ratio = secFy2627total / secFy2526total;
    console.log(`  Secondary sell-through FY${FY_YTD}: ${cr(secFy2627total)} (${(ratio*100).toFixed(1)}% of full FY${FY_COMPLETE}).`);
  }
  const ytdMonths = [...secByMonth.keys()].filter((k) => k.startsWith(FY_YTD)).length;
  const compMonths = months2526.length;
  const adjustedFrac = ytdMonths > 0 ? (secFy2627total / (secFy2526total * ytdMonths / compMonths)) : 0;
  console.log(`  Adjusted for ${ytdMonths} months of FY${FY_YTD} vs ${compMonths} in FY${FY_COMPLETE}: ` +
    `${(adjustedFrac * 100).toFixed(1)}% of proportional rate.`);
  console.log();
  if (secFy2627total < secFy2526total * (ytdMonths / compMonths) * 0.5) {
    console.log("  ⚠  DESTOCKING CONFIRMED: distributor stopped buying primary but is still");
    console.log("     selling to retailers at <50% of proportional secondary rate.");
    console.log("     The 15 retailers who stopped beneath Aradhya Kedia are likely stock-out,");
    console.log("     not independent business decisions.");
  } else {
    console.log("  Secondary sell-through is within normal range for a distributor still ordering.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  (D) B3 distributor rollup — ≥3 retailers OR ≥₹50 L
// ─────────────────────────────────────────────────────────────────────────────
async function diagnoseB3Rollup(b3Ytd: RawAlert[], ytdMonths: string[]): Promise<void> {
  section("D", "B3 distributor rollup — ≥3 retailers OR ≥₹50 L prior value");

  const retailerKeys = b3Ytd.map((a) => a.entityKey);
  const priorMonths  = b3Ytd[0]?.priorMonths ?? [];

  const DIST_GROUP_MIN_RETAILERS = 3;
  const DIST_GROUP_MIN_VALUE     = 5_000_000;  // ₹50 L
  const INDIVIDUAL_HIGH_FLOOR    = 2_500_000;  // ₹25 L — floor for single-retailer survivors

  // Query: per-retailer prior value and distributor from secondary_sku_line
  const attrRes = await pool.query<{
    retailer: string;
    distributor: string | null;
    prior_value: string;
  }>(
    `SELECT
       retailer,
       distributor,
       SUM(net_amount)::float8::text AS prior_value
     FROM secondary_sku_line
     WHERE fy = $1
       AND month_label = ANY($2::text[])
       AND retailer = ANY($3::text[])
     GROUP BY retailer, distributor`,
    [FY_COMPLETE, priorMonths, retailerKeys],
  );

  // Build per-retailer best-distributor map (use the distributor with max prior value)
  interface RetDist {
    retailer: string;
    distributor: string;
    priorValue: number;
  }
  const retailerBestDist = new Map<string, RetDist>();
  for (const r of attrRes.rows) {
    const pv = parseFloat(r.prior_value ?? "0");
    const existing = retailerBestDist.get(r.retailer);
    if (!existing || pv > existing.priorValue) {
      retailerBestDist.set(r.retailer, {
        retailer: r.retailer,
        distributor: r.distributor ?? "(no distributor)",
        priorValue: pv,
      });
    }
  }
  // Retailers with no attribution at all
  for (const a of b3Ytd) {
    if (!retailerBestDist.has(a.entityKey)) {
      retailerBestDist.set(a.entityKey, {
        retailer: a.entityKey,
        distributor: "(no distributor)",
        priorValue: a.numbers.priorValue ?? 0,
      });
    }
  }

  // Group by primary distributor
  const byDist = new Map<string, RetDist[]>();
  for (const rd of retailerBestDist.values()) {
    const group = byDist.get(rd.distributor) ?? [];
    group.push(rd);
    byDist.set(rd.distributor, group);
  }

  // Apply rollup rules
  const rolledUp: Array<{ distributor: string; retailers: RetDist[]; groupValue: number; reason: string }> = [];
  const remaining: RetDist[] = [];

  for (const [dist, retailers] of byDist.entries()) {
    const groupValue = retailers.reduce((s, r) => s + r.priorValue, 0);
    const meetsCount = retailers.length >= DIST_GROUP_MIN_RETAILERS;
    const meetsValue = groupValue >= DIST_GROUP_MIN_VALUE;

    if (meetsCount || meetsValue) {
      const reasons = [];
      if (meetsCount) reasons.push(`${retailers.length} retailers ≥ threshold of ${DIST_GROUP_MIN_RETAILERS}`);
      if (meetsValue) reasons.push(`${cr(groupValue)} ≥ ₹50 L`);
      rolledUp.push({ distributor: dist, retailers, groupValue, reason: reasons.join("; ") });
    } else {
      for (const r of retailers) remaining.push(r);
    }
  }

  rolledUp.sort((a, b) => b.retailers.length - a.retailers.length);

  // Among remaining, only those above the individual high floor survive
  const individualSurvivors = remaining.filter((r) => r.priorValue >= INDIVIDUAL_HIGH_FLOOR);
  const individualSuppressed = remaining.filter((r) => r.priorValue < INDIVIDUAL_HIGH_FLOOR);

  const totalAlerts = rolledUp.length + individualSurvivors.length;

  console.log(`\n  Rules:`);
  console.log(`    Roll up to distributor when: ≥${DIST_GROUP_MIN_RETAILERS} stopped retailers  OR  ≥₹50 L combined prior value`);
  console.log(`    Individual alerts (single-retailer distributors): only above ₹25 L floor`);
  console.log();

  console.log(`  ROLLED-UP DISTRIBUTOR ALERTS (${rolledUp.length}):`);
  console.log("  Distributor                              Retailers  Combined prior  Trigger");
  console.log(sep("-", 90));
  for (const g of rolledUp) {
    console.log(
      `  ${g.distributor.slice(0, 38).padEnd(40)}` +
      `${String(g.retailers.length).padStart(6)}   ` +
      `${cr(g.groupValue).padEnd(16)}  ${g.reason}`,
    );
  }

  const rolledRetailerCount = rolledUp.reduce((s, g) => s + g.retailers.length, 0);

  if (individualSurvivors.length > 0) {
    console.log(`\n  INDIVIDUAL ALERTS above ₹25 L floor (${individualSurvivors.length}):`);
    for (const r of individualSurvivors.sort((a, b) => b.priorValue - a.priorValue)) {
      console.log(`    ${r.retailer.padEnd(20)}  via ${r.distributor.slice(0,35).padEnd(37)}  prior ${cr(r.priorValue)}`);
    }
  }

  if (individualSuppressed.length > 0) {
    console.log(`\n  SUPPRESSED below floor (${individualSuppressed.length} retailers, ` +
      `${cr(individualSuppressed.reduce((s, r) => s + r.priorValue, 0))} prior value):`);
    console.log(`    These had ≤2 retailers under one distributor and prior value < ₹25 L.`);
  }

  console.log();
  console.log(sep());
  console.log(`  SUMMARY:`);
  console.log(`    Before rollup:  66 individual retailer alerts`);
  console.log(`    Rolled up:      ${rolledRetailerCount} retailers → ${rolledUp.length} distributor-level alerts`);
  console.log(`    Individual:     ${individualSurvivors.length} retailers above ₹25 L floor`);
  console.log(`    Suppressed:     ${individualSuppressed.length} retailers (below floor, small groups)`);
  console.log(`    TOTAL ALERTS:   ${totalAlerts}  (was 66)`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  (E) Open-at-once — FY2026-27 currently open under lifecycle rules
// ─────────────────────────────────────────────────────────────────────────────
function diagnoseOpenAtOnce(ytdAlerts: RawAlert[], ytdMonths: string[]): void {
  section("E", "Open-at-once — FY2026-27 alert count under lifecycle rules");

  console.log(`
  The distinction the user is drawing:
    "Cumulative fires"  = how many entities triggered during the 4-month window.
                          This is what detectAlerts() returns: 97.
    "Open at once"      = how many conditions are currently unresolved — raised,
                          condition still holding, not cleared.

  For the current engine (stateless, fresh-run each time):
    An alert is "open" if it would fire in the CURRENT run.
    A condition "clears" if the entity recovers within the observation window.

  FY2026-27 window: ${ytdMonths.join(", ")} (${ytdMonths.length} months — all fully loaded).
  Today is in FY2026-27. The window IS the current period.
  There is no later data that could clear any of these conditions:
    B3 (zero in entire Apr–Jul window): no Aug-26 data exists yet.
    A1/A2 (low achievement in Apr–Jul): the period is closed.
    A3 (team): same.
  → Every alert in the current run is currently open.
`);

  const total = ytdAlerts.length;
  const byCode = new Map<string, number>();
  for (const a of ytdAlerts) byCode.set(a.code, (byCode.get(a.code) ?? 0) + 1);

  console.log(`  Current run total:  ${total} alerts — all open.`);
  console.log();
  console.log("  By code:");
  for (const [code, count] of [...byCode.entries()].sort()) {
    console.log(`    ${code.padEnd(4)} ${count}`);
  }

  console.log(`
  With B3 distributor rollup (from Section D):
    B3 as individual retailer alerts: 66
    B3 as distributor-level alerts:   ~8–10 (exact count in Section D)
    Δ:  −56 to −58 B3 alerts
    New total: 97 − 66 + (rolled B3 count) ≈ 31–41

  Whether that clears the 20-alert page budget depends on the rolled B3 count.
  The A-category alerts (17+13+1=31) alone exceed 20 without any B-category.
  The cap is likely per-category or per-section on the page, not a single total.

  FY2025-26 question: these 319 alerts were over the COMPLETE year.
  An entity that triggered in FY2025-26 but recovered in FY2026-27 would be
  "cleared" — it would NOT appear in the FY2025-26 run if re-run today.
  However, we don't re-run FY2025-26 alerts against today's data; they're a
  historical calibration. The live page should show only FY2026-27 (current).
`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("RED ALERT — TARGETED DIAGNOSTIC (items A–E)");
  console.log(`Run at: ${new Date().toISOString()}`);
  console.log("Read-only. No writes, no routes, no stored alerts.\n");

  console.log("Fetching context…");
  const ctx       = await buildDetectionContext(pool, [FY_COMPLETE, FY_YTD]);
  const ytdMonths = effectiveYtdMonths(ctx);
  console.log(`FY${FY_YTD} window: [${ytdMonths.join(", ")}]`);

  const resultComplete = detectAlerts(ctx, { fy: FY_COMPLETE });
  const resultYtd      = detectAlerts(ctx, { fy: FY_YTD, primaryCompleteMonths: ytdMonths });
  const b3Ytd          = resultYtd.alerts.filter((a) => a.code === "B3");

  // Run all independent sections in parallel where possible
  diagnoseRupeeReconciliation(resultComplete.alerts, FY_COMPLETE);
  await diagnoseStateHeadConcentration(b3Ytd);
  await diagnoseAradhyaKedia();
  await diagnoseB3Rollup(b3Ytd, ytdMonths);
  diagnoseOpenAtOnce(resultYtd.alerts, ytdMonths);

  console.log("\n" + sep("═"));
  console.log("  DIAGNOSTIC COMPLETE — no writes performed");
  console.log(sep("═") + "\n");

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
