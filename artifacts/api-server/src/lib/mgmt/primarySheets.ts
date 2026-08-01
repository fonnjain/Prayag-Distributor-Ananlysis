// Reads primary order-booking and dispatch-sale sheets and returns company,
// head-level, and distributor-level aggregations — no distributor-TM bridge needed.
//
// FY2026-27:
//   Booking : Order Sheet 26-27  (1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A)
//   Sale    : State Head Sale 26-27 (1QIpcfgOVCFjcCmgU_DXKn8h7Bfa8rm2q2wB2HneTvKs)
// FY2025-26:
//   Booking : none (no per-FY primary booking sheet for historical FYs)
//   Sale    : State Head Sale 25-26 (1RuXHIXfusOT-VDdDqeuB-Nx-pxyVkmrJsqr21BB-NUA)
//
// The byHead breakdown is always available from the STATE HEAD column.
// The byDistributor breakdown is always available from the Customer column.
// Both degrade to empty (with a reason) when sheets are unreachable.
import { createHash } from "node:crypto";
import {
  listSheetTabs,
  readTabRowsChunked,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import { normHead, buildHeadResolver } from "./names.js";
import { loadRoster } from "./roster.js";
import { logger } from "../logger.js";
import { and, eq } from "drizzle-orm";
import { db, primaryOrderLines, type InsertPrimaryOrderLine } from "@workspace/db";

export const BOOKING_SHEETS: Record<string, string> = {
  "2026-27": "1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A",
  "2025-26": "1Xzq-gmB6K7iuMcE6gb-O7OpvGgSDU33DzEVyK60LK6E",
  "2024-25": "1cT6lWRPJ3oSeYhab-cqeVjJidGitFQsr0DOq-vNn6cI",
  "2023-24": "1jtSUGE6iT8WuUKi56F4LYqjJgZF42oR1mk51imG8yq8",
};

export const SALE_SHEETS: Record<string, string> = {
  // FY2026-27: "SALE SHEET 26-27" — monthly tabs Apr/May/Jun/July.
  // Columns: A=serial B=invoice C=date D=bill-from E=customer F=city G=dest
  //          H=code I=colour J=qty K=MRP L=rate M=TAXABLE VALUE N=group
  //          O=station P=state Q=STATE HEAD R=month
  "2026-27": "19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps",
  "2025-26": "1RuXHIXfusOT-VDdDqeuB-Nx-pxyVkmrJsqr21BB-NUA",
};

// Positional fallback column indices for sheets where header detection fails
// entirely (0-based column indices).  Applied only when globalRow > 30 and
// no header row was found at all.
const SALE_POSITIONAL: Record<string, { taxIdx: number; headIdx: number }> = {
  "19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps": { taxIdx: 12, headIdx: 16 },
};

// Per-sheet override for the STATE HEAD column when the header IS found
// (taxIdx set correctly) but the HEAD cell label doesn't match the standard
// regex.  Applied after headIdx detection: fires only when headIdx === -1,
// so it never overrides a successfully-detected column.
const HEAD_COL_OVERRIDE: Record<string, number> = {
  // No active entries.  FY2023-24 booking sheet was probed live (Jul-2026): col 24
  // exists in the header row but is empty in ALL data rows.  The per-row channel
  // split ('Govt'/'Retail') is at unlabeled col 20 — handled by CHANNEL_COL_OVERRIDE.
};

// Per-sheet channel column override.  Two uses:
//   chanIdx >= 0: positional override for sheets whose channel column has no header label.
//     explicit=true  → non-'Govt' treated as territory (isTerritory=true).
//     explicit=false → only 'Govt' is classified; others fall back to HEAD column.
//   chanIdx = -1:  explicit BLOCK — disables channel detection for this sheet entirely.
//     Used when the last-non-empty-header fallback would land on a non-channel column
//     (e.g. SEGMENT) and produce misleading govtValue / ntBooking / isTerritory values.
// Applied after header-scan chanIdx detection; takes precedence over the last-non-empty
// fallback in all three call sites (readAndAggregate, readOrderTabInventory, ingest).
const CHANNEL_COL_OVERRIDE: Record<string, { chanIdx: number; explicit: boolean }> = {
  // FY2023-24 booking sheet: col 20 is SEGMENT (Retail / Govt / JJM / Project / Gem).
  // SEGMENT is NOT labeled in the monthly-tab header rows; data rows extend to col 20
  // while the header ends at col 19 ("Month").  chanIdx=20 is forced here so the
  // last-non-empty-header fallback (which would land on "Month" at col 19) is bypassed.
  // explicit=true: non-institutional SEGMENT → isTerritory=true.
  // NON_TERRITORY_RE is used (not /^govt$/i) so JJM/Project/GEM/Govt all match.
  "1jtSUGE6iT8WuUKi56F4LYqjJgZF42oR1mk51imG8yq8": { chanIdx: 20, explicit: true },
};

const NON_TERRITORY_RE = /^(other|project|govt|gem|jjm|nonterrit)/i;
// Tabs that are reference/lookup tables or navigation aids — never contain order rows.
// INDEX = product-group lookup.
// WT / WT-LTR = tank-size lookup table (maps last two digits of item code to
//   litre capacity: 05→500 L, 07→750 L, 10→1000 L, 20→2000 L).
//   The user confirmed: "It is the tank-size lookup table, not order data."
const SKIP_TAB_RE =
  /^(instruction|change.?log|legend|notes?|readme|cover|summary|index|template|wt|wt-ltr|sheet)$/i;
const COMBINED_TAB_RE = /^(combined|last.?month.?order|all.?orders?|pivot)$/i;
const PER_HEAD_TAB_RE = /^[A-Z][A-Za-z .'-]+(?:\s[A-Z][A-Za-z .'-]+)+$/; // title-case or all-caps name
// Match abbreviated OR full month names, with or without year suffix.
const MONTHLY_RE =
  /^(Apr(il)?|May|Jun(e)?|Jul(y)?|Aug(ust)?|Sep(tember)?|Oct(ober)?|Nov(ember)?|Dec(ember)?|Jan(uary)?|Feb(ruary)?|Mar(ch)?)\b/i;

// ── Public types ─────────────────────────────────────────────────────────────

export type PrimaryHeadRow = {
  head: string;
  booking: number;
  sale: number;
  pending: number;
};

export type PrimaryDistributorRow = {
  name: string;
  stateHead: string;
  booking: number;
};

/**
 * Per-tab breakdown for the primary Order Sheet.
 * Gives a transparent, auditable account of what each tab contains and
 * which non-overlapping set is included in the company-level total.
 *
 * The Litre Rule (user-verified):
 *   Unit.Name = "Ltr." → quantity is LITRES (water tanks).
 *   Unit.Name blank or anything else → quantity is PIECES.
 *   NEVER sum ltrQty and pieceQty together — different units.
 *   Label each separately on screen.
 *
 * Scheme eligibility column (user-verified):
 *   The last column of the Order Sheet contains "Retail" or "Govt".
 *   retailValue = Taxable Value of Retail rows (scheme-eligible).
 *   govtValue   = Taxable Value of Govt rows (schemes do not apply).
 */
/**
 * Row-level verification result for per-head and combined tabs.
 * Each data row in the candidate tab is fingerprinted as
 * (date|customer|code|qty|amount) and looked up in the set of fingerprints
 * accumulated from monthly tabs.  This distinguishes "subset" (safe to
 * exclude) from "has unique rows" (exclusion would silently drop data).
 *
 * status:
 *   "confirmed-subset" — every row fingerprint matched a monthly-tab row.
 *                        Exclusion is definitively safe.
 *   "has-unique-rows"  — at least one fingerprint was absent from all monthly
 *                        tabs.  Exclusion would miss those rows.
 *   "unreadable"       — header not found or Sheets API error.
 *   null               — not checked (monthly / lookup / unknown roles).
 */
