// skuWipeGuard.ts — pre-delete ratio guard for secondary_sku_line full-FY replaces.
//
// Called INSIDE the write transaction, BEFORE the DELETE statement.
// On a ratio violation it throws WipeGuardAbortError, which propagates out of
// the transaction callback and causes Drizzle to issue a ROLLBACK automatically.
// Nothing is deleted and nothing is inserted.
//
// Three rules, applied per month using the dates already parsed from the source:
//
//   Rule 1: incoming rows       < 0.60 × existing rows            → ABORT
//   Rule 2: incoming distinct
//             distributors      < 0.70 × existing distinct         → ABORT
//   Rule 3: any (month, head_canon) pair that had ≥ GUARD_HEAD_MIN_ROWS
//             existing rows has 0 incoming rows for that head      → ABORT
//             (per-member silent-drop guard)
//
// Rule 3 catches the case where a single member's PSCode2 tab is absent from
// the workbook: the company-wide ratios (Rules 1 & 2) can stay above their
// thresholds because other members' data is intact, but Rule 3 fires as soon as
// any member with meaningful existing coverage contributes zero incoming rows
// for a month.
//
// A batch that is fine in aggregate but thin for one specific month (e.g. "full
// August but only 50% of July") is refused by month, not just in total.
//
// When existing rows = 0 the guard is not applicable (first ingest) and
// is skipped with an INFO log.
//
// skipGuard is an explicit override for legitimate small loads (single-month
// re-sync, new FY bootstrap). It must be set by the caller explicitly — never
// defaulted, never read from an environment variable, never inferred.

import { sql } from "drizzle-orm";
import { logger } from "../logger.js";

export const GUARD_ROWS_RATIO = 0.60;
export const GUARD_DIST_RATIO = 0.70;

/**
 * Minimum existing rows a (month, head_canon) pair must have before Rule 3
 * is applied to it.  Members with fewer existing rows than this threshold are
 * ignored by the per-member check to avoid noise from tiny tails.
 */
export const GUARD_HEAD_MIN_ROWS = 10;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxOrDb = { execute: (q: any) => Promise<{ rows: any[] }> };

export class WipeGuardAbortError extends Error {
  constructor(
    public readonly fy: string,
    public readonly month: string,
    public readonly rule: "rows" | "distributors" | "member",
    public readonly existing: number,
    public readonly incoming: number,
    public readonly ratio: number,
    public readonly threshold: number,
    public readonly head?: string,
  ) {
    super(
      `wipe guard ABORT — ${fy} ${month} ${rule}` +
        (head ? ` head=${head}` : "") +
        `: incoming=${incoming} existing=${existing} ` +
        `ratio=${ratio.toFixed(3)} threshold=${threshold}`,
    );
    this.name = "WipeGuardAbortError";
  }
}

/** Per-month distinct-distributor count derived from the incoming batch. */
export function incomingMonthStats(
  rows: Array<{ monthLabel: string | null; distributor: string | null }>,
): Map<string, { rows: number; distinctDistributors: number }> {
  const rowCounts = new Map<string, number>();
  const distSets = new Map<string, Set<string>>();
  for (const r of rows) {
    const ml = r.monthLabel;
    if (!ml) continue;
    rowCounts.set(ml, (rowCounts.get(ml) ?? 0) + 1);
    const norm = (r.distributor ?? "").trim().toLowerCase();
    if (norm) {
      if (!distSets.has(ml)) distSets.set(ml, new Set());
      distSets.get(ml)!.add(norm);
    }
  }
  const result = new Map<string, { rows: number; distinctDistributors: number }>();
  for (const [ml, n] of rowCounts) {
    result.set(ml, { rows: n, distinctDistributors: distSets.get(ml)?.size ?? 0 });
  }
  return result;
}

/**
 * Per-month, per-head row count derived from the incoming batch.
 *
 * Returns a Map keyed by `"${monthLabel}|${headCanon}"` → row count.
 * Rows with a null/blank head are excluded (they cannot match a DB head entry).
 */
