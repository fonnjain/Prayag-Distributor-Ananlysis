// backfillChannel.ts — channel enrichment for sale_line_all rows written by
// the Sheets register ingest (which always writes channel = NULL by design).
//
// The Sheets sync is decoupled from the rate-list lookup for correctness
// reasons (the register is a pure dispatch record; channel is a party-level
// attribute from the rate-list Sheet2). This module bridges the two so that
// channel is annotated immediately at the end of every sync that writes rows,
// rather than requiring a separate manual admin call.
//
// JOIN KEY: normParty(customer name) → channel from Sheet2.
//   No item code is involved. Sheet2 has one row per party; the customer column
//   from sale_line_all is normalised with normParty() on both sides.
//
// RESIDUAL SEMANTICS: customers with no Sheet2 match receive NULL channel and
// are named in the warning log. NULL is never a fallback — it means the party
// is genuinely absent from the rate-list customer master.
import { getRateListMaps, matchCustomer } from "./rateList.js";
import { normalizeChannel } from "./derive.js";
import { logger } from "../logger.js";
import { pool } from "@workspace/db";

export interface BackfillChannelResult {
  fys: string[];
  distinctNullCustomers: number;
  resolved: number;
  residualCount: number;
  /** Names of customers still NULL after backfill — genuinely absent from Sheet2. */
  residualCustomers: string[];
}

/**
 * Resolve NULL-channel rows in sale_line_all for the given FYs.
 *
 * Safe to call after every open-FY sync:
 *   - Only touches rows where channel IS NULL (idempotent on already-set rows).
 *   - Never changes row count or amount.
 *   - Logs residual customers (genuinely absent from Sheet2) as WARN.
 *   - Logs zero-residual completion as INFO.
 */
export async function backfillSaleChannel(
  fys: string[],
): Promise<BackfillChannelResult> {
  // Load rate-list customer map (30-min TTL, concurrent-safe via the existing
  // inflight coalescing in rateList.ts).
  const maps = await getRateListMaps();

  // Fetch every distinct customer that still has NULL channel in these FYs.
  const { rows: nullRows } = await pool.query<{ customer: string }>(
    `SELECT DISTINCT customer
       FROM sale_line_all
      WHERE fy = ANY($1::text[])
        AND channel IS NULL
        AND customer IS NOT NULL`,
    [fys],
  );

  if (nullRows.length === 0) {
    logger.info({ fys }, "channel backfill: no NULL-channel rows — nothing to do");
    return { fys, distinctNullCustomers: 0, resolved: 0, residualCount: 0, residualCustomers: [] };
  }

  const BATCH = 500;
  const updates: { channel: string; customer: string }[] = [];
  const residualCustomers: string[] = [];

  for (const { customer } of nullRows) {
    const info = matchCustomer(customer, maps);
    const ch = normalizeChannel(info?.channel ?? null);
    if (ch !== null) {
      updates.push({ channel: ch, customer });
    } else {
      residualCustomers.push(customer);
    }
  }

  // Batch-UPDATE in groups of 500 to stay within query-plan limits.
  for (let i = 0; i < updates.length; i += BATCH) {
    const batch = updates.slice(i, i + BATCH);
    const vals = batch
      .map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2}::text)`)
      .join(", ");
    const params: string[] = batch.flatMap(({ customer, channel }) => [customer, channel]);
    await pool.query(
      `UPDATE sale_line_all AS sl
          SET channel = v.channel
         FROM (VALUES ${vals}) AS v(customer, channel)
        WHERE sl.customer = v.customer
          AND sl.fy = ANY($${params.length + 1}::text[])
          AND sl.channel IS NULL`,
      [...params, fys],
    );
  }

  // ── Assertion ─────────────────────────────────────────────────────────────
  // After every sync the open-FY should have zero NULL-channel rows except for
  // customers genuinely absent from Sheet2. Log residual names so the team can
  // decide whether to add them to the rate-list master.
  if (residualCustomers.length > 0) {
    logger.warn(
      {
        fys,
        distinctNullIn: nullRows.length,
        resolved: updates.length,
        residualCount: residualCustomers.length,
        residualCustomers,
      },
      "channel backfill: residual NULL-channel customers — these are genuinely absent from rate-list Sheet2; add them to the customer master to resolve",
    );
  } else {
    logger.info(
      { fys, distinctNullIn: nullRows.length, resolved: updates.length },
      "channel backfill: complete — zero residual NULL-channel customers",
    );
  }

  return {
    fys,
    distinctNullCustomers: nullRows.length,
    resolved: updates.length,
    residualCount: residualCustomers.length,
    residualCustomers,
  };
}