export type TabContentVerification = {
  status: "confirmed-subset" | "has-unique-rows" | "unreadable";
  /** Data rows read from this tab (positive amounts only). */
  tabRows: number;
  /** Rows whose fingerprint was found in at least one monthly tab. */
  inMonthlyRows: number;
  /** Rows NOT found in any monthly tab — would be lost if this tab were excluded. */
  uniqueRows: number;
  /** Taxable Value sum of uniqueRows. */
  uniqueAmount: number;
  /** Total Taxable Value of all rows in this tab. */
  tabTotal: number;
  /** Monthly-tab aggregate for this head (per-head) or all monthly tabs (combined). */
  monthlyEquivalent: number;
};

export type OrderTabInventoryRow = {
  tabName: string;
  /** How this tab is classified. */
  role: "monthly" | "lookup" | "combined" | "per-head" | "unknown";
  /** Whether this tab is included in the company-level booking total. */
  includedInSum: boolean;
  /** Why this tab was excluded (null when included). */
  excludedReason: string | null;
  /** Data rows read (excludes header rows, 0 for non-read tabs). */
  rowCount: number;
  /** Earliest date found in this tab (ISO string YYYY-MM-DD). */
  dateMin: string | null;
  /** Latest date found in this tab (ISO string YYYY-MM-DD). */
  dateMax: string | null;
  /** Sum of Taxable Value for all data rows. */
  taxableValue: number;
  /** Row count where Unit.Name = "Ltr." (water tanks). */
  ltrRows: number;
  /** Sum of Qty for Ltr. rows (in LITRES — not pieces, do not combine). */
  ltrQty: number;
  /** Row count where Unit.Name is blank or other (pieces). */
  pieceRows: number;
  /** Sum of Qty for piece rows. */
  pieceQty: number;
  /** Taxable Value for Retail channel rows (scheme-eligible). */
  retailValue: number;
  /** Taxable Value for Govt channel rows (schemes do not apply). */
  govtValue: number;
  /**
   * Content-based verification result for per-head and combined tabs.
   * null for all other roles.
   */
  contentVerification: TabContentVerification | null;
};

export type PrimarySheetData = {
  fy: string;
  companyBooking: number;
  /** Non-territory (institutional) booking from the booking sheet (NON_TERRITORY_RE matched on HEAD column). */
  ntBooking: number;
  companySale: number;
  companyPending: number;
  byHead: PrimaryHeadRow[];
  byDistributor: PrimaryDistributorRow[];
  sources: { booking: string | null; sale: string | null };
  bookingAvailable: boolean;
  saleAvailable: boolean;
  /** Full tab inventory for the booking sheet — auditable breakdown. */
  tabInventory: OrderTabInventoryRow[] | null;
};

// ── Cache ─────────────────────────────────────────────────────────────────────

const _cache = new Map<string, { ts: number; data: PrimarySheetData }>();
const TTL_MS = 30 * 60 * 1000;

