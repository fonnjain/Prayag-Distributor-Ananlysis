// Row-level reconciliation: SAP source sheet vs derived sale sheet.
//
// Both sheets are read via the Sheets API (read-only). Every data row is
// reduced to a fingerprint:
//
//   normCustomer(customer) | invoiceDate | round(qty × 1000) | round(amount)
//
// Note: item codes cannot be used as a join key — the SAP source stores full
// SAP material numbers (e.g. "SWXXXXXX4653TDX101") while the derived sale
// sheet stores short Prayag item codes (e.g. "4653"). Similarly, the SAP
// source tab may not expose the billing document number in a detectable column.
// Customer name + date + qty + amount is unique enough for this comparison
// and is consistent across both sheets.
//
// Occurrences are counted per fingerprint so that legitimate duplicate lines
// (same customer, same date, same qty/amount, genuinely ordered twice) are
// matched one-for-one rather than collapsed.
//
// The result is a structured report with:
//   - sapOnly  : rows in SAP but absent from the sale sheet (the gap to recover)
//   - saleOnly : rows in sale sheet not present in SAP (manual additions / noise)
//   - matched  : rows present in both (verification that matching is working)
//
// Only the SAP source sheet tab for the requested month is read (tab title
// prefix match e.g. "Jul" → "July"). All SAP rows are date-filtered to the
// requested calendar month so a mixed-month tab does not inflate the count.

