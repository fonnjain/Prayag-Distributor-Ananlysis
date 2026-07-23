// Distributor Deep Dive — Phase D1
//
// Reads all member working sheets under a state head and groups retailer
// rows by their Assigned Distributor field. Surfaces the four distinct
// field states:
//
//   blank / null   → direct dealer  (parallel branch, NOT a child of any dist)
//   '--' / '-'     → no distributor assigned  (mapping problem — flag it)
//   'A, B' comma   → shared distributor  (model as relation, not a string)
//   numeric        → malformed row  (exclude)
//   other          → normalize name → assign to distributor group
//
// Rules:
//  - Never publish a distributor total without Confirmed/Guessed split.
//  - Direct dealers are a PARALLEL branch — they must never appear under
//    a distributor in any summary or total.
//  - Distributor name normalization: TRADERS → TRADE, ENTERPRISES →
//    ENTERPRISE, etc. so 'Jagdamba Traders' and 'Jagdamba Trade' merge.
//  - Concentration is Jagdamba's OB / party OB (party = all distributor
//    rows, including shared; excludes direct dealer and none-assigned).
//  - Flow-gap = primary inflow (dist buys from Prayag) minus secondary
//    outflow (dist sells to retailers). Stock building and channel leakage
//    are indistinguishable in the data; the page says so explicitly.
//  - Closed years stay frozen. Live-year reads only.
//  - Never console.log — use logger.

import { db, customerMaster } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger.js";
import { loadDeepDiveData } from "./deepDiveData.js";
import { loadMemberSheet, type RetailerRow } from "./memberSheet.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type DistributorRetailerRow = {
  name: string;
  district: string | null;
  city: string | null;
  orderBooking: number;
  sale: number;
  visits: number | null;
  isActive: boolean;
  confirmedHead: boolean;
  memberName: string;
};

export type DistributorGroup = {
  name: string;              // canonical display name (most common raw form)
  normKey: string;           // stable grouping key
  retailerCount: number;
  activeCount: number;
  dormantCount: number;
  orderBooking: number;
  sale: number;
  visits: number | null;
  obSharePct: number | null;        // share of party OB
  isConcentrationRisk: boolean;     // obSharePct >= 60 %
  confirmedCount: number;
  guessedCount: number;
  retailers: DistributorRetailerRow[];
};

export type SharedRetailerEntry = {
  name: string;
  rawDistributor: string;
  distributorParts: string[];      // split on comma
  orderBooking: number;
  sale: number;
  visits: number | null;
  isActive: boolean;
  confirmedHead: boolean;
  memberName: string;
};

export type DirectDealerSummary = {
  retailerCount: number;
  activeCount: number;
  dormantCount: number;
  orderBooking: number;
  sale: number;
  visits: number | null;
};

export type NoneAssignedSummary = {
  retailerCount: number;
  activeCount: number;
  dormantCount: number;
  orderBooking: number;
  sale: number;
  visits: number | null;
  visitSharePct: number | null;   // of the member's total visits
  allDormant: boolean;
};

export type MappingQuality = {
  totalRetailers: number;
  blankCount: number;
  noneCount: number;
  sharedCount: number;
  malformedCount: number;
  distributorCount: number;
  noneVisits: number | null;
  totalVisits: number | null;
  noneVisitSharePct: number | null;
  noneAllDormant: boolean;
};

export type DistributorDeepDiveResult = {
  fy: string;
  stateHeads: string[];
  distributors: DistributorGroup[];
  sharedRetailers: SharedRetailerEntry[];
  directDealer: DirectDealerSummary | null;
  noneAssigned: NoneAssignedSummary | null;
  mappingQuality: MappingQuality | null;
  partyObTotal: number;
  membersLoaded: number;
  membersNotMapped: number;
  error: string | null;
};

// ── Distributor field classification ─────────────────────────────────────────

type DistClass =
  | { type: "blank" }
  | { type: "none" }
  | { type: "malformed" }
  | { type: "shared"; parts: string[] }
  | { type: "distributor"; raw: string; normKey: string };

