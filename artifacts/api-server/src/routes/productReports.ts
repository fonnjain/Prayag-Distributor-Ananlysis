// GET /api/product-reports?fy=2026-27&heads=[..]&states=[..]&customers=[..]
import { currentOpenFy } from "../lib/fyAnchors.js";
//   Products page data: per-product sales from sale_line for the FY, with the
//   shared State Head / State / Distributor filters (values from
//   /api/company-reports/filters).
// GET /api/product-reports/export — same params; returns an xlsx workbook.
//
// RULE 2 (litre rule) is respected: qty is reported per product code only,
// never summed across products/groups. WATER TANK rows report litres.
import { Router } from "express";
import ExcelJS from "exceljs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, saleLines, itemMaster } from "@workspace/db";
import {
  resolveProductCode,
  buildResolverIndex,
} from "../lib/sku/productCodeResolver.js";
import {
  entityConds,
  entityCondsAliased,
  hasEntityFilterValues,
  type EntityFilter,
} from "../lib/saleLineFilter.js";
import { parseJsonArray } from "./companyReports.js";
import { serveWithSnapshot } from "../lib/payloadSnapshot.js";
import { parseMonthsParam } from "../lib/periodMonths.js";
import { isFrozen } from "../lib/customers/registerSync.js";
import { provisionalMonthsExportInfo } from "../lib/exportInfo.js";
import { respondIfQuotaError } from "../lib/quotaResponse.js";

const router = Router();

const FY_RE = /^\d{4}-\d{2}$/;
// Default FY derives from the calendar so the page never opens on a stale year.
const PRODUCT_REPORTS_TTL_MS = 10 * 60 * 1000;

export type ProductRow = {
  code: string;
  product: string;
  group: string;
  qty: number;
  unit: string;
  amount: number;
};

/** A code+feature listed under two segments with different MRP — kept
 *  unresolved (loaded under both) pending a business decision. */
export type MrpConflict = {
  code: string;
  feature: string;
  product: string;
  options: { segment: string; mrp: number | null }[];
};

/** A segment name from the product upload that has no canonical mapping yet
 *  (MANHOLE COVER / WATER HEATER / COCKROACH TRAPS & GRATINGS). */
export type UnmappedSegment = {
  segment: string;
  codes: number;
};

/** Register codes (this FY) that fail to resolve to any master code,
 *  grouped by family prefix, so the catalogue gap is sized and visible. */
export type RegisterGap = {
  totalUnresolved: number;
  totalCodes: number;
  prefixes: { prefix: string; codes: number }[];
};

export type ProductDataQuality = {
  mrpConflicts: MrpConflict[];
  unmappedSegments: UnmappedSegment[];
  unmappedCodeTotal: number;
  registerGap: RegisterGap;
};

export type ProductReportsPayload = {
  fy: string;
  filtered: boolean;
  /** Month labels the figures are restricted to (empty = full FY). */
  months: string[];
  total: number;
  products: ProductRow[];
  /** Data-quality panels from the Product_Upload_Sample_File.csv load. */
  dataQuality: ProductDataQuality;
  /** Category currently applied to the product rows; All does not touch the registry. */
  selectedCategory: ProductCategory;
  /** All is counted once; a line matched by several categories is counted in each of those categories. */
  categoryTabs: ProductCategoryTab[];
  /** Row-level mapped/unmapped split (unlike category tabs, this cannot double-count a line). */
  mappingSplit: ProductMappingSplit;
};

export const PRODUCT_CATEGORIES = [
  "WATER TANK", "AGRI", "UPVC", "CPVC", "SWR", "PPR", "HDPE",
  "Garden Pipe", "COLUMN", "Corrugated Pipe", "PTMT / Faucets",
  "CISTERN", "CP (Chrome-Plated)", "Sink", "Sanitaryware",
  "Connection / Waste", "Hardware",
] as const;

export type CanonicalProductCategory = (typeof PRODUCT_CATEGORIES)[number];
export type ProductCategory = CanonicalProductCategory | "Unmapped" | "All";
export type ProductCategoryTab = {
  category: ProductCategory;
  value: number;
  rows: number;
  distinctCodes: number;
};
export type ProductMappingSplit = {
  mapped: Omit<ProductCategoryTab, "category">;
  unmapped: Omit<ProductCategoryTab, "category">;
};

