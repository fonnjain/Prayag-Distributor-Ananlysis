// registerWipeGuard.ts — pre-insert completeness guard for secondary_register_line loads.
//
// Called BEFORE the INSERT statement (the register loader is append-only — it
// does not DELETE existing rows before inserting).  If the guard fires, it
// throws WipeGuardAbortError; callers must treat this as an unrecoverable load
// failure and skip the insert entirely.  Nothing is inserted and existing rows
// are never touched.
//
// Three rules, applied per month using the dates already parsed from the source:
//
//   Rule 1: incoming rows         < 0.60 × existing rows              → ABORT
//   Rule 2: incoming distinct
//             customers           < 0.70 × existing distinct customers → ABORT
//   Rule 3: any (month, head_canon) pair that had ≥ GUARD_HEAD_MIN_ROWS
//             existing rows has 0 incoming rows for that head          → ABORT
//             (per-member silent-drop guard)
//
// Rule 3 catches the case where a single member's register tab is absent from
// the incoming workbook: the company-wide ratios (Rules 1 & 2) can stay above
// their thresholds because other members' data is intact, but Rule 3 fires as
// soon as any member with meaningful existing coverage contributes zero incoming
// rows for a month.
//
// When existing rows = 0 the guard is not applicable (first ingest) and is
// skipped with an INFO log.
//
// skipGuard is an explicit override for legitimate small loads (single-member
// re-sync, new FY bootstrap). It must be set by the caller explicitly — never
// defaulted, never read from an environment variable, never inferred.
//
// NOTE: the register loader uses customer as the "diversity" dimension
// (analogous to distributor in the SKU guard) because secondary_register_line
// does not carry a distributor column.

import { sql } from "drizzle-orm";
import { logger } from "../logger.js";
import {
  WipeGuardAbortError,
  GUARD_HEAD_MIN_ROWS,
  incomingMonthHeadStats,
} from "../sku/skuWipeGuard.js";

export { WipeGuardAbortError, GUARD_HEAD_MIN_ROWS };

export const GUARD_REG_ROWS_RATIO = 0.60;
export const GUARD_REG_CUSTOMER_RATIO = 0.70;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxOrDb = { execute: (q: any) => Promise<{ rows: any[] }> };

/**
 * Per-month distinct-customer count derived from the incoming batch.
 *
 * Returns a Map keyed by monthLabel → { rows, distinctCustomers }.
 * Rows with null/blank monthLabel are excluded (cannot match any DB month).
 */
export function incomingRegMonthStats(
  rows: Array<{ monthLabel: string | null; customer: string | null }>,
): Map<string, { rows: number; distinctCustomers: number }> {
  const rowCounts = new Map<string, number>();
  const custSets = new Map<string, Set<string>>();
  for (const r of rows) {
    const ml = r.monthLabel;
    if (!ml) continue;
    rowCounts.set(ml, (rowCounts.get(ml) ?? 0) + 1);
    const norm = (r.customer ?? "").trim().toLowerCase();
    if (norm) {
      if (!custSets.has(ml)) custSets.set(ml, new Set());
      custSets.get(ml)!.add(norm);
    }
  }
  const result = new Map<string, { rows: number; distinctCustomers: number }>();
  for (const [ml, n] of rowCounts) {
    result.set(ml, { rows: n, distinctCustomers: custSets.get(ml)?.size ?? 0 });
  }
  return result;
}

/**
 * Assert that the incoming batch is not implausibly smaller than what is
 * already in secondary_register_line for this FY.
 *
 * @param tx                 Drizzle transaction or db — used to read existing
 *                           counts inside the same isolation context.
 * @param fy                 FY being loaded, e.g. "2026-27".
 * @param incoming           All rows the caller intends to insert (full parsed set).
 * @param skipGuard          Explicit override.  Must NEVER be a default or env var.
 * @param callerLabel        Human-readable label for who/what set skipGuard (always logged).
 * @param sourceLike         Optional LIKE pattern to restrict the existing-row query to
 *                           the same source being loaded (e.g. 'sheets').
 *                           When omitted, all sources for the FY are counted.
 * @param memberGuardEnabled Explicit flag: set true when the caller supplies the head
 *                           dimension in every incoming row.  Rule 3 (per-member drop
 *                           check) runs if and only if this is true.  This MUST be set
 *                           deliberately by the caller — never inferred from whether any
 *                           incoming row happens to have a non-null head value, because
 *                           a malformed workbook that loses the head column produces
 *                           rows with null heads and would silently disable Rule 3
 *                           through the inference path.
 */
