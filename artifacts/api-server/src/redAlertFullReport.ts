// Red Alert — Full calibration + B3 cluster analysis + threshold proposals.
//
// Covers three deliverables:
//   1. Full calibration table at current thresholds (both FYs).
//   2. B3 cluster analysis for FY2026-27: by state/head, by distributor,
//      and whether those distributors are still active in FY2026-27.
//   3. Threshold proposals to bring each period to ~20 total alerts,
//      with what falls off the page at those levels.
//
// Read-only. No routes, no writes, no stored alerts.
//
// Run:
//   node build.mjs && node --enable-source-maps dist/redAlertFullReport.mjs

import { pool } from "@workspace/db";
import { buildDetectionContext } from "./lib/redAlert/context.js";
import { detectAlerts, fyMonthLabels } from "./lib/redAlert/detectAlerts.js";
import type { RawAlert, AlertCode, CalibrationResult } from "./lib/redAlert/types.js";

const FY_COMPLETE = "2025-26";
const FY_YTD     = "2026-27";

// ── Helpers ──────────────────────────────────────────────────────────────────

function cr(v: number): string {
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${Math.round(v).toLocaleString("en-IN")}`;
}
function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}
function bar(n: number, total: number, width = 30): string {
  const filled = total === 0 ? 0 : Math.round((n / total) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
function sep(c = "─", w = 72): string { return c.repeat(w); }
function section(title: string): void {
  console.log("\n" + sep("═"));
  console.log("  " + title);
  console.log(sep("═"));
}
function sub(title: string): void {
  console.log("\n" + sep());
  console.log("  " + title);
  console.log(sep());
}
function row(label: string, ...cols: string[]): string {
  return label.padEnd(36) + cols.map((c) => c.padStart(12)).join("  ");
}

// ── Effective months helper (same logic as calibration) ───────────────────────

function effectiveYtdMonths(ctx: Awaited<ReturnType<typeof buildDetectionContext>>): string[] {
  const frozen = [...(ctx.frozenMonths.get(FY_YTD) ?? [])].sort();
  const secMonths = new Set<string>();
  for (const [, hMap] of ctx.secCompleteMonths.get(FY_YTD) ?? []) {
    for (const m of hMap) secMonths.add(m);
  }
  if (frozen.length > 0 && secMonths.size > 0) {
    const intersection = frozen.filter((m) => secMonths.has(m));
    return intersection.length > 0 ? intersection : frozen;
  }
  return frozen.length > 0 ? frozen : fyMonthLabels(FY_YTD).slice(0, 4);
}

// ────────────────────────────────────────────────────────────────────────────
//  SECTION 1 — Full calibration table at current thresholds
// ────────────────────────────────────────────────────────────────────────────

function printCalibrationTable(results: CalibrationResult[]): void {
  section("SECTION 1 — Full calibration at current thresholds");

  const codes: AlertCode[] = [
    "A1","A2","A3",
    "B1","B2","B3","B4","B5",
    "C1","C2","C3","C4","C5",
  ];

  // Column header
  const hdrs = results.map((r) => `FY${r.fy}`);
  console.log("\n" + "Code  " + hdrs.map((h) => h.padEnd(26)).join("  "));
  console.log(sep("-", 70));

  for (const code of codes) {
    const cols = results.map((r) => {
      const b = r.byCode[code];
      if (b.count === 0) return "0".padEnd(26);
      return `${b.count}  ${cr(b.rupeesAtStake)}`.padEnd(26);
    });
    console.log(`${code.padEnd(6)}${cols.join("  ")}`);
  }

  console.log(sep("-", 70));
  for (const r of results) {
    const total = r.alerts.length;
    const totalRs = r.alerts.reduce((s, a) => s + a.rupeesAtStake, 0);
    console.log(`  FY${r.fy}:  TOTAL ${total} alerts  |  ${cr(totalRs)} at stake`);
  }

  // Per-category subtotals
  console.log();
  for (const r of results) {
    const catA = r.alerts.filter((a) => a.category === "A");
    const catB = r.alerts.filter((a) => a.category === "B");
    const catC = r.alerts.filter((a) => a.category === "C");
    const sA = catA.reduce((s, a) => s + a.rupeesAtStake, 0);
    const sB = catB.reduce((s, a) => s + a.rupeesAtStake, 0);
    const sC = catC.reduce((s, a) => s + a.rupeesAtStake, 0);
    console.log(`  FY${r.fy}  Cat-A: ${catA.length} (${cr(sA)})  ` +
                `Cat-B: ${catB.length} (${cr(sB)})  ` +
                `Cat-C: ${catC.length} (${cr(sC)})`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  SECTION 2 — B3 cluster analysis (FY2026-27)
// ────────────────────────────────────────────────────────────────────────────

async function printB3ClusterAnalysis(
  b3Ytd: RawAlert[],
  ytdMonths: string[],
): Promise<void> {
  section("SECTION 2 — B3 cluster analysis (FY2026-27)");

  if (b3Ytd.length === 0) {
    console.log("  No B3 alerts for FY2026-27.");
    return;
  }

  console.log(`  ${b3Ytd.length} retailer stops across 4 months ` +
    `(${ytdMonths.join(", ")}).`);
  console.log(`  Prior window: ${b3Ytd[0]?.priorMonths.join(", ") ?? "—"}`);

  const retailerKeys = b3Ytd.map((a) => a.entityKey);
  const priorMonths  = b3Ytd[0]?.priorMonths ?? [];

  // ── Query: get state/head/distributor for these retailers in the prior window
  //    A retailer may appear under more than one distributor across the 4 prior
  //    months; we keep all rows and deduplicate.
  const attrRes = await pool.query<{
    retailer: string;
    state_canon: string | null;
    head_canon: string | null;
    distributor: string | null;
    prior_value: string;
  }>(
    `SELECT
       retailer,
       state_canon,
       head_canon,
       distributor,
       SUM(net_amount)::float8::text AS prior_value
     FROM secondary_sku_line
     WHERE fy = $1
       AND month_label = ANY($2::text[])
       AND retailer = ANY($3::text[])
     GROUP BY retailer, state_canon, head_canon, distributor`,
    [FY_COMPLETE, priorMonths, retailerKeys],
  );

  // Build per-retailer map: retailer → { state, head, distributors[], priorValue }
  interface RetailerAttr {
    retailer: string;
    state: string;
    head: string;
    distributors: Set<string>;
    priorValue: number;
  }
  const byRetailer = new Map<string, RetailerAttr>();
  for (const r of attrRes.rows) {
    let entry = byRetailer.get(r.retailer);
    if (!entry) {
      entry = {
        retailer: r.retailer,
        state: r.state_canon ?? "(no state)",
        head: r.head_canon ?? "(no head)",
        distributors: new Set(),
        priorValue: 0,
      };
      byRetailer.set(r.retailer, entry);
    }
    if (r.distributor) entry.distributors.add(r.distributor);
    entry.priorValue += parseFloat(r.prior_value ?? "0");
  }

  // Match to alert's priorValue for retailers not in secondary_sku_line
  // (fallback: use the alert's priorValue)
  for (const a of b3Ytd) {
    if (!byRetailer.has(a.entityKey)) {
      byRetailer.set(a.entityKey, {
        retailer: a.entityKey,
        state: "(not in SKU line)",
        head: "(not in SKU line)",
        distributors: new Set(),
        priorValue: a.numbers.priorValue ?? 0,
      });
    }
  }

  // Build alert priorValue map for threshold section
  const alertPriorValue = new Map<string, number>();
  for (const a of b3Ytd) {
    alertPriorValue.set(a.entityKey, a.numbers.priorValue ?? 0);
  }

  // Collect all implicated distributors
  const implicatedDists = new Set<string>();
  for (const attr of byRetailer.values()) {
    for (const d of attr.distributors) implicatedDists.add(d);
  }

  // ── Query: which of these distributors are active in FY2026-27?
  const distActivityRes = await pool.query<{
    distributor: string;
    months_active: string;
    total_value: string;
  }>(
    `SELECT
       distributor,
       COUNT(DISTINCT month_label)::text AS months_active,
       SUM(net_amount)::float8::text AS total_value
     FROM secondary_sku_line
     WHERE fy = $1
       AND distributor = ANY($2::text[])
     GROUP BY distributor`,
    [FY_YTD, [...implicatedDists]],
  );
  const distActivity = new Map<string, { months: number; value: number }>();
  for (const r of distActivityRes.rows) {
    distActivity.set(r.distributor, {
      months: parseInt(r.months_active),
      value: parseFloat(r.total_value ?? "0"),
    });
  }

  // ── (a) By state and State Head ─────────────────────────────────────────
  sub("(a) By state and State Head");

  const byState = new Map<string, { heads: Map<string, number>; count: number; value: number }>();
  for (const attr of byRetailer.values()) {
    let stEntry = byState.get(attr.state);
    if (!stEntry) { stEntry = { heads: new Map(), count: 0, value: 0 }; byState.set(attr.state, stEntry); }
    stEntry.count++;
    stEntry.value += attr.priorValue;
    const hCount = stEntry.heads.get(attr.head) ?? 0;
    stEntry.heads.set(attr.head, hCount + 1);
  }

  const statesSorted = [...byState.entries()].sort((a, b) => b[1].count - a[1].count);
  const total66 = b3Ytd.length;

  console.log(row("State", "Retailers", "Share", "Prior value") + "  Top Head Head-count");
  console.log(sep("-", 90));
  for (const [state, st] of statesSorted) {
    const topHead = [...st.heads.entries()].sort((a, b) => b[1] - a[1])[0];
    const headStr = topHead ? `${topHead[0]} (${topHead[1]})` : "—";
    console.log(
      row(state.slice(0, 35), String(st.count), pct(st.count, total66), cr(st.value)) +
      `  ${headStr}`,
    );
    // Sub-list heads for states with ≥5 alerts
    if (st.count >= 5 && st.heads.size > 1) {
      const headsSorted = [...st.heads.entries()].sort((a, b) => b[1] - a[1]);
      for (const [head, cnt] of headsSorted) {
        console.log(`    ${"".padEnd(32)}${head.slice(0, 30).padEnd(32)}  ${cnt}`);
      }
    }
  }

  // Concentration check
  const topStates = statesSorted.slice(0, 3);
  const topCount  = topStates.reduce((s, [, st]) => s + st.count, 0);
  console.log();
  console.log(`  Concentration: top 3 states account for ${topCount}/${total66} ` +
    `(${pct(topCount, total66)}) of stops.`);
  if (topCount / total66 > 0.5) {
    console.log("  ⚠  >50% concentrated in 3 states — territorial signal, not general.");
  } else {
    console.log("  ✓  Stops spread across states — not concentrated in a single territory.");
  }

  // ── (b) By distributor ───────────────────────────────────────────────────
  sub("(b) By distributor — which served these retailers last year");

  const byDist = new Map<string, { retailers: Set<string>; value: number; states: Set<string>; heads: Set<string> }>();
  for (const attr of byRetailer.values()) {
    for (const dist of attr.distributors) {
      let de = byDist.get(dist);
      if (!de) { de = { retailers: new Set(), value: 0, states: new Set(), heads: new Set() }; byDist.set(dist, de); }
      de.retailers.add(attr.retailer);
      de.value += attr.priorValue;
      de.states.add(attr.state);
      de.heads.add(attr.head);
    }
  }

  const noDistCount = [...byRetailer.values()].filter((a) => a.distributors.size === 0).length;
  const distsSorted = [...byDist.entries()].sort((a, b) => b[1].retailers.size - a[1].retailers.size);

  console.log(`  ${byDist.size} distinct distributors served the ${total66} stopped retailers.`);
  if (noDistCount > 0) {
    console.log(`  ${noDistCount} retailers have no distributor attribution in secondary_sku_line.`);
  }
  console.log();

  // Print top distributors
  const topDists = distsSorted.slice(0, 20);
  console.log(
    row("Distributor", "Ret-stops", "Share", "Prior value") +
    "  Active FY2026-27?  Months  Current value",
  );
  console.log(sep("-", 110));
  for (const [dist, de] of topDists) {
    const act = distActivity.get(dist);
    const activeStr = act ? `YES (${act.months}m, ${cr(act.value)})` : "NO — zero activity";
    console.log(
      row(dist.slice(0, 35), String(de.retailers.size), pct(de.retailers.size, total66), cr(de.value)) +
      `  ${activeStr}`,
    );
  }
  if (distsSorted.length > 20) {
    const rest = distsSorted.slice(20).reduce((s, [, de]) => s + de.retailers.size, 0);
    console.log(`  … ${distsSorted.length - 20} more distributors, ${rest} more retailer-stops.`);
  }

  // Concentration check
  const topDistCount = topDists.slice(0, 5).reduce((s, [, de]) => s + de.retailers.size, 0);
  console.log();
  console.log(`  Top 5 distributors account for ${topDistCount} retailer-stops ` +
    `(${pct(topDistCount, total66)}).`);

  // ── (c) Distributor activity summary ────────────────────────────────────
  sub("(c) Distributor activity in FY2026-27");

  const stillActive   = [...implicatedDists].filter((d) => distActivity.has(d));
  const inactive      = [...implicatedDists].filter((d) => !distActivity.has(d));

  console.log(`  ${implicatedDists.size} distributors served the stopped retailers in FY2025-26.`);
  console.log(`  ${stillActive.length} are still active in FY2026-27 (have secondary_sku_line rows).`);
  console.log(`  ${inactive.length} have ZERO FY2026-27 presence — stopped entirely.`);
  console.log();

  if (inactive.length > 0) {
    console.log("  Inactive distributors (zero FY2026-27 secondary activity):");
    // Count how many stopped retailers each inactive dist served
    for (const dist of inactive.slice(0, 15)) {
      const de = byDist.get(dist);
      const retCount = de?.retailers.size ?? 0;
      console.log(`    ${dist.slice(0, 50).padEnd(52)}  ${retCount} stopped retailers`);
    }
    if (inactive.length > 15) {
      console.log(`    … ${inactive.length - 15} more inactive distributors.`);
    }
    console.log();

    // Count retailers whose ONLY distributor(s) are all inactive
    let orphanedRetailers = 0;
    for (const attr of byRetailer.values()) {
      if (attr.distributors.size === 0) continue;
      const allInactive = [...attr.distributors].every((d) => !distActivity.has(d));
      if (allInactive) orphanedRetailers++;
    }
    console.log(`  Retailers whose every prior-period distributor is now inactive: ` +
      `${orphanedRetailers} / ${total66}`);
    if (orphanedRetailers > 0) {
      console.log("  ⚠  These retailers may have stopped BECAUSE their distributor stopped.");
      console.log("     Alerting on the retailer is correct, but the root cause is upstream.");
    }
  } else {
    console.log("  ✓  All implicated distributors remain active in FY2026-27.");
    console.log("     Retailer stops are not explained by distributor dropout.");
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  SECTION 3 — Threshold proposals to reach ~20 alerts per period
// ────────────────────────────────────────────────────────────────────────────

function printThresholdProposals(results: CalibrationResult[]): void {
  section("SECTION 3 — Threshold proposals to reach ~20 alerts per period");

  const TARGET = 20;

  for (const r of results) {
    sub(`FY${r.fy} — current total: ${r.alerts.length}`);

    const codes: AlertCode[] = [
      "A1","A2","A3","B1","B2","B3","B4","B5","C1","C2","C3","C4","C5",
    ];

    // Count per-code
    const byCode = new Map<AlertCode, RawAlert[]>();
    for (const code of codes) byCode.set(code, []);
    for (const a of r.alerts) byCode.get(a.code as AlertCode)?.push(a);

    const exceedingCodes = codes.filter((c) => (byCode.get(c)?.length ?? 0) > TARGET);
    const okCodes        = codes.filter((c) => {
      const n = byCode.get(c)?.length ?? 0;
      return n > 0 && n <= TARGET;
    });

    if (okCodes.length > 0) {
      console.log(`  Codes already at or below ${TARGET}: ` +
        okCodes.map((c) => `${c} (${byCode.get(c)?.length})`).join("  "));
    }

    if (exceedingCodes.length === 0) {
      console.log(`\n  ✓  All codes already at or below ${TARGET}. No threshold change needed.`);
      console.log(`     Total: ${r.alerts.length} — within a 20-alert page budget.`);
      continue;
    }

    console.log(`\n  Codes exceeding ${TARGET}: ` +
      exceedingCodes.map((c) => `${c} (${byCode.get(c)?.length})`).join("  "));

    // For each exceeding code: propose a floor that cuts to ~TARGET
    for (const code of exceedingCodes) {
      const alerts = byCode.get(code) ?? [];
      const sortedByRs = [...alerts].sort((a, b) =>
        (b.numbers.priorValue ?? b.rupeesAtStake) - (a.numbers.priorValue ?? a.rupeesAtStake),
      );

      // The 20th alert's priorValue is the proposed new floor
      const cutAlert  = sortedByRs[TARGET - 1];
      const proposedFloor = cutAlert
        ? Math.ceil((cutAlert.numbers.priorValue ?? cutAlert.rupeesAtStake) / 100_000) * 100_000
        : null;

      const excluded  = proposedFloor != null
        ? sortedByRs.filter((a) => (a.numbers.priorValue ?? a.rupeesAtStake) < proposedFloor)
        : [];
      const surviving = sortedByRs.filter((a) =>
        proposedFloor == null || (a.numbers.priorValue ?? a.rupeesAtStake) >= proposedFloor,
      );

      console.log();
      console.log(`  ── ${code} (${alerts.length} alerts → target ~${TARGET}) ──`);

      if (code === "B3") {
        console.log(`     B3 floor is entity-type-specific. Current retailer floor: ₹10 L.`);
        const retailerAlerts = sortedByRs.filter((a) => a.entityType === "retailer");
        const distAlerts     = sortedByRs.filter((a) => a.entityType === "distributor");
        const dealerAlerts   = sortedByRs.filter((a) => a.entityType === "direct_dealer");

        for (const [label, group, currentFloor] of [
          ["Retailer", retailerAlerts, 1_000_000] as const,
          ["Distributor", distAlerts, 2_500_000] as const,
          ["Direct dealer", dealerAlerts, 1_500_000] as const,
        ]) {
          if (group.length <= TARGET) {
            if (group.length > 0) {
              console.log(`     ${label}: ${group.length} ≤ ${TARGET}. No change needed.`);
            }
            continue;
          }
          const cut = group[TARGET - 1];
          const floor = cut
            ? Math.ceil((cut.numbers.priorValue ?? cut.rupeesAtStake) / 500_000) * 500_000
            : null;
          if (floor == null) continue;
          const excl = group.filter((a) => (a.numbers.priorValue ?? a.rupeesAtStake) < floor);
          const exclVal = excl.reduce((s, a) => s + (a.numbers.priorValue ?? 0), 0);
          console.log(`     ${label}: ${group.length} alerts → raise floor to ${cr(floor)}.`);
          console.log(`       Excluded: ${excl.length} entities, ${cr(exclVal)} prior value at stake.`);
          if (excl.length <= 12) {
            for (const a of excl) {
              const pv = a.numbers.priorValue ?? 0;
              console.log(`         ${a.entityKey.slice(0, 40).padEnd(42)}  prior ${cr(pv)}`);
            }
          } else {
            // Show lowest and highest of excluded
            console.log(`         Excluded range: ${cr(excl[excl.length-1]?.numbers.priorValue ?? 0)} – ${cr(excl[0]?.numbers.priorValue ?? 0)}`);
            console.log(`         Bottom 8 excluded (smallest prior values):`);
            for (const a of excl.slice(-8)) {
              const pv = a.numbers.priorValue ?? 0;
              console.log(`           ${a.entityKey.slice(0, 40).padEnd(42)}  prior ${cr(pv)}`);
            }
          }
        }

      } else if (code === "B5") {
        // B5 has two levers: prior code count floor and breadth drop floor
        const sortedByCode = [...alerts].sort((a, b) =>
          (b.numbers.codePrior ?? 0) - (a.numbers.codePrior ?? 0),
        );
        const cutB5       = sortedByCode[TARGET - 1];
        const proposedCCFloor = cutB5
          ? Math.ceil((cutB5.numbers.codePrior ?? 0) / 5) * 5
          : null;

        // Alternative: raise the breadth-drop floor (declinePct stored on numbers)
        const sortedByDrop = [...alerts].sort((a, b) =>
          (b.numbers.declinePct ?? 0) - (a.numbers.declinePct ?? 0),
        );
        let dropFloor: number | null = null;
        if (alerts.length > TARGET) {
          const cutDrop = sortedByDrop[TARGET - 1];
          dropFloor = cutDrop
            ? Math.ceil((cutDrop.numbers.declinePct ?? 0) / 5) * 5
            : null;
        }

        console.log(`     Current: prior code count ≥ 30, breadth drop ≥ 60%.`);
        if (proposedCCFloor != null) {
          const excl     = sortedByCode.filter((a) => Number(a.numbers.codePrior ?? 0) < proposedCCFloor);
          const exclVal  = excl.reduce((s, a) => s + (a.numbers.priorValue ?? 0), 0);
          console.log(`     Option A — raise code-count floor to ${proposedCCFloor}:`);
          console.log(`       Excluded: ${excl.length}  |  ${cr(exclVal)} prior value at stake`);
          if (excl.length <= 12) {
            for (const a of excl) {
              const cc = a.numbers.codePrior ?? 0;
              const pv = a.numbers.priorValue ?? 0;
              console.log(`         ${a.entityKey.slice(0, 40).padEnd(42)}  ${cc} codes  prior ${cr(pv)}`);
            }
          }
        }
        if (dropFloor != null) {
          const exclDrop   = sortedByDrop.filter((a) => Number(a.numbers.declinePct ?? 0) < dropFloor!);
          const exclValD   = exclDrop.reduce((s, a) => s + (a.numbers.priorValue ?? 0), 0);
          console.log(`     Option B — raise drop floor to ${dropFloor}%:`);
          console.log(`       Excluded: ${exclDrop.length}  |  ${cr(exclValD)} prior value at stake`);
          if (exclDrop.length <= 12) {
            for (const a of exclDrop) {
              const dp = a.numbers.declinePct ?? 0;
              const pv = a.numbers.priorValue ?? 0;
              console.log(`         ${a.entityKey.slice(0, 40).padEnd(42)}  ${dp.toFixed(0)}% drop  prior ${cr(pv)}`);
            }
          }
        }

      } else {
        // Generic: raise priorValue floor
        if (proposedFloor == null) {
          console.log(`     Could not determine a priorValue floor — inspect manually.`);
          continue;
        }
        const exclVal = excluded.reduce((s, a) => s + (a.numbers.priorValue ?? a.rupeesAtStake), 0);
        console.log(`     Raise priorValue floor to ${cr(proposedFloor)}. ` +
          `Excluded: ${excluded.length}  |  ${cr(exclVal)} at stake`);
        if (excluded.length <= 12) {
          for (const a of excluded) {
            const pv = a.numbers.priorValue ?? a.rupeesAtStake;
            console.log(`       ${a.entityKey.slice(0, 50).padEnd(52)}  prior ${cr(pv)}`);
          }
        } else {
          console.log(`       Excluded range: ${cr(excluded[excluded.length-1]?.numbers.priorValue ?? 0)} – ${cr(excluded[0]?.numbers.priorValue ?? 0)}`);
          const bottom8 = excluded.slice(-8);
          console.log(`       Bottom 8 excluded (smallest prior values):`);
          for (const a of bottom8) {
            const pv = a.numbers.priorValue ?? a.rupeesAtStake;
            console.log(`         ${a.entityKey.slice(0, 48).padEnd(50)}  prior ${cr(pv)}`);
          }
        }
        console.log(`       Surviving: ${surviving.slice(0, 5).map((a) => a.entityKey.slice(0, 20)).join(" | ")}` +
          (surviving.length > 5 ? " …" : ""));
      }
    }

    // Summary for this FY
    const residual = (results.find((r2) => r2.fy === r.fy)?.alerts.length ?? 0) -
      exceedingCodes.reduce((s, c) => s + (byCode.get(c)?.length ?? 0), 0) +
      exceedingCodes.length * TARGET;
    console.log();
    console.log(`  At proposed thresholds: ~${Math.min(residual, r.alerts.length)} alerts ` +
      `(rough; actual depends on entity overlap).`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  MAIN
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("RED ALERT — FULL CALIBRATION + CLUSTER ANALYSIS + THRESHOLD PROPOSALS");
  console.log(`Run at: ${new Date().toISOString()}`);
  console.log("Read-only. No writes, no routes, no stored alerts.");

  console.log("\nFetching context…");
  const ctx      = await buildDetectionContext(pool, [FY_COMPLETE, FY_YTD]);
  const ytdMonths = effectiveYtdMonths(ctx);
  console.log(`FY${FY_YTD} effective window: [${ytdMonths.join(", ")}] (${ytdMonths.length} months)`);
  console.log(`FY${FY_COMPLETE}: full 12 months.`);

  // Run detection
  const resultComplete = detectAlerts(ctx, { fy: FY_COMPLETE });
  const resultYtd      = detectAlerts(ctx, { fy: FY_YTD, primaryCompleteMonths: ytdMonths });

  const results = [resultComplete, resultYtd];

  // Section 1
  printCalibrationTable(results);

  // Section 2 — B3 cluster
  const b3Ytd = resultYtd.alerts.filter((a) => a.code === "B3");
  await printB3ClusterAnalysis(b3Ytd, ytdMonths);

  // Section 3 — threshold proposals
  printThresholdProposals(results);

  console.log("\n" + sep("═"));
  console.log("  REPORT COMPLETE — no writes performed");
  console.log(sep("═") + "\n");

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
