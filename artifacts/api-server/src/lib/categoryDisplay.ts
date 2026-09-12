import { pool } from "@workspace/db";

export const MASTER_CATEGORIES = [
  "PLUMBING",
  "PTMT",
  "C P",
  "SANITARYWARE",
  "SINK",
  "HARDWARE",
] as const;

export const MASTER_CATEGORY_DISPLAY_NOTE =
  "Master categories use each code's latest reviewed canonical_item_category_registry assignment for every FY; historical periods are shown under the current classification. Stored sales, frozen anchors, and effective-dated registry history are unchanged.";

const normCode = (value: string): string => value.trim().toUpperCase();

/**
 * Display classification deliberately differs from effective-dated registry
 * history: historical figures are regrouped under the latest reviewed master.
 * Revisit this rule if a genuine commercial reclassification (rather than a
 * correction) moves a code between masters.
 */
export async function loadLatestReviewedMasterByCode(
  codes: string[],
): Promise<Map<string, string>> {
  const requested = [...new Set(codes.map(normCode).filter(Boolean))];
  if (requested.length === 0) return new Map();
  const result = await pool.query<{ code: string; master_category: string }>(
    `
      SELECT DISTINCT ON (UPPER(BTRIM(item_code)))
        UPPER(BTRIM(item_code)) AS code,
        master_category
      FROM canonical_item_category_registry
      WHERE master_category IS NOT NULL
        AND UPPER(BTRIM(item_code)) = ANY($1::text[])
      ORDER BY UPPER(BTRIM(item_code)), effective_from DESC NULLS LAST, id DESC
    `,
    [requested],
  );
  return new Map(result.rows.map((row) => [row.code, row.master_category]));
}

export function rollUpMarginRows(
  rows: Array<{ code: string; revenue: number; cost: number }>,
  masterByCode: ReadonlyMap<string, string>,
): Array<{ group: string; revenue: number; cost: number }> {
  const grouped = new Map<string, { revenue: number; cost: number }>();
  for (const row of rows) {
    const group = masterByCode.get(normCode(row.code)) ?? "Unmapped";
    const current = grouped.get(group) ?? { revenue: 0, cost: 0 };
    current.revenue += Number(row.revenue);
    current.cost += Number(row.cost);
    grouped.set(group, current);
  }
  return [...grouped.entries()].map(([group, totals]) => ({ group, ...totals }));
}

export function latestReviewedMasterJoinSql(
  saleAlias: string,
  registryAlias = "registry_master",
): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(saleAlias) || !/^[a-z_][a-z0-9_]*$/i.test(registryAlias)) {
    throw new Error("SQL aliases must be simple identifiers");
  }
  return `
    LEFT JOIN LATERAL (
      SELECT r.master_category, r.canonical_category
      FROM canonical_item_category_registry r
      WHERE UPPER(BTRIM(r.item_code)) = UPPER(BTRIM(${saleAlias}.code))
        AND r.master_category IS NOT NULL
      ORDER BY r.effective_from DESC NULLS LAST, r.id DESC
      LIMIT 1
    ) ${registryAlias} ON TRUE
  `;
}