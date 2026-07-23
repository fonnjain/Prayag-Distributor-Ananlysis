// Phase D5: Territory whitespace and channel overlap.
//
// Purely derived from D1 retailer rows — no new DB or Sheets reads.
//
// TWO KINDS OF GAP (must never be merged):
//   COVERAGE GAP   — the district has retailers but NO distributor at all.
//                    Fix: appoint a distributor. Strategic, slow.
//   ASSIGNMENT GAP — the district HAS a distributor but some retailers are
//                    unassigned (distributor field = '--'/'−').
//                    Fix: assign them to the existing distributor. Admin, fast.
//
// "Prior-year demand" proxy: RetailerRow.sale.
// In the member working summary tab, the SALE column holds the secondary-
// received figure for the period (or the prior-FY reference), making it the
// best single-field proxy for proven demand.  Never estimate.
//
// Channel overlap rule (from the D1 spec):
//   Direct dealer in a district WITH a distributor → structural conflict.
//   Direct dealer in a district WITHOUT a distributor → only channel, NOT conflict.
//   The page must tell those two cases apart and NEVER merge them.
//
// Never console.log — pure synchronous function.

import type { DistributorGroup } from "./distributorDeepDive.js";

// Locally alias the retailer row element type to avoid a circular import
// (distributorDeepDive imports distributorWhitespace; exporting DistributorRetailerRow
// from distributorDeepDive and importing it back here would create a cycle).
type DistributorRetailerRow = DistributorGroup["retailers"][number];

// ── Types ──────────────────────────────────────────────────────────────────────

/** A retailer row as needed by whitespace (enriched with memberName). */
export type WhitespaceRow = {
  name: string;
  district: string | null;
  city: string | null;
  orderBooking: number;
  sale: number;                  // prior-year demand proxy
  visits: number | null;
  isActive: boolean;
  memberName: string;
};

export type DistrictStat = {
  district: string;

  // Distributor presence
  hasDistributor: boolean;
  distributorNames: string[];    // unique distributor names operating in this district

  // Retailer counts
  coveredCount: number;          // assigned to a named distributor
  directCount: number;           // blank distributor field (direct dealer)
  noneCount: number;             // '--' / not assigned (mapping gap)
  totalCount: number;

  // OB and demand
  coveredOb: number;             // current-year OB from distributor retailers
  directOb: number;              // current-year OB from direct dealers (they CAN order)
  noneOb: number;                // current-year OB from unassigned (almost always 0)
  priorYearOb: number;           // sale (prior-year demand proxy) for direct + none

  // Visits
  coveredVisits: number | null;
  directVisits: number | null;
  noneVisits: number | null;
  totalVisits: number | null;

  // Gap classification
  gapType: "coverage" | "assignment" | "both" | "none";
  // coverage  → no distributor in district
  // assignment → has distributor but some unassigned retailers
  // both       → no distributor AND some none-assigned (should not happen logically but can)
  // none       → fully covered, no gap

  // Channel conflict flag
  isChannelConflict: boolean;    // direct dealers AND distributor present

  // Unassigned retailer detail (for "tie it back to dormancy")
  noneRetailers: Array<{
    name: string;
    ob: number;
    sale: number;
    visits: number | null;
    isActive: boolean;
  }>;
};

export type ChannelConflictEntry = {
  name: string;
  district: string;
  ob: number;
  sale: number;
  visits: number | null;
  isActive: boolean;
};

