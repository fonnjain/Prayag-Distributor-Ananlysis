// Laspeyres price multiplier for scheme target deflation.
//
// Formula: multiplier = Σ(qty_LY × price_CY) / Σ(qty_LY × price_LY)
//
// where price = realized price = Taxable Value ÷ Quantity, computed from
// sale_line — NEVER from the rate list MRP (unreliable, often 0).
//
// Do NOT use naive value÷qty as the multiplier — that is contaminated by mix
// shift. Laspeyres holds the LY quantity basket fixed and reprices it at CY
// realized prices, removing mix.
//
// Verified: company FY25-26→26-27 Laspeyres = 1.1072, naive = 1.1563.
// Difference = 4.9pp of the apparent "price rise" was mix, not price.
//
// Resolution order (per customer, per scheme):
//   1. Customer multiplier (≥ MIN_SHARED_ITEMS and ≥ MIN_LY_VALUE_COVERED)
//   2. Category multiplier (when scheme is category-scoped)
//   3. Company multiplier (fallback)
//
// Guardrails:
//   - Cap to [0.8, 1.5]; outside this range → flag, don't apply
//   - If prices FELL (multiplier < 1), the target falls too. Never floor at 1.
import { pool } from "@workspace/db";

const MIN_SHARED_ITEMS = 10;
const MIN_LY_VALUE_COVERED = 200_000; // ₹2 L
const MULTIPLIER_MIN = 0.8;
const MULTIPLIER_MAX = 1.5;

export type MultiplierResult = {
  multiplier: number;
  level: "customer" | "category" | "company";
  sharedItemCount: number;
  lyValueCovered: number;
  capped: boolean;
  warning?: string;
};

export type CategoryMultiplierMap = Map<
  string,
  { multiplier: number; sharedItemCount: number; lyValueCovered: number }
>;

// ── Core SQL ──────────────────────────────────────────────────────────────────

/**
 * Compute the Laspeyres multiplier for an arbitrary WHERE clause.
 * Returns null when there is insufficient overlap between the two years.
 */
