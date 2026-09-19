import { pool } from "@workspace/db";
import { currentOpenFy } from "../fyAnchors.js";

export type ProductWiseDiscountRow = {
  productCode: string;
  month: string;
  transactionDate: string | Date;
  segment: string | null;
  discountPct: number | null;
  basicOrderValueExGst: number;
};

export type ProductWiseMrpResult = ProductWiseDiscountRow & {
  mrp: number | null;
  mrpSource: "mrp_history" | "mrp_synced";
  gross: number | null;
  grossBasis: "derived" | null;
  included: boolean;
  exclusionReason: "missing_mrp" | "invalid_discount" | "non_positive_denominator" | null;
};

export type ProductWiseMrpControls = {
  rows: number;
  includedRows: number;
  missingMrpRows: number;
  missingMrpValue: number;
  invalidDiscountRows: number;
  invalidDiscountValue: number;
  nonPositiveDenominatorRows: number;
  nonPositiveDenominatorValue: number;
  excludedCodes: string[];
  valueSelected: number;
  valueCovered: number;
  valueCoveragePct: number;
};

export type ProductWiseMrpAdapted = {
  rows: ProductWiseMrpResult[];
  controls: ProductWiseMrpControls;
  source: "productwise_xlsx";
  valueBasis: "basic_order_value_ex_gst";
  mrpSources: Array<"mrp_history" | "mrp_synced">;
  observedGross: false;
};