/** The only category values accepted by the report endpoints. */
export function parseProductCategory(value: unknown): ProductCategory | null {
  if (value === undefined) return "All";
  if (typeof value !== "string") return null;
  return (value === "All" || value === "Unmapped" ||
    (PRODUCT_CATEGORIES as readonly string[]).includes(value))
    ? value as ProductCategory
    : null;
}

function effectiveDateSql(alias: string) {
  return sql`COALESCE(${sql.raw(`${alias}.invoice_date`)}, TO_DATE(${sql.raw(`${alias}.month_label`)}, 'Mon-YY'))`;
}

/** Correlated condition deliberately uses EXISTS: no category assignment can duplicate a sale line. */
export function categorySelectionSql(category: Exclude<ProductCategory, "All">, alias: string) {
  const effectiveDate = effectiveDateSql(alias);
  const matchingAssignment = sql`
    r.item_code = ${sql.raw(`${alias}.code`)}
    AND (r.effective_from IS NULL OR r.effective_from <= ${effectiveDate})
    AND (r.effective_to IS NULL OR ${effectiveDate} < r.effective_to)
  `;
  return category === "Unmapped"
    ? sql`NOT EXISTS (SELECT 1 FROM canonical_item_category_registry r WHERE ${matchingAssignment})`
    : sql`EXISTS (
      SELECT 1 FROM canonical_item_category_registry r
      WHERE ${matchingAssignment} AND r.canonical_category = ${category}
    )`;
}

type CategorySummaryDbRow = {
  kind: "all" | "category" | "mapped" | "unmapped";
  category: string | null;
  value: string;
  rows: string;
  distinct_codes: string;
};