export function invalidatePrimarySheetCache(fy?: string): void {
  if (fy) _cache.delete(fy);
  else _cache.clear();
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function numVal(v: SheetCellValue | undefined): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function strVal(v: SheetCellValue | undefined): string {
  return v == null ? "" : String(v).trim();
}

function findCol(headers: SheetCellValue[], re: RegExp): number {
  for (let i = 0; i < headers.length; i++) {
    if (re.test(strVal(headers[i]))) return i;
  }
  return -1;
}

/**
 * Deterministic row fingerprint for duplicate detection across tabs.
 * Uses (date | customer | code | qty | amount).  Empty strings are used when
 * a column is absent.
 */
function rowFingerprint(
  date: string | null,
  customer: string,
  code: string,
  qty: number,
  amount: number,
): string {
  return [
    date ?? "",
    customer.toLowerCase().replace(/\s+/g, ""),
    code.toLowerCase().replace(/\s+/g, ""),
    Math.round(qty),
    Math.round(amount),
  ].join("|");
}

/**
 * Four variants of the fingerprint covering customer-present/absent ×
 * code-present/absent.  Date is always included as-is (null → empty string).
 *
 * The four variants exist because different tabs sometimes detect different
 * optional column sets (customer name, item code) due to header naming
 * differences.  Date is NOT varied — if a per-head tab uses a date column
 * header the regex misses, that produces genuinely different fingerprints and
 * the rows are correctly treated as unique rather than masking the finding.
 */
function rowFingerprintVariants(
  date: string | null,
  customer: string,
  code: string,
  qty: number,
  amount: number,
): string[] {
  const d = date ?? "";
  const c = customer.toLowerCase().replace(/\s+/g, "");
  const k = code.toLowerCase().replace(/\s+/g, "");
  const q = Math.round(qty);
  const a = Math.round(amount);
  return [
    `${d}|${c}|${k}|${q}|${a}`, // full
    `${d}||${k}|${q}|${a}`,      // no customer
    `${d}|${c}||${q}|${a}`,      // no code
    `${d}|||${q}|${a}`,           // neither
  ];
}

type SheetAgg = {
  byNormHead: Map<string, number>;
  byDistributor: Map<string, { displayName: string; stateHeadNorm: string; amount: number }>;
  nonTerritoryTotal: number;
  total: number;
  fyYearValues: string[];
  ntHeads: string[];
};

async function readAndAggregate(
  sheetId: string,
  forBooking: boolean,
  opts?: { fyFilter?: string },
): Promise<SheetAgg> {
  const tabs = await listSheetTabs(sheetId);

  // Monthly tabs only (Apr/April, May, Jun/June, Jul/July, …).
  // WT and WT-LTR are EXCLUDED: they are tank-size lookup tables, not order data.
  // Combined / Last Month Order are EXCLUDED: they duplicate the monthly data.
  // Fallback to all non-skip tabs only when no monthly tabs are found (legacy sheets).
  let dataTabs = tabs.filter(
    (t) =>
      MONTHLY_RE.test(t.title.trim()) ||
      /^data$/i.test(t.title.trim()),
  );
  if (dataTabs.length === 0)
    dataTabs = tabs.filter((t) => !SKIP_TAB_RE.test(t.title.trim()) && !COMBINED_TAB_RE.test(t.title.trim()));

  logger.info(
    { sheetId, forBooking, allTabs: tabs.map((t) => t.title), dataTabs: dataTabs.map((t) => t.title) },
    "primarySheets: tabs selected",
  );

  // Positional fallback column indices (used when header-scan finds nothing).
  const positional = SALE_POSITIONAL[sheetId];

  const byNormHead = new Map<string, number>();
  const byDistributor = new Map<
    string,
    { displayName: string; stateHeadNorm: string; amount: number }
  >();
  let nonTerritoryTotal = 0;
  let total = 0;
  // Distinct FY YEAR values encountered across all tabs (before filter is applied).
  // State Head Sale workbooks carry BOTH the prior FY and the current FY in one file.
  const fyYearValues = new Set<string>();
  // Distinct raw head strings that triggered NON_TERRITORY_RE.
  const ntHeads = new Set<string>();

  for (const tab of dataTabs) {
    let taxIdx = -1,
      headIdx = -1,
      chanIdx = -1,
      custIdx = -1,
      fyYearIdx = -1;
    let headerFound = false;
    let tabRows = 0;
    // V4 col-20 sanity: true when the channel column came from an explicit
    // CHANNEL_COL_OVERRIDE (not a header-scan or positional fallback).
    let chanOverrideExplicit = false;
    // Unexpected SEGMENT values seen for this tab when chanOverrideExplicit is set.
    const unknownChanValues = new Set<string>();
    // Valid values for explicitly-overridden channel columns (FY2023-24 col 20).
    const EXPECTED_CHAN_RE = /^(retail|jjm|govt|project|gem)$/i;

    await readTabRowsChunked(sheetId, tab.title, (rows, startRow) => {
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        const globalRow = startRow + ri;

        if (!headerFound) {
          if (globalRow > 30) {
            // Header not found in first 30 rows — try positional fallback once.
            if (positional) {
              taxIdx = positional.taxIdx;
              headIdx = positional.headIdx;
              headerFound = true;
              logger.warn(
                { sheetId, tab: tab.title },
                "primarySheets: header not detected, using positional fallback",
              );
            }
            if (!headerFound) continue;
          } else {
            // Accept "Taxable Value", "Taxable Amount", or bare "Amount" (FY2023-24).
            // State Head column is optional — sheets that lack it yield headIdx = -1
            // and those rows are skipped in aggregation (no attribution possible).
            const tI = findCol(row, /taxable\s*(value|amount)|^amount$/i);
            if (tI >= 0) {
              taxIdx = tI;
              headIdx = findCol(row, /state\s*head|^head$|^tm\s*(name)?$|^rsm$|^sm$|sales\s*head|^zone$/i);
              // Override: some sheets have the STATE HEAD column but use an
              // unconventional label.  Apply positional override only when the
              // regex found nothing.
              if (headIdx < 0 && HEAD_COL_OVERRIDE[sheetId] !== undefined) {
                headIdx = HEAD_COL_OVERRIDE[sheetId]!;
              }
              // FY YEAR column (e.g. "FY YEAR", "FY-YEAR") exists in State Head Sale
              // workbooks which hold two fiscal years in one file.
              fyYearIdx = findCol(row, /^fy[\s_-]?year$/i);
              if (forBooking) {
                custIdx = findCol(
                  row,
                  /^(customer|party\s*name|firm\s*name|dealer\s*name|distributor\s*name)$/i,
                );
                if (custIdx < 0) custIdx = findCol(row, /customer|party/i);
              }
              // Channel column: explicit header first; positional override for sheets
              // where the column exists in data rows but has no header label; finally
              // fall back to the last non-empty cell in the header row (same heuristic
              // used by readOrderTabInventory so govtValue and ntBooking stay consistent).
              chanIdx = findCol(row, /^(channel|chan|type|sale.?type|category)$/i);
              if (chanIdx < 0) {
                const co = CHANNEL_COL_OVERRIDE[sheetId];
                if (co !== undefined) {
                  chanIdx = co.chanIdx;
                  chanOverrideExplicit = co.explicit;
                } else {
                  for (let ci = row.length - 1; ci >= 0; ci--) {
                    if (strVal(row[ci])) { chanIdx = ci; break; }
                  }
                }
              }
              headerFound = true;
              logger.info(
                { sheetId, tab: tab.title, valueAlias: strVal(row[tI]), valueIdx: tI, headIdx, chanIdx, fyYearIdx },
                "primarySheets: aggregate header detected",
              );
            }
            continue;
          }
        }

        // FY YEAR filter — State Head Sale workbooks hold two fiscal years.
        // Collect distinct values verbatim (before filter) so the log shows what is in the sheet.
        // Format in the sheet: "FY-2025-26".  opts.fyFilter is "2025-26" (no prefix).
        if (fyYearIdx >= 0) {
          const fyYearVal = strVal(row[fyYearIdx]);
          if (fyYearVal) fyYearValues.add(fyYearVal);
          if (opts?.fyFilter && fyYearVal !== `FY-${opts.fyFilter}`) continue;
        }

        const head = headIdx >= 0 ? strVal(row[headIdx]) : "";
        const amt = numVal(row[taxIdx]);
        if (amt <= 0) continue;

        // When headIdx=-1 (no STATE HEAD column in this sheet), fall back to the
        // channel column for institutional/territory split.  FY2023-24 monthly tabs
        // have no STATE HEAD data in rows; SEGMENT (col 20) is the only per-row flag.
        // All rows — including blank-SEGMENT rows — count in total/tabRows.
        // NON_TERRITORY_RE captures Govt / JJM / Project / GEM / Other.
        if (!head) {
          if (chanIdx >= 0) {
            const chan = strVal(row[chanIdx]);
            if (NON_TERRITORY_RE.test(chan)) nonTerritoryTotal += amt;
            // Col-20 sanity: when the channel index came from an explicit override
            // (FY2023-24), every non-blank value must be one of the known SEGMENT
            // labels.  Unexpected values indicate a sheet layout change that may
            // silently mis-classify institutional sales as territory.
            if (chanOverrideExplicit && chan && !EXPECTED_CHAN_RE.test(chan)) {
              unknownChanValues.add(chan);
            }
          }
          total += amt;
          tabRows++;
          continue;
        }

        const hNorm = normHead(head);
        if (NON_TERRITORY_RE.test(hNorm)) {
          ntHeads.add(head);
          nonTerritoryTotal += amt;
          total += amt;
          tabRows++;
          continue;
        }
        if (!hNorm) continue;

        byNormHead.set(hNorm, (byNormHead.get(hNorm) ?? 0) + amt);
        total += amt;
        tabRows++;

        // Distributor-level granularity for the booking sheet.
        if (forBooking && custIdx >= 0) {
          const cust = strVal(row[custIdx]);
          if (cust) {
            const key = cust.toLowerCase().replace(/\s+/g, " ").trim();
            const ex = byDistributor.get(key);
            if (ex) {
              ex.amount += amt;
            } else {
              byDistributor.set(key, {
                displayName: cust,
                stateHeadNorm: hNorm,
                amount: amt,
              });
            }
          }
        }
      }
    });

    // Col-20 sanity: after processing all rows, log any unexpected SEGMENT
    // values encountered when the explicit channel override was active.
    // Unexpected values indicate the sheet layout changed and may cause silent
    // mis-classification of institutional sales as territory.
    if (unknownChanValues.size > 0) {
      logger.error(
        {
          sheetId,
          tab: tab.title,
          unexpectedSegmentValues: [...unknownChanValues].sort(),
          expectedValues: ["Retail", "JJM", "Govt", "Project", "Gem", "(blank)"],
        },
        "primarySheets: unexpected SEGMENT values at explicit chanIdx — review sheet layout",
      );
    }

    logger.info(
      { sheetId, tab: tab.title, tabRows, tabTotal: Math.round(total) },
      "primarySheets: tab processed",
    );
  }

  if (fyYearValues.size > 0) {
    logger.info(
      {
        sheetId,
        fyYearValues: Array.from(fyYearValues).sort(),
        fyFilter: opts?.fyFilter ?? null,
        filtered: !!opts?.fyFilter,
      },
      "primarySheets: FY YEAR values found (filter applied per-row above)",
    );
  }

  if (ntHeads.size > 0) {
    logger.info(
      {
        sheetId,
        forBooking,
        ntHeads: Array.from(ntHeads).sort(),
        ntTotal: Math.round(nonTerritoryTotal),
      },
      "primarySheets: non-territory heads",
    );
  }

  if (total === 0) {
    logger.warn(
      { sheetId, forBooking, dataTabs: dataTabs.map((t) => t.title) },
      "primarySheets: all tabs yielded 0 rows — check sheet structure and column headers",
    );
  }

  return {
    byNormHead,
    byDistributor,
    nonTerritoryTotal,
    total,
    fyYearValues: Array.from(fyYearValues).sort(),
    ntHeads: Array.from(ntHeads).sort(),
  };
}

/**
 * Read a "State Head Sale" workbook that holds two fiscal years and return only
 * the rows matching `fyFilter` (e.g. "2024-25" → rows where FY YEAR = "FY-2024-25").
 * Logs distinct FY YEAR values found before filtering so caller can verify.
 */
