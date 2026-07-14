// Customer Performance analytics — query sale_line directly.
//
// RULE ZERO: Every function leads with QUANTITY (pcs). Value is alongside, never instead.
// Realized price = amount / qty — NEVER the rate list's MRP (unreliable, often 0).
// Never compare consecutive months — only same-month-prior-year.
// Primary (distributor/dealer) and secondary (retailer) are never summed.
//
// Month label format: "Apr-26", "Jan-27". Year suffix is the calendar year (Apr-26 = Apr 2026).
// LY conversion: "Apr-26" → "Apr-25" (same month name, year suffix −1).
import { pool } from "@workspace/db";
import { isMonthComplete } from "../analytics/analytics.js";

// ── Month helpers ─────────────────────────────────────────────────────────────

const MONTH_ORDER = [
  "Apr", "May", "Jun", "Jul", "Aug", "Sep",
  "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
] as const;

/** Convert CY month labels to the corresponding LY month labels (same month, year −1). */
export function toLyMonths(cyMonths: string[]): string[] {
  return cyMonths.map((m) => {
    const name = m.slice(0, 4); // "Apr-"
    const yy = parseInt(m.slice(4), 10);
    return `${name}${yy - 1}`;
  });
}

/** Parse "Apr-26" → { monthName: "Apr", calendarYear: 2026, fyIndex: 0 } */
export function parseMonthLabel(
  label: string,
): { monthName: string; calendarYear: number; fyIndex: number } | null {
  const name = label.slice(0, 3);
  const idx = (MONTH_ORDER as readonly string[]).indexOf(name);
  if (idx === -1) return null;
  const yy = parseInt(label.slice(4), 10);
  if (!Number.isFinite(yy)) return null;
  return { monthName: name, calendarYear: 2000 + yy, fyIndex: idx };
}

/** All distinct month labels present in the DB for a given FY, in fiscal order. */
export async function getAvailableMonths(fy: string): Promise<string[]> {
  const res = await pool.query<{ month_label: string }>(
    `SELECT DISTINCT month_label FROM sale_line WHERE fy = $1 AND month_label IS NOT NULL`,
    [fy],
  );
  const labels = res.rows.map((r) => r.month_label);
  labels.sort((a, b) => {
    const pa = parseMonthLabel(a);
    const pb = parseMonthLabel(b);
    if (!pa || !pb) return 0;
    return pa.fyIndex - pb.fyIndex;
  });
  return labels;
}

/**
 * Complete month labels for a FY — months whose last calendar day has passed
 * (or whose max invoice date reaches the last day of the month). Partial /
 * in-progress months are excluded. Returns labels in fiscal order.
 */
export async function getCompleteMonths(fy: string): Promise<string[]> {
  const res = await pool.query<{ month_label: string; max_date: string | null }>(
    `SELECT month_label, max(invoice_date)::text AS max_date
     FROM sale_line
     WHERE fy = $1 AND month_label IS NOT NULL
     GROUP BY month_label`,
    [fy],
  );
  const labels = res.rows
    .filter((r) => isMonthComplete(r.month_label, r.max_date))
    .map((r) => r.month_label);
  labels.sort((a, b) => {
    const pa = parseMonthLabel(a);
    const pb = parseMonthLabel(b);
    if (!pa || !pb) return 0;
    return pa.fyIndex - pb.fyIndex;
  });
  return labels;
}