async function buildCategorySummaries(
  fy: string,
  filter: EntityFilter | undefined,
  months: string[] | undefined,
): Promise<{ categoryTabs: ProductCategoryTab[]; mappingSplit: ProductMappingSplit }> {
  const monthCond = months?.length
    ? sql`AND sl.month_label IN (${sql.join(months.map((m) => sql`${m}`), sql`, `)})`
    : sql``;
  const rows = await db.execute<CategorySummaryDbRow>(sql`
    WITH filtered AS (
      SELECT sl.line_uid, sl.code, sl.amount, sl.invoice_date, sl.month_label
      FROM sale_line_current sl
      WHERE sl.fy = ${fy}
      ${monthCond}
      ${entityCondsAliased(filter, "sl")}
    ),
    assignments AS (
      SELECT DISTINCT f.line_uid, f.code, f.amount, r.canonical_category
      FROM filtered f
      JOIN canonical_item_category_registry r
        ON r.item_code = f.code
       AND (r.effective_from IS NULL OR r.effective_from <=
         COALESCE(f.invoice_date, TO_DATE(f.month_label, 'Mon-YY')))
       AND (r.effective_to IS NULL OR
         COALESCE(f.invoice_date, TO_DATE(f.month_label, 'Mon-YY')) < r.effective_to)
    ),
    category_code_values AS (
      SELECT canonical_category, code, round(sum(amount::numeric)) AS value
      FROM assignments
      GROUP BY canonical_category, code
    ),
    category_counts AS (
      SELECT canonical_category, count(*) AS rows, count(DISTINCT code) AS distinct_codes
      FROM assignments
      GROUP BY canonical_category
    ),
    all_code_values AS (
      SELECT code, round(sum(amount::numeric)) AS value
      FROM filtered
      GROUP BY code
    ),
    classified AS (
      SELECT f.*,
        CASE WHEN EXISTS (
          SELECT 1 FROM canonical_item_category_registry r
          WHERE r.item_code = f.code
            AND (r.effective_from IS NULL OR r.effective_from <=
              COALESCE(f.invoice_date, TO_DATE(f.month_label, 'Mon-YY')))
            AND (r.effective_to IS NULL OR
              COALESCE(f.invoice_date, TO_DATE(f.month_label, 'Mon-YY')) < r.effective_to)
        ) THEN 'mapped' ELSE 'unmapped' END AS mapping_kind
      FROM filtered f
    ),
    mapping_code_values AS (
      SELECT mapping_kind, code, round(sum(amount::numeric)) AS value
      FROM classified
      GROUP BY mapping_kind, code
    ),
    mapping_counts AS (
      SELECT mapping_kind, count(*) AS rows, count(DISTINCT code) AS distinct_codes
      FROM classified
      GROUP BY mapping_kind
    )
    SELECT 'category'::text AS kind, c.canonical_category AS category,
      COALESCE(sum(v.value), 0)::text AS value,
      c.rows::text AS rows, c.distinct_codes::text AS distinct_codes
    FROM category_counts c
    JOIN category_code_values v USING (canonical_category)
    GROUP BY c.canonical_category, c.rows, c.distinct_codes
    UNION ALL
    SELECT 'all'::text AS kind, NULL::text AS category,
      COALESCE((SELECT sum(value) FROM all_code_values), 0)::text AS value,
      count(*)::text AS rows, count(DISTINCT code)::text AS distinct_codes
    FROM filtered
    UNION ALL
    SELECT c.mapping_kind AS kind, NULL::text AS category,
      COALESCE(sum(v.value), 0)::text AS value,
      c.rows::text AS rows, c.distinct_codes::text AS distinct_codes
    FROM mapping_counts c
    JOIN mapping_code_values v USING (mapping_kind)
    GROUP BY c.mapping_kind, c.rows, c.distinct_codes
  `);
  const zero = { value: 0, rows: 0, distinctCodes: 0 };
  let all: ProductCategoryTab = { category: "All", ...zero };
  let mapped = zero;
  let unmapped = zero;
  const categories = rows.rows
    .filter((r) => r.kind === "category")
    .map((r) => ({
      category: r.category as CanonicalProductCategory,
      value: Math.round(Number(r.value)),
      rows: Number(r.rows),
      distinctCodes: Number(r.distinct_codes),
    }))
    .sort((a, b) => b.value - a.value || a.category.localeCompare(b.category));
  for (const row of rows.rows) {
    if (row.kind === "all") {
      all = {
        category: "All",
        value: Math.round(Number(row.value)),
        rows: Number(row.rows),
        distinctCodes: Number(row.distinct_codes),
      };
      continue;
    }
    if (row.kind !== "mapped" && row.kind !== "unmapped") continue;
    const summary = {
      value: Math.round(Number(row.value)),
      rows: Number(row.rows),
      distinctCodes: Number(row.distinct_codes),
    };
    if (row.kind === "mapped") mapped = summary;
    else unmapped = summary;
  }
  const categoryTabs = [
    ...categories,
    ...(unmapped.rows > 0 ? [{ category: "Unmapped" as const, ...unmapped }] : []),
  ]
    .sort((a, b) => b.value - a.value || a.category.localeCompare(b.category));
  return {
    categoryTabs: [all, ...categoryTabs],
    mappingSplit: { mapped, unmapped },
  };
}

/** Family prefix for an unresolved register code: leading letters up to and
 *  including a hyphen (PTA-, CPCS-), else the leading letter run, else the
 *  bucket "(numeric)" for all-digit codes. Mirrors the loader script. */
function familyPrefix(code: string): string {
  const hyphen = /^([A-Za-z]+-)/.exec(code);
  if (hyphen) return hyphen[1];
  const alpha = /^([A-Za-z]+)/.exec(code);
  if (alpha) return alpha[1];
  return "(numeric)";
}

/**
 * Build the three data-quality panels the Products page renders:
 *   (a) the unresolved MRP conflicts (TTS-01/02/03),
 *   (b) the "segment not yet mapped" UNMAPPED segments,
 *   (c) the unresolved register-code gap for this FY, grouped by prefix.
 * These do NOT depend on the entity/month filter — they describe the loaded
 * master and the whole FY register — so they are computed once per FY.
 */