export async function readSaleSheetFyFiltered(
  sheetId: string,
  fyFilter: string,
): Promise<{ total: number; fyYearValues: string[]; ntHeads: string[] }> {
  const agg = await readAndAggregate(sheetId, false, { fyFilter });
  return { total: agg.total, fyYearValues: agg.fyYearValues, ntHeads: agg.ntHeads };
}

const _bookingAggCache = new Map<
  string,
  { ts: number; result: { companyTotal: number; ntBooking: number } }
>();

/**
 * Lightweight booking-only aggregate: reads a single booking sheet via
 * readAndAggregate (isBooking=true, HEAD-column NON_TERRITORY_RE detection)
 * and returns companyTotal and ntBooking.  Does NOT read any sale sheet.
 * Results are cached for TTL_MS (30 min) — keyed by sheetId.
 * Used by the booking-vs-sale route so it can run in parallel with
 * readOrderTabInventory without triggering slow sale-sheet reads.
 */
const _bookingAggInFlight = new Map<string, Promise<{ companyTotal: number; ntBooking: number }>>();

export async function readBookingAggregated(
  sheetId: string,
): Promise<{ companyTotal: number; ntBooking: number }> {
  const cached = _bookingAggCache.get(sheetId);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.result;

  const existing = _bookingAggInFlight.get(sheetId);
  if (existing) return existing;

  const p = (async () => {
    const agg = await readAndAggregate(sheetId, true);
    const result = { companyTotal: agg.total, ntBooking: agg.nonTerritoryTotal };
    _bookingAggCache.set(sheetId, { ts: Date.now(), result });
    return result;
  })().finally(() => _bookingAggInFlight.delete(sheetId));
  _bookingAggInFlight.set(sheetId, p);
  return p;
}

// ── Tab inventory ─────────────────────────────────────────────────────────────

const _inventoryCache = new Map<string, { ts: number; rows: OrderTabInventoryRow[] }>();

function classifyOrderTab(
  title: string,
): Pick<OrderTabInventoryRow, "role" | "includedInSum" | "excludedReason"> {
  const t = title.trim();
  if (/^(wt|wt-ltr)$/i.test(t))
    return {
      role: "lookup",
      includedInSum: false,
      excludedReason:
        "Tank-size lookup table — maps item-code suffix to litre capacity (05→500 L, 07→750 L, 10→1000 L, 20→2000 L). Not order data.",
    };
  if (SKIP_TAB_RE.test(t))
    return { role: "lookup", includedInSum: false, excludedReason: "Reference or navigation tab — not order data." };
  if (COMBINED_TAB_RE.test(t))
    return {
      role: "combined",
      includedInSum: false,
      excludedReason: "Summary/combined tab — duplicates individual monthly tabs; excluded to prevent double-counting.",
    };
  if (MONTHLY_RE.test(t)) return { role: "monthly", includedInSum: true, excludedReason: null };
  // Tabs whose title ends with "INDEX" (e.g. "SEGMENT INDEX") are lookup tables.
  // NOT added to SKIP_TAB_RE — kept visible in inventory so a mislabelled data
  // tab cannot silently disappear.
  if (/\bINDEX$/i.test(t))
    return { role: "lookup", includedInSum: false, excludedReason: "Lookup/index tab — not order data." };
  // Per-head tabs look like "ANUJ SHARMA", "BIJU C.O" — mixed-/all-caps with a space.
  if (PER_HEAD_TAB_RE.test(t) && t.includes(" "))
    return {
      role: "per-head",
      includedInSum: false,
      excludedReason: "Per-state-head tab — duplicates monthly data for one head.",
    };
  return { role: "unknown", includedInSum: false, excludedReason: "Unrecognised tab structure — excluded from total." };
}