export type TerritoryWhitespace = {
  districtStats: DistrictStat[];      // one per district, sorted by priorYearOb desc

  // Gap totals
  totalAssignmentGapRetailers: number;    // none-assigned in districts WITH a distributor
  totalAssignmentGapDistricts: number;    // count of affected districts
  totalCoverageGapRetailers: number;      // retailers in districts with NO distributor
  totalCoverageGapDistricts: number;
  coverageGapPriorYearOb: number;         // prior-year demand with no supply route
  coverageGapCurrentOb: number;           // current OB in coverage-gap districts (from direct dealers)
  coverageGapVisits: number;              // visits spent on coverage-gap retailers

  // Channel overlap
  channelConflictCount: number;           // direct dealers inside districts WITH a distributor
  channelNonConflictCount: number;        // direct dealers in districts WITHOUT a distributor
  channelConflictEntries: ChannelConflictEntry[];  // detail of conflict direct dealers
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function addVisits(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Pure synchronous computation — called after Step 6 (D1 distGroups built).
 * Mutates nothing; returns a new TerritoryWhitespace object.
 */
export function computeTerritoryWhitespace(
  distGroups: DistributorGroup[],
  directDealerRows: WhitespaceRow[],
  noneRows: WhitespaceRow[],
): TerritoryWhitespace {

  // ── Step A: Districts that have at least one named distributor ──────────────
  const districtHasDist = new Set<string>();
  // Map district → set of distributor names
  const distToDistNames = new Map<string, Set<string>>();
  // Map district → covered retailer rows (for counts and OB)
  const distToCoveredRows = new Map<string, DistributorRetailerRow[]>();

  for (const g of distGroups) {
    for (const r of g.retailers) {
      const d = r.district ?? "Unknown";
      districtHasDist.add(d);
      const names = distToDistNames.get(d) ?? new Set<string>();
      names.add(g.name);
      distToDistNames.set(d, names);
      const covered = distToCoveredRows.get(d) ?? [];
      covered.push(r);
      distToCoveredRows.set(d, covered);
    }
  }

  // ── Step B: Aggregate direct dealer rows by district ───────────────────────
  const distToDirectRows = new Map<string, WhitespaceRow[]>();
  for (const r of directDealerRows) {
    const d = r.district ?? "Unknown";
    const rows = distToDirectRows.get(d) ?? [];
    rows.push(r);
    distToDirectRows.set(d, rows);
  }

  // ── Step C: Aggregate none-assigned rows by district ──────────────────────
  const distToNoneRows = new Map<string, WhitespaceRow[]>();
  for (const r of noneRows) {
    const d = r.district ?? "Unknown";
    const rows = distToNoneRows.get(d) ?? [];
    rows.push(r);
    distToNoneRows.set(d, rows);
  }

  // ── Step D: Build per-district stats ──────────────────────────────────────
  const allDistricts = new Set<string>([
    ...districtHasDist,
    ...distToDirectRows.keys(),
    ...distToNoneRows.keys(),
  ]);

  const districtStats: DistrictStat[] = [];

  for (const district of allDistricts) {
    const covered = distToCoveredRows.get(district) ?? [];
    const direct  = distToDirectRows.get(district) ?? [];
    const none    = distToNoneRows.get(district) ?? [];
    const hasDist = districtHasDist.has(district);

    const coveredOb = covered.reduce((s, r) => s + r.orderBooking, 0);
    const directOb  = direct.reduce((s, r) => s + r.orderBooking, 0);
    const noneOb    = none.reduce((s, r) => s + r.orderBooking, 0);

    // prior-year demand proxy: RetailerRow.orderBooking maps to the "OLDPARTYOB"
    // column in member working sheets — the prior-FY reference OB per retailer.
    // Direct dealers use their prior-year OB (they were ordering last year via
    // the direct channel). Unassigned retailers have OB = 0 (they were dormant).
    const priorYearOb = directOb + noneOb;

    const coveredVisits = covered.reduce<number | null>((s, r) => addVisits(s, r.visits), null);
    const directVisits  = direct.reduce<number | null>((s, r) => addVisits(s, r.visits), null);
    const noneVisits    = none.reduce<number | null>((s, r) => addVisits(s, r.visits), null);

    const totalVisitsArr = [coveredVisits, directVisits, noneVisits];
    const totalVisits = totalVisitsArr.every((v) => v === null)
      ? null
      : totalVisitsArr.reduce<number>((s, v) => s + (v ?? 0), 0);

    // Gap type
    const hasCoverageGap  = !hasDist;           // no distributor at all
    const hasAssignmentGap = hasDist && none.length > 0;  // has distributor, some unassigned
    const gapType: DistrictStat["gapType"] =
      hasCoverageGap && none.length > 0 ? "both"
      : hasCoverageGap                  ? "coverage"
      : hasAssignmentGap                ? "assignment"
      : "none";

    const isChannelConflict = hasDist && direct.length > 0;

    districtStats.push({
      district,
      hasDistributor: hasDist,
      distributorNames: [...(distToDistNames.get(district) ?? new Set())],
      coveredCount: covered.length,
      directCount:  direct.length,
      noneCount:    none.length,
      totalCount:   covered.length + direct.length + none.length,
      coveredOb,
      directOb,
      noneOb,
      priorYearOb,
      coveredVisits,
      directVisits,
      noneVisits,
      totalVisits,
      gapType,
      isChannelConflict,
      noneRetailers: none.map((r) => ({
        name:     r.name,
        ob:       r.orderBooking,
        sale:     r.sale,
        visits:   r.visits,
        isActive: r.isActive,
      })),
    });
  }

  // Sort districts by prior-year demand descending (coverage first, then assignment, then none)
  districtStats.sort((a, b) => {
    // Coverage gaps first (no distributor)
    const typePriority = (g: DistrictStat["gapType"]) =>
      g === "coverage" || g === "both" ? 0 : g === "assignment" ? 1 : 2;
    const tp = typePriority(a.gapType) - typePriority(b.gapType);
    if (tp !== 0) return tp;
    return b.priorYearOb - a.priorYearOb;
  });

  // ── Step E: Gap totals ─────────────────────────────────────────────────────
  const assignmentGapStats = districtStats.filter((d) => d.gapType === "assignment");

  // Coverage gap summary counts only "both" districts — districts with NO distributor
  // AND at least one unassigned (none-assigned) retailer.  These are the true
  // supply-mapping failures: the retailer has no supply route whatsoever.
  //
  // gapType "coverage" districts (no distributor, only direct dealers) ARE shown
  // in the district table but are NOT counted in the summary totals, because the
  // direct dealer IS a supply route — there is no supply-mapping failure.
  const coverageGapStats = districtStats.filter((d) => d.gapType === "both");

  const totalAssignmentGapRetailers = assignmentGapStats.reduce((s, d) => s + d.noneCount, 0);
  const totalAssignmentGapDistricts = assignmentGapStats.length;

  // Coverage gap: all retailers in the district (direct + unassigned) because
  // appointing a distributor would serve all of them.
  const totalCoverageGapRetailers = coverageGapStats.reduce(
    (s, d) => s + d.directCount + d.noneCount, 0,
  );
  const totalCoverageGapDistricts = coverageGapStats.length;

  const coverageGapPriorYearOb = coverageGapStats.reduce((s, d) => s + d.priorYearOb, 0);
  const coverageGapCurrentOb   = coverageGapStats.reduce((s, d) => s + d.directOb + d.noneOb, 0);
  const coverageGapVisits      = coverageGapStats.reduce(
    (s, d) => s + (d.directVisits ?? 0) + (d.noneVisits ?? 0), 0,
  );

  // ── Step F: Channel conflict entries ──────────────────────────────────────
  const channelConflictEntries: ChannelConflictEntry[] = [];
  let channelNonConflictCount = 0;

  for (const r of directDealerRows) {
    const d = r.district ?? "Unknown";
    if (districtHasDist.has(d)) {
      channelConflictEntries.push({
        name:     r.name,
        district: d,
        ob:       r.orderBooking,
        sale:     r.sale,
        visits:   r.visits,
        isActive: r.isActive,
      });
    } else {
      channelNonConflictCount++;
    }
  }

  // Sort conflict entries by district then by OB descending
  channelConflictEntries.sort((a, b) =>
    a.district < b.district ? -1 : a.district > b.district ? 1 : b.ob - a.ob,
  );

  return {
    districtStats,
    totalAssignmentGapRetailers,
    totalAssignmentGapDistricts,
    totalCoverageGapRetailers,
    totalCoverageGapDistricts,
    coverageGapPriorYearOb,
    coverageGapCurrentOb,
    coverageGapVisits,
    channelConflictCount:    channelConflictEntries.length,
    channelNonConflictCount,
    channelConflictEntries,
  };
}
