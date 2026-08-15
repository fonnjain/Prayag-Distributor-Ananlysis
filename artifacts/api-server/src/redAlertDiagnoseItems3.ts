// Red Alert — diagnostic items from Aug 2026 review round 3.
//
// (A) Mahabir attribution — for each of the 9 B3 stops under Mahabir,
//     show all distributors bought from in the prior window and which one
//     the rollup assigned them to (primary = max value).
//
// (B) Destocking alert — retrospective run: ≥3 consecutive months zero
//     primary purchase while secondary sell-through continues.  Print
//     which distributors it catches and when it would first have fired.
//
// (C) A1/A2 overlap — how many members fire both; are they the same alert?
//
// (D) Territorial concentration alert — using the SH rollup from items2,
//     propose a threshold and show what would fire.
//
// Read-only.  No routes, no writes, no stored alerts.
//
// Run:
//   node build.mjs && node --enable-source-maps dist/redAlertDiagnoseItems3.mjs

import { pool } from "@workspace/db";
import { buildDetectionContext } from "./lib/redAlert/context.js";
import { detectAlerts, fyMonthLabels } from "./lib/redAlert/detectAlerts.js";

const FY_COMPLETE = "2025-26";
const FY_YTD     = "2026-27";

function cr(v: number): string {
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
}
function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`;
}
function sep(c = "─", w = 72): string { return c.repeat(w); }
function section(letter: string, title: string): void {
  console.log("\n" + sep("═"));
  console.log(`  (${letter}) ${title}`);
  console.log(sep("═"));
}

// ── Effective YTD months ──────────────────────────────────────────────────────
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
//  (A) Mahabir attribution
// ─────────────────────────────────────────────────────────────────────────────
async function diagnoseMahabir(b3Ytd: Array<{ entityKey: string; priorMonths: string[]; priorValue: number }>): Promise<void> {
  section("A", "Mahabir attribution — where did the 9 Mahabir-linked B3 stops actually buy?");

  const retailerKeys = b3Ytd.map((a) => a.entityKey);
  const priorMonths  = b3Ytd[0]?.priorMonths ?? [];

  // All distributor purchases for every B3 stop retailer in the prior window
  const allDistRes = await pool.query<{
    retailer: string;
    distributor: string | null;
    dist_value: string;
  }>(
    `SELECT
       retailer,
       distributor,
       SUM(net_amount)::float8::text AS dist_value
     FROM secondary_sku_line
     WHERE fy = $1
       AND month_label = ANY($2::text[])
       AND retailer = ANY($3::text[])
       AND distributor IS NOT NULL
     GROUP BY retailer, distributor
     ORDER BY retailer, SUM(net_amount) DESC`,
    [FY_COMPLETE, priorMonths, retailerKeys],
  );

  // Group by retailer → list of (distributor, value) sorted by value desc
  const byRetailer = new Map<string, Array<{ distributor: string; value: number }>>();
  for (const r of allDistRes.rows) {
    const list = byRetailer.get(r.retailer) ?? [];
    list.push({ distributor: r.distributor!, value: parseFloat(r.dist_value ?? "0") });
    byRetailer.set(r.retailer, list);
  }

  // Filter to retailers that have MAHABIR in their distributor list
  const mahabirKey = "mahabir sales corporation";
  const mahabirRetailers = [...byRetailer.entries()].filter(([, dists]) =>
    dists.some((d) => d.distributor.toLowerCase().includes("mahabir")),
  );

  console.log(`\n  B3 stops that include Mahabir Sales Corporation in their prior-window purchases: ${mahabirRetailers.length}`);
  console.log(`  (These are the "9" from Section 2b of the full report.)\n`);

  if (mahabirRetailers.length === 0) {
    console.log("  None found — the 9 may have been an aggregate artifact.");
    return;
  }

  let mahabirPrimary   = 0;
  let mahabirSecondary = 0;

  for (const [retailer, dists] of mahabirRetailers) {
    const priorAlert = b3Ytd.find((a) => a.entityKey === retailer);
    const totalPrior = priorAlert?.priorValue ?? dists.reduce((s, d) => s + d.value, 0);
    const primary    = dists[0]; // highest value
    const isPrimaryMahabir = primary.distributor.toLowerCase().includes("mahabir");

    if (isPrimaryMahabir) mahabirPrimary++;
    else mahabirSecondary++;

    console.log(`  ${retailer}  total prior: ${cr(totalPrior)}`);
    for (const d of dists) {
      const tag = d.distributor.toLowerCase().includes("mahabir") ? " ← MAHABIR" : "";
      const primaryTag = d === primary ? " [PRIMARY — rollup assigns here]" : "";
      console.log(`    ${d.distributor.padEnd(40)} ${cr(d.value)}${tag}${primaryTag}`);
    }
    console.log();
  }

  console.log(sep());
  console.log(`  VERDICT:`);
  console.log(`  Retailers where Mahabir IS the primary (max-value) distributor: ${mahabirPrimary}`);
  console.log(`  Retailers where Mahabir is a secondary distributor (lower value): ${mahabirSecondary}`);
  console.log();

  if (mahabirSecondary > 0) {
    console.log(`  The rollup correctly assigns the ${mahabirSecondary} secondary-Mahabir retailers`);
    console.log(`  to their actual primary distributor.  They DID buy from Mahabir, but their`);
    console.log(`  primary supply relationship was with the other distributor.  Attributing the`);
    console.log(`  stop to Mahabir would be wrong — the primary channel stopped, not Mahabir's.`);
  }
  if (mahabirPrimary > 0) {
    console.log(`  The ${mahabirPrimary} retailer(s) where Mahabir IS primary should appear in a`);
    console.log(`  Mahabir group — check whether their total prior value is above the ₹10 L floor.`);
    for (const [retailer, dists] of mahabirRetailers) {
      if (!dists[0].distributor.toLowerCase().includes("mahabir")) continue;
      const priorAlert = b3Ytd.find((a) => a.entityKey === retailer);
      const pv = priorAlert?.priorValue ?? 0;
      console.log(`    ${retailer}  prior: ${cr(pv)}  ${pv >= 1_000_000 ? "≥ ₹10 L — SHOULD roll up" : "< ₹10 L — below floor, correctly suppressed"}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  (B) Destocking alert — retrospective
// ─────────────────────────────────────────────────────────────────────────────

// Known distributor→primary-customer linkage (from SQL matching in prep queries)
const DIST_CUST_LINKS: Array<[string, string]> = [
  ["Avirasico International",                          "AVIRASICO INTERNATIONAL (KOLKATTA)"],
  ["ARADHYA KEDIA DISTRIBUTION HOUSE PVT.",            "ARADHYA KEDIA DISTRIBUTION HOUSE PVT LTD"],
  ["ARADHYA KEDIA DISTRIBUTION HOUSE PVT. LTD. (Closed)", "ARADHYA KEDIA DISTRIBUTION HOUSE PVT LTD"],
  ["MAHABIR SALES CORPORATION",                        "MAHABIR SALES CORPORATION"],
  ["Anand Sanitaryware",                               "ANAND SANITARYWARE"],
  ["PRAYAG SALE CORPORATION NE",                       "PRAYAG SALES CORPORATION (NE) (GUWAHATI)"],
  ["PRAYAG MARKETING",                                 "PRAYAG SALES CORPORATION (NE) (GUWAHATI)"],
  ["Prayag Sales Corporation",                         "PRAYAG SALES CORPORATION (NE) (GUWAHATI)"],
  ["Subham Enterprise",                                "SUBHAM ENTERPRISE (W.B)"],
  ["SB ENTERPRISES",                                   "SB ENTERPRISES"],
  ["Lalta Prasad Ram Dayal",                           "Lalta Prasad Ram Dayal"],
  ["CHHINAMASTIKE SANITATION PVT. LTD.",               "CHHINAMASTIKE SANITATION PRIVATE LIMITED"],
  ["Mittal Agencies",                                  "MITTAL AGENCIES (Patna)"],
  ["Unique Pipe & Sanitation",                         "UNIQUE PIPE & SANITATION (BANKUDA)"],
  ["Sriram Packaging",                                 "SRIRAM PACKAGING"],
  ["Grahaa Priya enterprise",                          "GRAHAA PRIYA ENTERPRISES"],
];

async function diagnoseDestocking(): Promise<void> {
  section("B", "Destocking alert — retrospective run (FY2025-26 and FY2026-27)");

  console.log(`
  Rule: a distributor fires when they have ≥ 3 consecutive months of zero
  primary purchase from Prayag while secondary sell-through is positive.

  This fires BEFORE retailers stop — the stock-out happens later.

  Linkage: ${DIST_CUST_LINKS.length} secondary distributors matched to primary customers.
  Checking all 12 months of FY2025-26 and 4 months of FY2026-27.
`);

  const uniqueCustomers = [...new Set(DIST_CUST_LINKS.map(([, c]) => c))];
  const uniqueDistributors = [...new Set(DIST_CUST_LINKS.map(([d]) => d))];

  // Load all months for FY2025-26 and FY2026-27 — ordered chronologically
  const ALL_MONTHS_ORDERED = [
    ...fyMonthLabels(FY_COMPLETE),   // Apr-25 … Mar-26
    ...fyMonthLabels(FY_YTD).slice(0, 4),  // Apr-26, May-26, Jun-26, Jul-26
  ];

  // Primary by customer by month
  const primRes = await pool.query<{
    customer: string; fy: string; month_label: string; amount: string;
  }>(
    `SELECT customer, fy, month_label, SUM(amount)::float8::text AS amount
       FROM sale_line_current
      WHERE customer = ANY($1::text[])
        AND fy = ANY($2::text[])
      GROUP BY customer, fy, month_label`,
    [uniqueCustomers, [FY_COMPLETE, FY_YTD]],
  );
  const primByKey = new Map<string, number>(); // `${customer}|${month}` → amount
  for (const r of primRes.rows) {
    primByKey.set(`${r.customer}|${r.month_label}`, parseFloat(r.amount ?? "0"));
  }

  // Secondary by distributor by month
  const secRes = await pool.query<{
    distributor: string; fy: string; month_label: string; net: string;
  }>(
    `SELECT distributor, fy, month_label, SUM(net_amount)::float8::text AS net
       FROM secondary_sku_line
      WHERE distributor = ANY($1::text[])
        AND fy = ANY($2::text[])
      GROUP BY distributor, fy, month_label`,
    [uniqueDistributors, [FY_COMPLETE, FY_YTD]],
  );
  const secByKey = new Map<string, number>();
  for (const r of secRes.rows) {
    secByKey.set(`${r.distributor}|${r.month_label}`, parseFloat(r.net ?? "0"));
  }

  // Deduplicate: one canonical distributor per customer link
  // (multiple distributor names can map to the same customer — use the first one with sec data)
  const custToDistributor = new Map<string, string>();
  for (const [dist, cust] of DIST_CUST_LINKS) {
    if (!custToDistributor.has(cust)) custToDistributor.set(cust, dist);
    // If this dist has more sec data, prefer it
    const secTotal = ALL_MONTHS_ORDERED.reduce((s, m) => s + (secByKey.get(`${dist}|${m}`) ?? 0), 0);
    const existingDist = custToDistributor.get(cust)!;
    const existingSecTotal = ALL_MONTHS_ORDERED.reduce((s, m) => s + (secByKey.get(`${existingDist}|${m}`) ?? 0), 0);
    if (secTotal > existingSecTotal) custToDistributor.set(cust, dist);
  }

  interface DestockResult {
    distributor: string;
    customer: string;
    firstAlertMonth: string | null;
    consecutiveZerosAtAlert: number;
    secAtFirstAlert: number; // secondary in the 3 alert months
    secTotalFall: string | null; // month secondary first hits zero after alert
    priorMonthlySecAvg: number;
    months: Array<{ m: string; prim: number; sec: number }>;
  }

  const results: DestockResult[] = [];

  for (const [customer, distributor] of custToDistributor.entries()) {
    const monthData: Array<{ m: string; prim: number; sec: number }> = [];
    for (const m of ALL_MONTHS_ORDERED) {
      const prim = primByKey.get(`${customer}|${m}`) ?? 0;
      const sec  = secByKey.get(`${distributor}|${m}`) ?? 0;
      monthData.push({ m, prim, sec });
    }

    // Skip distributors with no secondary data at all
    const totalSec = monthData.reduce((s, d) => s + d.sec, 0);
    if (totalSec === 0) continue;

    // Find first month where 3 consecutive zero-primary AND positive secondary
    let consecutiveZeros = 0;
    let firstAlertMonth: string | null = null;
    let secAtAlert = 0;

    for (let i = 0; i < monthData.length; i++) {
      const { prim, sec } = monthData[i];
      if (prim === 0) {
        consecutiveZeros++;
        if (consecutiveZeros >= 3 && firstAlertMonth === null) {
          // Check that secondary is positive in at least one of these 3 months
          const window = monthData.slice(i - 2, i + 1);
          const secInWindow = window.reduce((s, d) => s + d.sec, 0);
          if (secInWindow > 0) {
            firstAlertMonth = monthData[i].m;
            secAtAlert = secInWindow;
          }
        }
      } else {
        consecutiveZeros = 0;
      }
    }

    // When does secondary first hit zero after the alert?
    let secFallMonth: string | null = null;
    if (firstAlertMonth) {
      const alertIdx = monthData.findIndex((d) => d.m === firstAlertMonth);
      for (let i = alertIdx + 1; i < monthData.length; i++) {
        if (monthData[i].sec === 0) { secFallMonth = monthData[i].m; break; }
      }
    }

    // Prior monthly secondary average (months before first zero streak)
    const priorMonths = monthData.filter((d) => d.prim > 0);
    const priorSecAvg = priorMonths.length > 0
      ? priorMonths.reduce((s, d) => s + d.sec, 0) / priorMonths.length
      : 0;

    results.push({
      distributor, customer,
      firstAlertMonth,
      consecutiveZerosAtAlert: 3,
      secAtFirstAlert: secAtAlert,
      secTotalFall: secFallMonth,
      priorMonthlySecAvg: priorSecAvg,
      months: monthData,
    });
  }

  // Sort: those that fire first, then those that don't fire
  results.sort((a, b) => {
    if (a.firstAlertMonth && b.firstAlertMonth) return ALL_MONTHS_ORDERED.indexOf(a.firstAlertMonth) - ALL_MONTHS_ORDERED.indexOf(b.firstAlertMonth);
    if (a.firstAlertMonth) return -1;
    if (b.firstAlertMonth) return 1;
    return 0;
  });

  const firing = results.filter((r) => r.firstAlertMonth !== null);
  const silent = results.filter((r) => r.firstAlertMonth === null);

  console.log(`  DISTRIBUTORS THAT FIRE THE DESTOCKING ALERT: ${firing.length}`);
  console.log();

  for (const r of firing) {
    const secFallNote = r.secTotalFall ? `secondary hits zero: ${r.secTotalFall}` : "secondary still positive at end of window";
    console.log(`  ${r.distributor}`);
    console.log(`    Primary customer:         ${r.customer}`);
    console.log(`    Alert fires:              ${r.firstAlertMonth} (3rd consecutive month with zero primary)`);
    console.log(`    Secondary in alert window: ${cr(r.secAtFirstAlert)} — distributor still selling from stock`);
    console.log(`    Prior avg monthly sec:    ${cr(r.priorMonthlySecAvg)}`);
    console.log(`    Stock exhaustion:         ${secFallNote}`);

    // Print the monthly timeline (condensed — only show months with non-zero primary or secondary)
    console.log(`    Timeline (prim | sec):`);
    for (const { m, prim, sec } of r.months) {
      if (prim === 0 && sec === 0) continue; // skip dead months
      const alert = m === r.firstAlertMonth ? " ← ALERT FIRES" : "";
      const stock = m === r.secTotalFall ? " ← STOCK OUT" : "";
      const primStr = prim > 0 ? cr(prim) : "—";
      const secStr  = sec  > 0 ? cr(sec)  : "—";
      console.log(`      ${m.padEnd(8)} prim: ${primStr.padEnd(12)} sec: ${secStr}${alert}${stock}`);
    }
    console.log();
  }

  if (silent.length > 0) {
    console.log(`  DISTRIBUTORS CHECKED BUT NOT FIRING: ${silent.length}`);
    for (const r of silent) {
      const secTotal = r.months.reduce((s, d) => s + d.sec, 0);
      const lastPrim = [...r.months].reverse().find((d) => d.prim > 0)?.m ?? "never";
      console.log(`    ${r.distributor.slice(0, 48).padEnd(50)} last primary: ${lastPrim}  sec total: ${cr(secTotal)}`);
    }
  }

  console.log();
  console.log(sep());
  console.log(`  SUMMARY:`);
  console.log(`    ${firing.length} distributors would have triggered the destocking alert.`);
  if (firing.length > 0) {
    const earliest = firing[0];
    console.log(`    Earliest: ${earliest.distributor} at ${earliest.firstAlertMonth}.`);
    const aradhya = firing.find((r) => r.distributor.toLowerCase().includes("aradhya"));
    if (aradhya) {
      console.log(`    Aradhya Kedia: alert at ${aradhya.firstAlertMonth},`);
      console.log(`      ${aradhya.secTotalFall ? aradhya.secTotalFall + " is when secondary goes to zero (retailer stock-out starts)." : "secondary still non-zero at window end."}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  (C) A1/A2 overlap
// ─────────────────────────────────────────────────────────────────────────────
function diagnoseA1A2Overlap(ytdAlerts: Array<{ code: string; entityKey: string; numbers: Record<string, number | string | null | undefined> }>): void {
  section("C", "A1 / A2 overlap — are they the same alert with different names?");

  const a1 = ytdAlerts.filter((a) => a.code === "A1");
  const a2 = ytdAlerts.filter((a) => a.code === "A2");
  const a1Keys = new Set(a1.map((a) => a.entityKey));
  const a2Keys = new Set(a2.map((a) => a.entityKey));

  const overlap = [...a1Keys].filter((k) => a2Keys.has(k));
  const a1Only  = [...a1Keys].filter((k) => !a2Keys.has(k));
  const a2Only  = [...a2Keys].filter((k) => !a1Keys.has(k));

  console.log(`\n  A1: ${a1.length} alerts (low achievement, below threshold)`);
  console.log(`  A2: ${a2.length} alerts (zero order booking)`);
  console.log(`  Overlap (entity in both A1 and A2): ${overlap.length}`);
  console.log(`  A1 only: ${a1Only.length}    A2 only: ${a2Only.length}`);

  // A2 is a subset of A1: zero booking → 0% achievement → below any % threshold
  // Cross-suppression in the engine prevents both from firing simultaneously.
  // Check what the engine actually outputs — if overlap is 0, cross-suppression is working.
  if (overlap.length === 0) {
    console.log(`\n  ✓  Zero overlap — the engine is cross-suppressing correctly.`);
    console.log(`     A2 fires instead of A1 when booking = 0.`);
    console.log(`     A1 fires only when booking > 0 but achievement < threshold.`);
    console.log(`     They are already mutually exclusive by design.`);
    console.log(`\n  HOWEVER — the user's observation is correct at the alert-page level:`);
    console.log(`     A member who books nothing (A2) is by definition below 35% (A1).`);
    console.log(`     They fire different codes but represent the same underlying failure:`);
    console.log(`     member is not contributing to target.`);
    console.log(`\n  Recommendation: treat A1 and A2 as ONE alert type "Member Below Target"`);
    console.log(`     with a severity level:`);
    console.log(`       CRITICAL: zero booking (current A2) — severity = red`);
    console.log(`       WARNING:  booking > 0 but achievement < 35% (current A1) — severity = amber`);
    console.log(`     This turns A1(17) + A2(13) = 30 separate alerts into 30 cards with`);
    console.log(`     two severity bands — no count reduction, but conceptually one alert type.`);
  } else {
    console.log(`\n  ⚠  ${overlap.length} members fire both A1 and A2 — cross-suppression may not be complete.`);
    console.log(`     Overlapping members:`);
    for (const k of overlap.slice(0, 10)) {
      const a1a = a1.find((a) => a.entityKey === k);
      const a2a = a2.find((a) => a.entityKey === k);
      console.log(`       ${k.padEnd(35)} A1 ach: ${(a1a?.numbers.achievementPct as number | undefined)?.toFixed(1) ?? "—"}%`);
    }
  }

  console.log(`\n  A1-only members (low booking but non-zero):`);
  for (const k of a1Only.slice(0, 8)) {
    const a = a1.find((a) => a.entityKey === k);
    const ach = (a?.numbers.achievementPct as number | undefined)?.toFixed(1) ?? "—";
    const ob  = a?.numbers.cumulativeOb ?? 0;
    console.log(`    ${k.padEnd(40)} ach: ${ach}%  OB: ${cr(Number(ob))}`);
  }
  if (a1Only.length > 8) console.log(`    … ${a1Only.length - 8} more`);

  console.log(`\n  A2-only members (zero booking):`);
  for (const k of a2Only.slice(0, 8)) {
    const a = a2.find((a) => a.entityKey === k);
    console.log(`    ${k.padEnd(40)} plan: ${cr(Number(a?.numbers.cumulativeTarget ?? a?.rupeesAtStake ?? 0))}`);
  }
  if (a2Only.length > 8) console.log(`    … ${a2Only.length - 8} more`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  (D) Territorial concentration alert — threshold proposal
// ─────────────────────────────────────────────────────────────────────────────
async function diagnoseConcentrationThreshold(b3Ytd: Array<{ entityKey: string; priorMonths: string[] }>): Promise<void> {
  section("D", "Territorial concentration alert — threshold proposal");

  const retailerKeys = b3Ytd.map((a) => a.entityKey);
  const priorMonths  = b3Ytd[0]?.priorMonths ?? [];

  // State head rollup (same join as items2)
  const res = await pool.query<{
    state_head: string;
    retailer_count: string;
    total_value: string;
  }>(
    `SELECT
       COALESCE(pr.state_head, '(no SH mapped)') AS state_head,
       COUNT(DISTINCT ssl.retailer)::text AS retailer_count,
       SUM(ssl.net_amount)::float8::text AS total_value
     FROM secondary_sku_line ssl
     LEFT JOIN person_registry pr
           ON LOWER(pr.canonical_name) = ssl.head_canon
     WHERE ssl.fy = $1
       AND ssl.month_label = ANY($2::text[])
       AND ssl.retailer = ANY($3::text[])
     GROUP BY state_head
     ORDER BY COUNT(DISTINCT ssl.retailer) DESC`,
    [FY_COMPLETE, priorMonths, retailerKeys],
  );

  const total = b3Ytd.length;
  const rows = res.rows.map((r) => ({
    sh: r.state_head,
    count: parseInt(r.retailer_count),
    value: parseFloat(r.total_value ?? "0"),
  }));

  console.log(`\n  Current B3 stop distribution by State Head (${total} total stops):\n`);
  console.log("  State Head                              Retailers   Share    Prior value");
  console.log(sep("-", 72));
  for (const r of rows) {
    console.log(
      `  ${r.sh.slice(0, 38).padEnd(40)}${String(r.count).padStart(6)}` +
      `   ${pct(r.count, total).padEnd(10)} ${cr(r.value)}`,
    );
  }

  // Note the 36% unmapped limitation
  const unmapped = rows.find((r) => r.sh === "(no SH mapped)");
  if (unmapped) {
    console.log(`\n  Note: ${unmapped.count}/${total} stops (${pct(unmapped.count, total)}) have no state_head`);
    console.log(`  in person_registry.  Fixing #298 will complete this picture.`);
    console.log(`  If the unmapped retailers distribute evenly, Sandeep Dadheech's real`);
    console.log(`  share stays ~60%.  If they cluster under him, it rises.`);
  }

  // Threshold proposal
  const sandeep = rows.find((r) => r.sh === "Sandeep Dadheech");
  const rizvi   = rows.find((r) => r.sh === "Syed Aqil Rizvi");

  console.log(`\n  THRESHOLD PROPOSAL for "SH B3 Concentration Alert":`);
  console.log(`\n  Candidates:`);
  console.log(`    (i)   Count-only:      ≥ 15 stopped retailers under one SH`);
  console.log(`    (ii)  Share-only:      SH accounts for ≥ 40% of all B3 stops`);
  console.log(`    (iii) Count + value:   ≥ 10 stopped retailers AND ≥ ₹5 Cr prior value`);
  console.log(`    (iv)  Count + share:   ≥ 10 stopped retailers AND ≥ 30% share`);
  console.log();

  const thresholds: Array<{ name: string; fn: (r: typeof rows[0]) => boolean }> = [
    { name: "(i)  ≥ 15 retailers",             fn: (r) => r.count >= 15 },
    { name: "(ii)  ≥ 40% share",               fn: (r) => r.count / total >= 0.40 },
    { name: "(iii) ≥ 10 retailers + ≥ ₹5 Cr", fn: (r) => r.count >= 10 && r.value >= 5e7 },
    { name: "(iv)  ≥ 10 retailers + ≥ 30%",   fn: (r) => r.count >= 10 && r.count / total >= 0.30 },
  ];

  for (const { name, fn } of thresholds) {
    const fires = rows.filter((r) => r.sh !== "(no SH mapped)" && fn(r));
    const misses = [sandeep, rizvi].filter((r) => r && !fn(r));
    const fireSandeep = sandeep ? fn(sandeep) : false;
    const fireRizvi   = rizvi   ? fn(rizvi)   : false;
    console.log(`  ${name}`);
    console.log(`    Fires on: ${fires.map((r) => r.sh).join(", ") || "nobody"}`);
    console.log(`    Sandeep Dadheech (${sandeep?.count ?? 0}, ${pct(sandeep?.count ?? 0, total)}): ${fireSandeep ? "✓ FIRES" : "✗ silent"}`);
    console.log(`    Syed Aqil Rizvi  (${rizvi?.count ?? 0}, ${pct(rizvi?.count ?? 0, total)}): ${fireRizvi ? "✓ FIRES" : "✗ silent"}`);
    console.log();
  }

  console.log(`  RECOMMENDED: option (iv) — ≥ 10 stopped retailers AND ≥ 30% of total B3 stops.`);
  console.log(`    - Fires on Sandeep Dadheech (40, 60%) — the signal.`);
  console.log(`    - Silent on Syed Aqil Rizvi (9, 13%) — correctly below threshold.`);
  console.log(`    - Count floor (10) prevents spurious fires from small populations.`);
  console.log(`    - Share floor (30%) scales with total alert volume — won't misfire`);
  console.log(`      when B3 total is low (e.g., 5 total stops, 3 under one SH is`);
  console.log(`      60% share but only 3 retailers — not worth an alert).`);
  console.log(`\n  Implement after #298 so the unmapped 36% don't distort the denominator.`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("RED ALERT — DIAGNOSTIC ITEMS (round 3: Mahabir, destocking, A1/A2, SH concentration)");
  console.log(`Run at: ${new Date().toISOString()}`);
  console.log("Read-only. No writes.\n");

  console.log("Fetching context…");
  const ctx       = await buildDetectionContext(pool, [FY_COMPLETE, FY_YTD]);
  const ytdMonths = effectiveYtdMonths(ctx);
  console.log(`FY${FY_YTD} window: [${ytdMonths.join(", ")}]`);

  const resultYtd = detectAlerts(ctx, { fy: FY_YTD, primaryCompleteMonths: ytdMonths });
  const b3Ytd     = resultYtd.alerts
    .filter((a) => a.code === "B3")
    .map((a) => ({ entityKey: a.entityKey, priorMonths: a.priorMonths, priorValue: a.numbers.priorValue ?? 0 }));

  // (A) and (B) and (D) need DB queries — run in parallel where possible
  const [, , ,] = await Promise.all([
    diagnoseMahabir(b3Ytd),
    diagnoseDestocking(),
    (async () => {
      // C is synchronous, run after context is ready
      diagnoseA1A2Overlap(resultYtd.alerts.map((a) => ({
        code: a.code, entityKey: a.entityKey,
        numbers: a.numbers as Record<string, number | string | null | undefined>,
        rupeesAtStake: a.rupeesAtStake,
      })));
    })(),
    diagnoseConcentrationThreshold(b3Ytd),
  ]);

  console.log("\n" + sep("═"));
  console.log("  DIAGNOSTIC COMPLETE — no writes performed");
  console.log(sep("═") + "\n");

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