/**
 * Normalize a raw distributor name to a stable grouping key.
 * Merges common spelling variants so 'Jagdamba Traders' and
 * 'Jagdamba Trade' both collapse to 'JAGDAMBA TRADE'.
 */
function normDistKey(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\bTRADERS?\b/g, "TRADE")           // Traders / Trader → TRADE
    .replace(/\bENTERPRISES?\b/g, "ENTERPRISE")   // Enterprises → ENTERPRISE
    .replace(/\bINDUSTRIES\b/g, "INDUSTRY")
    .replace(/\bPVT\.?\s*LTD\.?\b/g, "PVTLTD")
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyDist(raw: string | null): DistClass {
  if (!raw || raw.trim() === "") return { type: "blank" };
  const t = raw.trim();
  // Numeric-only cell → malformed, exclude
  if (/^\d+(\.\d+)?$/.test(t)) return { type: "malformed" };
  // None-assigned markers
  if (t === "--" || t === "-" || t === "—" || t === "–") return { type: "none" };
  // Comma-separated → shared distributor relationship
  if (t.includes(",")) {
    const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
    return { type: "shared", parts };
  }
  return { type: "distributor", raw: t, normKey: normDistKey(t) };
}

// ── Main function ─────────────────────────────────────────────────────────────

export async function loadDistributorDeepDive(
  fy: string,
  selectedStateHead?: string,
): Promise<DistributorDeepDiveResult> {
  // Step 1: Load member list via the deepDiveData cache (avoids a second
  // Sheets read for the Data tab; the result is already cached or loading).
  const ddResult = await loadDeepDiveData(fy, selectedStateHead, undefined);
  const { stateHeads, members } = ddResult;

  const empty = (): DistributorDeepDiveResult => ({
    fy, stateHeads, distributors: [], sharedRetailers: [],
    directDealer: null, noneAssigned: null, mappingQuality: null,
    partyObTotal: 0, membersLoaded: 0, membersNotMapped: 0, error: null,
  });

  if (!selectedStateHead || !members.length) return empty();

  // Step 2: Load all member working sheets in parallel.
  const TIMEOUT_MS = 20_000;
  const sheetResults = await Promise.allSettled(
    members.map((m) =>
      Promise.race([
        loadMemberSheet(m.normKey, m.name, fy),
        new Promise<{ status: "error"; error: string }>((resolve) =>
          setTimeout(
            () => resolve({ status: "error", error: "timeout after 20s" }),
            TIMEOUT_MS,
          ),
        ),
      ]),
    ),
  );

  type RichRow = RetailerRow & { memberName: string };
  const allRows: RichRow[] = [];
  let membersLoaded = 0;
  let membersNotMapped = 0;

  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const res = sheetResults[i];
    if (res.status === "rejected") {
      logger.warn({ member: m.name, err: res.reason }, "distributorDeepDive: sheet load rejected");
      continue;
    }
    const sheet = res.value;
    if (sheet.status === "not-mapped") { membersNotMapped++; continue; }
    if (sheet.status !== "ok") {
      logger.warn({ member: m.name, status: sheet.status }, "distributorDeepDive: sheet not ok");
      continue;
    }
    membersLoaded++;
    for (const row of sheet.rows) {
      allRows.push({ ...row, memberName: m.name });
    }
  }

  if (!allRows.length) {
    return {
      ...empty(),
      membersLoaded, membersNotMapped,
      error: membersLoaded === 0
        ? "No working sheets could be loaded for this state head."
        : null,
    };
  }

  // Step 3: Query customer_master for Confirmed/Guessed attribution confidence.
  // Confidence tells us how reliable the retailer → state head mapping is.
  const confidenceMap = new Map<string, "Confirmed" | "Guessed">();
  try {
    const cmRows = await db
      .select({ company: customerMaster.company, headConfidence: customerMaster.headConfidence })
      .from(customerMaster)
      .where(eq(customerMaster.stateHead, selectedStateHead));
    for (const r of cmRows) {
      const k = r.company.toLowerCase().replace(/\s+/g, " ").trim();
      confidenceMap.set(k, r.headConfidence.startsWith("Confirmed") ? "Confirmed" : "Guessed");
    }
  } catch (err) {
    logger.warn({ err }, "distributorDeepDive: customer_master query failed — confidence will default to Guessed");
  }

  function conf(name: string): "Confirmed" | "Guessed" {
    return confidenceMap.get(name.toLowerCase().replace(/\s+/g, " ").trim()) ?? "Guessed";
  }

  // Step 4: Classify all retailer rows.
  const distMap = new Map<string, { rawNames: string[]; rows: RichRow[] }>();
  const sharedRows: RichRow[] = [];
  const directDealerRows: RichRow[] = [];
  const noneRows: RichRow[] = [];
  const malformedRows: RichRow[] = [];

  let totalVisitSum = 0;
  let hasAnyVisit = false;

  for (const row of allRows) {
    if (row.totalVisit !== null) { totalVisitSum += row.totalVisit; hasAnyVisit = true; }
    const cls = classifyDist(row.distributor);
    switch (cls.type) {
      case "blank":       directDealerRows.push(row); break;
      case "none":        noneRows.push(row);         break;
      case "malformed":   malformedRows.push(row);    break;
      case "shared":      sharedRows.push(row);       break;
      case "distributor": {
        const existing = distMap.get(cls.normKey);
        if (existing) { existing.rawNames.push(cls.raw); existing.rows.push(row); }
        else          { distMap.set(cls.normKey, { rawNames: [cls.raw], rows: [row] }); }
        break;
      }
    }
  }

  // Step 5: Build shared retailer entries.
  const sharedRetailers: SharedRetailerEntry[] = sharedRows.map((row) => {
    const cls = classifyDist(row.distributor) as { type: "shared"; parts: string[] };
    return {
      name: row.name,
      rawDistributor: row.distributor ?? "",
      distributorParts: cls.parts,
      orderBooking: row.orderBooking,
      sale: row.sale,
      visits: row.totalVisit,
      isActive: row.isActive,
      confirmedHead: conf(row.name) === "Confirmed",
      memberName: row.memberName,
    };
  });

  const sharedOb = sharedRetailers.reduce((s, r) => s + r.orderBooking, 0);

  // Step 6: Build distributor groups.
  let totalDistOb = 0;
  const distGroups: DistributorGroup[] = Array.from(distMap.entries()).map(
    ([normKey, { rawNames, rows }]) => {
      // Canonical name: most frequent raw form.
      const freq = new Map<string, number>();
      for (const n of rawNames) freq.set(n, (freq.get(n) ?? 0) + 1);
      const canonicalName =
        [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? rawNames[0];

      const retailerRows: DistributorRetailerRow[] = rows
        .map((row) => ({
          name: row.name,
          district: row.district,
          city: row.city,
          orderBooking: row.orderBooking,
          sale: row.sale,
          visits: row.totalVisit,
          isActive: row.isActive,
          confirmedHead: conf(row.name) === "Confirmed",
          memberName: row.memberName,
        }))
        .sort((a, b) => b.orderBooking - a.orderBooking);

      const active   = rows.filter((r) => r.isActive);
      const ob       = rows.reduce((s, r) => s + r.orderBooking, 0);
      const sale     = rows.reduce((s, r) => s + r.sale, 0);
      const vArr     = rows.map((r) => r.totalVisit).filter((v): v is number => v !== null);
      const visits   = vArr.length > 0 ? vArr.reduce((s, v) => s + v, 0) : null;
      const confCnt  = rows.filter((r) => conf(r.name) === "Confirmed").length;

      totalDistOb += ob;

      return {
        name: canonicalName, normKey,
        retailerCount: rows.length,
        activeCount:   active.length,
        dormantCount:  rows.length - active.length,
        orderBooking: ob, sale, visits,
        obSharePct:         null,  // filled below
        isConcentrationRisk: false, // filled below
        confirmedCount: confCnt,
        guessedCount:   rows.length - confCnt,
        retailers: retailerRows,
      };
    },
  );

  // party OB = distributor OB + shared OB
  // (excludes direct dealer and none-assigned — they are separate branches)
  const partyObTotal = totalDistOb + sharedOb;

  for (const g of distGroups) {
    g.obSharePct         = partyObTotal > 0 ? (g.orderBooking / partyObTotal) * 100 : null;
    g.isConcentrationRisk = (g.obSharePct ?? 0) >= 60;
  }
  distGroups.sort((a, b) => b.orderBooking - a.orderBooking);

  // Step 7: Direct dealer summary (PARALLEL branch — never a child of any dist).
  const ddActive  = directDealerRows.filter((r) => r.isActive);
  const ddVArr    = directDealerRows.map((r) => r.totalVisit).filter((v): v is number => v !== null);
  const directDealer: DirectDealerSummary | null = directDealerRows.length > 0
    ? {
        retailerCount: directDealerRows.length,
        activeCount:   ddActive.length,
        dormantCount:  directDealerRows.length - ddActive.length,
        orderBooking:  directDealerRows.reduce((s, r) => s + r.orderBooking, 0),
        sale:          directDealerRows.reduce((s, r) => s + r.sale, 0),
        visits:        ddVArr.length > 0 ? ddVArr.reduce((s, v) => s + v, 0) : null,
      }
    : null;

  // Step 8: None-assigned summary (cannot order — supply-mapping problem).
  const noneActive = noneRows.filter((r) => r.isActive);
  const noneVArr   = noneRows.map((r) => r.totalVisit).filter((v): v is number => v !== null);
  const noneVTotal = noneVArr.length > 0 ? noneVArr.reduce((s, v) => s + v, 0) : null;
  const noneAssigned: NoneAssignedSummary | null = noneRows.length > 0
    ? {
        retailerCount: noneRows.length,
        activeCount:   noneActive.length,
        dormantCount:  noneRows.length - noneActive.length,
        orderBooking:  noneRows.reduce((s, r) => s + r.orderBooking, 0),
        sale:          noneRows.reduce((s, r) => s + r.sale, 0),
        visits:        noneVTotal,
        visitSharePct:
          hasAnyVisit && totalVisitSum > 0 && noneVTotal !== null
            ? (noneVTotal / totalVisitSum) * 100
            : null,
        allDormant: noneActive.length === 0,
      }
    : null;

  // Step 9: Mapping quality panel.
  const mappingQuality: MappingQuality = {
    totalRetailers: allRows.length,
    blankCount:     directDealerRows.length,
    noneCount:      noneRows.length,
    sharedCount:    sharedRows.length,
    malformedCount: malformedRows.length,
    distributorCount:
      allRows.length
      - directDealerRows.length
      - noneRows.length
      - sharedRows.length
      - malformedRows.length,
    noneVisits:        noneVTotal,
    totalVisits:       hasAnyVisit ? totalVisitSum : null,
    noneVisitSharePct:
      hasAnyVisit && totalVisitSum > 0 && noneVTotal !== null
        ? (noneVTotal / totalVisitSum) * 100
        : null,
    noneAllDormant: noneActive.length === 0,
  };

  logger.info(
    {
      fy, selectedStateHead, membersLoaded, membersNotMapped,
      totalRetailers: allRows.length,
      distributors:   distGroups.length,
      partyObTotal,
      directDealerOb: directDealer?.orderBooking ?? null,
      noneCount:      noneRows.length,
      sharedCount:    sharedRows.length,
      malformedCount: malformedRows.length,
    },
    "distributorDeepDive: aggregation complete — verify against acceptance criteria",
  );

  return {
    fy, stateHeads,
    distributors: distGroups,
    sharedRetailers,
    directDealer,
    noneAssigned,
    mappingQuality,
    partyObTotal,
    membersLoaded,
    membersNotMapped,
    error: null,
  };
}