export function incomingMonthHeadStats(
  rows: Array<{ monthLabel: string | null; head: string | null }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const ml = r.monthLabel;
    const h = (r.head ?? "").trim().toLowerCase();
    if (!ml || !h) continue;
    const key = `${ml}|${h}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Assert that the incoming batch is not implausibly smaller than what is
 * already in secondary_sku_line for this FY.
 *
 * @param tx                 Drizzle transaction — must be the SAME tx that owns the
 *                           upcoming DELETE so the advisory lock is shared.
 * @param fy                 FY being replaced, e.g. "2026-27".
 * @param incoming           All rows the caller intends to insert (full parsed set).
 * @param skipGuard          Explicit override.  Must NEVER be a default or env var.
 * @param callerLabel        Human-readable label for who/what set skipGuard (always logged).
 * @param sourceLike         Optional LIKE pattern to restrict the existing-row query to
 *                           the same source being replaced (e.g. 'sheets_sku_backfill:%').
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
export async function assertSkuWipeGuard(opts: {
  tx: TxOrDb;
  fy: string;
  incoming: Array<{ monthLabel: string | null; distributor: string | null; head?: string | null }>;
  skipGuard: boolean;
  callerLabel: string;
  sourceLike?: string;
  memberGuardEnabled?: boolean;
}): Promise<void> {
  const { tx, fy, incoming, skipGuard, callerLabel, sourceLike, memberGuardEnabled } = opts;

  // Query existing per-month stats inside the same transaction so concurrent
  // writers cannot race between our read and the upcoming DELETE.
  const existingRes = await tx.execute(
    sourceLike
      ? sql`
          SELECT month_label,
                 COUNT(*)::int                                       AS rows,
                 COUNT(DISTINCT NULLIF(TRIM(distributor), ''))::int  AS distributors
          FROM   secondary_sku_line
          WHERE  fy         = ${fy}
            AND  source LIKE ${sourceLike}
          GROUP  BY month_label
        `
      : sql`
          SELECT month_label,
                 COUNT(*)::int                                       AS rows,
                 COUNT(DISTINCT NULLIF(TRIM(distributor), ''))::int  AS distributors
          FROM   secondary_sku_line
          WHERE  fy = ${fy}
          GROUP  BY month_label
        `,
  );

  const existingRows: Array<{ month_label: string; rows: number; distributors: number }> =
    existingRes.rows as any;
  const totalExisting = existingRows.reduce((s, r) => s + r.rows, 0);

  if (totalExisting === 0) {
    logger.info({ fy, sourceLike: sourceLike ?? "all" }, "wipe guard: not applicable — zero existing rows (first ingest)");
    return;
  }

  if (skipGuard) {
    const incomingTotal = incoming.filter((r) => r.monthLabel).length;
    logger.warn(
      { fy, callerLabel, incomingTotal, existingTotal: totalExisting, sourceLike: sourceLike ?? "all" },
      "wipe guard: SKIPPED via explicit override — override use logged",
    );
    return;
  }

  const incMap = incomingMonthStats(incoming);

  for (const exRow of existingRows) {
    const ml = exRow.month_label;
    const exRows = exRow.rows;
    const exDist = exRow.distributors;
    const inc = incMap.get(ml) ?? { rows: 0, distinctDistributors: 0 };

    // Rule 1: row ratio
    if (inc.rows < GUARD_ROWS_RATIO * exRows) {
      logger.error(
        {
          fy, month: ml, sourceLike: sourceLike ?? "all",
          existingRows: exRows, incomingRows: inc.rows,
          ratio: (inc.rows / exRows).toFixed(3),
          threshold: GUARD_ROWS_RATIO,
        },
        "wipe guard ABORT — incoming rows below threshold; transaction will roll back",
      );
      throw new WipeGuardAbortError(fy, ml, "rows", exRows, inc.rows, inc.rows / exRows, GUARD_ROWS_RATIO);
    }

    // Rule 2: distinct distributor ratio (skipped when existing has none)
    if (exDist > 0 && inc.distinctDistributors < GUARD_DIST_RATIO * exDist) {
      logger.error(
        {
          fy, month: ml, sourceLike: sourceLike ?? "all",
          existingDist: exDist, incomingDist: inc.distinctDistributors,
          ratio: (inc.distinctDistributors / exDist).toFixed(3),
          threshold: GUARD_DIST_RATIO,
        },
        "wipe guard ABORT — incoming distinct distributors below threshold; transaction will roll back",
      );
      throw new WipeGuardAbortError(fy, ml, "distributors", exDist, inc.distinctDistributors, inc.distinctDistributors / exDist, GUARD_DIST_RATIO);
    }
  }

  // Rule 3: per-member (head_canon) check.
  //
  // Even when Rules 1 & 2 pass company-wide, a single member's PSCode2 tab
  // could be absent from the incoming workbook.  Because other members' rows
  // are intact, the aggregate ratio stays above 0.60× and Rules 1/2 never
  // fire.  Rule 3 catches this by checking each (month, head_canon) pair that
  // had meaningful existing rows (≥ GUARD_HEAD_MIN_ROWS) independently.
  //
  // Activation is controlled by the explicit memberGuardEnabled flag set by
  // the caller — never inferred from whether incoming rows happen to have
  // non-null head values.  A malformed workbook that loses the head column
  // produces rows with all-null heads and would silently bypass Rule 3 if
  // activation used value-presence detection.  The loader must declare that
  // it is supplying the head dimension; the guard then checks regardless of
  // how many incoming heads are actually non-null.
  if (memberGuardEnabled) {
    // Fetch per-head existing counts (same source filter, same FY).
    const headRes = await tx.execute(
      sourceLike
        ? sql`
            SELECT month_label,
                   LOWER(TRIM(COALESCE(head_canon, ''))) AS head_norm,
                   COUNT(*)::int                          AS rows
            FROM   secondary_sku_line
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
            FROM   secondary_sku_line
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
          "wipe guard ABORT — member has existing rows but zero incoming rows; transaction will roll back",
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
    "wipe guard: PASS",
  );
}
