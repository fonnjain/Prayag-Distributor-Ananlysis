/**
 * Pure classification for the SKU/detail versus brand-mirror audit.
 *
 * A mirror is evidence-bearing only for months that have a provenance row from
 * the protected dual-write loader. Older secondary data predates that loader
 * and must not be treated as a failed mirror merely because no mirror exists.
 */

export type SkuBrandMirrorProvenance = {
  monthLabel: string;
  source: string;
  rowCount: number | string | null;
  netAmount: number | string | null;
};

export type SkuBrandMirrorMonthlyTotal = {
  monthLabel: string;
  skuRows: number | string | null;
  skuNet: number | string | null;
  mirrorRows: number | string | null;
  mirrorNet: number | string | null;
};

export type SkuBrandMirrorClassification = {
  status: "skip" | "pass" | "fail";
  authoritativeMonths: string[];
  badMonths: string[];
  detailMismatchMonths: string[];
  mirrorMismatchMonths: string[];
  provenanceTotal: number;
  skuTotal: number;
  mirrorTotal: number;
  provenanceRows: number;
  skuRows: number;
  mirrorRows: number;
};

function asNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asCount(value: number | string | null | undefined): number {
  const parsed = asNumber(value);
  return Math.trunc(parsed);
}

/**
 * Classify only the months whose load provenance identifies the protected
 * dual-write source. The provenance controls are the expected image: missing
 * detail and mirror totals are retained as zero so a complete data loss cannot
 * accidentally pass as 0 = 0. No authoritative provenance yields a deliberate
 * N/A/skip result.
 */
export function classifySkuBrandMirror(input: {
  provenance: SkuBrandMirrorProvenance[];
  monthlyTotals: SkuBrandMirrorMonthlyTotal[];
  protectedSource: string;
  tolerance?: number;
}): SkuBrandMirrorClassification {
  const authoritativeMonths = [...new Set(
    input.provenance
      .filter((row) => row.source === input.protectedSource)
      .map((row) => row.monthLabel),
  )].sort();

  if (authoritativeMonths.length === 0) {
    return {
      status: "skip",
      authoritativeMonths: [],
      badMonths: [],
      detailMismatchMonths: [],
      mirrorMismatchMonths: [],
      provenanceTotal: 0,
      skuTotal: 0,
      mirrorTotal: 0,
      provenanceRows: 0,
      skuRows: 0,
      mirrorRows: 0,
    };
  }

  const provenanceByMonth = new Map<string, SkuBrandMirrorProvenance>();
  for (const row of input.provenance) {
    if (row.source === input.protectedSource) provenanceByMonth.set(row.monthLabel, row);
  }
  const totalsByMonth = new Map<string, {
    skuRows: number;
    skuNet: number;
    mirrorRows: number;
    mirrorNet: number;
  }>();
  for (const row of input.monthlyTotals) {
    if (!authoritativeMonths.includes(row.monthLabel)) continue;
    const current = totalsByMonth.get(row.monthLabel) ?? {
      skuRows: 0, skuNet: 0, mirrorRows: 0, mirrorNet: 0,
    };
    current.skuRows += asCount(row.skuRows);
    current.skuNet += asNumber(row.skuNet);
    current.mirrorRows += asCount(row.mirrorRows);
    current.mirrorNet += asNumber(row.mirrorNet);
    totalsByMonth.set(row.monthLabel, current);
  }

  const tolerance = input.tolerance ?? 1;
  const detailMismatchMonths = authoritativeMonths.filter((month) => {
    const expected = provenanceByMonth.get(month)!;
    const totals = totalsByMonth.get(month) ?? {
      skuRows: 0, skuNet: 0, mirrorRows: 0, mirrorNet: 0,
    };
    return !totalsByMonth.has(month) ||
      totals.skuRows !== asCount(expected.rowCount) ||
      Math.abs(totals.skuNet - asNumber(expected.netAmount)) > tolerance;
  });
  const mirrorMismatchMonths = authoritativeMonths.filter((month) => {
    const expected = provenanceByMonth.get(month)!;
    const totals = totalsByMonth.get(month) ?? {
      skuRows: 0, skuNet: 0, mirrorRows: 0, mirrorNet: 0,
    };
    return !totalsByMonth.has(month) ||
      totals.mirrorRows !== asCount(expected.rowCount) ||
      Math.abs(totals.mirrorNet - asNumber(expected.netAmount)) > tolerance ||
      totals.mirrorRows !== totals.skuRows ||
      Math.abs(totals.mirrorNet - totals.skuNet) > tolerance;
  });
  const badMonths = [...new Set([...detailMismatchMonths, ...mirrorMismatchMonths])];
  let provenanceTotal = 0;
  let skuTotal = 0;
  let mirrorTotal = 0;
  let provenanceRows = 0;
  let skuRows = 0;
  let mirrorRows = 0;
  for (const month of authoritativeMonths) {
    const expected = provenanceByMonth.get(month)!;
    const totals = totalsByMonth.get(month) ?? {
      skuRows: 0, skuNet: 0, mirrorRows: 0, mirrorNet: 0,
    };
    provenanceRows += asCount(expected.rowCount);
    provenanceTotal += asNumber(expected.netAmount);
    skuRows += totals.skuRows;
    skuTotal += totals.skuNet;
    mirrorRows += totals.mirrorRows;
    mirrorTotal += totals.mirrorNet;
  }

  return {
    status: badMonths.length === 0 ? "pass" : "fail",
    authoritativeMonths,
    badMonths,
    detailMismatchMonths,
    mirrorMismatchMonths,
    provenanceTotal,
    skuTotal,
    mirrorTotal,
    provenanceRows,
    skuRows,
    mirrorRows,
  };
}