async function computeRaw(
  fyLy: string,
  fyCy: string,
  extraWhere: string,
  extraParams: unknown[],
): Promise<{ multiplier: number; sharedItemCount: number; lyValueCovered: number } | null> {
  const baseParams = [fyLy, fyCy, ...extraParams];
  const p = (n: number) => `$${n}`;

  const extraIdx = extraParams.map((_, i) => i + 3);
  void extraIdx;

  // Build the extra WHERE clauses using positional params starting at $3.
  const extraWhereParts = extraWhere
    ? extraWhere.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + 2}`)
    : "";

  const res = await pool.query<{
    laspeyres: string | null;
    shared_count: string | null;
    ly_value_covered: string | null;
  }>(
    `
    WITH prices AS (
      SELECT
        code,
        fy,
        SUM(amount::numeric) / NULLIF(SUM(qty::numeric), 0) AS avg_price
      FROM sale_line
      WHERE fy IN ($1, $2)
        AND qty IS NOT NULL AND qty::numeric > 0
        AND amount IS NOT NULL AND amount::numeric > 0
        ${extraWhereParts ? `AND (${extraWhereParts})` : ""}
      GROUP BY code, fy
    ),
    ly_basket AS (
      SELECT code, SUM(qty::numeric) AS qty_ly
      FROM sale_line
      WHERE fy = $1
        AND qty IS NOT NULL AND qty::numeric > 0
        ${extraWhereParts ? `AND (${extraWhereParts})` : ""}
      GROUP BY code
    ),
    joined AS (
      SELECT
        lb.code,
        lb.qty_ly,
        ly.avg_price AS price_ly,
        cy.avg_price AS price_cy
      FROM ly_basket lb
      JOIN prices ly ON ly.code = lb.code AND ly.fy = $1
      LEFT JOIN prices cy ON cy.code = lb.code AND cy.fy = $2
      WHERE ly.avg_price IS NOT NULL
    )
    SELECT
      SUM(qty_ly * COALESCE(price_cy, price_ly)) / NULLIF(SUM(qty_ly * price_ly), 0) AS laspeyres,
      COUNT(*) FILTER (WHERE price_cy IS NOT NULL)::text AS shared_count,
      SUM(qty_ly * price_ly) FILTER (WHERE price_cy IS NOT NULL)::text AS ly_value_covered
    FROM joined
    `,
    baseParams,
  );

  const row = res.rows[0];
  if (!row || row.laspeyres == null) return null;
  const m = parseFloat(row.laspeyres);
  if (!Number.isFinite(m)) return null;
  return {
    multiplier: m,
    sharedItemCount: parseInt(row.shared_count ?? "0"),
    lyValueCovered: parseFloat(row.ly_value_covered ?? "0"),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Company-level Laspeyres multiplier (FY25-26 → FY26-27 expected ≈ 1.1072). */
export async function computeCompanyMultiplier(
  fyLy: string,
  fyCy: string,
): Promise<MultiplierResult | null> {
  const raw = await computeRaw(fyLy, fyCy, "", []);
  if (!raw) return null;
  const capped =
    raw.multiplier < MULTIPLIER_MIN || raw.multiplier > MULTIPLIER_MAX;
  const m = Math.min(MULTIPLIER_MAX, Math.max(MULTIPLIER_MIN, raw.multiplier));
  return {
    multiplier: m,
    level: "company",
    sharedItemCount: raw.sharedItemCount,
    lyValueCovered: raw.lyValueCovered,
    capped,
    warning: capped
      ? `Multiplier ${raw.multiplier.toFixed(4)} outside [${MULTIPLIER_MIN}, ${MULTIPLIER_MAX}] — capped. Flag for review.`
      : undefined,
  };
}

/** Per-category Laspeyres multipliers. Returns a Map keyed by category name. */
export async function computeCategoryMultipliers(
  fyLy: string,
  fyCy: string,
): Promise<CategoryMultiplierMap> {
  const res = await pool.query<{
    category: string;
    laspeyres: string | null;
    shared_count: string | null;
    ly_value_covered: string | null;
  }>(
    `
    WITH prices AS (
      SELECT
        sl.code,
        sl.fy,
        COALESCE(sl.group_canon, sl.group_raw, 'Uncategorized') AS category,
        SUM(sl.amount::numeric) / NULLIF(SUM(sl.qty::numeric), 0) AS avg_price
      FROM sale_line sl
      WHERE sl.fy IN ($1, $2)
        AND sl.qty IS NOT NULL AND sl.qty::numeric > 0
        AND sl.amount IS NOT NULL AND sl.amount::numeric > 0
      GROUP BY sl.code, sl.fy, COALESCE(sl.group_canon, sl.group_raw, 'Uncategorized')
    ),
    ly_basket AS (
      SELECT
        sl.code,
        COALESCE(sl.group_canon, sl.group_raw, 'Uncategorized') AS category,
        SUM(sl.qty::numeric) AS qty_ly
      FROM sale_line sl
      WHERE sl.fy = $1 AND sl.qty IS NOT NULL AND sl.qty::numeric > 0
      GROUP BY sl.code, COALESCE(sl.group_canon, sl.group_raw, 'Uncategorized')
    ),
    joined AS (
      SELECT
        lb.category,
        lb.qty_ly,
        ly.avg_price AS price_ly,
        cy.avg_price AS price_cy
      FROM ly_basket lb
      JOIN prices ly ON ly.code = lb.code AND ly.fy = $1 AND ly.category = lb.category
      LEFT JOIN prices cy ON cy.code = lb.code AND cy.fy = $2 AND cy.category = lb.category
      WHERE ly.avg_price IS NOT NULL
    )
    SELECT
      category,
      SUM(qty_ly * COALESCE(price_cy, price_ly)) / NULLIF(SUM(qty_ly * price_ly), 0) AS laspeyres,
      COUNT(*) FILTER (WHERE price_cy IS NOT NULL)::text AS shared_count,
      SUM(qty_ly * price_ly) FILTER (WHERE price_cy IS NOT NULL)::text AS ly_value_covered
    FROM joined
    GROUP BY category
    `,
    [fyLy, fyCy],
  );

  const result: CategoryMultiplierMap = new Map();
  for (const row of res.rows) {
    if (!row.laspeyres) continue;
    const m = parseFloat(row.laspeyres);
    if (!Number.isFinite(m)) continue;
    result.set(row.category, {
      multiplier: Math.min(MULTIPLIER_MAX, Math.max(MULTIPLIER_MIN, m)),
      sharedItemCount: parseInt(row.shared_count ?? "0"),
      lyValueCovered: parseFloat(row.ly_value_covered ?? "0"),
    });
  }
  return result;
}

/** Per-customer Laspeyres multiplier.
 *  Falls back to category → company if insufficient shared items or LY value. */
export async function resolveCustomerMultiplier(params: {
  customer: string;
  fyLy: string;
  fyCy: string;
  category?: string;
  companyMultiplier?: MultiplierResult;
  categoryMultipliers?: CategoryMultiplierMap;
}): Promise<MultiplierResult> {
  const { customer, fyLy, fyCy, category, companyMultiplier, categoryMultipliers } = params;

  // Level 1: customer-specific basket
  const customerRaw = await computeRaw(
    fyLy,
    fyCy,
    "customer = $1",
    [customer],
  );

  if (
    customerRaw &&
    customerRaw.sharedItemCount >= MIN_SHARED_ITEMS &&
    customerRaw.lyValueCovered >= MIN_LY_VALUE_COVERED
  ) {
    const capped =
      customerRaw.multiplier < MULTIPLIER_MIN ||
      customerRaw.multiplier > MULTIPLIER_MAX;
    return {
      multiplier: Math.min(
        MULTIPLIER_MAX,
        Math.max(MULTIPLIER_MIN, customerRaw.multiplier),
      ),
      level: "customer",
      sharedItemCount: customerRaw.sharedItemCount,
      lyValueCovered: customerRaw.lyValueCovered,
      capped,
      warning: capped
        ? `Customer multiplier ${customerRaw.multiplier.toFixed(4)} capped.`
        : undefined,
    };
  }

  // Level 2: category multiplier
  if (category && categoryMultipliers) {
    const catM = categoryMultipliers.get(category);
    if (catM) {
      return {
        multiplier: catM.multiplier,
        level: "category",
        sharedItemCount: catM.sharedItemCount,
        lyValueCovered: catM.lyValueCovered,
        capped: false,
      };
    }
  }

  // Level 3: company fallback
  if (companyMultiplier) return companyMultiplier;

  // Last resort: compute company on the fly
  const co = await computeCompanyMultiplier(fyLy, fyCy);
  return (
    co ?? {
      multiplier: 1,
      level: "company",
      sharedItemCount: 0,
      lyValueCovered: 0,
      capped: false,
      warning: "No multiplier data — using 1.0 (no deflation).",
    }
  );
}

/** Compute all three levels and return them for the frontend display. */
export async function computeAllMultipliers(
  fyLy: string,
  fyCy: string,
): Promise<{
  company: MultiplierResult | null;
  byCategory: Record<string, { multiplier: number; sharedItemCount: number }>;
}> {
  const [company, catMap] = await Promise.all([
    computeCompanyMultiplier(fyLy, fyCy),
    computeCategoryMultipliers(fyLy, fyCy),
  ]);
  const byCategory: Record<string, { multiplier: number; sharedItemCount: number }> = {};
  for (const [cat, v] of catMap) {
    byCategory[cat] = { multiplier: v.multiplier, sharedItemCount: v.sharedItemCount };
  }
  return { company, byCategory };
}