/** Infer entity type from typeRaw. Primary register distinguishes distributors from direct dealers. */
export function classifyEntityType(
  typeRaw: string | null,
): "distributor" | "direct_dealer" | "unknown" {
  if (!typeRaw) return "distributor";
  const t = typeRaw.trim().toLowerCase();
  if (t.includes("direct") || t.includes("dealer")) return "direct_dealer";
  return "distributor";
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type EntityType = "all" | "distributor" | "direct_dealer" | "retailer";

export type CustomerRow = {
  customer: string;
  entityType: "distributor" | "direct_dealer" | "retailer" | "unknown";
  state: string | null;         // dominant state from state_canon (MAX per customer)
  qtyCy: number;
  valCy: number;
  qtyLy: number;
  valLy: number;
  priceCy: number | null;   // realized price CY = valCy / qtyCy
  priceLy: number | null;   // realized price LY
  qtyGrowthPct: number | null;
  valGrowthPct: number | null;
  priceChangePct: number | null;
  priceEffectPp: number | null; // = valGrowthPct − qtyGrowthPct
  revenueUpVolumeDown: boolean; // hidden shrinker flag
};

export type CategoryRow = {
  customer: string;
  category: string;
  qtyCy: number;
  valCy: number;
  qtyLy: number;
  valLy: number;
  priceCy: number | null;
  priceLy: number | null;
  qtyGrowthPct: number | null;
  valGrowthPct: number | null;
  priceChangePct: number | null;
  priceEffectPp: number | null;
  revenueUpVolumeDown: boolean;
};

export type ProductRow = {
  customer: string;
  category: string;
  code: string;
  itemName: string | null;
  qtyCy: number;
  valCy: number;
  qtyLy: number;
  valLy: number;
  priceCy: number | null;
  priceLy: number | null;
  qtyGrowthPct: number | null;
  valGrowthPct: number | null;
  priceChangePct: number | null;
  priceEffectPp: number | null;
  revenueUpVolumeDown: boolean;
};

export type ChurnRow = {
  customer: string;
  entityType: "distributor" | "direct_dealer" | "retailer" | "unknown";
  lastOrderDate: string | null;
  qtyLy: number;
  valLy: number;
  monthsOrdered: number;
};

export type ShrinkerRow = {
  customer: string;
  category: string | null;
  code: string | null;
  itemName: string | null;
  qtyCy: number;
  valCy: number;
  qtyLy: number;
  valLy: number;
  qtyGrowthPct: number;
  valGrowthPct: number;
  priceChangePct: number | null;
  priceEffectPp: number | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeN(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function growthPct(cy: number, ly: number): number | null {
  if (ly <= 0) return null;
  return ((cy - ly) / ly) * 100;
}

function realizedPrice(val: number, qty: number): number | null {
  if (qty <= 0) return null;
  return val / qty;
}

function buildCustomerRow(r: {
  customer: string;
  type_raw: string | null;
  state_canon: string | null;
  qty_cy: unknown;
  val_cy: unknown;
  qty_ly: unknown;
  val_ly: unknown;
}): CustomerRow {
  const qtyCy = safeN(r.qty_cy);
  const valCy = safeN(r.val_cy);
  const qtyLy = safeN(r.qty_ly);
  const valLy = safeN(r.val_ly);
  const priceCy = realizedPrice(valCy, qtyCy);
  const priceLy = realizedPrice(valLy, qtyLy);
  const qtyGrowthPct = growthPct(qtyCy, qtyLy);
  const valGrowthPct = growthPct(valCy, valLy);
  const priceChangePct =
    priceCy != null && priceLy != null ? growthPct(priceCy, priceLy) : null;
  const priceEffectPp =
    valGrowthPct != null && qtyGrowthPct != null
      ? valGrowthPct - qtyGrowthPct
      : null;
  return {
    customer: r.customer,
    entityType: classifyEntityType(r.type_raw),
    state: r.state_canon ?? null,
    qtyCy,
    valCy,
    qtyLy,
    valLy,
    priceCy,
    priceLy,
    qtyGrowthPct,
    valGrowthPct,
    priceChangePct,
    priceEffectPp,
    revenueUpVolumeDown: qtyCy < qtyLy && valCy > valLy,
  };
}

// ── Customer rankings ─────────────────────────────────────────────────────────

export async function listCustomers(params: {
  fyCy: string;
  fyLy: string;
  monthsCy: string[];
  monthsLy: string[];
  entityType?: EntityType;
  states?: string[];
}): Promise<CustomerRow[]> {
  const { fyCy, fyLy, monthsCy, monthsLy, entityType = "all", states = [] } = params;

  const typeFilter =
    entityType === "distributor"
      ? `AND (sl.type_raw IS NULL OR sl.type_raw NOT ILIKE '%direct%')`
      : entityType === "direct_dealer"
      ? `AND sl.type_raw ILIKE '%direct%'`
      : "";

  const query = `
    SELECT
      customer,
      MAX(type_raw) AS type_raw,
      MAX(state_canon) AS state_canon,
      COALESCE(SUM(qty::numeric) FILTER (WHERE fy = $1 AND month_label = ANY($3::text[])), 0) AS qty_cy,
      COALESCE(SUM(amount::numeric) FILTER (WHERE fy = $1 AND month_label = ANY($3::text[])), 0) AS val_cy,
      COALESCE(SUM(qty::numeric) FILTER (WHERE fy = $2 AND month_label = ANY($4::text[])), 0) AS qty_ly,
      COALESCE(SUM(amount::numeric) FILTER (WHERE fy = $2 AND month_label = ANY($4::text[])), 0) AS val_ly
    FROM sale_line sl
    WHERE customer IS NOT NULL
      AND (
        (fy = $1 AND month_label = ANY($3::text[]))
        OR (fy = $2 AND month_label = ANY($4::text[]))
      )
      ${typeFilter}
      AND ($5::text[] = '{}' OR sl.state_canon = ANY($5::text[]))
    GROUP BY customer
    HAVING
      COALESCE(SUM(qty::numeric) FILTER (WHERE fy = $1 AND month_label = ANY($3::text[])), 0) > 0
      OR COALESCE(SUM(qty::numeric) FILTER (WHERE fy = $2 AND month_label = ANY($4::text[])), 0) > 0
    ORDER BY qty_cy DESC, val_cy DESC
  `;

  const res = await pool.query<{
    customer: string;
    type_raw: string | null;
    state_canon: string | null;
    qty_cy: unknown;
    val_cy: unknown;
    qty_ly: unknown;
    val_ly: unknown;
  }>(query, [fyCy, fyLy, monthsCy, monthsLy, states]);

  return res.rows.map(buildCustomerRow);
}

// ── Category drill-down ───────────────────────────────────────────────────────

export async function getCustomerCategories(params: {
  customer: string;
  fyCy: string;
  fyLy: string;
  monthsCy: string[];
  monthsLy: string[];
}): Promise<CategoryRow[]> {
  const { customer, fyCy, fyLy, monthsCy, monthsLy } = params;

  const res = await pool.query<{
    category: string | null;
    qty_cy: unknown;
    val_cy: unknown;
    qty_ly: unknown;
    val_ly: unknown;
  }>(
    `
    SELECT
      COALESCE(group_canon, group_raw, 'Uncategorized') AS category,
      COALESCE(SUM(qty::numeric) FILTER (WHERE fy = $1 AND month_label = ANY($3::text[])), 0) AS qty_cy,
      COALESCE(SUM(amount::numeric) FILTER (WHERE fy = $1 AND month_label = ANY($3::text[])), 0) AS val_cy,
      COALESCE(SUM(qty::numeric) FILTER (WHERE fy = $2 AND month_label = ANY($4::text[])), 0) AS qty_ly,
      COALESCE(SUM(amount::numeric) FILTER (WHERE fy = $2 AND month_label = ANY($4::text[])), 0) AS val_ly
    FROM sale_line
    WHERE customer = $5
      AND (
        (fy = $1 AND month_label = ANY($3::text[]))
        OR (fy = $2 AND month_label = ANY($4::text[]))
      )
    GROUP BY COALESCE(group_canon, group_raw, 'Uncategorized')
    ORDER BY qty_cy DESC
    `,
    [fyCy, fyLy, monthsCy, monthsLy, customer],
  );

  return res.rows.map((r) => {
    const qtyCy = safeN(r.qty_cy);
    const valCy = safeN(r.val_cy);
    const qtyLy = safeN(r.qty_ly);
    const valLy = safeN(r.val_ly);
    const priceCy = realizedPrice(valCy, qtyCy);
    const priceLy = realizedPrice(valLy, qtyLy);
    const qtyGrowthPct = growthPct(qtyCy, qtyLy);
    const valGrowthPct = growthPct(valCy, valLy);
    const priceChangePct =
      priceCy != null && priceLy != null ? growthPct(priceCy, priceLy) : null;
    const priceEffectPp =
      valGrowthPct != null && qtyGrowthPct != null
        ? valGrowthPct - qtyGrowthPct
        : null;
    return {
      customer,
      category: r.category ?? "Uncategorized",
      qtyCy,
      valCy,
      qtyLy,
      valLy,
      priceCy,
      priceLy,
      qtyGrowthPct,
      valGrowthPct,
      priceChangePct,
      priceEffectPp,
      revenueUpVolumeDown: qtyCy < qtyLy && valCy > valLy,
    };
  });
}

// ── Product drill-down ────────────────────────────────────────────────────────

export async function getCustomerProducts(params: {
  customer: string;
  category?: string;
  fyCy: string;
  fyLy: string;
  monthsCy: string[];
  monthsLy: string[];
}): Promise<ProductRow[]> {
  const { customer, category, fyCy, fyLy, monthsCy, monthsLy } = params;

  const catFilter = category
    ? `AND COALESCE(sl.group_canon, sl.group_raw, 'Uncategorized') = $6`
    : "";
  const params6 = category ? [fyCy, fyLy, monthsCy, monthsLy, customer, category] : [fyCy, fyLy, monthsCy, monthsLy, customer];

  const res = await pool.query<{
    code: string;
    category: string | null;
    item_name: string | null;
    qty_cy: unknown;
    val_cy: unknown;
    qty_ly: unknown;
    val_ly: unknown;
  }>(
    `
    SELECT
      sl.code,
      COALESCE(sl.group_canon, sl.group_raw, 'Uncategorized') AS category,
      im.item_name,
      COALESCE(SUM(sl.qty::numeric) FILTER (WHERE sl.fy = $1 AND sl.month_label = ANY($3::text[])), 0) AS qty_cy,
      COALESCE(SUM(sl.amount::numeric) FILTER (WHERE sl.fy = $1 AND sl.month_label = ANY($3::text[])), 0) AS val_cy,
      COALESCE(SUM(sl.qty::numeric) FILTER (WHERE sl.fy = $2 AND sl.month_label = ANY($4::text[])), 0) AS qty_ly,
      COALESCE(SUM(sl.amount::numeric) FILTER (WHERE sl.fy = $2 AND sl.month_label = ANY($4::text[])), 0) AS val_ly
    FROM sale_line sl
    LEFT JOIN item_master im ON im.code = sl.code
    WHERE sl.customer = $5
      AND (
        (sl.fy = $1 AND sl.month_label = ANY($3::text[]))
        OR (sl.fy = $2 AND sl.month_label = ANY($4::text[]))
      )
      ${catFilter}
    GROUP BY sl.code, COALESCE(sl.group_canon, sl.group_raw, 'Uncategorized'), im.item_name
    ORDER BY qty_cy DESC
    `,
    params6,
  );

  return res.rows.map((r) => {
    const qtyCy = safeN(r.qty_cy);
    const valCy = safeN(r.val_cy);
    const qtyLy = safeN(r.qty_ly);
    const valLy = safeN(r.val_ly);
    const priceCy = realizedPrice(valCy, qtyCy);
    const priceLy = realizedPrice(valLy, qtyLy);
    const qtyGrowthPct = growthPct(qtyCy, qtyLy);
    const valGrowthPct = growthPct(valCy, valLy);
    const priceChangePct =
      priceCy != null && priceLy != null ? growthPct(priceCy, priceLy) : null;
    const priceEffectPp =
      valGrowthPct != null && qtyGrowthPct != null
        ? valGrowthPct - qtyGrowthPct
        : null;
    return {
      customer,
      category: r.category ?? "Uncategorized",
      code: r.code,
      itemName: r.item_name,
      qtyCy,
      valCy,
      qtyLy,
      valLy,
      priceCy,
      priceLy,
      qtyGrowthPct,
      valGrowthPct,
      priceChangePct,
      priceEffectPp,
      revenueUpVolumeDown: qtyCy < qtyLy && valCy > valLy,
    };
  });
}

// ── Churn detection ───────────────────────────────────────────────────────────

/** Customers who ordered in the LY period but have not ordered in the CY period. */
export async function getChurned(params: {
  fyCy: string;
  fyLy: string;
  monthsCy: string[];
  monthsLy: string[];
  entityType?: EntityType;
}): Promise<ChurnRow[]> {
  const { fyCy, fyLy, monthsCy, monthsLy, entityType = "all" } = params;

  const typeFilter =
    entityType === "distributor"
      ? `AND (type_raw IS NULL OR type_raw NOT ILIKE '%direct%')`
      : entityType === "direct_dealer"
      ? `AND type_raw ILIKE '%direct%'`
      : "";

  const res = await pool.query<{
    customer: string;
    type_raw: string | null;
    last_order_date: string | null;
    qty_ly: unknown;
    val_ly: unknown;
    months_ordered: unknown;
  }>(
    `
    WITH cy_customers AS (
      SELECT DISTINCT customer
      FROM sale_line
      WHERE fy = $1 AND month_label = ANY($3::text[]) AND customer IS NOT NULL
    ),
    ly_data AS (
      SELECT
        customer,
        MAX(type_raw) AS type_raw,
        MAX(invoice_date::text) AS last_order_date,
        SUM(qty::numeric) AS qty_ly,
        SUM(amount::numeric) AS val_ly,
        COUNT(DISTINCT month_label) AS months_ordered
      FROM sale_line
      WHERE fy = $2 AND month_label = ANY($4::text[]) AND customer IS NOT NULL
        ${typeFilter}
      GROUP BY customer
    )
    SELECT l.*
    FROM ly_data l
    WHERE l.customer NOT IN (SELECT customer FROM cy_customers)
    ORDER BY val_ly DESC
    `,
    [fyCy, fyLy, monthsCy, monthsLy],
  );

  return res.rows.map((r) => ({
    customer: r.customer,
    entityType: classifyEntityType(r.type_raw),
    lastOrderDate: r.last_order_date,
    qtyLy: safeN(r.qty_ly),
    valLy: safeN(r.val_ly),
    monthsOrdered: safeN(r.months_ordered),
  }));
}

// ── New customers ─────────────────────────────────────────────────────────────

/** Customers who appear in CY period but had no orders in the LY period. */
export async function getNewCustomers(params: {
  fyCy: string;
  fyLy: string;
  monthsCy: string[];
  monthsLy: string[];
  entityType?: EntityType;
}): Promise<ChurnRow[]> {
  const { fyCy, fyLy, monthsCy, monthsLy, entityType = "all" } = params;

  const typeFilter =
    entityType === "distributor"
      ? `AND (type_raw IS NULL OR type_raw NOT ILIKE '%direct%')`
      : entityType === "direct_dealer"
      ? `AND type_raw ILIKE '%direct%'`
      : "";

  const res = await pool.query<{
    customer: string;
    type_raw: string | null;
    last_order_date: string | null;
    qty_ly: unknown;
    val_ly: unknown;
    months_ordered: unknown;
  }>(
    `
    WITH ly_customers AS (
      SELECT DISTINCT customer
      FROM sale_line
      WHERE fy = $2 AND month_label = ANY($4::text[]) AND customer IS NOT NULL
    ),
    cy_data AS (
      SELECT
        customer,
        MAX(type_raw) AS type_raw,
        MAX(invoice_date::text) AS last_order_date,
        SUM(qty::numeric) AS qty_ly,
        SUM(amount::numeric) AS val_ly,
        COUNT(DISTINCT month_label) AS months_ordered
      FROM sale_line
      WHERE fy = $1 AND month_label = ANY($3::text[]) AND customer IS NOT NULL
        ${typeFilter}
      GROUP BY customer
    )
    SELECT c.*
    FROM cy_data c
    WHERE c.customer NOT IN (SELECT customer FROM ly_customers)
    ORDER BY val_ly DESC
    `,
    [fyCy, fyLy, monthsCy, monthsLy],
  );

  return res.rows.map((r) => ({
    customer: r.customer,
    entityType: classifyEntityType(r.type_raw),
    lastOrderDate: r.last_order_date,
    qtyLy: safeN(r.qty_ly),
    valLy: safeN(r.val_ly),
    monthsOrdered: safeN(r.months_ordered),
  }));
}

// ── Revenue-up, volume-down flag list ─────────────────────────────────────────

/** "Hidden shrinkers" — customers or products where value grew but units fell.
 *  These are the single most valuable output: price rises masking real decline. */
export async function getPriceShrinkers(params: {
  fyCy: string;
  fyLy: string;
  monthsCy: string[];
  monthsLy: string[];
  grain: "customer" | "category" | "product";
  entityType?: EntityType;
}): Promise<ShrinkerRow[]> {
  const { fyCy, fyLy, monthsCy, monthsLy, grain, entityType = "all" } = params;

  const typeFilter =
    entityType === "distributor"
      ? `AND (type_raw IS NULL OR type_raw NOT ILIKE '%direct%')`
      : entityType === "direct_dealer"
      ? `AND type_raw ILIKE '%direct%'`
      : "";

  const groupBy =
    grain === "customer"
      ? "customer"
      : grain === "category"
      ? "customer, COALESCE(group_canon, group_raw, 'Uncategorized')"
      : "customer, COALESCE(group_canon, group_raw, 'Uncategorized'), code";

  const selectExtra =
    grain === "customer"
      ? `NULL::text AS category, NULL::text AS code, NULL::text AS item_name`
      : grain === "category"
      ? `COALESCE(group_canon, group_raw, 'Uncategorized') AS category, NULL::text AS code, NULL::text AS item_name`
      : `COALESCE(group_canon, group_raw, 'Uncategorized') AS category, code, im.item_name`;

  const joinClause =
    grain === "product"
      ? `LEFT JOIN item_master im ON im.code = sl.code`
      : "";

  const res = await pool.query<{
    customer: string;
    category: string | null;
    code: string | null;
    item_name: string | null;
    qty_cy: unknown;
    val_cy: unknown;
    qty_ly: unknown;
    val_ly: unknown;
  }>(
    `
    SELECT
      customer, ${selectExtra},
      COALESCE(SUM(qty::numeric) FILTER (WHERE fy = $1 AND month_label = ANY($3::text[])), 0) AS qty_cy,
      COALESCE(SUM(amount::numeric) FILTER (WHERE fy = $1 AND month_label = ANY($3::text[])), 0) AS val_cy,
      COALESCE(SUM(qty::numeric) FILTER (WHERE fy = $2 AND month_label = ANY($4::text[])), 0) AS qty_ly,
      COALESCE(SUM(amount::numeric) FILTER (WHERE fy = $2 AND month_label = ANY($4::text[])), 0) AS val_ly
    FROM sale_line sl ${joinClause}
    WHERE customer IS NOT NULL
      AND (
        (fy = $1 AND month_label = ANY($3::text[]))
        OR (fy = $2 AND month_label = ANY($4::text[]))
      )
      ${typeFilter}
    GROUP BY ${groupBy}${grain === "product" ? ", im.item_name" : ""}
    HAVING
      COALESCE(SUM(qty::numeric) FILTER (WHERE fy = $2 AND month_label = ANY($4::text[])), 0) > 0
      AND COALESCE(SUM(qty::numeric) FILTER (WHERE fy = $1 AND month_label = ANY($3::text[])), 0) <
          COALESCE(SUM(qty::numeric) FILTER (WHERE fy = $2 AND month_label = ANY($4::text[])), 0)
      AND COALESCE(SUM(amount::numeric) FILTER (WHERE fy = $1 AND month_label = ANY($3::text[])), 0) >
          COALESCE(SUM(amount::numeric) FILTER (WHERE fy = $2 AND month_label = ANY($4::text[])), 0)
    ORDER BY
      (COALESCE(SUM(amount::numeric) FILTER (WHERE fy = $1 AND month_label = ANY($3::text[])), 0) -
       COALESCE(SUM(amount::numeric) FILTER (WHERE fy = $2 AND month_label = ANY($4::text[])), 0)) DESC
    `,
    [fyCy, fyLy, monthsCy, monthsLy],
  );

  return res.rows.map((r) => {
    const qtyCy = safeN(r.qty_cy);
    const valCy = safeN(r.val_cy);
    const qtyLy = safeN(r.qty_ly);
    const valLy = safeN(r.val_ly);
    const priceCy = realizedPrice(valCy, qtyCy);
    const priceLy = realizedPrice(valLy, qtyLy);
    const qtyGrowthPct = growthPct(qtyCy, qtyLy) ?? 0;
    const valGrowthPct = growthPct(valCy, valLy) ?? 0;
    const priceChangePct =
      priceCy != null && priceLy != null ? growthPct(priceCy, priceLy) : null;
    const priceEffectPp = valGrowthPct - qtyGrowthPct;
    return {
      customer: r.customer,
      category: r.category,
      code: r.code,
      itemName: r.item_name,
      qtyCy,
      valCy,
      qtyLy,
      valLy,
      qtyGrowthPct,
      valGrowthPct,
      priceChangePct,
      priceEffectPp,
    };
  });
}

// ── Seasonal weights + full-year projection ───────────────────────────────────

/** Monthly share of annual sales (spec-provided, Apr–Mar). Sums to ~100. */
export const SEASONAL_WEIGHTS: Record<string, number> = {
  Apr: 4.2, May: 8.2, Jun: 8.3, Jul: 7.3, Aug: 7.0, Sep: 7.4,
  Oct: 7.1, Nov: 8.5, Dec: 10.1, Jan: 10.1, Feb: 9.6, Mar: 12.3,
};

/** Sum of all weights (≈ 100.1 — use this so the projection is self-consistent). */
export const SEASONAL_TOTAL = Object.values(SEASONAL_WEIGHTS).reduce(
  (s, v) => s + v, 0,
);

/**
 * Fraction of the annual total represented by completedMonthNames.
 * Accepts either "Apr" (3-char) or "Apr-26" (month label) format.
 */
export function calcPctElapsed(completedMonthNames: string[]): number {
  return completedMonthNames.reduce((sum, m) => {
    const name = m.slice(0, 3);
    return sum + (SEASONAL_WEIGHTS[name] ?? 0);
  }, 0);
}

/**
 * Annualise a YTD amount using the seasonal weight table.
 * Returns null when no months are provided or elapsed weight is zero.
 */
export function projectFullYear(
  ytdAmount: number,
  completedMonthNames: string[],
): number | null {
  const elapsed = calcPctElapsed(completedMonthNames);
  if (elapsed <= 0) return null;
  return (ytdAmount / elapsed) * SEASONAL_TOTAL;
}

// ── At-risk scoring ───────────────────────────────────────────────────────────
//
// Replaces the binary "churned" flag.
// Each customer is scored against their own historical median inter-order gap.
// gap_ratio = days_since_last / median_gap
//   < 1.2× → active (not shown)
//   1.2–2×  → mild risk
//   > 2×    → high risk
//
// Historical FYs have no invoice_date; we proxy with month start (1st of month).
// Customers with < 2 recorded gaps are skipped (insufficient history).
// Accounts last active more than 730 days ago are excluded (lost/dead).

export type AtRiskRow = {
  customer: string;
  entityType: "distributor" | "direct_dealer" | "retailer" | "unknown";
  medianGap: number;      // days — their normal inter-order cycle
  daysSinceLast: number;  // days since last invoice (or month proxy)
  lastOrderDate: string | null;
  gapRatio: number;       // daysSinceLast / medianGap
  riskLevel: "high" | "mild";
};

export async function getAtRisk(params: {
  entityType?: EntityType;
}): Promise<AtRiskRow[]> {
  const { entityType = "all" } = params;

  const typeFilter =
    entityType === "distributor"
      ? `AND (sl2.type_raw IS NULL OR sl2.type_raw NOT ILIKE '%direct%')`
      : entityType === "direct_dealer"
      ? `AND sl2.type_raw ILIKE '%direct%'`
      : "";

  const res = await pool.query<{
    customer: string;
    type_raw: string | null;
    median_gap: string;
    last_order_date: string | null;
    days_since_last: string;
    gap_ratio: string;
  }>(
    `
    WITH order_dates AS (
      SELECT DISTINCT
        sl.customer,
        COALESCE(
          sl.invoice_date::date,
          make_date(
            2000 + CAST(SUBSTRING(sl.month_label, 5, 2) AS INTEGER),
            CASE SUBSTRING(sl.month_label, 1, 3)
              WHEN 'Apr' THEN 4  WHEN 'May' THEN 5  WHEN 'Jun' THEN 6
              WHEN 'Jul' THEN 7  WHEN 'Aug' THEN 8  WHEN 'Sep' THEN 9
              WHEN 'Oct' THEN 10 WHEN 'Nov' THEN 11 WHEN 'Dec' THEN 12
              WHEN 'Jan' THEN 1  WHEN 'Feb' THEN 2  WHEN 'Mar' THEN 3
              ELSE NULL
            END,
            1
          )
        ) AS order_date
      FROM sale_line sl
      WHERE sl.customer IS NOT NULL AND sl.month_label IS NOT NULL
    ),
    valid_od AS (
      SELECT customer, order_date FROM order_dates WHERE order_date IS NOT NULL
    ),
    gap_series AS (
      SELECT
        customer,
        order_date - LAG(order_date) OVER (PARTITION BY customer ORDER BY order_date) AS gap_days
      FROM valid_od
    ),
    customer_gaps AS (
      SELECT
        customer,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gap_days)::integer AS median_gap
      FROM gap_series
      WHERE gap_days IS NOT NULL AND gap_days > 0
      GROUP BY customer
      HAVING COUNT(*) >= 2
    ),
    last_orders AS (
      SELECT customer, MAX(order_date) AS last_order_date
      FROM valid_od
      GROUP BY customer
    )
    SELECT
      cg.customer,
      MAX(sl2.type_raw) AS type_raw,
      cg.median_gap,
      lo.last_order_date::text AS last_order_date,
      (CURRENT_DATE - lo.last_order_date)::integer AS days_since_last,
      ROUND(
        (CURRENT_DATE - lo.last_order_date)::numeric / NULLIF(cg.median_gap, 0),
        2
      ) AS gap_ratio
    FROM customer_gaps cg
    JOIN last_orders lo ON lo.customer = cg.customer
    JOIN sale_line sl2 ON sl2.customer = cg.customer
    WHERE
      (CURRENT_DATE - lo.last_order_date)::numeric >= cg.median_gap * 1.2
      AND lo.last_order_date >= CURRENT_DATE - INTERVAL '730 days'
      ${typeFilter}
    GROUP BY cg.customer, cg.median_gap, lo.last_order_date
    ORDER BY
      (CURRENT_DATE - lo.last_order_date)::numeric / NULLIF(cg.median_gap, 0) DESC
    LIMIT 500
    `,
    [],
  );

  return res.rows.map((r) => {
    const medianGap = parseInt(r.median_gap, 10);
    const daysSinceLast = parseInt(r.days_since_last, 10);
    const gapRatio = parseFloat(r.gap_ratio);
    return {
      customer: r.customer,
      entityType: classifyEntityType(r.type_raw),
      medianGap,
      daysSinceLast,
      lastOrderDate: r.last_order_date,
      gapRatio,
      riskLevel: (gapRatio >= 2 ? "high" : "mild") as "high" | "mild",
    };
  });
}

// ── Multi-year history for a single customer ───────────────────────────────────

export type HistoryYear = {
  fy: string;
  qty: number;
  val: number;
  price: number | null;
};

export async function getCustomerHistory(params: {
  customer: string;
  fys: string[];          // ordered oldest→newest, up to 7 years
  monthFilter?: string[]; // if set, only include these month names (e.g. ["Apr","May","Jun"])
}): Promise<HistoryYear[]> {
  const { customer, fys, monthFilter } = params;

  const monthCond = monthFilter?.length
    ? `AND SUBSTRING(month_label, 1, 3) = ANY($3::text[])`
    : "";
  const queryParams: unknown[] = monthFilter?.length
    ? [customer, fys, monthFilter]
    : [customer, fys];

  const res = await pool.query<{
    fy: string;
    qty: unknown;
    val: unknown;
  }>(
    `
    SELECT fy,
      SUM(qty::numeric) AS qty,
      SUM(amount::numeric) AS val
    FROM sale_line
    WHERE customer = $1 AND fy = ANY($2::text[]) ${monthCond}
    GROUP BY fy
    ORDER BY fy
    `,
    queryParams,
  );

  return res.rows.map((r) => {
    const qty = safeN(r.qty);
    const val = safeN(r.val);
    return { fy: r.fy, qty, val, price: realizedPrice(val, qty) };
  });
}

// ── Distributor scheme-risk ────────────────────────────────────────────────────

export type DistributorRiskRow = {
  customer: string;
  cyVal: number;
  lyVal: number;
  growthPct: number | null;
  isZeroBuyer: boolean;
  status: "on_track" | "at_risk" | "zero";
};

/**
 * Like-months YoY comparison for every customer who bought in the LY period.
 * Sorted by revenue at risk (lyVal − cyVal) descending — zero-buyers first.
 * No type_raw filter: the primary register has no reliable customer-type flag.
 */
export async function getDistributorRisk(params: {
  fyCy: string;
  fyLy: string;
  monthsCy: string[];
  monthsLy: string[];
}): Promise<DistributorRiskRow[]> {
  const { fyCy, fyLy, monthsCy, monthsLy } = params;
  if (!monthsCy.length || !monthsLy.length) return [];

  const res = await pool.query<{
    customer: string;
    cy_val: unknown;
    ly_val: unknown;
    growth_pct: unknown;
    is_zero_buyer: unknown;
  }>(
    `
    WITH cy AS (
      SELECT customer, SUM(amount::numeric) AS cy_val
      FROM sale_line
      WHERE fy = $1 AND month_label = ANY($2::text[]) AND customer IS NOT NULL
      GROUP BY customer
    ),
    ly AS (
      SELECT customer, SUM(amount::numeric) AS ly_val
      FROM sale_line
      WHERE fy = $3 AND month_label = ANY($4::text[]) AND customer IS NOT NULL
      GROUP BY customer
    )
    SELECT
      ly.customer,
      COALESCE(cy.cy_val, 0)                                    AS cy_val,
      ly.ly_val,
      CASE WHEN ly.ly_val > 0
        THEN ROUND((COALESCE(cy.cy_val, 0) - ly.ly_val) / ly.ly_val * 100, 1)
        ELSE NULL END                                            AS growth_pct,
      (COALESCE(cy.cy_val, 0) = 0)                              AS is_zero_buyer
    FROM ly
    LEFT JOIN cy USING (customer)
    ORDER BY (ly.ly_val - COALESCE(cy.cy_val, 0)) DESC
    `,
    [fyCy, monthsCy, fyLy, monthsLy],
  );

  return res.rows.map((r) => {
    const cyVal = safeN(r.cy_val);
    const lyVal = safeN(r.ly_val);
    const isZeroBuyer = Boolean(r.is_zero_buyer);
    const growthPct = r.growth_pct != null ? Number(r.growth_pct) : null;
    const status: DistributorRiskRow["status"] = isZeroBuyer
      ? "zero"
      : cyVal < lyVal
      ? "at_risk"
      : "on_track";
    return { customer: r.customer, cyVal, lyVal, growthPct, isZeroBuyer, status };
  });
}
