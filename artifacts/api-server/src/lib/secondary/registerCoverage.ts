import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../logger.js";

export type SecondaryRegisterCoverageDisclosure = {
  code: "H5";
  id: number;
  status: "open";
  owner: string;
  resolutionUrl: string;
  fiscalYear: string;
  targetMonths: string[];
  loadedMonths: string[];
  missingMonths: string[];
  missingRows: number;
  missingNet: number;
  message: string;
};

export type SecondaryRegisterCoverageBuilderInput = {
  id: number;
  owner: string;
  fiscalYear: string;
  targetMonths: string[];
  loadedMonths: string[];
  /** H5-scoped months which still have a live row/net difference. */
  missingMonths: string[];
  /** Live difference, not the H5 estimate. */
  missingRows: number;
  missingNet: number;
  /** H5 value_at_stake, used only for the user-facing disclosure value. */
  h5ValueAtStake: number;
};

type ResolutionRow = {
  id: number;
  fiscal_year: string | null;
  month: string | null;
  owner: string;
  status: string;
  value_at_stake: string | null;
};

const FISCAL_MONTHS = [
  "Apr", "May", "Jun", "Jul", "Aug", "Sep",
  "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
] as const;
const FULL_MONTHS = [
  "April", "May", "June", "July", "August", "September",
  "October", "November", "December", "January", "February", "March",
] as const;

function fiscalMonthLabel(fy: string, index: number): string {
  const start = Number(fy.slice(0, 4));
  const year = index <= 9 ? start : start + 1;
  return `${FISCAL_MONTHS[index - 1]}-${String(year).slice(-2)}`;
}

function parseMonthIndexes(month: string): number[] {
  const found = [...month.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b/gi)]
    .map((match) => {
      const value = match[1]!.slice(0, 3).toLowerCase();
      return FISCAL_MONTHS.findIndex((entry) => entry.toLowerCase() === value || (value === "sep" && entry === "Sep")) + 1;
    })
    .filter((index, position, all) => index > 0 && all.indexOf(index) === position);
  if (found.length === 0) return [];
  if (found.length === 1) return found;
  const from = found[0]!;
  const to = found[found.length - 1]!;
  return Array.from({ length: to - from + 1 }, (_, offset) => from + offset);
}

function formatIndianAmount(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 10_000_000) return (value / 10_000_000).toFixed(2);
  if (absolute >= 100_000) return (value / 100_000).toFixed(2);
  if (absolute >= 1_000) return Math.round(value).toLocaleString("en-IN");
  return value.toFixed(2);
}

function formatMonthRange(labels: string[], fy: string): string {
  const indexes = labels
    .map((label) => FISCAL_MONTHS.indexOf(label.slice(0, 3) as (typeof FISCAL_MONTHS)[number]) + 1)
    .filter((index) => index > 0);
  if (indexes.length === 0) return "no months";
  indexes.sort((a, b) => a - b);
  const start = indexes[0]!;
  const end = indexes[indexes.length - 1]!;
  const startYear = Number(fy.slice(0, 4)) + (start > 9 ? 1 : 0);
  const endYear = Number(fy.slice(0, 4)) + (end > 9 ? 1 : 0);
  const contiguous = indexes.every((index, offset) => offset === 0 || index === indexes[offset - 1]! + 1);
  if (!contiguous) {
    return indexes
      .map((index) => `${FULL_MONTHS[index - 1]} ${Number(fy.slice(0, 4)) + (index > 9 ? 1 : 0)}`)
      .join(", ");
  }
  if (start === end) return `${FULL_MONTHS[start - 1]} ${startYear}`;
  if (startYear === endYear) return `${FULL_MONTHS[start - 1]} to ${FULL_MONTHS[end - 1]} ${startYear}`;
  return `${FULL_MONTHS[start - 1]} ${startYear} to ${FULL_MONTHS[end - 1]} ${endYear}`;
}

/**
 * Pure disclosure builder. H5 owns scope and value_at_stake; the caller owns
 * the live difference. Returning null for a zero live difference is important:
 * after the protected loader completes, an open historical H5 cannot leave a
 * stale banner behind.
 */