function dateValue(value: string | Date): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid Product-Wise transaction date '${value}'`);
  return date;
}

/** Product-Wise and MRP catalogues use the same code vocabulary, but exports
 * have historically varied in casing and surrounding whitespace. */
export function normaliseMrpCode(productCode: string): string {
  return productCode.trim().toUpperCase();
}

function fyForDate(date: Date): string {
  const year = date.getUTCFullYear();
  const start = date.getUTCMonth() >= 3 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function productWiseMrpLookupKey(productCode: string, transactionDate: string | Date): string {
  return `${normaliseMrpCode(productCode)}\u0000${dateValue(transactionDate).toISOString().slice(0, 10)}`;
}

/** Pure application of an effective MRP lookup. Missing MRP is not zero. */
export function applyProductWiseMrp(
  input: ProductWiseDiscountRow[],
  mrps: Map<string, number | null>,
): ProductWiseMrpAdapted {
  const rows = input.map((row) => {
    const rowDate = dateValue(row.transactionDate);
    const mrpSource = fyForDate(rowDate) === currentOpenFy() ? "mrp_synced" as const : "mrp_history" as const;
    // Code-only fallback keeps this pure helper convenient for focused tests.
    // The database adapter always supplies the stricter code+transaction-date key.
    const normalisedCode = normaliseMrpCode(row.productCode);
    const mrp = mrps.get(productWiseMrpLookupKey(normalisedCode, rowDate))
      ?? mrps.get(normalisedCode)
      ?? null;
    const denominator = row.discountPct == null ? null : 1 - row.discountPct / 100;
    let exclusionReason: ProductWiseMrpResult["exclusionReason"] = null;
    if (mrp == null) exclusionReason = "missing_mrp";
    else if (denominator == null || !Number.isFinite(denominator)) exclusionReason = "invalid_discount";
    else if (denominator <= 0) exclusionReason = "non_positive_denominator";
    const included = exclusionReason == null;
    return {
      ...row, mrp, mrpSource,
      gross: included ? row.basicOrderValueExGst / denominator! : null,
      grossBasis: included ? "derived" as const : null,
      included, exclusionReason,
    };
  });
  const valueSelected = rows.reduce((sum, row) => sum + row.basicOrderValueExGst, 0);
  const includedRows = rows.filter((row) => row.included);
  const valueCovered = includedRows.reduce((sum, row) => sum + row.basicOrderValueExGst, 0);
  return {
    rows,
    controls: {
      rows: rows.length,
      includedRows: includedRows.length,
      missingMrpRows: rows.filter((row) => row.exclusionReason === "missing_mrp").length,
      missingMrpValue: rows.filter((row) => row.exclusionReason === "missing_mrp")
        .reduce((sum, row) => sum + row.basicOrderValueExGst, 0),
      invalidDiscountRows: rows.filter((row) => row.exclusionReason === "invalid_discount").length,
      invalidDiscountValue: rows.filter((row) => row.exclusionReason === "invalid_discount")
        .reduce((sum, row) => sum + row.basicOrderValueExGst, 0),
      nonPositiveDenominatorRows: rows.filter((row) => row.exclusionReason === "non_positive_denominator").length,
      nonPositiveDenominatorValue: rows.filter((row) => row.exclusionReason === "non_positive_denominator")
        .reduce((sum, row) => sum + row.basicOrderValueExGst, 0),
      excludedCodes: [...new Set(rows.filter((row) => !row.included)
        .map((row) => normaliseMrpCode(row.productCode)))].sort(),
      valueSelected,
      valueCovered,
      valueCoveragePct: valueSelected > 0 ? valueCovered / valueSelected : 0,
    },
    source: "productwise_xlsx",
    valueBasis: "basic_order_value_ex_gst",
    mrpSources: [...new Set(rows.map((row) => row.mrpSource))],
    observedGross: false,
  };
}

/**
 * Read-only effective lookup. Closed months use effective-dated history;
 * current-open-FY months use the active synced catalogue. A missing row is the
 * same not-offered/unpriced outcome used by primary coverage.
 */
export async function adaptProductWiseMrp(rows: ProductWiseDiscountRow[]): Promise<ProductWiseMrpAdapted> {
  const openFy = currentOpenFy();
  if (rows.length === 0) {
    return applyProductWiseMrp([], new Map());
  }
  const datedRows = rows.map((row) => ({ row, date: dateValue(row.transactionDate) }));
  const openRows = datedRows.filter(({ date }) => fyForDate(date) === openFy);
  const closedRows = datedRows.filter(({ date }) => fyForDate(date) !== openFy);
  const currentGeneration = await pool.query<{ generation_id: string }>(
    "SELECT generation_id::text FROM mrp_sync_generation WHERE is_active = TRUE LIMIT 1",
  );
  const generation = currentGeneration.rows[0]?.generation_id ?? null;
  const lookup = new Map<string, number | null>();
  if (generation && openRows.length) {
    const codes = [...new Set(openRows.map(({ row }) => normaliseMrpCode(row.productCode)))];
    const result = await pool.query<{ item_code: string; mrp: string | null }>(
      `SELECT item_code, mrp::text FROM mrp_synced
       WHERE generation_id = $1 AND UPPER(BTRIM(item_code)) = ANY($2::text[])`,
      [generation, codes],
    );
    const currentByCode = new Map(result.rows.map((row) => [
      normaliseMrpCode(row.item_code),
      row.mrp == null ? null : Number(row.mrp),
    ]));
    for (const { row, date } of openRows) {
      const code = normaliseMrpCode(row.productCode);
      lookup.set(productWiseMrpLookupKey(code, date), currentByCode.get(code) ?? null);
    }
  } else {
    for (const { row, date } of openRows) {
      lookup.set(productWiseMrpLookupKey(row.productCode, date), null);
    }
  }
  if (closedRows.length) {
    const requests = [...new Map(closedRows.map(({ row, date }) => [
      productWiseMrpLookupKey(row.productCode, date),
      { productCode: normaliseMrpCode(row.productCode), date: date.toISOString().slice(0, 10) },
    ])).values()];
    const params: string[] = [];
    const valuesSql = requests.map(({ productCode, date }, index) => {
      params.push(productCode, date);
      return `($${index * 2 + 1}::text, $${index * 2 + 2}::date)`;
    }).join(", ");
    const result = await pool.query<{ item_code: string; tx_date: string; mrp: string | null }>(
      `WITH requested(item_code, tx_date) AS (VALUES ${valuesSql})
       SELECT requested.item_code, requested.tx_date::text, effective.mrp::text
         FROM requested
         LEFT JOIN LATERAL (
           SELECT h.mrp
             FROM mrp_history h
             WHERE UPPER(BTRIM(h.item_code)) = requested.item_code
              AND h.mrp IS NOT NULL
              AND h.effective_from <= requested.tx_date
              AND (h.effective_to IS NULL OR h.effective_to > requested.tx_date)
            ORDER BY h.effective_from DESC
            LIMIT 1
         ) effective ON TRUE`,
      params,
    );
    result.rows.forEach((row) => {
       lookup.set(productWiseMrpLookupKey(row.item_code, row.tx_date), row.mrp == null ? null : Number(row.mrp));
    });
  }
  return applyProductWiseMrp(rows, lookup);
}