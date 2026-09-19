import { pool } from "@workspace/db";

export type ProductWiseDiscountRow = {
  orderId?: string | null;
  productCode: string;
  month: string;
  transactionDate: string | Date;
  segment: string | null;
  discountPct: number | null;
  /** Product-Wise quantity; required by the price-list gross calculation. */
  qty?: number | null;
  basicOrderValueExGst: number;
};

export type ProductWiseMrpResult = ProductWiseDiscountRow & {
  mrp: number | null;
  mrpSource: "mrp_history" | "mrp_synced";
  grossMrp: number | null;
  discountMrp: number | null;
  /** CRM's own implied gross, retained only as a separately labelled measure. */
  grossCrm: number | null;
  observedCrmDiscount: number | null;
  included: boolean;
  exclusionReason: "missing_mrp" | "invalid_discount" | "non_positive_denominator" | "unit_mismatch" | null;
  unitMismatch: boolean;
  /** A priced row more than 5% from its code's modal implied MRP. */
  priceOutlier: boolean;
  discountDisagreement: boolean;
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
  unitMismatchRows: number;
  unitMismatchValue: number;
  unitMismatchCodes: number;
  unitMismatchCodeList: string[];
  priceOutlierRows: number;
  priceOutlierValue: number;
  priceOutlierCodes: number;
  priceOutlierCodeList: string[];
  agreementWithin1Pct: { codes: number; value: number };
  agreementWithin5Pct: { codes: number; value: number };
  agreementOutside5Pct: { codes: number; value: number };
  disagreementRows: number;
  disagreementValue: number;
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
  mrpBasis: "Primary convention: published effective MRP × Qty directly, with no GST conversion. Product-Wise Basic Order Value remains ex-GST; MRP tax status is not asserted.";
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

export function productWiseMrpLookupKey(productCode: string, transactionDate: string | Date): string {
  return `${normaliseMrpCode(productCode)}\u0000${dateValue(transactionDate).toISOString().slice(0, 10)}`;
}

/** Pure application of an effective MRP lookup. Missing MRP is not zero. */
export function applyProductWiseMrp(
  input: ProductWiseDiscountRow[],
  mrps: Map<string, number | null>,
): ProductWiseMrpAdapted {
  const preliminary = input.map((row) => {
    const rowDate = dateValue(row.transactionDate);
    const sourceMarker = mrps.get(`${productWiseMrpLookupKey(row.productCode, rowDate)}\u0000source`);
    const mrpSource = sourceMarker === -1 ? "mrp_synced" as const : "mrp_history" as const;
    // Code-only fallback keeps this pure helper convenient for focused tests.
    // The database adapter always supplies the stricter code+transaction-date key.
    const normalisedCode = normaliseMrpCode(row.productCode);
    const mrp = mrps.get(productWiseMrpLookupKey(normalisedCode, rowDate))
      ?? mrps.get(normalisedCode)
      ?? null;
    const denominator = row.discountPct == null ? null : 1 - row.discountPct / 100;
    const qty = row.qty == null ? 1 : row.qty;
    const grossCrm = denominator != null && Number.isFinite(denominator) && denominator > 0
      ? row.basicOrderValueExGst / denominator : null;
    const impliedMrp = grossCrm != null && qty > 0 ? grossCrm / qty : null;
    return { row, rowDate, mrp, mrpSource, denominator, qty, grossCrm, impliedMrp };
  });
  const impliedByCode = new Map<string, number[]>();
  for (const value of preliminary) {
    if (value.impliedMrp != null && Number.isFinite(value.impliedMrp) && value.impliedMrp > 0) {
      const code = normaliseMrpCode(value.row.productCode);
      impliedByCode.set(code, [...(impliedByCode.get(code) ?? []), value.impliedMrp]);
    }
  }
  const modalByCode = new Map<string, number>();
  for (const [code, values] of impliedByCode) {
    const frequencies = new Map<number, number>();
    for (const value of values) {
      const rounded = Math.round(value * 100) / 100;
      frequencies.set(rounded, (frequencies.get(rounded) ?? 0) + 1);
    }
    const ordered = [...frequencies.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    if (ordered[0]) modalByCode.set(code, ordered[0][0]);
  }
  const rows = preliminary.map(({ row, mrp, mrpSource, denominator, qty, grossCrm, impliedMrp }) => {
    const code = normaliseMrpCode(row.productCode);
    const modalImpliedMrp = modalByCode.get(code) ?? null;
    const priceOutlier = impliedMrp != null && modalImpliedMrp != null && modalImpliedMrp > 0
      ? Math.abs(impliedMrp / modalImpliedMrp - 1) > 0.05 : false;
    let exclusionReason: ProductWiseMrpResult["exclusionReason"] = null;
    const ratio = mrp != null && impliedMrp != null && mrp > 0 ? impliedMrp / mrp : null;
    if (ratio != null && (ratio < 0.5 || ratio > 2)) exclusionReason = "unit_mismatch";
    else if (mrp == null) exclusionReason = "missing_mrp";
    else if (denominator == null || !Number.isFinite(denominator)) exclusionReason = "invalid_discount";
    else if (denominator <= 0) exclusionReason = "non_positive_denominator";
    const included = exclusionReason == null;
    const grossMrp = included && qty > 0 ? mrp! * qty : null;
    const discountMrp = grossMrp != null && grossMrp > 0
      ? (1 - row.basicOrderValueExGst / grossMrp) * 100 : null;
    const agreementPct = ratio == null ? null : Math.abs(ratio - 1) * 100;
    return {
      ...row, mrp, mrpSource, grossMrp, discountMrp, grossCrm,
      observedCrmDiscount: row.discountPct,
      included, exclusionReason,
      unitMismatch: exclusionReason === "unit_mismatch",
      priceOutlier,
      discountDisagreement: discountMrp != null && row.discountPct != null
        ? Math.abs(discountMrp - row.discountPct) > 2 : false,
      _agreementPct: agreementPct,
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
       unitMismatchRows: rows.filter((row) => row.unitMismatch).length,
      unitMismatchValue: rows.filter((row) => row.unitMismatch)
        .reduce((sum, row) => sum + row.basicOrderValueExGst, 0),
       unitMismatchCodes: new Set(rows.filter((row) => row.unitMismatch)
         .map((row) => normaliseMrpCode(row.productCode))).size,
       unitMismatchCodeList: [...new Set(rows.filter((row) => row.unitMismatch)
         .map((row) => normaliseMrpCode(row.productCode)))].sort(),
       priceOutlierRows: rows.filter((row) => row.priceOutlier).length,
       priceOutlierValue: rows.filter((row) => row.priceOutlier)
         .reduce((sum, row) => sum + row.basicOrderValueExGst, 0),
       priceOutlierCodes: new Set(rows.filter((row) => row.priceOutlier)
         .map((row) => normaliseMrpCode(row.productCode))).size,
       priceOutlierCodeList: [...new Set(rows.filter((row) => row.priceOutlier)
         .map((row) => normaliseMrpCode(row.productCode)))].sort(),
      agreementWithin1Pct: agreementControl(rows, 0, 1),
      agreementWithin5Pct: agreementControl(rows, 1, 5),
      agreementOutside5Pct: agreementControl(rows, 5, Infinity, true),
      disagreementRows: rows.filter((row) => row.discountDisagreement).length,
      disagreementValue: rows.filter((row) => row.discountDisagreement)
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
    mrpBasis: "Primary convention: published effective MRP × Qty directly, with no GST conversion. Product-Wise Basic Order Value remains ex-GST; MRP tax status is not asserted.",
  };
}

function agreementControl(
  rows: Array<ProductWiseMrpResult & { _agreementPct?: number | null }>,
  lower: number,
  upper: number,
  outside = false,
): { codes: number; value: number } {
  // Agreement is a code-level control: aggregate each code once, using its
  // quantity-weighted implied MRP, and assign the code's full Basic value to
  // exactly one mutually-exclusive bucket.
  const byCode = new Map<string, { value: number; grossCrm: number; qty: number; mrp: number }>();
  for (const row of rows) {
    if (row.unitMismatch || row.mrp == null || row.grossCrm == null || row.qty == null || row.qty <= 0) continue;
    const code = normaliseMrpCode(row.productCode);
    const current = byCode.get(code);
    if (current) {
      current.value += row.basicOrderValueExGst;
      current.grossCrm += row.grossCrm;
      current.qty += row.qty;
    } else {
      byCode.set(code, { value: row.basicOrderValueExGst, grossCrm: row.grossCrm, qty: row.qty, mrp: row.mrp });
    }
  }
  const matching = [...byCode.values()].filter((code) => {
    const agreementPct = Math.abs((code.grossCrm / code.qty) / code.mrp - 1) * 100;
    return outside ? agreementPct > lower
      : (lower === 0 ? agreementPct >= lower : agreementPct > lower) && agreementPct <= upper;
  });
  return {
    codes: matching.length,
    value: matching.reduce((sum, code) => sum + code.value, 0),
  };
}

/**
 * Read-only effective lookup. Closed months use effective-dated history;
 * current-open-FY months use the active synced catalogue. A missing row is the
 * same not-offered/unpriced outcome used by primary coverage.
 */
export async function adaptProductWiseMrp(rows: ProductWiseDiscountRow[]): Promise<ProductWiseMrpAdapted> {
  if (rows.length === 0) {
    return applyProductWiseMrp([], new Map());
  }
  const datedRows = rows.map((row) => ({ row, date: dateValue(row.transactionDate) }));
  const lookup = new Map<string, number | null>();
  // Effective history is authoritative. If a row has no history, use the
  // generation that was already active on its transaction date; never use a
  // later refreshed catalogue for a closed row.
  const requests = [...new Map(datedRows.map(({ row, date }) => [
      productWiseMrpLookupKey(row.productCode, date),
      { productCode: normaliseMrpCode(row.productCode), date: date.toISOString().slice(0, 10) },
  ])).values()];
  if (requests.length) {
    const params: string[] = [];
    const valuesSql = requests.map(({ productCode, date }, index) => {
      params.push(productCode, date);
      return `($${index * 2 + 1}::text, $${index * 2 + 2}::date)`;
    }).join(", ");
     const result = await pool.query<{ item_code: string; tx_date: string; mrp: string | null; source: string }>(
      `WITH requested(item_code, tx_date) AS (VALUES ${valuesSql})
        SELECT requested.item_code, requested.tx_date::text,
               COALESCE(effective.mrp, synced.mrp)::text AS mrp,
               CASE WHEN effective.mrp IS NOT NULL THEN 'history' ELSE 'synced' END AS source
         FROM requested
         LEFT JOIN LATERAL (
           SELECT h.mrp
             FROM mrp_history h
             WHERE UPPER(BTRIM(h.item_code)) = requested.item_code
              AND h.mrp IS NOT NULL
              AND h.effective_from <= requested.tx_date
              AND (h.effective_to IS NULL OR h.effective_to > requested.tx_date)
             ORDER BY h.effective_from DESC, h.id DESC
            LIMIT 1
           ) effective ON TRUE
          LEFT JOIN LATERAL (
            SELECT s.mrp
              FROM mrp_synced s
              JOIN mrp_sync_generation g ON g.generation_id = s.generation_id
             WHERE effective.mrp IS NULL
               AND UPPER(BTRIM(s.item_code)) = requested.item_code
               AND g.activated_at <= requested.tx_date::date + INTERVAL '1 day'
             ORDER BY g.activated_at DESC
             LIMIT 1
          ) synced ON TRUE`,
      params,
    );
    result.rows.forEach((row) => {
       const key = productWiseMrpLookupKey(row.item_code, row.tx_date);
       lookup.set(key, row.mrp == null ? null : Number(row.mrp));
       if (row.mrp != null && row.source === "synced") lookup.set(`${key}\u0000source`, -1);
     });
  }
  return applyProductWiseMrp(rows, lookup);
}