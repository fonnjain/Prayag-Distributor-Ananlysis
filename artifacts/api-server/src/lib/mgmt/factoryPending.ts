// Reads the factory pending order book from the "REPORT 2" tab of the
// internal pending sheet (1dmt6uHOdZSIT0wgNkSfuK8W8d0YO8STW51PVOAAFHvY).
//
// Sheet layout (all rows 1-indexed):
//   Row 1  : empty
//   Row 2  : grand-total row (Balance Qty=261,171, product-group subtotals)
//   Row 3  : header row — col B=State Head, col C=Party Name, col D=Balance Qty,
//             cols E-AB = product groups GARDEN PIPE … HARDWARE
//             col AC = broken VLOOKUP (#N/A) — skip
//             col AD = formula label column — skip
//   Row 4  : empty
//   Rows 5+ : data rows (94 rows as of Jul 2026)
//
// NOTE: Water tank quantities in this sheet are in PIECES, not litres.
// The sale register records tanks in litres; do NOT apply the litre rule here.
//
// State Head (col B) carries forward — it is non-empty only on the first
// party row for each head; subsequent rows for the same head leave it blank.
//
// Columns 27+ (0-indexed) are internal formula columns and must be skipped.
import { readTabRowsChunked, type SheetCellValue } from "../registers/sheetsApi.js";
import { loadOrderBookSaleByHead } from "./orderBookSale.js";
import { loadStateHeadSale } from "./stateHeadSale.js";
import { logger } from "../logger.js";

const SHEET_ID = "1dmt6uHOdZSIT0wgNkSfuK8W8d0YO8STW51PVOAAFHvY";
const TAB = "REPORT 2";

// Formula helper columns start at this 0-indexed position; everything from
// here onward is a VLOOKUP/formula column, not actual product quantities.
const FORMULA_COL_START = 27;

// ── Types ──────────────────────────────────────────────────────────────────────

export type PendingParty = {
  party: string;
  total: number;
  byGroup: Record<string, number>;
};

export type PendingHead = {
  head: string;
  total: number;
  parties: PendingParty[];
};

export type DerivedPending = {
  ob: number | null;
  sale: number | null;
  pending: number | null;
  obError: string | null;
  saleError: string | null;
};

export type FactoryPendingResult = {
  groups: string[];
  grandTotal: number;
  byHead: PendingHead[];
  derived: DerivedPending;
  computedAt: string;
  error: string | null;
};

// ── Cache ──────────────────────────────────────────────────────────────────────

let _cache: { ts: number; result: FactoryPendingResult } | null = null;
const TTL_MS = 30 * 60 * 1000;

export function invalidateFactoryPendingCache(): void {
  _cache = null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function strVal(v: SheetCellValue | undefined): string {
  return v == null ? "" : String(v).trim();
}

function numVal(v: SheetCellValue | undefined): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── Main loader ────────────────────────────────────────────────────────────────

export async function loadFactoryPending(): Promise<FactoryPendingResult> {
  if (_cache && Date.now() - _cache.ts < TTL_MS) return _cache.result;

  const [sheetResult, obResult, saleResult] = await Promise.allSettled([
    readReport2(),
    loadOrderBookSaleByHead(),
    loadStateHeadSale("2026-27"),
  ]);

  const sheet = sheetResult.status === "fulfilled" ? sheetResult.value : null;
  const sheetError =
    sheetResult.status === "rejected"
      ? String(sheetResult.reason instanceof Error ? sheetResult.reason.message : sheetResult.reason)
      : null;

  const ob = obResult.status === "fulfilled" ? obResult.value : null;
  const sale = saleResult.status === "fulfilled" ? saleResult.value : null;

  const obTotal = ob && !ob.error ? ob.total : null;
  const saleTotal = sale && !sale.error ? sale.total : null;
  const pendingTotal =
    obTotal != null && saleTotal != null ? obTotal - saleTotal : null;

  const derived: DerivedPending = {
    ob: obTotal,
    sale: saleTotal,
    pending: pendingTotal,
    obError: ob?.error ?? (obResult.status === "rejected" ? String(obResult.reason) : null),
    saleError:
      sale?.error ?? (saleResult.status === "rejected" ? String(saleResult.reason) : null),
  };

  const result: FactoryPendingResult = {
    groups: sheet?.groups ?? [],
    grandTotal: sheet?.grandTotal ?? 0,
    byHead: sheet?.byHead ?? [],
    derived,
    computedAt: new Date().toISOString(),
    error: sheetError,
  };

  if (!sheetError) {
    _cache = { ts: Date.now(), result };
    logger.info(
      { grandTotal: result.grandTotal, heads: result.byHead.length, groups: result.groups.length },
      "factoryPending: loaded REPORT 2",
    );
  }

  return result;
}

// ── Sheet reader ───────────────────────────────────────────────────────────────

type SheetData = {
  groups: string[];
  grandTotal: number;
  byHead: PendingHead[];
};

async function readReport2(): Promise<SheetData> {
  let groups: string[] = [];
  let grandTotal = 0;
  const headsMap = new Map<string, PendingHead>();
  let currentHead = "";
  let headerFound = false;

  await readTabRowsChunked(SHEET_ID, TAB, (rows, startRow) => {
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const globalRow = startRow + ri; // 1-indexed sheet row

      if (!headerFound) {
        // The header row contains "State Head" in col B (index 1) and
        // "Party Name" in col C (index 2) and "Balance Qty" in col D (index 3).
        const b = strVal(row[1]);
        const c = strVal(row[2]);
        const d = strVal(row[3]);
        if (/state\s*head/i.test(b) && /party/i.test(c) && /balance/i.test(d)) {
          // Extract product group names from col E (index 4) onward,
          // stopping before the formula helper columns.
          for (let ci = 4; ci < Math.min(row.length, FORMULA_COL_START); ci++) {
            const name = strVal(row[ci]);
            if (name) groups.push(name);
          }
          headerFound = true;
        }
        continue;
      }

      // Grand total row is row 2 in the sheet (before the header row 3).
      // It should have been skipped by the !headerFound guard above, but
      // capture Balance Qty from any row before header that has a large total.
      // Actually: after header is found, we process data rows only.

      const headVal = strVal(row[1]);
      const party = strVal(row[2]);
      const qty = numVal(row[3]);

      if (headVal) currentHead = headVal;

      if (!party || qty <= 0) {
        // Possible blank/separator row — skip.
        if (globalRow > 200) break; // safety guard
        continue;
      }

      const head = currentHead || "Unknown";
      if (!headsMap.has(head)) {
        headsMap.set(head, { head, total: 0, parties: [] });
      }
      const headEntry = headsMap.get(head)!;

      const byGroup: Record<string, number> = {};
      for (let ci = 4; ci < Math.min(row.length, FORMULA_COL_START); ci++) {
        const groupIdx = ci - 4;
        if (groupIdx >= groups.length) break;
        const v = numVal(row[ci]);
        if (v > 0) byGroup[groups[groupIdx]] = v;
      }

      headEntry.parties.push({ party, total: qty, byGroup });
      headEntry.total += qty;
      grandTotal += qty;
    }
  });

  // Also pick up grand total from the totals row (row 2 in sheet, before header).
  // If we computed it from data rows it should match; prefer the data sum.
  if (grandTotal === 0) {
    // Sheet had no data rows; use computed from row 2 if we can.
    logger.warn("factoryPending: no data rows found in REPORT 2");
  }

  const byHead = Array.from(headsMap.values());
  return { groups, grandTotal, byHead };
}