function parseOrderDate(v: SheetCellValue | undefined): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && v > 40000 && v < 60000) {
    // Excel serial: days since 1900-01-01 (accounts for Lotus bug).
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (!s) return null;
  // DD-MMM-YY (e.g. "01-Mar-24") — used in FY2023-24 order sheets.
  const ddMmmYy = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
  if (ddMmmYy) {
    const year = 2000 + parseInt(ddMmmYy[3], 10);
    const parsed = new Date(`${ddMmmYy[1]} ${ddMmmYy[2]} ${year}`);
    return isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  }
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/**
 * Reads every tab in the given Order Sheet and returns a structured inventory:
 * which tabs are monthly (summed), which are lookup tables (WT, INDEX), which
 * are combined summaries, etc. Monthly tabs are read in full so the inventory
 * includes row count, date range, Taxable Value, unit breakdown (litres vs
 * pieces from the Unit.Name column), and channel breakdown (Retail vs Govt
 * from the last column — the scheme-eligibility flag).
 */
const _inventoryInFlight = new Map<string, Promise<OrderTabInventoryRow[]>>();

export async function readOrderTabInventory(sheetId: string): Promise<OrderTabInventoryRow[]> {
  const cached = _inventoryCache.get(sheetId);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.rows;

  const existing = _inventoryInFlight.get(sheetId);
  if (existing) return existing;

  const p = _readOrderTabInventoryUncached(sheetId).finally(() =>
    _inventoryInFlight.delete(sheetId),
  );
  _inventoryInFlight.set(sheetId, p);
  return p;
}

async function _readOrderTabInventoryUncached(sheetId: string): Promise<OrderTabInventoryRow[]> {
  const tabs = await listSheetTabs(sheetId);
  const rows: OrderTabInventoryRow[] = [];

  // Accumulated during the monthly-tab pass — used to content-verify per-head
  // and combined tabs in the second pass.
  const monthlyByNormHead = new Map<string, number>();
  const monthlyFingerprints = new Set<string>(); // row-level duplicate detection
  let monthlyTotal = 0;
  const verifyPending: OrderTabInventoryRow[] = [];

  // ── First pass: classify every tab; read monthly and unknown tabs ──────────
  for (const tab of tabs) {
    const cls = classifyOrderTab(tab.title.trim());
    const inv: OrderTabInventoryRow = {
      tabName: tab.title.trim(),
      ...cls,
      rowCount: 0,
      dateMin: null,
      dateMax: null,
      taxableValue: 0,
      ltrRows: 0,
      ltrQty: 0,
      pieceRows: 0,
      pieceQty: 0,
      retailValue: 0,
      govtValue: 0,
      contentVerification: null,
    };

    // Only read data rows for monthly tabs (and unknown tabs that might have data).
    // Per-head and combined tabs are read in the second pass (content verification).
    if (inv.role === "monthly" || inv.role === "unknown") {
      let dateIdx = -1, taxIdx = -1, unitIdx = -1, qtyIdx = -1, chanIdx = -1, headIdx = -1, custIdx = -1, codeIdx = -1;
      let headerFound = false;
      let bestCandidateRow: SheetCellValue[] = [];
      let bestCandidateNonEmpty = 0;

      await readTabRowsChunked(sheetId, tab.title, (chunkRows, startRow) => {
        for (let ri = 0; ri < chunkRows.length; ri++) {
          const row = chunkRows[ri];
          const globalRow = startRow + ri;

          if (!headerFound) {
            if (globalRow > 30) continue;
            // Track the row with the most non-empty string cells as a diagnostic aid.
            const nonEmpty = row.filter((c) => strVal(c).trim().length > 0).length;
            if (nonEmpty > bestCandidateNonEmpty) {
              bestCandidateNonEmpty = nonEmpty;
              bestCandidateRow = row;
            }
            const tI = findCol(row, /taxable\s*(value|amount)|^amount$/i);
            if (tI >= 0) {
              // Header row found.  State Head column is optional.
              taxIdx  = tI;
              headIdx = findCol(row, /state\s*head|^head$|^tm\s*(name)?$|^rsm$|^sm$|sales\s*head|^zone$/i);
              // Override: apply positional fallback only when the regex found nothing.
              if (headIdx < 0 && HEAD_COL_OVERRIDE[sheetId] !== undefined) {
                headIdx = HEAD_COL_OVERRIDE[sheetId]!;
              }
              dateIdx = findCol(row, /^(date|order.?date|invoice.?date)$/i);
              unitIdx = findCol(row, /^(unit(\.name| name)?|uom|measure)$/i);
              qtyIdx  = findCol(row, /^(qty|quantity|qnty|pieces?)$/i);
              custIdx = findCol(row, /^(customer|party[\s_]*name?|firm\s*name|dealer\s*name|distributor\s*name)$/i);
              if (custIdx < 0) custIdx = findCol(row, /customer|party/i);
              codeIdx = findCol(row, /^(item[\s_]*code|code|product[\s_]*code|sku|material[\s_]*code)$/i);
              // Channel flag: look for explicit header; fallback to last non-empty cell.
              chanIdx = findCol(row, /^(channel|chan|type|sale.?type|category)$/i);
              if (chanIdx < 0) {
                // Positional override before last-non-empty fallback — the fallback
                // picks the last header cell ('Month', 'FY', etc.) which is not a
                // channel flag.  CHANNEL_COL_OVERRIDE maps the actual data column.
                const co = CHANNEL_COL_OVERRIDE[sheetId];
                if (co !== undefined) {
                  chanIdx = co.chanIdx;
                } else {
                  for (let ci = row.length - 1; ci >= 0; ci--) {
                    if (strVal(row[ci])) { chanIdx = ci; break; }
                  }
                }
              }
              logger.info(
                { sheetId, tab: tab.title, valueAlias: strVal(row[tI]), valueIdx: tI, headIdx, chanIdx, dateIdx, unitIdx },
                "primarySheets: inventory header detected",
              );
              headerFound = true;
              continue; // skip the header row itself
            }
            continue; // not a header row — skip until header is found
          }

          const amt = numVal(row[taxIdx]);
          if (amt <= 0) continue; // blank or subtotal rows

          inv.rowCount++;
          inv.taxableValue += amt;
          monthlyTotal += amt;

          // Track STATE HEAD sums and build row fingerprints for per-head verification.
          if (headIdx >= 0) {
            const hNorm = normHead(strVal(row[headIdx]));
            if (hNorm) monthlyByNormHead.set(hNorm, (monthlyByNormHead.get(hNorm) ?? 0) + amt);
          }
          // Store all four (customer × code) variants so that per-head/combined
          // tabs whose column layout differs from monthly tabs can still match.
          for (const fp of rowFingerprintVariants(
            dateIdx >= 0 ? parseOrderDate(row[dateIdx]) : null,
            custIdx >= 0 ? strVal(row[custIdx]) : "",
            codeIdx >= 0 ? strVal(row[codeIdx]) : "",
            qtyIdx  >= 0 ? numVal(row[qtyIdx]) : 0,
            amt,
          )) {
            monthlyFingerprints.add(fp);
          }

          const d = parseOrderDate(dateIdx >= 0 ? row[dateIdx] : undefined);
          if (d) {
            if (!inv.dateMin || d < inv.dateMin) inv.dateMin = d;
            if (!inv.dateMax || d > inv.dateMax) inv.dateMax = d;
          }

          // Litre Rule: Unit.Name = "Ltr." → water-tank order (litres); else pieces.
          // NEVER add ltrQty and pieceQty together — different units.
          const unit = unitIdx >= 0 ? strVal(row[unitIdx]) : "";
          const qty  = qtyIdx  >= 0 ? numVal(row[qtyIdx]) : 0;
          if (/^ltr\.?$/i.test(unit)) {
            inv.ltrRows++;
            inv.ltrQty += qty;
          } else {
            inv.pieceRows++;
            inv.pieceQty += qty;
          }

          // Scheme eligibility: institutional rows → schemes do not apply.
          // NON_TERRITORY_RE (Govt/JJM/Project/GEM/Other) → govtValue (institutional).
          // All others including blank → retailValue.
          const chan = chanIdx >= 0 ? strVal(row[chanIdx]) : "";
          if (NON_TERRITORY_RE.test(chan)) inv.govtValue += amt;
          else inv.retailValue += amt;
        }
      });

      if (!headerFound && inv.role === "monthly") {
        logger.warn(
          {
            sheetId,
            tab: tab.title,
            bestCandidateHeaders: bestCandidateRow.map(strVal).filter(Boolean),
          },
          "primarySheets inventory: header not found in monthly tab",
        );
      }
    } else if (inv.role === "per-head" || inv.role === "combined") {
      // Defer content verification until after all monthly tabs are read.
      verifyPending.push(inv);
    }

    rows.push(inv);
  }

  // ── Second pass: content-verify per-head and combined tabs ────────────────
  // For each candidate tab, read its own Taxable Value total and compare to
  // the corresponding monthly-tab aggregate.  A match within ₹1 confirms it
  // is a safe duplicate; a larger gap flags it for manual review.
  for (const inv of verifyPending) {
    let tabTaxIdx = -1, tabCustIdx = -1, tabCodeIdx = -1, tabQtyIdx = -1, tabDateIdx = -1;
    let tabHeaderFound = false;
    let tabTotal = 0, tabRows = 0, inMonthlyRows = 0, uniqueRows = 0, uniqueAmount = 0;
    let readFailed = false;

    try {
      await readTabRowsChunked(sheetId, inv.tabName, (chunkRows, startRow) => {
        for (let ri = 0; ri < chunkRows.length; ri++) {
          const row = chunkRows[ri];
          const globalRow = startRow + ri;
          if (!tabHeaderFound) {
            if (globalRow > 30) continue;
            const tI = findCol(row, /taxable\s*(value|amount)|^amount$/i);
            if (tI >= 0) {
              tabTaxIdx  = tI;
              tabDateIdx = findCol(row, /^(date|order.?date|invoice.?date)$/i);
              tabQtyIdx  = findCol(row, /^(qty|quantity|qnty|pieces?)$/i);
              tabCustIdx = findCol(row, /^(customer|party[\s_]*name?|firm\s*name|dealer\s*name|distributor\s*name)$/i);
              if (tabCustIdx < 0) tabCustIdx = findCol(row, /customer|party/i);
              tabCodeIdx = findCol(row, /^(item[\s_]*code|code|product[\s_]*code|sku|material[\s_]*code)$/i);
              tabHeaderFound = true;
            }
            continue;
          }
          const amt = numVal(row[tabTaxIdx]);
          if (amt <= 0) continue;
          tabRows++;
          tabTotal += amt;
          // Check all fingerprint variants — if any matches a monthly fingerprint
          // the row is accounted for regardless of which columns each tab exposes.
          const matched = rowFingerprintVariants(
            tabDateIdx >= 0 ? parseOrderDate(row[tabDateIdx]) : null,
            tabCustIdx >= 0 ? strVal(row[tabCustIdx]) : "",
            tabCodeIdx >= 0 ? strVal(row[tabCodeIdx]) : "",
            tabQtyIdx  >= 0 ? numVal(row[tabQtyIdx]) : 0,
            amt,
          ).some((fp) => monthlyFingerprints.has(fp));
          if (matched) {
            inMonthlyRows++;
          } else {
            uniqueRows++;
            uniqueAmount += amt;
          }
        }
      });
    } catch (err) {
      readFailed = true;
      logger.warn({ sheetId, tab: inv.tabName, err }, "primarySheets: content-verify read failed");
    }

    if (readFailed || !tabHeaderFound) {
      inv.contentVerification = {
        status: "unreadable",
        tabRows: 0, inMonthlyRows: 0, uniqueRows: 0, uniqueAmount: 0,
        tabTotal: 0, monthlyEquivalent: 0,
      };
      inv.excludedReason = (inv.excludedReason ?? "") + " (content-verification: tab could not be read)";
      continue;
    }

    const monthlyEquivalent =
      inv.role === "combined"
        ? monthlyTotal
        : (monthlyByNormHead.get(normHead(inv.tabName) ?? "") ?? 0);

    inv.contentVerification = {
      status: uniqueRows === 0 ? "confirmed-subset" : "has-unique-rows",
      tabRows,
      inMonthlyRows,
      uniqueRows,
      uniqueAmount: Math.round(uniqueAmount),
      tabTotal: Math.round(tabTotal),
      monthlyEquivalent: Math.round(monthlyEquivalent),
    };

    if (uniqueRows === 0) {
      inv.excludedReason =
        `All ${tabRows} tab rows confirmed in monthly tabs (row fingerprint match) — safe to exclude.`;
    } else {
      inv.excludedReason =
        `WARNING: ${uniqueRows} of ${tabRows} tab rows` +
        ` (₹${(uniqueAmount / 1e7).toFixed(2)} Cr)` +
        ` not found in any monthly tab — exclusion would drop those rows.`;
    }
  }

  const includedTotal = rows.filter((r) => r.includedInSum).reduce((s, r) => s + r.taxableValue, 0);
  logger.info(
    {
      sheetId,
      includedTotal: Math.round(includedTotal),
      tabs: rows.map((r) => ({
        tab: r.tabName,
        role: r.role,
        included: r.includedInSum,
        rows: r.rowCount,
        tv: Math.round(r.taxableValue),
        ltrRows: r.ltrRows,
        pieceRows: r.pieceRows,
        retailValue: Math.round(r.retailValue),
        govtValue: Math.round(r.govtValue),
        dateMin: r.dateMin,
        dateMax: r.dateMax,
        cv: r.contentVerification?.status ?? null,
      })),
    },
    "primarySheets: tab inventory complete",
  );

  _inventoryCache.set(sheetId, { ts: Date.now(), rows });
  return rows;
}

// ── Public loader ─────────────────────────────────────────────────────────────

// Single-flight: concurrent callers share one in-flight load per FY (a
// cold-start stampede of parallel multi-tab reads exhausts the Sheets
// per-minute read quota → 429s in production).
const _inFlight = new Map<string, Promise<PrimarySheetData>>();

export async function loadPrimarySheetData(fy: string): Promise<PrimarySheetData> {
  const cached = _cache.get(fy);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

  const existing = _inFlight.get(fy);
  if (existing) return existing;

  const p = _loadPrimarySheetDataUncached(fy).finally(() => _inFlight.delete(fy));
  _inFlight.set(fy, p);
  return p;
}

async function _loadPrimarySheetDataUncached(fy: string): Promise<PrimarySheetData> {
  // Build head resolver from roster (best-effort).
  let resolve: (raw: unknown) => string | null;
  try {
    const roster = await loadRoster();
    const canonicalHeads = new Set(
      roster.members.map((m) => m.stateHead).filter((h) => h && h.trim() !== ""),
    );
    resolve = buildHeadResolver(canonicalHeads);
  } catch {
    resolve = (raw) => (normHead(raw) ? normHead(raw) : null);
  }

  const bookingSheetId = BOOKING_SHEETS[fy];
  const saleSheetId = SALE_SHEETS[fy];

  let bookingAgg: SheetAgg = {
    byNormHead: new Map(),
    byDistributor: new Map(),
    nonTerritoryTotal: 0,
    total: 0,
    fyYearValues: [],
    ntHeads: [],
  };
  let saleAgg: SheetAgg = {
    byNormHead: new Map(),
    byDistributor: new Map(),
    nonTerritoryTotal: 0,
    total: 0,
    fyYearValues: [],
    ntHeads: [],
  };
  let bookingAvailable = false;
  let saleAvailable = false;
  let tabInventory: OrderTabInventoryRow[] | null = null;

  if (bookingSheetId) {
    try {
      // Run the financial aggregation and the tab inventory in parallel —
      // both read the same sheet but accumulate different metrics.
      const [agg, inv] = await Promise.all([
        readAndAggregate(bookingSheetId, true),
        readOrderTabInventory(bookingSheetId).catch((err) => {
          logger.warn({ err, fy }, "primarySheets: tab inventory failed (non-fatal)");
          return null;
        }),
      ]);
      bookingAgg = agg;
      tabInventory = inv;

      // Per-head tabs with genuinely unique rows (not found in any monthly tab)
      // are excluded from readAndAggregate's sum.  Add their unique amounts here
      // so the booking total captures data that never made it into monthly tabs.
      if (tabInventory) {
        for (const tab of tabInventory) {
          const cv = tab.contentVerification;
          if (cv?.status === "has-unique-rows" && cv.uniqueAmount > 0) {
            bookingAgg.total += cv.uniqueAmount;
            if (tab.role === "per-head") {
              const hNorm = normHead(tab.tabName);
              if (hNorm) {
                bookingAgg.byNormHead.set(
                  hNorm,
                  (bookingAgg.byNormHead.get(hNorm) ?? 0) + cv.uniqueAmount,
                );
              }
            }
            logger.info(
              { tab: tab.tabName, uniqueRows: cv.uniqueRows, uniqueAmount: cv.uniqueAmount },
              "primarySheets: unique rows from per-head tab added to booking total",
            );
          }
        }
      }

      bookingAvailable = bookingAgg.total > 0;
      logger.info(
        { fy, total: bookingAgg.total, heads: bookingAgg.byNormHead.size },
        "primarySheets: booking loaded",
      );
    } catch (err) {
      logger.warn({ err, fy }, "primarySheets: booking load failed");
    }
  }

  if (saleSheetId) {
    try {
      // Pass fyFilter so multi-year "State Head Sale" workbooks are scoped
      // to the requested FY only.  Format: "FY-2025-26" in the sheet.
      saleAgg = await readAndAggregate(saleSheetId, false, { fyFilter: fy });
      saleAvailable = saleAgg.total > 0;
      logger.info(
        { fy, total: saleAgg.total, heads: saleAgg.byNormHead.size },
        "primarySheets: sale loaded",
      );
    } catch (err) {
      logger.warn({ err, fy }, "primarySheets: sale load failed");
    }
  }

  // Merge head entries from both aggregations into display-name keyed map.
  const allKeys = new Set([
    ...bookingAgg.byNormHead.keys(),
    ...saleAgg.byNormHead.keys(),
  ]);
  const headDisplayMap = new Map<string, { booking: number; sale: number }>();

  for (const key of allKeys) {
    const display = resolve(key) ?? key;
    const ex = headDisplayMap.get(display) ?? { booking: 0, sale: 0 };
    ex.booking += bookingAgg.byNormHead.get(key) ?? 0;
    ex.sale += saleAgg.byNormHead.get(key) ?? 0;
    headDisplayMap.set(display, ex);
  }

  // Non-territory bucket.
  const ntBooking = bookingAgg.nonTerritoryTotal;
  const ntSale = saleAgg.nonTerritoryTotal;
  if (ntBooking > 0 || ntSale > 0) {
    const ex = headDisplayMap.get("Non-territory") ?? { booking: 0, sale: 0 };
    ex.booking += ntBooking;
    ex.sale += ntSale;
    headDisplayMap.set("Non-territory", ex);
  }

  const byHead: PrimaryHeadRow[] = Array.from(headDisplayMap.entries())
    .map(([head, { booking, sale }]) => ({
      head,
      booking,
      sale,
      pending: Math.max(0, booking - sale),
    }))
    .sort((a, b) => b.booking - a.booking);

  // Distributor rows — resolve state head to display name.
  const byDistributor: PrimaryDistributorRow[] = Array.from(
    bookingAgg.byDistributor.values(),
  )
    .map(({ displayName, stateHeadNorm, amount }) => ({
      name: displayName,
      stateHead: resolve(stateHeadNorm) ?? stateHeadNorm,
      booking: amount,
    }))
    .sort((a, b) => b.booking - a.booking)
    .slice(0, 300); // cap payload size

  const data: PrimarySheetData = {
    fy,
    companyBooking: bookingAgg.total,
    ntBooking: bookingAgg.nonTerritoryTotal,
    companySale: saleAgg.total,
    companyPending: Math.max(0, bookingAgg.total - saleAgg.total),
    byHead,
    byDistributor,
    sources: {
      booking: bookingAvailable ? `Order Sheet ${fy}` : null,
      sale: saleAvailable ? `Sale Sheet ${fy}` : null,
    },
    bookingAvailable,
    saleAvailable,
    tabInventory,
  };

  _cache.set(fy, { ts: Date.now(), data });
  return data;
}

// ── Order Booking Ingest ──────────────────────────────────────────────────────

export type IngestOrderBookingResult = {
  fy: string;
  dryRun: boolean;
  tabsRead: string[];
  rowsEmitted: number;
  inserted: number;
  errors: string[];
};

const _MONTH_ABBR = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];

