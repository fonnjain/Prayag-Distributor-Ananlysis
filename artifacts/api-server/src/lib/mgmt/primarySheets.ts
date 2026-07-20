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
import {
  listSheetTabs,
  readTabRowsChunked,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import { normHead, buildHeadResolver } from "./names.js";
import { loadRoster } from "./roster.js";
import { logger } from "../logger.js";

export const BOOKING_SHEETS: Record<string, string> = {
  "2026-27": "1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A",
};

export const SALE_SHEETS: Record<string, string> = {
  // FY2026-27: "SALE SHEET 26-27" — monthly tabs Apr/May/Jun/July.
  // Columns: A=serial B=invoice C=date D=bill-from E=customer F=city G=dest
  //          H=code I=colour J=qty K=MRP L=rate M=TAXABLE VALUE N=group
  //          O=station P=state Q=STATE HEAD R=month
  "2026-27": "19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps",
  "2025-26": "1RuXHIXfusOT-VDdDqeuB-Nx-pxyVkmrJsqr21BB-NUA",
};

// Positional fallback column indices for the FY2026-27 sale sheet when
// header detection fails (0-based: M=12, Q=16).
const SALE_POSITIONAL: Record<string, { taxIdx: number; headIdx: number }> = {
  "19LQGpkbZiecGaXdBvl48rPZT2LUz3sKekeKX5fHu7Ps": { taxIdx: 12, headIdx: 16 },
};

const NON_TERRITORY_RE = /^(other|project|govt|gem|jjm|nonterrit)/i;
// Tabs that are reference/lookup tables or navigation aids — never contain order rows.
// INDEX = product-group lookup.
// WT / WT-LTR = tank-size lookup table (maps last two digits of item code to
//   litre capacity: 05→500 L, 07→750 L, 10→1000 L, 20→2000 L).
//   The user confirmed: "It is the tank-size lookup table, not order data."
const SKIP_TAB_RE =
  /^(instruction|change.?log|legend|notes?|readme|cover|summary|index|template|wt|wt-ltr)$/i;
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
 * Result of comparing a per-head or combined tab's own content against the
 * monthly-tab aggregate it is expected to duplicate.
 *
 * status:
 *   "confirmed-duplicate" — tab total matches monthly aggregate within ₹1 (safe to exclude)
 *   "content-differs"     — gap detected; tab may contain unique rows — review before excluding
 *   "unreadable"          — header detection failed or Sheets API error
 *   null                  — not applicable (monthly / lookup / unknown roles are not verified)
 */
export type TabContentVerification = {
  status: "confirmed-duplicate" | "content-differs" | "unreadable";
  /** Monthly-tab aggregate for this head (per-head) or all monthly tabs (combined). */
  monthlyEquivalent: number;
  /** Total Taxable Value found by reading this tab's own content. */
  tabTotal: number;
  /** tabTotal − monthlyEquivalent (positive = tab has MORE than monthly). */
  diffAmount: number;
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

type SheetAgg = {
  byNormHead: Map<string, number>;
  byDistributor: Map<string, { displayName: string; stateHeadNorm: string; amount: number }>;
  nonTerritoryTotal: number;
  total: number;
};

async function readAndAggregate(
  sheetId: string,
  forBooking: boolean,
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

  for (const tab of dataTabs) {
    let taxIdx = -1,
      headIdx = -1,
      custIdx = -1;
    let headerFound = false;
    let tabRows = 0;

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
            // Accept "Taxable Value" or "Taxable Amount" (case-insensitive).
            const tI = findCol(row, /taxable\s*(value|amount)/i);
            const hI = findCol(row, /state\s*head/i);
            if (tI >= 0 && hI >= 0) {
              taxIdx = tI;
              headIdx = hI;
              if (forBooking) {
                custIdx = findCol(
                  row,
                  /^(customer|party\s*name|firm\s*name|dealer\s*name|distributor\s*name)$/i,
                );
                if (custIdx < 0) custIdx = findCol(row, /customer|party/i);
              }
              headerFound = true;
            }
            continue;
          }
        }

        const head = strVal(row[headIdx]);
        const amt = numVal(row[taxIdx]);
        if (!head || amt <= 0) continue;

        const hNorm = normHead(head);
        if (NON_TERRITORY_RE.test(hNorm)) {
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

    logger.info(
      { sheetId, tab: tab.title, tabRows, tabTotal: Math.round(total) },
      "primarySheets: tab processed",
    );
  }

  if (total === 0) {
    logger.warn(
      { sheetId, forBooking, dataTabs: dataTabs.map((t) => t.title) },
      "primarySheets: all tabs yielded 0 rows — check sheet structure and column headers",
    );
  }

  return { byNormHead, byDistributor, nonTerritoryTotal, total };
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
export async function readOrderTabInventory(sheetId: string): Promise<OrderTabInventoryRow[]> {
  const cached = _inventoryCache.get(sheetId);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.rows;

  const tabs = await listSheetTabs(sheetId);
  const rows: OrderTabInventoryRow[] = [];

  // Accumulated during the monthly-tab pass — used to content-verify per-head
  // and combined tabs in the second pass.
  const monthlyByNormHead = new Map<string, number>();
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
      let dateIdx = -1, taxIdx = -1, unitIdx = -1, qtyIdx = -1, chanIdx = -1, headIdx = -1;
      let headerFound = false;

      await readTabRowsChunked(sheetId, tab.title, (chunkRows, startRow) => {
        for (let ri = 0; ri < chunkRows.length; ri++) {
          const row = chunkRows[ri];
          const globalRow = startRow + ri;

          if (!headerFound) {
            if (globalRow > 30) continue;
            const tI = findCol(row, /taxable\s*(value|amount)/i);
            const hI = findCol(row, /state\s*head/i);
            if (tI >= 0 && hI >= 0) {
              taxIdx  = tI;
              headIdx = hI;
              dateIdx = findCol(row, /^(date|order.?date|invoice.?date)$/i);
              unitIdx = findCol(row, /^(unit\.?name|unit\s+name|uom|measure)$/i);
              qtyIdx  = findCol(row, /^(qty|quantity|qnty|pieces?)$/i);
              // Channel flag: look for explicit header; fallback to last non-empty cell.
              chanIdx = findCol(row, /^(channel|chan|type|sale.?type|category)$/i);
              if (chanIdx < 0) {
                for (let ci = row.length - 1; ci >= 0; ci--) {
                  if (strVal(row[ci])) { chanIdx = ci; break; }
                }
              }
              headerFound = true;
            }
            continue;
          }

          const amt = numVal(row[taxIdx]);
          if (amt <= 0) continue; // blank or subtotal rows

          inv.rowCount++;
          inv.taxableValue += amt;
          monthlyTotal += amt;

          // Track STATE HEAD sums for per-head content verification.
          if (headIdx >= 0) {
            const hNorm = normHead(strVal(row[headIdx]));
            if (hNorm) monthlyByNormHead.set(hNorm, (monthlyByNormHead.get(hNorm) ?? 0) + amt);
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

          // Scheme eligibility: "Retail" rows → scheme-eligible.
          // "Govt" rows → schemes do not apply. Blank → treated as retail.
          const chan = chanIdx >= 0 ? strVal(row[chanIdx]) : "";
          if (/^govt$/i.test(chan)) inv.govtValue += amt;
          else inv.retailValue += amt;
        }
      });

      if (!headerFound && inv.role === "monthly") {
        logger.warn({ sheetId, tab: tab.title }, "primarySheets inventory: header not found in monthly tab");
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
    let tabTotal = 0;
    let tabTaxIdx = -1;
    let tabHeaderFound = false;
    let readFailed = false;

    try {
      await readTabRowsChunked(sheetId, inv.tabName, (chunkRows, startRow) => {
        for (let ri = 0; ri < chunkRows.length; ri++) {
          const row = chunkRows[ri];
          const globalRow = startRow + ri;
          if (!tabHeaderFound) {
            if (globalRow > 30) continue;
            const tI = findCol(row, /taxable\s*(value|amount)/i);
            if (tI >= 0) { tabTaxIdx = tI; tabHeaderFound = true; }
            continue;
          }
          const amt = numVal(row[tabTaxIdx]);
          if (amt > 0) tabTotal += amt;
        }
      });
    } catch (err) {
      readFailed = true;
      logger.warn({ sheetId, tab: inv.tabName, err }, "primarySheets: content-verify read failed");
    }

    if (readFailed || !tabHeaderFound) {
      inv.contentVerification = { status: "unreadable", monthlyEquivalent: 0, tabTotal: 0, diffAmount: 0 };
      inv.excludedReason = (inv.excludedReason ?? "") + " (content-verification: tab could not be read)";
      continue;
    }

    const monthlyEquivalent =
      inv.role === "combined"
        ? monthlyTotal
        : (monthlyByNormHead.get(normHead(inv.tabName) ?? "") ?? 0);

    const diffAmount = tabTotal - monthlyEquivalent;
    const isDuplicate = Math.abs(diffAmount) <= 1;

    inv.contentVerification = {
      status: isDuplicate ? "confirmed-duplicate" : "content-differs",
      monthlyEquivalent: Math.round(monthlyEquivalent),
      tabTotal: Math.round(tabTotal),
      diffAmount: Math.round(diffAmount),
    };

    if (isDuplicate) {
      inv.excludedReason =
        `Content-verified duplicate: tab total ₹${(tabTotal / 1e7).toFixed(2)} Cr` +
        ` matches monthly-tab aggregate within ₹1.`;
    } else if (diffAmount < 0) {
      // Tab has LESS than what monthly tabs attribute to this head/combined.
      // No unique rows can exist — safe to exclude.
      inv.excludedReason =
        `Tab total ₹${(tabTotal / 1e7).toFixed(2)} Cr is less than monthly aggregate` +
        ` ₹${(monthlyEquivalent / 1e7).toFixed(2)} Cr` +
        ` (gap ₹${Math.abs(Math.round(diffAmount)).toLocaleString("en-IN")})` +
        ` — tab contains no rows absent from monthly tabs; safe to exclude.`;
    } else {
      // Tab has MORE than monthly tabs: may contain rows not yet reflected
      // in any monthly tab. Flag clearly — manual review required.
      inv.excludedReason =
        `WARNING: tab total ₹${(tabTotal / 1e7).toFixed(2)} Cr exceeds monthly aggregate` +
        ` ₹${(monthlyEquivalent / 1e7).toFixed(2)} Cr` +
        ` by ₹${Math.round(diffAmount).toLocaleString("en-IN")}` +
        ` — tab may contain rows not covered by monthly tabs; review before excluding.`;
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

export async function loadPrimarySheetData(fy: string): Promise<PrimarySheetData> {
  const cached = _cache.get(fy);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;

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
  };
  let saleAgg: SheetAgg = {
    byNormHead: new Map(),
    byDistributor: new Map(),
    nonTerritoryTotal: 0,
    total: 0,
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
      bookingAvailable = bookingAgg.total > 0;
      tabInventory = inv;
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
      saleAgg = await readAndAggregate(saleSheetId, false);
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
    companySale: saleAgg.total,
    companyPending: Math.max(0, bookingAgg.total - saleAgg.total),
    byHead,
    byDistributor,
    sources: {
      booking: bookingAvailable ? `Order Sheet ${fy}` : null,
      sale: saleAvailable ? `State Head Sale ${fy}` : null,
    },
    bookingAvailable,
    saleAvailable,
    tabInventory,
  };

  _cache.set(fy, { ts: Date.now(), data });
  return data;
}