export async function buildProductDataQuality(fy: string): Promise<ProductDataQuality> {
  // (a) MRP conflicts — variants flagged mrp_conflict, grouped by (code,feature).
  const conflictRows = await db.execute<{
    code: string;
    feature_name: string;
    product_name: string | null;
    segment_source: string | null;
    mrp: string | null;
  }>(sql`
    SELECT code, feature_name, product_name, segment_source, mrp
    FROM item_master_variant
    WHERE mrp_conflict = TRUE
    ORDER BY code, feature_name, segment_source
  `);
  const conflictMap = new Map<string, MrpConflict>();
  for (const r of conflictRows.rows) {
    const key = `${r.code}\u0000${r.feature_name}`;
    let c = conflictMap.get(key);
    if (!c) {
      c = {
        code: r.code,
        feature: r.feature_name,
        product: r.product_name ?? "",
        options: [],
      };
      conflictMap.set(key, c);
    }
    c.options.push({
      segment: r.segment_source ?? "",
      mrp: r.mrp === null ? null : Number(r.mrp),
    });
  }
  const mrpConflicts = Array.from(conflictMap.values());

  // (b) UNMAPPED segments — distinct source segments whose canon is UNMAPPED,
  //     with the code count per source segment.
  const unmappedRows = await db.execute<{ segment_source: string; codes: string }>(sql`
    SELECT segment_source, count(DISTINCT code)::text AS codes
    FROM item_master_variant
    WHERE segment_canon = 'UNMAPPED'
    GROUP BY segment_source
    ORDER BY segment_source
  `);
  const unmappedSegments = unmappedRows.rows.map((r) => ({
    segment: r.segment_source ?? "",
    codes: Number(r.codes),
  }));
  const unmappedTotalRow = await db.execute<{ codes: string }>(sql`
    SELECT count(DISTINCT code)::text AS codes
    FROM item_master_variant
    WHERE segment_canon = 'UNMAPPED'
  `);
  const unmappedCodeTotal = Number(unmappedTotalRow.rows[0]?.codes ?? 0);

  // (c) Register-code gap — resolve every distinct FY code against the active,
  //     authoritative current-price catalogue. item_master is an uploaded
  //     enrichment table and can otherwise make this card look complete while
  //     the source catalogue is missing a product line.
  //     mrp_current_catalogue falls back to legacy MRP only before the first
  //     successful authoritative sync.
  const masterRes = await db.execute<{ code: string }>(
    sql`SELECT DISTINCT item_code AS code FROM mrp_current_catalogue`,
  );
  const { has, codes } = buildResolverIndex(masterRes.rows.map((r) => r.code));
  const fyCodesRes = await db.execute<{ code: string }>(
    sql`SELECT DISTINCT code FROM sale_line WHERE fy = ${fy}`,
  );
  const fyCodes = fyCodesRes.rows.map((r) => r.code);
  const prefixCounts = new Map<string, number>();
  let totalUnresolved = 0;
  for (const c of fyCodes) {
    const r = resolveProductCode(c, has, codes);
    if (r.method === "unresolved") {
      totalUnresolved++;
      const p = familyPrefix(c);
      prefixCounts.set(p, (prefixCounts.get(p) ?? 0) + 1);
    }
  }
  const prefixes = Array.from(prefixCounts.entries())
    .map(([prefix, cnt]) => ({ prefix, codes: cnt }))
    .sort((a, b) => b.codes - a.codes || a.prefix.localeCompare(b.prefix))
    .slice(0, 10);

  return {
    mrpConflicts,
    unmappedSegments,
    unmappedCodeTotal,
    registerGap: { totalUnresolved, totalCodes: fyCodes.length, prefixes },
  };
}