/** "YYYY-MM-DD" → "Mon-YY" (e.g. "2026-04-15" → "Apr-26"). */
function _isoToMonthLabel(isoDate: string): string | null {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(isoDate);
  if (!m) return null;
  const yy  = Number(m[1]) % 100;
  const mon = Number(m[2]) - 1;
  if (mon < 0 || mon > 11) return null;
  return `${_MONTH_ABBR[mon]}-${String(yy).padStart(2, "0")}`;
}

/**
 * Derive month label from a tab title + FY string.
 * "Apr" in FY "2026-27" → "Apr-26";  "Jan" in FY "2026-27" → "Jan-27".
 * Apr–Dec use the first calendar year; Jan–Mar use the second.
 */
function _tabToMonthLabel(tabTitle: string, fy: string): string | null {
  const fyM = /^(\d{4})-(\d{2})$/.exec(fy);
  if (!fyM) return null;
  const yr1 = Number(fyM[1]) % 100; // e.g. 26
  const yr2 = Number(fyM[2]);        // e.g. 27
  const norm = tabTitle.trim().toLowerCase();
  for (let i = 0; i < _MONTH_ABBR.length; i++) {
    if (norm.startsWith(_MONTH_ABBR[i].toLowerCase())) {
      const yy = i >= 3 ? yr1 : yr2; // Apr(3)…Dec(11) → yr1; Jan(0)…Mar(2) → yr2
      return `${_MONTH_ABBR[i]}-${String(yy).padStart(2, "0")}`;
    }
  }
  return null;
}

