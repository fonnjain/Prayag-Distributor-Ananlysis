// Loads productivity and HR data for team members from the Data tab of the
// STATE HEAD DASHBOARD workbook (same sheet as the roster_fallback source).
// Header is on row 3 (1-indexed); data starts at row 4.
// Columns are detected by header text to survive sheet-column drift; the
// fixed indices in the comments are the expected positions as of FY26-27.

import { readAllTabRows } from "../registers/sheetsApi.js";
import { normName } from "./names.js";
import { mgmtSources } from "./roster.js";

export type HrSfaRecord = {
  ctcMonthly: number | null;
  workingDays: number | null;
  totalVisits: number | null;
  visitedParties: number | null;
  nonVisitedRetailers: number | null;
  distributorVisits: number | null;
  directDealerVisits: number | null;
  ddLeadCounter: number | null;
  ddLeadVisits: number | null;
  totalLeadCounters: number | null;
  totalLeadVisits: number | null;
  totalNonLeadVisits: number | null;
  activePartiesVisits: number | null;
  businessReceivedVisits: number | null;
  visitedNoBusinessReceived: number | null;
  noVisitNoBusinessReceived: number | null;
  totalWorkingHours: number | null;
  totalGpsKm: number | null;
  avgDistanceKm: number | null;
  costRatioPct: number | null;
  designation: string | null;
  empCode: string | null;
};

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const s = String(v).replace(/[,\s]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// Cost Ratio in the sheet may be a decimal (0.0523) or a string ("5.23%").
// In both cases return the 0-1 decimal for ExcelJS "0.0%" formatting.
function toPct(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v; // already decimal fraction from Sheets
  const s = String(v).trim();
  if (s.endsWith("%")) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : null;
  }
  const n = Number(s.replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Find the first column whose lowercased header contains the needle.
// Falls back to `fallback` (default -1 = not found) when no match.
function fc(headers: string[], needle: string, fallback = -1): number {
  const n = needle.toLowerCase();
  const idx = headers.findIndex((h) => h.toLowerCase().includes(n));
  return idx >= 0 ? idx : fallback;
}

let cache: { data: Map<string, HrSfaRecord>; at: number } | null = null;
const TTL_MS = 3_600_000; // 1 h — same as roster TTL

export async function loadHrSfaDashboard(): Promise<Map<string, HrSfaRecord>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const fb = mgmtSources().roster_fallback;
  const rows = await readAllTabRows(fb.sheetId, fb.dataTab);

  // Row 3 (1-indexed) is the header; 0-indexed: rows[2].
  const rawHeader = rows[2] ?? [];
  const header = rawHeader.map((v) => (v == null ? "" : String(v).trim()));

  // Detect columns by header text. Fallback indices (0-indexed) are the
  // known fixed positions as of FY26-27 (1-indexed column - 1).
  const iName           = fc(header, "name",                           2);  // col 3
  const iVisited        = fc(header, "visited in",                    11);  // col 12
  const iNonVisited     = fc(header, "non visited",                   14);  // col 15
  const iTotalVisits    = fc(header, "total visits",                  31);  // col 32
  const iWorkingDays    = fc(header, "working days",                  32);  // col 33
  const iCtcMonthly     = fc(header, "ctc monthly",                   35);  // col 36
  const iCostRatio      = fc(header, "cost ratio",                    38);  // col 39
  const iWorkingHours   = fc(header, "working hours",                 43);  // col 44
  const iGpsKm          = fc(header, "gps km",                        44);  // col 45
  const iAvgDistance    = fc(header, "avg distance",                  46);  // col 47
  const iDesignation    = fc(header, "designation",                   74);  // col 75
  const iEmpCode        = fc(header, "emp code",                      75);  // col 76

  // Visit-breakdown columns — no reliable fixed fallback, text-only detection.
  const iDistributorVisits  = fc(header, "distributor visits");
  const iDirectDealerVisits = fc(header, "direct dealer visits");
  const iDdLeadCounter      = fc(header, "distributor/direct dealer lead counter");
  const iDdLeadVisits       = fc(header, "distributor/direct dealer lead visits");
  const iTotalLeadCounters  = fc(header, "total lead counter");
  const iTotalLeadVisits    = fc(header, "total lead visit");
  const iTotalNonLeadVisits = fc(header, "non lead visit");
  const iActiveParties      = fc(header, "active parties");
  const iBizReceived        = fc(header, "business received parties");
  const iVisitedNoBiz       = fc(header, "visited but no");
  const iNoVisitNoBiz       = fc(header, "no visit no");

  const data = new Map<string, HrSfaRecord>();

  // Data rows start at row 4 (1-indexed) = index 3 (0-indexed).
  for (let i = 3; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const name = toStr(r[iName]);
    if (!name) continue;
    const nk = normName(name);
    if (!nk) continue;

    const g = (idx: number): unknown => (idx >= 0 ? r[idx] : undefined);

    data.set(nk, {
      ctcMonthly:                toNum(g(iCtcMonthly)),
      workingDays:               toNum(g(iWorkingDays)),
      totalVisits:               toNum(g(iTotalVisits)),
      visitedParties:            toNum(g(iVisited)),
      nonVisitedRetailers:       toNum(g(iNonVisited)),
      distributorVisits:         toNum(g(iDistributorVisits)),
      directDealerVisits:        toNum(g(iDirectDealerVisits)),
      ddLeadCounter:             toNum(g(iDdLeadCounter)),
      ddLeadVisits:              toNum(g(iDdLeadVisits)),
      totalLeadCounters:         toNum(g(iTotalLeadCounters)),
      totalLeadVisits:           toNum(g(iTotalLeadVisits)),
      totalNonLeadVisits:        toNum(g(iTotalNonLeadVisits)),
      activePartiesVisits:       toNum(g(iActiveParties)),
      businessReceivedVisits:    toNum(g(iBizReceived)),
      visitedNoBusinessReceived: toNum(g(iVisitedNoBiz)),
      noVisitNoBusinessReceived: toNum(g(iNoVisitNoBiz)),
      totalWorkingHours:         toNum(g(iWorkingHours)),
      totalGpsKm:                toNum(g(iGpsKm)),
      avgDistanceKm:             toNum(g(iAvgDistance)),
      costRatioPct:              toPct(g(iCostRatio)),
      designation:               toStr(g(iDesignation)),
      empCode:                   toStr(g(iEmpCode)),
    });
  }

  cache = { data, at: Date.now() };
  return data;
}

export function clearHrSfaCache(): void {
  cache = null;
}