export async function buildProductReports(
  fy: string,
  filter?: EntityFilter,
  months?: string[],
  selectedCategory: ProductCategory = "All",
): Promise<ProductReportsPayload> {
  const rows = await db
    .select({
      code: saleLines.code,
      product: sql<string>`coalesce(max(${itemMaster.itemName}), ${saleLines.code})`,
      group: sql<string>`coalesce(max(${saleLines.groupCanon}), 'Unmapped')`,
      // Per-code qty only (RULE 2): tanks report litres, everything else pieces.
      qty: sql<number>`coalesce(case when max(coalesce(${saleLines.groupRaw}, '')) = 'WATER TANK' then sum(${saleLines.qtyLtr}::numeric) else sum(${saleLines.qty}::numeric) end, 0)::float8`,
      unit: sql<string>`case when max(coalesce(${saleLines.groupRaw}, '')) = 'WATER TANK' then 'Ltr' else coalesce(max(${itemMaster.unit}), '') end`,
      amount: sql<number>`coalesce(sum(${saleLines.amount}::numeric), 0)::float8`,
    })
    .from(saleLines)
    .leftJoin(itemMaster, eq(saleLines.code, itemMaster.code))
    .where(and(
      eq(saleLines.fy, fy),
      eq(saleLines.versionStatus, "current"),
      ...(months && months.length > 0 ? [inArray(saleLines.monthLabel, months)] : []),
      ...entityConds(filter),
      ...(selectedCategory === "All" ? [] : [categorySelectionSql(selectedCategory, "sale_line_all")]),
    ))
    .groupBy(saleLines.code);

  const products = rows
    .map((r) => ({
      code: r.code,
      product: r.product,
      group: selectedCategory === "All" ? r.group : selectedCategory,
      qty: Math.round(r.qty * 100) / 100,
      unit: r.unit,
      amount: Math.round(r.amount),
    }))
    .sort((a, b) => b.amount - a.amount);

  const allTab: ProductCategoryTab = {
    category: "All",
    value: products.reduce((s, p) => s + p.amount, 0),
    // These counts are intentionally based on sale lines, not product rows.
    // They are supplied by the category query below.
    rows: 0,
    distinctCodes: 0,
  };
  const [dataQuality, summaries] = await Promise.all([
    buildProductDataQuality(fy),
    buildCategorySummaries(fy, filter, months),
  ]);
  // Preserve the legacy code aggregation's rounded total for the unfiltered
  // All request; registry reporting is deliberately separate from that path.
  if (selectedCategory === "All") summaries.categoryTabs[0].value = allTab.value;
  const selectedTab = summaries.categoryTabs.find((tab) => tab.category === selectedCategory);
  const zeroSplit = { value: 0, rows: 0, distinctCodes: 0 };
  const mappingSplit = selectedCategory === "All"
    ? summaries.mappingSplit
    : selectedCategory === "Unmapped"
      ? { mapped: zeroSplit, unmapped: summaries.mappingSplit.unmapped }
      : {
          mapped: selectedTab
            ? {
                value: selectedTab.value,
                rows: selectedTab.rows,
                distinctCodes: selectedTab.distinctCodes,
              }
            : zeroSplit,
          unmapped: zeroSplit,
        };

  return {
    fy,
    filtered: hasEntityFilterValues(filter),
    months: months ?? [],
    total: allTab.value,
    products,
    dataQuality,
    selectedCategory,
    categoryTabs: summaries.categoryTabs,
    mappingSplit,
  };
}

function parseParams(req: import("express").Request, res: import("express").Response):
  | { fy: string; filter: EntityFilter | undefined; months: string[] | undefined; category: ProductCategory }
  | null {
  const fy = typeof req.query.fy === "string" && req.query.fy.trim() !== ""
    ? req.query.fy.trim()
    : currentOpenFy();
  if (!FY_RE.test(fy)) {
    res.status(400).json({ error: "Invalid fy — expected YYYY-YY" });
    return null;
  }
  const monthsResult = parseMonthsParam(req.query.months, fy);
  if (!monthsResult.ok) {
    res.status(400).json({ error: monthsResult.error });
    return null;
  }
  const months = monthsResult.months;
  const category = parseProductCategory(req.query.category);
  if (!category) {
    res.status(400).json({ error: "Invalid category" });
    return null;
  }
  const filter: EntityFilter = {
    heads: parseJsonArray(req.query.heads),
    states: parseJsonArray(req.query.states),
    customers: parseJsonArray(req.query.customers),
  };
  return { fy, filter: hasEntityFilterValues(filter) ? filter : undefined, months, category };
}

router.get("/product-reports", async (req, res) => {
  const params = parseParams(req, res);
  if (!params) return;
  const { fy, filter, months, category } = params;
  try {
    if (category !== "All" || filter || (months && months.length > 0)) {
      // Active filters or a sub-year period — always build live, never cache
      // or snapshot (the key space would be unbounded).
      res.json(await buildProductReports(fy, filter, months, category));
      return;
    }
    const payload = await serveWithSnapshot({
      // The card's catalogue basis changed from item_master to the
      // authoritative source cache; do not serve a snapshot made on v2.
      key: `product-reports|v4|${fy}`,
      ttlMs: PRODUCT_REPORTS_TTL_MS,
      build: () => buildProductReports(fy) as unknown as Promise<Record<string, unknown>>,
      log: req.log,
      frozen: isFrozen(fy),
    });
    res.json(payload);
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "product-reports error");
    res.status(500).json({ error: "Failed to compute product reports" });
  }
});