function _orderLineUid(
  fy: string,
  sourceTab: string,
  customer: string,
  code: string,
  qty: string,
  tv: string,
  occurrence: number,
): string {
  const key = [fy, sourceTab, customer, code, qty, tv].join("|");
  return createHash("sha1").update(`${key}|${occurrence}`).digest("hex");
}

const _INGEST_BATCH = 500;

/**
 * Pure reconciliation helper for replace-mode ingest: given the distinct
 * source_tab values currently in the DB mirror and the monthly tabs that were
 * successfully read (and replaced) from the sheet, return the tabs whose mirror
 * rows are orphaned — i.e. the tab was deleted or renamed in the sheet.
 * Comparison is on trimmed titles (both sides are stored trimmed).
 */
export function computeOrphanTabs(
  existingTabs: string[],
  replacedTabs: string[],
): string[] {
  const kept = new Set(replacedTabs.map((t) => t.trim()));
  return existingTabs.map((t) => t.trim()).filter((t) => !kept.has(t));
}

/**
 * Read all monthly tabs from BOOKING_SHEETS[fy] and upsert rows into
 * primary_order_line (ON CONFLICT (line_uid) DO NOTHING — fully idempotent).
 *
 * Only monthly tabs are inserted in this initial pipeline.  Per-head tabs
 * with unique rows (e.g. ANUJ SHARMA) are skipped and counted in errors[].
 *
 * isTerritory logic:
 *  1. Explicit channel column present AND cell value matches /^(retail|govt)$/i
 *     → isTerritory = (channel !== "Govt").
 *  2. No explicit channel column → HEAD column vs NON_TERRITORY_RE.
 *  3. Neither available → null.
 */
