// Phase 6: Dormant / win-back list from secondary_register_line.
//
// Returns retailers/customers who had Order Booking or Sale in FY2024-25 or
// FY2025-26 for the selected member, but are NOT present in the member's
// current working-sheet customer list (FY2026-27 Phase 2 data).
//
// Rules:
//  - Match head by regexp_replace(head_canon) = normKey (same as Phase 5).
//  - Customer name normalisation: lowercase, strip punctuation and spaces.
//  - Live FY with no register yet: return an empty list (not null) + a note.
//  - Never console.log; use logger.

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../logger.js";

export type WinBackItem = {
  customer: string;
  lastActiveFy: string;
  lastActiveMonth: string;
  lastNet: number;
};

type WinBackResult = {
  items: WinBackItem[];
  note: string | null;
};

type RegRow = {
  customer: string | null;
  fy: string;
  last_month: string;
  total_net: string | null;
};

// Normalise a customer name for comparison: lowercase + remove non-alphanum.
function normCust(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function computeWinBack(
  normKey: string,
  currentCustomers: string[],
): Promise<WinBackResult> {
  // Past-FY customers from secondary_register_line.
  const result = await db.execute<RegRow>(sql`
    SELECT
      customer,
      fy,
      max(month_label) AS last_month,
      sum(net_amount)::text AS total_net
    FROM   secondary_register_line
    WHERE  lower(regexp_replace(head_canon, '[^a-zA-Z0-9]', '', 'g')) = ${normKey}
      AND  fy IN ('2024-25', '2025-26')
      AND  customer IS NOT NULL
    GROUP BY customer, fy
    ORDER BY fy DESC, sum(net_amount) DESC NULLS LAST
  `);

  if (result.rows.length === 0) {
    logger.info({ normKey }, "winBack: no past-FY register rows for member");
    return { items: [], note: "No past secondary register data found for this member." };
  }

  // Build a set of normalised current-customer names.
  const currentSet = new Set(currentCustomers.map(normCust));

  // For each past customer, keep the most recent FY appearance (rows are
  // already ordered fy DESC so the first occurrence per customer is best).
  const seen = new Set<string>();
  const dormant: WinBackItem[] = [];

  for (const row of result.rows) {
    if (!row.customer) continue;
    const nc = normCust(row.customer);
    if (seen.has(nc)) continue;
    seen.add(nc);

    if (!currentSet.has(nc)) {
      dormant.push({
        customer: row.customer,
        lastActiveFy: row.fy,
        lastActiveMonth: row.last_month,
        lastNet: Math.round(Number(row.total_net ?? 0)),
      });
    }
  }

  logger.info(
    { normKey, pastCustomers: result.rows.length, dormant: dormant.length },
    "winBack: computed",
  );

  return {
    items: dormant,
    note:
      dormant.length === 0
        ? "All past customers appear in the current working sheet — no win-backs needed."
        : null,
  };
}