// ── Excel export ─────────────────────────────────────────────────────────────

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF5" } };
const MAX_EXPORT_ROWS_PER_SHEET = 20_000;
const MAX_CONCURRENT_EXPORTS = 2;
let activeExports = 0;

router.get("/product-reports/export", async (req, res) => {
  const params = parseParams(req, res);
  if (!params) return;
  const { fy, filter, months, category } = params;

  if (activeExports >= MAX_CONCURRENT_EXPORTS) {
    res.status(429).json({ error: "Another export is already running — try again in a few seconds." });
    return;
  }
  activeExports++;
  try {
    const p = await buildProductReports(fy, filter, months, category);
    const provisionalInfo = await provisionalMonthsExportInfo(p.fy);

    const wb = new ExcelJS.Workbook();
    wb.creator = "Prayag Sales Intelligence";

    // Cover sheet — basis + active filters, so a filtered file is
    // self-describing and never mistaken for unfiltered company totals.
    const info = wb.addWorksheet("Info");
    info.columns = [{ width: 26 }, { width: 95 }];
    const infoRows: Array<[string, string]> = [
      ["Page", `Products — FY ${p.fy} primary sales by product (sale_line register)`],
      ["FY", p.fy],
      ["Month filter", months?.length ? months.join(", ") : "Full FY"],
       ["Category", category === "All" ? "All categories" : category],
       ["Category allocation", "A sale-line's full value is included in every effective category assignment; All counts each sale-line once."],
       ["Mapped sales rows", String(p.mappingSplit.mapped.rows)],
       ["Mapped sales value (INR)", String(p.mappingSplit.mapped.value)],
       ["Unmapped sales rows", String(p.mappingSplit.unmapped.rows)],
       ["Unmapped sales value (INR)", String(p.mappingSplit.unmapped.value)],
      ["Total sales (INR)", String(p.total)],
      ["State Head filter", filter?.heads?.length ? filter.heads.join(", ") : "All"],
      ["State filter", filter?.states?.length ? filter.states.join(", ") : "All"],
      ["Distributor filter", filter?.customers?.length ? filter.customers.join(", ") : "All"],
      ["Provisional months", provisionalInfo],
      ["Note", "Quantity is per product only and must never be summed across products or groups (litres vs pieces). WATER TANK rows report litres."],
    ];
    for (const [k, v] of infoRows) {
      const row = info.addRow([k, v]);
      row.getCell(1).font = { bold: true };
    }

    const ws = wb.addWorksheet("Products");
    const columns = [
      { header: "Code", key: "code", width: 14 },
      { header: "Product", key: "product", width: 40 },
      { header: "Group", key: "group", width: 22 },
      { header: "Qty", key: "qty", width: 12 },
      { header: "Unit", key: "unit", width: 8 },
      { header: "Sales (INR)", key: "amount", width: 16 },
    ];
    ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    ws.getRow(1).eachCell((cell) => {
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
    });
    const truncated = p.products.length > MAX_EXPORT_ROWS_PER_SHEET;
    for (const r of p.products.slice(0, MAX_EXPORT_ROWS_PER_SHEET)) {
      ws.addRow(columns.map((c) => (r as unknown as Record<string, unknown>)[c.key] ?? ""));
    }
    if (truncated) {
      const row = ws.addRow([`… truncated: showing ${MAX_EXPORT_ROWS_PER_SHEET.toLocaleString()} of ${p.products.length.toLocaleString()} rows. Narrow the filters to export the rest.`]);
      row.font = { italic: true };
    }
    ws.views = [{ state: "frozen", ySplit: 1 }];

    const buf = await wb.xlsx.writeBuffer();
    const suffix = p.filtered ? "_filtered" : "";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="Products_${fy}${suffix}_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    if (respondIfQuotaError(err, res)) return;
    req.log.error({ err }, "product-reports export error");
    res.status(500).json({ error: "Export failed" });
  } finally {
    activeExports--;
  }
});

export default router;