export async function ingestOrderBookingFy(
  fy: string,
  opts: { dryRun?: boolean; replace?: boolean } = {},
): Promise<IngestOrderBookingResult> {
  const { dryRun = false, replace = false } = opts;
  const sheetId = BOOKING_SHEETS[fy];
  if (!sheetId) {
    return {
      fy, dryRun,
      tabsRead: [],
      rowsEmitted: 0,
      inserted: 0,
      errors: [`No BOOKING_SHEETS entry for FY ${fy}`],
    };
  }

  const errors: string[] = [];
  const tabsRead: string[] = [];
  const replacedTabs: string[] = [];
  let totalEmitted = 0;
  let totalInserted = 0;

  const tabs = await listSheetTabs(sheetId);

  for (const tab of tabs) {
    const cls = classifyOrderTab(tab.title.trim());
    if (cls.role !== "monthly") continue;

    const occCounts = new Map<string, number>();
    const nextOcc = (key: string): number => {
      const n = occCounts.get(key) ?? 0;
      occCounts.set(key, n + 1);
      return n;
    };

    let dateIdx = -1, taxIdx = -1, unitIdx = -1, qtyIdx = -1;
    let chanIdx = -1, chanIsExplicit = false;
    let headIdx = -1, custIdx = -1, codeIdx = -1;
    let headerFound = false;
    const tabRows: InsertPrimaryOrderLine[] = [];

    try {
      await readTabRowsChunked(sheetId, tab.title, (chunkRows, startRow) => {
        for (let ri = 0; ri < chunkRows.length; ri++) {
          const row = chunkRows[ri];
          const globalRow = startRow + ri;

          if (!headerFound) {
            if (globalRow > 30) continue;
            const tI = findCol(row, /taxable\s*(value|amount)|^amount$/i);
            if (tI < 0) continue;

            taxIdx  = tI;
            headIdx = findCol(row, /state\s*head|^head$|^tm\s*(name)?$|^rsm$|^sm$|sales\s*head|^zone$/i);
            // Override: apply positional fallback only when the regex found nothing.
            if (headIdx < 0 && HEAD_COL_OVERRIDE[sheetId] !== undefined) {
              headIdx = HEAD_COL_OVERRIDE[sheetId]!;
            }
            dateIdx = findCol(row, /^(date|order.?date|invoice.?date)$/i);
            unitIdx = findCol(row, /^(unit(\.name| name)?|uom|measure)$/i);
            qtyIdx  = findCol(row, /^(qty|quantity|qnty|pieces?)$/i);
            custIdx = findCol(row, /^(customer|party[\s_]*name?|firm\s*name|dealer\s*name|distributor\s*name)$/i);
            if (custIdx < 0) custIdx = findCol(row, /customer|party/i);
            codeIdx = findCol(row, /^(item[\s_]*code|code|product[\s_]*code|sku|material[\s_]*code)$/i);

            const eChan = findCol(row, /^(channel|chan|type|sale.?type|category)$/i);
            chanIsExplicit = eChan >= 0;
            if (eChan >= 0) {
              chanIdx = eChan;
            } else {
              // Positional override before last-non-empty fallback — the header fallback
              // would land on a non-channel label ('Month', 'FY', etc.).
              const co = CHANNEL_COL_OVERRIDE[sheetId];
              if (co !== undefined) {
                chanIdx = co.chanIdx;
                chanIsExplicit = co.explicit;
              } else {
                chanIdx = -1;
                for (let ci = row.length - 1; ci >= 0; ci--) {
                  if (strVal(row[ci])) { chanIdx = ci; break; }
                }
              }
            }
            headerFound = true;
            continue;
          }

          const tv = numVal(row[taxIdx]);
          if (tv <= 0) continue;

          // Date & month label
          const dateStr   = dateIdx >= 0 ? parseOrderDate(row[dateIdx]) : null;
          const monthLabel = dateStr
            ? _isoToMonthLabel(dateStr)
            : _tabToMonthLabel(tab.title.trim(), fy);

          // Fields
          const customer = custIdx >= 0 ? strVal(row[custIdx]) : "";
          const code     = codeIdx >= 0 ? strVal(row[codeIdx]) : "";
          const rawQtyN  = qtyIdx  >= 0 ? numVal(row[qtyIdx]) : 0;
          const unit     = unitIdx >= 0 ? strVal(row[unitIdx]) : "";
          const qtyUnit  = /^ltr\.?$/i.test(unit) ? "Ltr" : "Pcs";
          const headRaw  = headIdx >= 0 ? strVal(row[headIdx]) || null : null;
          const headCanon = headRaw ? normHead(headRaw) || null : null;

          // isTerritory
          // Priority: explicit channel column > HEAD-column NON_TERRITORY_RE > null.
          //
          // When chanIsExplicit=true (header name matched channel/type/etc. OR
          // CHANNEL_COL_OVERRIDE explicit=true):
          //   NON_TERRITORY_RE match (Govt/JJM/Project/GEM/Other) → institutional (false).
          //   Non-empty, non-institutional AND cv is non-blank → territory (true).
          //   Blank cv → null (unknown; cv guard prevents blank→territory promotion).
          //
          // When chanIsExplicit=false (fallback = last non-empty column):
          //   Can't trust the cell value as a channel flag → use HEAD column.
          let chanRaw: string | null = null;
          let isTerritory: boolean | null = null;
          if (chanIdx >= 0) {
            const cv = strVal(row[chanIdx]);
            if (NON_TERRITORY_RE.test(cv)) {
              chanRaw = cv;
              isTerritory = false;
            } else if (cv && chanIsExplicit) {
              // Explicit channel column, non-empty, non-institutional → territory.
              // cv guard: blank channel cell stays null rather than silently becoming territory.
              chanRaw = cv;
              isTerritory = true;
            } else if (headIdx >= 0 && headRaw) {
              // Fallback channel (last-col heuristic) — use HEAD column instead.
              const hNorm = normHead(headRaw);
              if (hNorm) isTerritory = !NON_TERRITORY_RE.test(hNorm);
            }
          }
          // HEAD-column fallback when no channel detection fired at all.
          if (isTerritory === null && headIdx >= 0 && headRaw) {
            const hNorm = normHead(headRaw);
            if (hNorm) isTerritory = !NON_TERRITORY_RE.test(hNorm);
          }

          const tvStr  = String(tv);
          const qtyStr = rawQtyN ? String(rawQtyN) : "";
          const occKey = [customer, code, qtyStr, tvStr].join("|");
          const uid    = _orderLineUid(
            fy, tab.title.trim(), customer, code, qtyStr, tvStr, nextOcc(occKey),
          );

          tabRows.push({
            lineUid:      uid,
            fy,
            invoiceDate:  dateStr,
            monthLabel,
            customer:     customer || null,
            code:         code || null,
            qty:          rawQtyN ? String(rawQtyN) : null,
            qtyUnit,
            taxableValue: String(tv),
            headRaw,
            headCanon,
            isTerritory,
            channel:      chanRaw,
            sourceTab:    tab.title.trim(),
            sheetId,
          });
        }
      });

      // In replace mode an EMPTY monthly tab still counts: its stale mirror rows
      // must be deleted. In append mode empty tabs are simply skipped.
      if (tabRows.length > 0 || replace) {
        tabsRead.push(tab.title.trim());
        totalEmitted += tabRows.length;
        replacedTabs.push(tab.title.trim());

        if (!dryRun) {
          if (replace) {
            // Full-replace per tab: delete the tab's existing mirror rows and
            // re-insert fresh from the sheet, atomically. This is the only way
            // rows deleted/edited in the sheet ever leave the DB mirror
            // (ON CONFLICT DO NOTHING alone can only add rows, never remove).
            await db.transaction(async (tx) => {
              await tx
                .delete(primaryOrderLines)
                .where(
                  and(
                    eq(primaryOrderLines.fy, fy),
                    eq(primaryOrderLines.sourceTab, tab.title.trim()),
                  ),
                );
              for (let i = 0; i < tabRows.length; i += _INGEST_BATCH) {
                const slice = tabRows.slice(i, i + _INGEST_BATCH);
                const res = await tx
                  .insert(primaryOrderLines)
                  .values(slice)
                  .onConflictDoNothing()
                  .returning({ uid: primaryOrderLines.lineUid });
                totalInserted += res.length;
              }
            });
          } else {
            for (let i = 0; i < tabRows.length; i += _INGEST_BATCH) {
              const slice = tabRows.slice(i, i + _INGEST_BATCH);
              const res = await db
                .insert(primaryOrderLines)
                .values(slice)
                .onConflictDoNothing()
                .returning({ uid: primaryOrderLines.lineUid });
              totalInserted += res.length;
            }
          }
        }

        logger.info(
          { fy, tab: tab.title.trim(), rows: tabRows.length, dryRun, replace },
          "ingestOrderBookingFy: tab done",
        );
      }
    } catch (err) {
      const msg = `Tab "${tab.title}": ${String(err)}`;
      errors.push(msg);
      logger.warn({ err, fy, tab: tab.title }, "ingestOrderBookingFy: tab error");
    }
  }

  // Orphan-tab reconciliation (replace mode only): mirror rows whose source_tab
  // no longer exists in the sheet (tab deleted or renamed) must be removed, or
  // they linger forever. Only safe when every monthly tab was read without error
  // — a transient read failure must never cascade into deleting a month.
  if (replace && !dryRun) {
    if (errors.length > 0) {
      logger.warn(
        { fy, errors: errors.length },
        "ingestOrderBookingFy: skipping orphan-tab cleanup — some tabs failed to read",
      );
    } else {
      const existing = await db
        .selectDistinct({ sourceTab: primaryOrderLines.sourceTab })
        .from(primaryOrderLines)
        .where(eq(primaryOrderLines.fy, fy));
      const orphans = computeOrphanTabs(
        existing.map((r) => r.sourceTab),
        replacedTabs,
      );
      for (const orphan of orphans) {
        await db
          .delete(primaryOrderLines)
          .where(
            and(eq(primaryOrderLines.fy, fy), eq(primaryOrderLines.sourceTab, orphan)),
          );
        logger.warn(
          { fy, orphanTab: orphan },
          "ingestOrderBookingFy: deleted mirror rows for tab no longer in sheet",
        );
      }
    }
  }

  logger.info(
    { fy, tabsRead, totalEmitted, totalInserted, dryRun, errors: errors.length },
    "ingestOrderBookingFy: complete",
  );
  return {
    fy,
    dryRun,
    tabsRead,
    rowsEmitted: totalEmitted,
    inserted: dryRun ? 0 : totalInserted,
    errors,
  };
}