import {
  listSheetTabs,
  readTabRowsChunked,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import rawRegisterSheets from "../../../config/register_sheets.json";
import { logger } from "../logger.js";
import { db, saleLines } from "@workspace/db";
import { eq, and } from "drizzle-orm";

type RegisterConfig = {
  registers: Record<string, string>;
  sap_source: Record<string, string>;
};
const _cfg = rawRegisterSheets as unknown as RegisterConfig;

// ── Column detection helpers ────────────────────────────────────────────────

function normHeader(v: SheetCellValue | undefined): string {
  return String(v ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function aliasIdx(headers: string[], ...aliases: string[]): number {
  for (const a of aliases) {
    const i = headers.indexOf(a);
    if (i >= 0) return i;
  }
  return -1;
}

function strVal(v: SheetCellValue | undefined): string {
  return v == null ? "" : String(v).trim();
}

function numVal(v: SheetCellValue | undefined): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function anyNumVal(v: SheetCellValue | undefined): number {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function parseDate(v: SheetCellValue | undefined): string | null {
  if (v == null || v === "") return null;
  // Excel serial (days since 1900-01-01 with Lotus bug offset)
  if (typeof v === "number" && v > 40_000 && v < 70_000) {
    const d = new Date(Math.round((v - 25569) * 86_400_000));
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (!s) return null;
  // DD-MM-YYYY or DD/MM/YYYY
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const day = Number(m[1]), mon = Number(m[2]);
    let yr = Number(m[3]);
    if (m[3].length === 2) yr += 2000;
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      return `${yr}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  const iso = new Date(s);
  return isNaN(iso.getTime()) ? null : iso.toISOString().slice(0, 10);
}

// Normalize invoice number for display/reporting (not part of the fingerprint).
function normInvoice(s: string | null | undefined): string {
  return (s ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

// Normalize customer name for fingerprint matching.
// The SAP source and the derived sale sheet both carry full display names;
// collapsing case and extra whitespace is sufficient.
function normCustomer(s: string | null | undefined): string {
  return (s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

// Deterministic fingerprint per line item.
//
// Uses (normCustomer | date | round(amount)).
//
// Item codes are intentionally excluded: the SAP source stores full SAP
// material numbers ("SWXXXXXX4653TDX101") while the derived sale sheet stores
// short Prayag codes ("4653") with no common normalisation path.
// Invoice numbers are excluded because the SAP source tab may not expose the
// billing document column in a position the generic header scan catches.
// Quantity is excluded because the SAP source records qty in SAP billing units
// (cartons / packs) while the derived sale sheet stores retail units — the same
// physical shipment may appear as qty=2 in SAP and qty=1000 in the sale sheet.
//
// Using only (customer, date, amount) is sufficient for an analytical gap-find:
// it is very rare for the same customer to receive two distinct line items of
// exactly the same taxable value on the same day. The bag-count approach
// handles the occasional genuine duplicate correctly.
//
// amount is rounded to the nearest rupee — the two sheets may differ by
// sub-rupee precision but always agree at ₹1 resolution.
function makeFingerprint(
  customer: string | null | undefined,
  date: string | null | undefined,
  amount: number,
): string {
  return [
    normCustomer(customer),
    date ?? "",
    Math.round(amount),
  ].join("|");
}

// ── Public types ─────────────────────────────────────────────────────────────

export type ReconcileRow = {
  invoiceNo: string | null;
  invoiceDate: string | null;
  customer: string | null;
  code: string | null;
  qty: number;
  amount: number;
  /** From the sale sheet (derived) — absent for SAP-only rows. */
  head: string | null;
  state: string | null;
  group: string | null;
};

export type ReconcileResult = {
  fy: string;
  month: string;
  generatedAt: string;
  sapSource: {
    sheetId: string;
    tab: string | null;
    totalRows: number;
    totalAmount: number;
    dateFilterApplied: boolean;
    dateFilterMonth: string | null;
  };
  saleSheet: {
    sheetId: string;
    tab: string | null;
    totalRows: number;
    totalAmount: number;
  };
  matched: {
    rows: number;
    amount: number;
  };
  sapOnly: {
    rows: number;
    amount: number;
    /** Top customers by missing amount. */
    byCustomer: Array<{ customer: string; rows: number; amount: number }>;
    /** Every missing row — use for recovery or download. */
    detail: ReconcileRow[];
  };
  saleOnly: {
    rows: number;
    amount: number;
    detail: ReconcileRow[];
  };
  errors: string[];
  conclusion: string;
};

// ── Tab finder ────────────────────────────────────────────────────────────────

function findMonthTab(
  tabs: Array<{ title: string }>,
  monthPrefix: string,
): string | null {
  const pfx = monthPrefix.toLowerCase().slice(0, 3);
  return (
    tabs.find((t) => t.title.trim().toLowerCase().startsWith(pfx))?.title ??
    null
  );
}

/**
 * Tab selection for the SAP source workbook.
 *
 * The SAP source workbook keeps a "Combined" tab that accumulates all months
 * from April onward with every branch prefix present (1=Bhiwadi, 4=Delhi,
 * 5=Gujarat, 7=Andal, …). Per-month tabs (e.g. "July") are partial exports
 * that may omit branch prefixes added after the last export. Always prefer
 * "Combined" — readSapSourceTab applies monthFilter to narrow it to the
 * requested month automatically.
 */
function findSapTab(
  tabs: Array<{ title: string }>,
  monthPrefix: string,
): { title: string; isCombined: boolean } | null {
  const combined = tabs.find((t) => /^combined$/i.test(t.title.trim()));
  if (combined) return { title: combined.title, isCombined: true };
  const monthly = findMonthTab(tabs, monthPrefix);
  if (monthly) return { title: monthly, isCombined: false };
  return null;
}

// ── SAP source reader ─────────────────────────────────────────────────────────
// The SAP source sheet is the raw 56-column SAP export in Google Sheets format.
// Column headers are detected by content (same aliases as the uploaded xlsx parser).

type SapSourceRow = {
  invoiceNo: string | null;
  invoiceDate: string | null;
  customer: string | null;
  code: string | null;
  qty: number;
  amount: number;
};

async function readSapSourceTab(
  sheetId: string,
  tabTitle: string,
  monthFilter: { year: number; month: number } | null,
): Promise<SapSourceRow[]> {
  const result: SapSourceRow[] = [];
  let invoiceIdx = -1,
    dateIdx = -1,
    customerIdx = -1,
    codeIdx = -1,
    qtyIdx = -1,
    amtIdx = -1;
  let headerFound = false;
  let rowsSkippedByDate = 0;

  await readTabRowsChunked(sheetId, tabTitle, (chunk, startRow) => {
    for (let ri = 0; ri < chunk.length; ri++) {
      const row = chunk[ri];
      const globalRow = startRow + ri;

      if (!headerFound) {
        if (globalRow > 25) continue; // header must appear in first 25 rows
        const hd = row.map(normHeader);
        const cI = aliasIdx(hd, "ITEMCODE", "CODE", "MATERIAL", "MATERIALCODE", "PRODUCTCODE");
        const qI = aliasIdx(hd, "QTY", "QUANTITY", "BILLQTY", "BILLINGQTY", "ORDEREDQTY");
        const aI = aliasIdx(
          hd,
          "TAXABLEVALUE",
          "TAXABLEAMOUNT",
          "TAXABLE",
          "ASSESSABLEVALUE",
          "NETVALUE",
          "AMOUNT",
        );
        if (cI >= 0 && qI >= 0 && aI >= 0) {
          codeIdx = cI;
          qtyIdx = qI;
          amtIdx = aI;
          invoiceIdx = aliasIdx(
            hd,
            "INVOICENO",
            "INVOICENUMBER",
            "BILLINGDOCUMENT",
            "INVOICE",
            "BILLNO",
            "DOCUMENTNO",
          );
          dateIdx = aliasIdx(hd, "DATE", "INVOICEDATE", "BILLINGDATE", "BILLDATE", "POSTINGDATE");
          customerIdx = aliasIdx(
            hd,
            "CUSTOMER",
            "CUSTOMERNAME",
            "PARTY",
            "PARTYNAME",
            "SOLDTOPARTY",
            "BILLTOPARTY",
            "NAME1",
            "NAME",
          );
          headerFound = true;
        }
        continue;
      }

      const code = strVal(row[codeIdx]);
      const amount = numVal(row[amtIdx]);
      if (!code || amount <= 0) continue;

      const rawDate = dateIdx >= 0 ? parseDate(row[dateIdx]) : null;

      // Date filter: exclude rows outside the requested calendar month.
      // Rows without a date pass through (historical SAP exports sometimes omit dates).
      if (monthFilter && rawDate) {
        const d = new Date(rawDate + "T00:00:00Z");
        if (
          d.getUTCFullYear() !== monthFilter.year ||
          d.getUTCMonth() + 1 !== monthFilter.month
        ) {
          rowsSkippedByDate++;
          continue;
        }
      }

      result.push({
        invoiceNo: invoiceIdx >= 0 ? strVal(row[invoiceIdx]) || null : null,
        invoiceDate: rawDate,
        customer: customerIdx >= 0 ? strVal(row[customerIdx]) || null : null,
        code,
        qty: qtyIdx >= 0 ? anyNumVal(row[qtyIdx]) : 0,
        amount,
      });
    }
  });

  logger.info(
    { sheetId, tab: tabTitle, rows: result.length, rowsSkippedByDate, headerFound },
    "reconcile: SAP source tab read",
  );
  return result;
}

// ── Sale sheet reader ─────────────────────────────────────────────────────────
// The derived sale sheet uses "Taxable Value" + "STATE HEAD" as header anchors,
// then detects the remaining columns by name regex.

type SaleSheetRow = ReconcileRow;

async function readSaleSheetTab(
  sheetId: string,
  tabTitle: string,
): Promise<SaleSheetRow[]> {
  const result: SaleSheetRow[] = [];
  let invoiceIdx = -1,
    dateIdx = -1,
    customerIdx = -1,
    codeIdx = -1,
    qtyIdx = -1,
    amtIdx = -1,
    headIdx = -1,
    stateIdx = -1,
    groupIdx = -1;
  let headerFound = false;

  await readTabRowsChunked(sheetId, tabTitle, (chunk, startRow) => {
    for (let ri = 0; ri < chunk.length; ri++) {
      const row = chunk[ri];
      const globalRow = startRow + ri;

      if (!headerFound) {
        if (globalRow > 30) continue;
        // Anchor: Taxable Value + STATE HEAD must both be present.
        const tI = row.findIndex((v) => /taxable\s*(value|amount)/i.test(strVal(v)));
        const hI = row.findIndex((v) => /state\s*head/i.test(strVal(v)));
        if (tI >= 0 && hI >= 0) {
          amtIdx = tI;
          headIdx = hI;
          for (let ci = 0; ci < row.length; ci++) {
            const h = strVal(row[ci]);
            if (/invoice|bill\s*no/i.test(h) && invoiceIdx < 0) invoiceIdx = ci;
            if (/^(date|invoice.?date|order.?date)$/i.test(h) && dateIdx < 0) dateIdx = ci;
            if (/^(customer.*name?|party.*name?|firm\s*name|dealer\s*name|distributor\s*name|customer)$/i.test(h) && customerIdx < 0) customerIdx = ci;
            if (/^(item.?code|code|product.?code|material.?code)$/i.test(h) && codeIdx < 0) codeIdx = ci;
            if (/^(qty|quantity|qnty)$/i.test(h) && qtyIdx < 0) qtyIdx = ci;
            if (/^state$/i.test(h) && stateIdx < 0 && ci !== hI) stateIdx = ci;
            if (/^group$/i.test(h) && groupIdx < 0) groupIdx = ci;
          }
          headerFound = true;
        }
        continue;
      }

      const amount = numVal(row[amtIdx]);
      if (amount <= 0) continue;

      result.push({
        invoiceNo: invoiceIdx >= 0 ? strVal(row[invoiceIdx]) || null : null,
        invoiceDate: dateIdx >= 0 ? parseDate(row[dateIdx]) : null,
        customer: customerIdx >= 0 ? strVal(row[customerIdx]) || null : null,
        code: codeIdx >= 0 ? strVal(row[codeIdx]) || null : null,
        qty: qtyIdx >= 0 ? anyNumVal(row[qtyIdx]) : 0,
        amount,
        head: headIdx >= 0 ? strVal(row[headIdx]) || null : null,
        state: stateIdx >= 0 ? strVal(row[stateIdx]) || null : null,
        group: groupIdx >= 0 ? strVal(row[groupIdx]) || null : null,
      });
    }
  });

  logger.info(
    { sheetId, tab: tabTitle, rows: result.length, headerFound },
    "reconcile: sale sheet tab read",
  );
  return result;
}

// ── Fingerprint bag ───────────────────────────────────────────────────────────
// Maps fingerprint → sorted list of row indices (preserves occurrence order).

function buildFingerprintBag(
  rows: Array<{ customer: string | null | undefined; invoiceDate: string | null; amount: number }>,
): Map<string, number[]> {
  const bag = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const fp = makeFingerprint(rows[i].customer, rows[i].invoiceDate, rows[i].amount);
    const list = bag.get(fp);
    if (list) list.push(i);
    else bag.set(fp, [i]);
  }
  return bag;
}

// ── Main export ───────────────────────────────────────────────────────────────

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Reconciles the SAP source sheet against the derived sale sheet for one month.
 *
 * @param fy        Fiscal year string e.g. "2026-27"
 * @param monthLabel Month label e.g. "Jul-26"
 */
export async function reconcileSapVsSaleSheet(
  fy: string,
  monthLabel: string,
): Promise<ReconcileResult> {
  const errors: string[] = [];
  const sapId = _cfg.sap_source?.[fy] ?? "";
  const saleId = _cfg.registers?.[fy] ?? "";

  if (!sapId) errors.push(`No sap_source sheet configured for FY${fy} in register_sheets.json`);
  if (!saleId) errors.push(`No registers sheet configured for FY${fy} in register_sheets.json`);

  // Parse month label into a calendar filter.
  const [abbrRaw, yrStr] = monthLabel.split("-");
  const abbr = abbrRaw?.slice(0, 3) ?? "";
  const monthNum = MONTH_ABBR.findIndex((m) => m.toLowerCase() === abbr.toLowerCase()) + 1;
  const yr = yrStr ? 2000 + parseInt(yrStr, 10) : NaN;
  const monthFilter =
    monthNum > 0 && !isNaN(yr) ? { year: yr, month: monthNum } : null;

  if (!monthFilter) {
    errors.push(`Cannot parse month label "${monthLabel}" — expected format: "Jul-26"`);
  }

  const monthPrefix = abbr;
  let sapTabTitle: string | null = null;
  let saleTabTitle: string | null = null;
  let sapRows: SapSourceRow[] = [];
  let saleRows: SaleSheetRow[] = [];

  // Read both sheets in parallel.
  const [sapResult, saleResult] = await Promise.allSettled([
    (async () => {
      if (!sapId) return;
      const tabs = await listSheetTabs(sapId);
      const sapTab = findSapTab(tabs, monthPrefix);
      if (!sapTab) {
        errors.push(
          `No "${monthPrefix}" or "Combined" tab found in SAP source sheet ${sapId} ` +
            `— tabs present: ${tabs.map((t) => t.title).join(", ") || "(none)"}`,
        );
        return;
      }
      sapTabTitle = sapTab.title;
      if (sapTab.isCombined) {
        logger.info({ sapId, tab: sapTab.title, month: monthLabel }, "sap reconcile: reading Combined tab with date filter");
      }
      sapRows = await readSapSourceTab(sapId, sapTabTitle, monthFilter);
    })(),
    (async () => {
      if (!saleId) return;
      const tabs = await listSheetTabs(saleId);
      saleTabTitle = findMonthTab(tabs, monthPrefix);
      if (!saleTabTitle) {
        errors.push(
          `No "${monthPrefix}" tab found in sale sheet ${saleId} ` +
            `— tabs present: ${tabs.map((t) => t.title).join(", ") || "(none)"}`,
        );
        return;
      }
      saleRows = await readSaleSheetTab(saleId, saleTabTitle);
    })(),
  ]);

  if (sapResult.status === "rejected") {
    errors.push(`SAP source read threw: ${String(sapResult.reason)}`);
  }
  if (saleResult.status === "rejected") {
    errors.push(`Sale sheet read threw: ${String(saleResult.reason)}`);
  }

  // ── Build fingerprint bags and compute set diff ───────────────────────────

  const sapBag = buildFingerprintBag(sapRows);
  const saleBag = buildFingerprintBag(saleRows);

  // SAP-only: occurrences in SAP that exceed occurrences in the sale sheet.
  const sapOnlyRows: ReconcileRow[] = [];
  let sapOnlyAmount = 0;

  for (const [fp, sapIndices] of sapBag) {
    const saleCount = (saleBag.get(fp) ?? []).length;
    const surplus = sapIndices.length - saleCount;
    if (surplus <= 0) continue;
    // The last `surplus` occurrences are unmatched.
    for (let k = sapIndices.length - surplus; k < sapIndices.length; k++) {
      const r = sapRows[sapIndices[k]];
      sapOnlyRows.push({
        invoiceNo: r.invoiceNo,
        invoiceDate: r.invoiceDate,
        customer: r.customer,
        code: r.code,
        qty: r.qty,
        amount: r.amount,
        head: null,
        state: null,
        group: null,
      });
      sapOnlyAmount += r.amount;
    }
  }

  // Sale-only: occurrences in the sale sheet that exceed SAP occurrences.
  const saleOnlyRows: ReconcileRow[] = [];
  let saleOnlyAmount = 0;

  for (const [fp, saleIndices] of saleBag) {
    const sapCount = (sapBag.get(fp) ?? []).length;
    const surplus = saleIndices.length - sapCount;
    if (surplus <= 0) continue;
    for (let k = saleIndices.length - surplus; k < saleIndices.length; k++) {
      const r = saleRows[saleIndices[k]];
      saleOnlyRows.push(r);
      saleOnlyAmount += r.amount;
    }
  }

  // Matched counts.
  const sapTotal = sapRows.reduce((s, r) => s + r.amount, 0);
  const saleTotal = saleRows.reduce((s, r) => s + r.amount, 0);
  const matchedRows = sapRows.length - sapOnlyRows.length;
  const matchedAmount = sapTotal - sapOnlyAmount;

  // By-customer breakdown for missing rows.
  const byCust = new Map<string, { rows: number; amount: number }>();
  for (const r of sapOnlyRows) {
    const key = r.customer ?? "(unknown customer)";
    const agg = byCust.get(key) ?? { rows: 0, amount: 0 };
    agg.rows++;
    agg.amount += r.amount;
    byCust.set(key, agg);
  }
  const byCustomer = [...byCust.entries()]
    .map(([customer, v]) => ({ customer, rows: v.rows, amount: Math.round(v.amount) }))
    .sort((a, b) => b.amount - a.amount);

  // Sort detail by invoice number for readability.
  sapOnlyRows.sort((a, b) =>
    (normInvoice(a.invoiceNo) < normInvoice(b.invoiceNo) ? -1 : 1),
  );

  // ── Conclusion ──────────────────────────────────────────────────────────────

  const crore = (n: number): string => `₹${(n / 1e7).toFixed(2)} Cr`;

  let conclusion: string;
  if (errors.length > 0 && sapRows.length === 0 && saleRows.length === 0) {
    conclusion = `Reconciliation could not run: ${errors.join("; ")}`;
  } else if (sapOnlyRows.length === 0 && saleOnlyRows.length === 0) {
    conclusion =
      `No gap detected: all ${sapRows.length.toLocaleString("en-IN")} SAP rows for ${monthLabel} ` +
      `are present in the sale sheet (${crore(sapTotal)}).`;
  } else {
    const parts: string[] = [];
    if (sapOnlyRows.length > 0) {
      parts.push(
        `${sapOnlyRows.length.toLocaleString("en-IN")} row(s) totalling ${crore(sapOnlyAmount)} ` +
          `are in the SAP source sheet ("${sapTabTitle ?? monthLabel}") but absent from the ` +
          `derived sale sheet. These rows are fully recoverable from the SAP source.`,
      );
    }
    if (saleOnlyRows.length > 0) {
      parts.push(
        `${saleOnlyRows.length.toLocaleString("en-IN")} row(s) totalling ${crore(saleOnlyAmount)} ` +
          `are in the sale sheet but not in the SAP source — these may be manual additions ` +
          `or the fingerprint did not match (review needed).`,
      );
    }
    conclusion = parts.join(" ");
  }

  return {
    fy,
    month: monthLabel,
    generatedAt: new Date().toISOString(),
    sapSource: {
      sheetId: sapId,
      tab: sapTabTitle,
      totalRows: sapRows.length,
      totalAmount: Math.round(sapTotal),
      dateFilterApplied: monthFilter !== null,
      dateFilterMonth:
        monthFilter
          ? `${monthFilter.year}-${String(monthFilter.month).padStart(2, "0")}`
          : null,
    },
    saleSheet: {
      sheetId: saleId,
      tab: saleTabTitle,
      totalRows: saleRows.length,
      totalAmount: Math.round(saleTotal),
    },
    matched: {
      rows: matchedRows,
      amount: Math.round(matchedAmount),
    },
    sapOnly: {
      rows: sapOnlyRows.length,
      amount: Math.round(sapOnlyAmount),
      byCustomer,
      detail: sapOnlyRows,
    },
    saleOnly: {
      rows: saleOnlyRows.length,
      amount: Math.round(saleOnlyAmount),
      detail: saleOnlyRows,
    },
    errors,
    conclusion,
  };
}

// ── DB gap analysis ───────────────────────────────────────────────────────────
// Compares the DB's historical snapshot (all rows ever ingested for a month)
// against the CURRENT live sale sheet, surfacing rows that were present when
// the sheet was last ingested but have since been deleted from it.
//
// Fingerprint: normInvoice(invoiceNo) | normCode(code) | round(qty×1000) | round(amount)
// This 4-field key is more precise than the SAP↔sheet key because the DB was
// ingested directly from the sale sheet, so all four fields are in identical
// format on both sides.

export type DbGapRow = {
  lineUid: string;
  invoiceNo: string | null;
  invoiceDate: string | null;
  customer: string | null;
  code: string;
  qty: number;
  amount: number;
  head: string | null;
  state: string | null;
  group: string | null;
  source: string;
};

export type DbGapResult = {
  fy: string;
  month: string;
  generatedAt: string;
  saleSheet: {
    sheetId: string;
    tab: string | null;
    totalRows: number;
    totalAmount: number;
  };
  db: {
    totalRows: number;
    totalAmount: number;
  };
  matched: {
    rows: number;
    amount: number;
  };
  /** Rows in the DB that have no matching row in the current live sheet. */
  dbOnly: {
    rows: number;
    amount: number;
    byCustomer: Array<{ customer: string; rows: number; amount: number }>;
    detail: DbGapRow[];
  };
  errors: string[];
  conclusion: string;
};

// Fingerprint for DB↔sheet matching. All four fields are in the same format
// on both sides since the DB was ingested from the same sheet.
function makeDbFingerprint(
  invoiceNo: string | null | undefined,
  code: string | null | undefined,
  qty: number,
  amount: number,
): string {
  return [
    normInvoice(invoiceNo),
    (code ?? "").replace(/\s+/g, "").toUpperCase(),
    Math.round(qty * 1000),
    Math.round(amount),
  ].join("|");
}

/**
 * Reads the live sale sheet for one month and the DB's stored rows for the
 * same month, then returns rows that exist in the DB but are absent from
 * the current sheet — i.e. rows that were deleted after the last ingest.
 */
export async function reconcileDbVsSaleSheet(
  fy: string,
  monthLabel: string,
): Promise<DbGapResult> {
  const errors: string[] = [];
  const saleId = _cfg.registers?.[fy] ?? "";

  if (!saleId) {
    errors.push(`No registers sheet configured for FY${fy} in register_sheets.json`);
  }

  const [abbrRaw] = monthLabel.split("-");
  const abbr = abbrRaw?.slice(0, 3) ?? "";
  let saleTabTitle: string | null = null;
  let saleRows: SaleSheetRow[] = [];

  const [sheetResult, dbQueryResult] = await Promise.allSettled([
    (async () => {
      if (!saleId) return;
      const tabs = await listSheetTabs(saleId);
      saleTabTitle = findMonthTab(tabs, abbr);
      if (!saleTabTitle) {
        errors.push(
          `No "${abbr}" tab found in sale sheet ${saleId} — tabs: ${tabs.map((t) => t.title).join(", ") || "(none)"}`,
        );
        return;
      }
      saleRows = await readSaleSheetTab(saleId, saleTabTitle);
    })(),
    db
      .select({
        lineUid: saleLines.lineUid,
        invoiceNo: saleLines.invoiceNo,
        invoiceDate: saleLines.invoiceDate,
        customer: saleLines.customer,
        code: saleLines.code,
        qty: saleLines.qty,
        amount: saleLines.amount,
        headRaw: saleLines.headRaw,
        stateRaw: saleLines.stateRaw,
        groupRaw: saleLines.groupRaw,
        source: saleLines.source,
      })
      .from(saleLines)
      .where(and(eq(saleLines.fy, fy), eq(saleLines.monthLabel, monthLabel))),
  ]);

  if (sheetResult.status === "rejected") {
    errors.push(`Sale sheet read threw: ${String(sheetResult.reason)}`);
  }
  if (dbQueryResult.status === "rejected") {
    errors.push(`DB query threw: ${String(dbQueryResult.reason)}`);
    return {
      fy,
      month: monthLabel,
      generatedAt: new Date().toISOString(),
      saleSheet: { sheetId: saleId, tab: saleTabTitle, totalRows: 0, totalAmount: 0 },
      db: { totalRows: 0, totalAmount: 0 },
      matched: { rows: 0, amount: 0 },
      dbOnly: { rows: 0, amount: 0, byCustomer: [], detail: [] },
      errors,
      conclusion: "DB query failed.",
    };
  }

  const dbRows = dbQueryResult.value as Array<{
    lineUid: string;
    invoiceNo: string | null;
    invoiceDate: string | null;
    customer: string | null;
    code: string;
    qty: string | null;
    amount: string;
    headRaw: string | null;
    stateRaw: string | null;
    groupRaw: string | null;
    source: string;
  }>;

  // Build a count-bag from the live sheet rows (bag handles genuine duplicates).
  const sheetBag = new Map<string, number>();
  let saleTotal = 0;
  for (const r of saleRows) {
    const fp = makeDbFingerprint(r.invoiceNo, r.code, r.qty, r.amount);
    sheetBag.set(fp, (sheetBag.get(fp) ?? 0) + 1);
    saleTotal += r.amount;
  }

  // Compare each DB row against the sheet bag.
  const dbOnlyRows: DbGapRow[] = [];
  let dbTotal = 0;
  let dbOnlyAmount = 0;
  let matchedRows = 0;
  let matchedAmount = 0;

  for (const row of dbRows) {
    const qty = Number(row.qty ?? 0);
    const amount = Number(row.amount);
    dbTotal += amount;
    const fp = makeDbFingerprint(row.invoiceNo, row.code, qty, amount);
    const cnt = sheetBag.get(fp) ?? 0;
    if (cnt > 0) {
      sheetBag.set(fp, cnt - 1);
      matchedRows++;
      matchedAmount += amount;
    } else {
      dbOnlyRows.push({
        lineUid: row.lineUid,
        invoiceNo: row.invoiceNo,
        invoiceDate: row.invoiceDate,
        customer: row.customer,
        code: row.code,
        qty,
        amount,
        head: row.headRaw,
        state: row.stateRaw,
        group: row.groupRaw,
        source: row.source,
      });
      dbOnlyAmount += amount;
    }
  }

  // Aggregate db-only by customer (top by amount).
  const byCustMap = new Map<string, { rows: number; amount: number }>();
  for (const r of dbOnlyRows) {
    const key = r.customer ?? "(unknown)";
    const s = byCustMap.get(key) ?? { rows: 0, amount: 0 };
    byCustMap.set(key, { rows: s.rows + 1, amount: s.amount + r.amount });
  }
  const byCustomer = Array.from(byCustMap.entries())
    .map(([customer, s]) => ({ customer, rows: s.rows, amount: Math.round(s.amount) }))
    .sort((a, b) => b.amount - a.amount);

  const pct =
    dbRows.length > 0 ? Math.round((dbOnlyRows.length / dbRows.length) * 100) : 0;
  const conclusion =
    dbOnlyRows.length === 0
      ? `All ${dbRows.length} DB rows are present in the live sale sheet — no deletions detected.`
      : `${dbOnlyRows.length} of ${dbRows.length} DB rows (${pct}%, ₹${Math.round(dbOnlyAmount).toLocaleString()}) are absent from the live sale sheet. These were ingested when the sheet contained more data and can be recovered from the database.`;

  logger.info(
    {
      fy,
      monthLabel,
      dbRows: dbRows.length,
      saleRows: saleRows.length,
      dbOnly: dbOnlyRows.length,
    },
    "db-gap: analysis complete",
  );

  return {
    fy,
    month: monthLabel,
    generatedAt: new Date().toISOString(),
    saleSheet: {
      sheetId: saleId,
      tab: saleTabTitle,
      totalRows: saleRows.length,
      totalAmount: Math.round(saleTotal),
    },
    db: {
      totalRows: dbRows.length,
      totalAmount: Math.round(dbTotal),
    },
    matched: {
      rows: matchedRows,
      amount: Math.round(matchedAmount),
    },
    dbOnly: {
      rows: dbOnlyRows.length,
      amount: Math.round(dbOnlyAmount),
      byCustomer,
      detail: dbOnlyRows,
    },
    errors,
    conclusion,
  };
}

// ── CSV formatter ─────────────────────────────────────────────────────────────

function csvEscape(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Formats the dbOnly detail rows as a CSV for download.
 * Every deleted row is exported with its lineUid so recovery is unambiguous.
 */
export function formatDbGapAsCsv(result: DbGapResult): string {
  const lines: string[] = [];
  lines.push(`DB vs Sale Sheet Gap Report — ${result.month} (FY${result.fy})`);
  lines.push(`Generated,${result.generatedAt}`);
  lines.push(`Sale sheet tab,${result.saleSheet.tab ?? "not found"}`);
  lines.push(`Sale sheet rows,${result.saleSheet.totalRows}`);
  lines.push(`Sale sheet amount,${result.saleSheet.totalAmount}`);
  lines.push(`DB rows,${result.db.totalRows}`);
  lines.push(`DB amount,${result.db.totalAmount}`);
  lines.push(`Matched rows,${result.matched.rows}`);
  lines.push(`DB-only (deleted),${result.dbOnly.rows}`);
  lines.push(`DB-only amount,${result.dbOnly.amount}`);
  lines.push(`Conclusion,${csvEscape(result.conclusion)}`);
  if (result.errors.length > 0) {
    lines.push(`Errors,${csvEscape(result.errors.join("; "))}`);
  }
  lines.push("");
  lines.push("=== Rows in DB but absent from live sale sheet (deleted — recoverable from DB) ===");
  lines.push(
    [
      "Line UID", "Invoice No", "Invoice Date", "Customer",
      "Item Code", "Qty", "Amount (Rs)", "State Head", "State", "Group", "Source",
    ].join(","),
  );
  for (const r of result.dbOnly.detail) {
    lines.push(
      [
        csvEscape(r.lineUid),
        csvEscape(r.invoiceNo),
        csvEscape(r.invoiceDate),
        csvEscape(r.customer),
        csvEscape(r.code),
        r.qty,
        r.amount,
        csvEscape(r.head),
        csvEscape(r.state),
        csvEscape(r.group),
        csvEscape(r.source),
      ].join(","),
    );
  }
  return lines.join("\n");
}

/**
 * Formats the sapOnly detail rows as a CSV string for download.
 * Includes a summary header block followed by the per-row table.
 */
export function formatReconcileAsCsv(result: ReconcileResult): string {
  const lines: string[] = [];

  // Summary block
  lines.push(`SAP vs Sale Sheet Reconciliation — ${result.month} (FY${result.fy})`);
  lines.push(`Generated,${result.generatedAt}`);
  lines.push(`SAP source tab,${result.sapSource.tab ?? "not found"}`);
  lines.push(`Sale sheet tab,${result.saleSheet.tab ?? "not found"}`);
  lines.push(`SAP rows (after date filter),${result.sapSource.totalRows}`);
  lines.push(`Sale sheet rows,${result.saleSheet.totalRows}`);
  lines.push(`Matched rows,${result.matched.rows}`);
  lines.push(`SAP-only (missing),${result.sapOnly.rows}`);
  lines.push(`SAP-only amount,${result.sapOnly.amount}`);
  lines.push(`Sale-only rows,${result.saleOnly.rows}`);
  lines.push(`Conclusion,${csvEscape(result.conclusion)}`);
  if (result.errors.length > 0) {
    lines.push(`Errors,${csvEscape(result.errors.join("; "))}`);
  }
  lines.push("");

  // SAP-only detail
  lines.push("=== Rows in SAP master but absent from sale sheet (recoverable) ===");
  lines.push(
    ["Invoice No", "Invoice Date", "Customer", "Item Code", "Qty", "Amount (₹)"].join(","),
  );
  for (const r of result.sapOnly.detail) {
    lines.push(
      [
        csvEscape(r.invoiceNo),
        csvEscape(r.invoiceDate),
        csvEscape(r.customer),
        csvEscape(r.code),
        r.qty,
        r.amount,
      ].join(","),
    );
  }

  if (result.saleOnly.rows > 0) {
    lines.push("");
    lines.push("=== Rows in sale sheet but absent from SAP master (review needed) ===");
    lines.push(
      ["Invoice No", "Invoice Date", "Customer", "Item Code", "Qty", "Amount (₹)", "State Head", "State", "Group"].join(","),
    );
    for (const r of result.saleOnly.detail) {
      lines.push(
        [
          csvEscape(r.invoiceNo),
          csvEscape(r.invoiceDate),
          csvEscape(r.customer),
          csvEscape(r.code),
          r.qty,
          r.amount,
          csvEscape(r.head),
          csvEscape(r.state),
          csvEscape(r.group),
        ].join(","),
      );
    }
  }

  return lines.join("\n");
}