export async function assertRegisterWipeGuard(opts: {
  tx: TxOrDb;
  fy: string;
  incoming: Array<{ monthLabel: string | null; customer: string | null; head?: string | null }>;
  skipGuard: boolean;
  callerLabel: string;
  sourceLike?: string;
  memberGuardEnabled?: boolean;
}): Promise<void> {
  const { tx, fy, incoming, skipGuard, callerLabel, sourceLike, memberGuardEnabled } = opts;

  // Query existing per-month stats so we can compare against them.
  const existingRes = await tx.execute(
    sourceLike
      ? sql`
          SELECT month_label,
                 COUNT(*)::int                                      AS rows,
                 COUNT(DISTINCT NULLIF(TRIM(customer), ''))::int    AS customers
          FROM   secondary_register_line
          WHERE  fy         = ${fy}
            AND  source LIKE ${sourceLike}
          GROUP  BY month_label
        `
      : sql`
          SELECT month_label,
                 COUNT(*)::int                                      AS rows,
                 COUNT(DISTINCT NULLIF(TRIM(customer), ''))::int    AS customers
          FROM   secondary_register_line
          WHERE  fy = ${fy}
          GROUP  BY month_label
        `,
  );

  const existingRows: Array<{ month_label: string; rows: number; customers: number }> =
    existingRes.rows as any;
  const totalExisting = existingRows.reduce((s, r) => s + r.rows, 0);

  if (totalExisting === 0) {
    logger.info(
      { fy, sourceLike: sourceLike ?? "all" },
      "register wipe guard: not applicable — zero existing rows (first ingest)",
    );
    return;
  }

  if (skipGuard) {
    const incomingTotal = incoming.filter((r) => r.monthLabel).length;
    logger.warn(
      { fy, callerLabel, incomingTotal, existingTotal: totalExisting, sourceLike: sourceLike ?? "all" },
      "register wipe guard: SKIPPED via explicit override — override use logged",
    );
    return;
  }

  const incMap = incomingRegMonthStats(incoming);

  for (const exRow of existingRows) {
    const ml = exRow.month_label;
    const exRows = exRow.rows;
    const exCust = exRow.customers;
    const inc = incMap.get(ml) ?? { rows: 0, distinctCustomers: 0 };

    // Rule 1: row ratio
    if (inc.rows < GUARD_REG_ROWS_RATIO * exRows) {
      logger.error(
        {
          fy, month: ml, sourceLike: sourceLike ?? "all",
          existingRows: exRows, incomingRows: inc.rows,
          ratio: (inc.rows / exRows).toFixed(3),
          threshold: GUARD_REG_ROWS_RATIO,
        },
        "register wipe guard ABORT — incoming rows below threshold; insert will not proceed",
      );
      throw new WipeGuardAbortError(
        fy, ml, "rows", exRows, inc.rows, inc.rows / exRows, GUARD_REG_ROWS_RATIO,
      );
    }

    // Rule 2: distinct customer ratio (skipped when existing has none)
    if (exCust > 0 && inc.distinctCustomers < GUARD_REG_CUSTOMER_RATIO * exCust) {
      logger.error(
        {
          fy, month: ml, sourceLike: sourceLike ?? "all",
          existingCustomers: exCust, incomingCustomers: inc.distinctCustomers,
          ratio: (inc.distinctCustomers / exCust).toFixed(3),
          threshold: GUARD_REG_CUSTOMER_RATIO,
        },
        "register wipe guard ABORT — incoming distinct customers below threshold; insert will not proceed",
      );
      throw new WipeGuardAbortError(
        fy, ml, "distributors",
        exCust, inc.distinctCustomers, inc.distinctCustomers / exCust,
        GUARD_REG_CUSTOMER_RATIO,
      );
    }
  }

  // Rule 3: per-member (head_canon) check.
  //
  // Even when Rules 1 & 2 pass company-wide, a single member's register tab
  // could be absent from the incoming workbook.  Because other members' rows
  // are intact, the aggregate ratio stays above 0.60× and Rules 1/2 never
  // fire.  Rule 3 catches this by checking each (month, head_canon) pair that
  // had meaningful existing rows (≥ GUARD_HEAD_MIN_ROWS) independently.
  //
  // Activation is controlled by the explicit memberGuardEnabled flag — never
  // inferred from whether incoming rows happen to have non-null head values.
  if (memberGuardEnabled) {
    const headRes = await tx.execute(
      sourceLike
        ? sql`
            SELECT month_label,
                   LOWER(TRIM(COALESCE(head_canon, ''))) AS head_norm,
                   COUNT(*)::int                          AS rows
            FROM   secondary_register_line
            WHERE  fy         = ${fy}
              AND  source LIKE ${sourceLike}
              AND  TRIM(COALESCE(head_canon, '')) <> ''
            GROUP  BY month_label, head_norm
            HAVING COUNT(*) >= ${GUARD_HEAD_MIN_ROWS}
          `
        : sql`
            SELECT month_label,
                   LOWER(TRIM(COALESCE(head_canon, ''))) AS head_norm,
                   COUNT(*)::int                          AS rows
            FROM   secondary_register_line
            WHERE  fy = ${fy}
              AND  TRIM(COALESCE(head_canon, '')) <> ''
            GROUP  BY month_label, head_norm
            HAVING COUNT(*) >= ${GUARD_HEAD_MIN_ROWS}
          `,
    );

    const existingHeadRows: Array<{ month_label: string; head_norm: string; rows: number }> =
      headRes.rows as any;

    const incHeadMap = incomingMonthHeadStats(
      incoming.map((r) => ({ monthLabel: r.monthLabel, head: r.head ?? null })),
    );

    for (const eh of existingHeadRows) {
      const key = `${eh.month_label}|${eh.head_norm}`;
      const incCount = incHeadMap.get(key) ?? 0;
      if (incCount === 0) {
        logger.error(
          {
            fy,
            month: eh.month_label,
            head: eh.head_norm,
            sourceLike: sourceLike ?? "all",
            existingRows: eh.rows,
            incomingRows: 0,
            threshold: GUARD_HEAD_MIN_ROWS,
          },
          "register wipe guard ABORT — member has existing rows but zero incoming rows; insert will not proceed",
        );
        throw new WipeGuardAbortError(
          fy,
          eh.month_label,
          "member",
          eh.rows,
          0,
          0,
          GUARD_HEAD_MIN_ROWS,
          eh.head_norm,
        );
      }
    }
  }

  logger.info(
    { fy, existingTotal: totalExisting, months: existingRows.length, sourceLike: sourceLike ?? "all" },
    "register wipe guard: PASS",
  );
}
