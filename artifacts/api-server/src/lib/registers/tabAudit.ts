// New-tab detection for register workbooks.
//
// On every sync the workbook's tab list is compared against the tabs the
// loader recognises. Any tab that is NOT read as sales/order data is:
//   a) never read into sales data,
//   b) logged by name with its grid row count,
//   c) shape-tested — a real month tab must have an invoice-number column,
//      a date column and a taxable-value/amount column,
//   d) PROPOSED (reported, never auto-included) when its name parses to a
//      month and the shape matches,
//   e) otherwise marked IGNORED with the concrete reason.
//
// Month names are matched by PARSING (toMonthLabel), not a hardcoded list —
// Sep, Oct, … are found automatically when their tabs appear. A tab named
// Sheet11, WT, INDEX, Combined or a person's name never parses to a month and
// is never read.
//
// Results are persisted in register_tab_audit (migration 009) and exposed via
// GET /api/registers/tab-audit. A first sighting logs at WARN level.
import { pool } from "@workspace/db";
import { isHeaderRow, mapRegisterColumns, toMonthLabel, type CellValue } from "./normalize.js";
import { readTabRowsSample, type SheetTab } from "./sheetsApi.js";
import { logger } from "../logger.js";

const MONTH_INDEX: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

export type TabNameClass = {
  kind: "month-started" | "month-future" | "not-month";
  monthLabel: string | null;
};

/** Classify a tab title by PARSING its name as a month within `fy`.
 *  "Aug" / "Aug-26" / "August" → month; a month whose calendar month has not
 *  begun yet (a 'Sep' tab appearing in August) is month-future. */
export function classifyTabName(title: string, fy: string, now: Date = new Date()): TabNameClass {
  const label = toMonthLabel(title.trim(), fy);
  if (!label) return { kind: "not-month", monthLabel: null };
  const m = /^([A-Z][a-z]{2})-(\d{2})$/.exec(label);
  if (!m) return { kind: "not-month", monthLabel: null };
  const mon = MONTH_INDEX[m[1]];
  if (mon === undefined) return { kind: "not-month", monthLabel: null };
  const year = 2000 + parseInt(m[2], 10);
  const started = now.getTime() >= Date.UTC(year, mon, 1);
  return { kind: started ? "month-started" : "month-future", monthLabel: label };
}

export type TabShape = {
  headerFound: boolean;
  hasInvoiceNo: boolean;
  hasDate: boolean;
  hasAmount: boolean;
  ok: boolean;
};

/** Shape test over the first rows of a tab: a real month tab must present a
 *  register header with invoice-number, date and taxable-value columns. */
export function testRegisterShape(rows: CellValue[][]): TabShape {
  const limit = Math.min(rows.length, 20);
  for (let i = 0; i < limit; i++) {
    if (!isHeaderRow(rows[i])) continue;
    const cols = mapRegisterColumns(rows[i], i + 1);
    const hasInvoiceNo = cols.invoiceNo >= 0;
    const hasDate = cols.date >= 0;
    const hasAmount = cols.amount >= 0;
    return { headerFound: true, hasInvoiceNo, hasDate, hasAmount, ok: hasInvoiceNo && hasDate && hasAmount };
  }
  return { headerFound: false, hasInvoiceNo: false, hasDate: false, hasAmount: false, ok: false };
}

export type TabDecision = { status: "proposed" | "ignored"; reason: string };

/** Pure decision: PROPOSE only a correctly-shaped future month tab; everything
 *  else is IGNORED with the concrete reason. Recognised (started-month) tabs
 *  never reach this function — the loader reads them. */
export function decideTabStatus(nameClass: TabNameClass, shape: TabShape): TabDecision {
  const missing = [
    !shape.hasInvoiceNo && "invoice-number",
    !shape.hasDate && "date",
    !shape.hasAmount && "taxable-value/amount",
  ].filter(Boolean).join(", ");

  if (nameClass.kind === "month-future") {
    if (shape.ok) {
      return {
        status: "proposed",
        reason: `Name parses to ${nameClass.monthLabel} (month not started) and the shape matches a sales register — proposed for inclusion when the month begins; NOT auto-included.`,
      };
    }
    return {
      status: "ignored",
      reason: shape.headerFound
        ? `Name parses to ${nameClass.monthLabel} but the shape is wrong — missing ${missing} column(s).`
        : `Name parses to ${nameClass.monthLabel} but no register header row was found in the first 20 rows.`,
    };
  }
  // not-month
  if (shape.ok) {
    return {
      status: "ignored",
      reason: "Shape looks like sales data but the name does not parse to a month — never read automatically. Rename to a month tab if it is real sales data.",
    };
  }
  return {
    status: "ignored",
    reason: shape.headerFound
      ? `Not a month name and not sales shape — header found but missing ${missing} column(s). Likely a scratch/working tab.`
      : "Not a month name and no register header detected — scratch, lookup or summary tab.",
  };
}