export function buildSecondaryRegisterCoverageDisclosure(
  input: SecondaryRegisterCoverageBuilderInput,
): SecondaryRegisterCoverageDisclosure | null {
  if (input.missingRows <= 0 && input.missingNet <= 0.005) return null;
  const missingMonths = input.targetMonths.filter((month) => input.missingMonths.includes(month));
  const missingNet = Number(input.h5ValueAtStake);
  const message =
    `FY${input.fiscalYear} secondary register covers ${formatMonthRange(input.loadedMonths, input.fiscalYear)} only. ` +
    `${formatMonthRange(missingMonths, input.fiscalYear)} - ${input.missingRows.toLocaleString("en-IN")} lines, ` +
    `Rs ${formatIndianAmount(missingNet)} Cr - are not loaded. See Resolution H5.`;
  return {
    code: "H5",
    id: input.id,
    status: "open",
    owner: input.owner,
    resolutionUrl: `/settings/resolution/${encodeURIComponent(String(input.id))}`,
    fiscalYear: input.fiscalYear,
    targetMonths: input.targetMonths,
    loadedMonths: input.loadedMonths,
    missingMonths,
    missingRows: input.missingRows,
    missingNet,
    message,
  };
}

/**
 * H5 is deliberately non-blocking: factual readers may show the loaded
 * months, but must carry this live disclosure until the protected load closes
 * the register gap. The resolution row supplies the scope and value; the
 * live tables supply the remaining row count and NET.
 */
export async function getSecondaryRegisterCoverageDisclosure(
  fy: string,
): Promise<SecondaryRegisterCoverageDisclosure | null> {
  const resolution = await db.execute<ResolutionRow>(sql`
    SELECT id, fiscal_year, month, owner, status, value_at_stake::text
    FROM resolution_item
    WHERE code = 'H5' AND type = 'HOLD' AND status = 'open'
      AND fiscal_year = ${fy}
    LIMIT 1
  `);
  const row = resolution.rows[0];
  if (!row?.month || row.status !== "open") return null;

  const indexes = parseMonthIndexes(row.month);
  const targetMonths = indexes.map((index) => fiscalMonthLabel(fy, index));
  if (targetMonths.length === 0) return null;

  const totals = await db.execute<{
    month_label: string;
    sku_rows: string;
    sku_net: string;
    mirror_rows: string;
    mirror_net: string;
  }>(sql`
    WITH sku AS (
      SELECT month_label, COUNT(*)::text AS sku_rows,
             COALESCE(SUM(net_amount::numeric), 0)::text AS sku_net
      FROM secondary_sku_line
      WHERE fy = ${fy} AND month_label IN (${sql.join(targetMonths.map((label) => sql`${label}`), sql`, `)})
      GROUP BY month_label
    ),
    mirror AS (
      SELECT month_label, COUNT(*)::text AS mirror_rows,
             COALESCE(SUM(net_amount::numeric), 0)::text AS mirror_net
      FROM secondary_register_line
      WHERE fy = ${fy} AND source = 'pscode3_brand_rollup'
        AND month_label IN (${sql.join(targetMonths.map((label) => sql`${label}`), sql`, `)})
      GROUP BY month_label
    )
    SELECT sku.month_label, sku.sku_rows, sku.sku_net,
           COALESCE(mirror.mirror_rows, '0') AS mirror_rows,
           COALESCE(mirror.mirror_net, '0') AS mirror_net
    FROM sku LEFT JOIN mirror USING (month_label)
  `);
  const missing = totals.rows.reduce(
    (result, current) => {
      const rows = Math.max(0, Number(current.sku_rows) - Number(current.mirror_rows));
      const net = Math.max(0, Number(current.sku_net) - Number(current.mirror_net));
      if (rows > 0 || net > 0.005) result.months.push(current.month_label);
      result.rows += rows;
      result.net += net;
      return result;
    },
    { months: [] as string[], rows: 0, net: 0 },
  );
  if (missing.rows === 0 && missing.net <= 0.005) return null;
  const h5ValueAtStake = Number(row.value_at_stake);
  if (!Number.isFinite(h5ValueAtStake)) return null;

  const loaded = await db.execute<{ month_label: string }>(sql`
    SELECT DISTINCT month_label
    FROM secondary_register_line
    WHERE fy = ${fy} AND source = 'pscode3_brand_rollup'
    ORDER BY month_label
  `);
  const loadedMonths = loaded.rows.map((item) => item.month_label);
  return buildSecondaryRegisterCoverageDisclosure({
    id: row.id,
    owner: row.owner,
    fiscalYear: fy,
    targetMonths,
    loadedMonths,
    missingMonths: missing.months,
    missingRows: missing.rows,
    missingNet: missing.net,
    h5ValueAtStake,
  });
}

/** Coverage is annotation-only; a register lookup failure must not fail facts. */
export async function getSecondaryRegisterCoverageDisclosureSafe(
  fy: string,
  consumer = "secondary reader",
): Promise<SecondaryRegisterCoverageDisclosure | null> {
  try {
    return await getSecondaryRegisterCoverageDisclosure(fy);
  } catch (error) {
    logger.warn({ err: error, fy, consumer }, "secondary coverage disclosure unavailable");
    return null;
  }
}

export const parseSecondaryCoverageMonthIndexes = parseMonthIndexes;