export type TabAuditRow = {
  sheetId: string;
  tabName: string;
  fy: string;
  register: "sale" | "order";
  status: "proposed" | "ignored";
  reason: string;
  gridRows: number;
  isNew: boolean;
};

/**
 * Audit every unrecognised tab of a register workbook: shape-test, decide,
 * persist, and WARN on first sighting. Never throws — detection must not take
 * down the sync it observes. Pass `presetReason` to skip the sample read for
 * tabs the caller has already classified (order-sheet lookup/per-head tabs).
 */
export async function auditRegisterTabs(opts: {
  sheetId: string;
  fy: string;
  register: "sale" | "order";
  tabs: Array<SheetTab & { presetReason?: string }>;
  now?: Date;
}): Promise<TabAuditRow[]> {
  const out: TabAuditRow[] = [];
  // Cache: a tab already audited whose grid row count is unchanged keeps its
  // stored verdict — no repeat Sheets sample read on every sync (quota).
  const prior = new Map<string, { status: string; reason: string | null; grid_rows: number | null }>();
  try {
    const priorRes = await pool.query<{ tab_name: string; status: string; reason: string | null; grid_rows: number | null }>(
      `SELECT tab_name, status, reason, grid_rows FROM register_tab_audit
       WHERE sheet_id = $1 AND fy = $2 AND register = $3`,
      [opts.sheetId, opts.fy, opts.register],
    );
    for (const r of priorRes.rows) prior.set(r.tab_name, r);
  } catch (err) {
    logger.warn({ err, sheetId: opts.sheetId }, "tabAudit: could not preload prior audit rows — will re-test shapes");
  }
  for (const tab of opts.tabs) {
    try {
      const nameClass = classifyTabName(tab.title, opts.fy, opts.now);
      const cached = prior.get(tab.title);
      let decision: TabDecision;
      if (tab.presetReason && nameClass.kind !== "month-future") {
        decision = { status: "ignored", reason: tab.presetReason };
      } else if (
        cached &&
        cached.grid_rows === tab.rowCount &&
        (cached.status === "proposed" || cached.status === "ignored")
      ) {
        decision = { status: cached.status, reason: cached.reason ?? "" };
      } else {
        const sample = await readTabRowsSample(opts.sheetId, tab.title, 25);
        decision = decideTabStatus(nameClass, testRegisterShape(sample as CellValue[][]));
      }
      const res = await pool.query<{ inserted: boolean }>(
        `INSERT INTO register_tab_audit (sheet_id, tab_name, fy, register, status, reason, grid_rows)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (sheet_id, tab_name, fy, register) DO UPDATE
           SET status = EXCLUDED.status, reason = EXCLUDED.reason,
               grid_rows = EXCLUDED.grid_rows, last_seen_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [opts.sheetId, tab.title, opts.fy, opts.register, decision.status, decision.reason, tab.rowCount],
      );
      const isNew = res.rows[0]?.inserted === true;
      const row: TabAuditRow = {
        sheetId: opts.sheetId,
        tabName: tab.title,
        fy: opts.fy,
        register: opts.register,
        status: decision.status,
        reason: decision.reason,
        gridRows: tab.rowCount,
        isNew,
      };
      out.push(row);
      logger[isNew ? "warn" : "info"](
        { sheetId: opts.sheetId, fy: opts.fy, register: opts.register, tab: tab.title, gridRows: tab.rowCount, status: decision.status, reason: decision.reason },
        isNew
          ? "tabAudit: NEW unrecognised tab detected — not read as sales data"
          : "tabAudit: unrecognised tab still present — not read as sales data",
      );
    } catch (err) {
      logger.warn({ err, sheetId: opts.sheetId, tab: tab.title }, "tabAudit: audit of one tab failed (sync unaffected)");
    }
  }
  return out;
}

/** Fiscal-year label ("2026-27") implied by the clock — April-based. */
export function currentFyLabel(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const start = now.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
