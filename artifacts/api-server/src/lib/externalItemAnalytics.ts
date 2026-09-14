import { pool } from "@workspace/db";
import { createHash } from "node:crypto";
import { openMonthLabels } from "./registers/monthlyReplace.js";
import {
  getOpenResolutionHolds,
  resolveHoldExclusionsFromRows,
  type ResolutionHold,
  type HoldResolutionInput,
  type StructuredExclusion,
} from "./resolution/holdResolver.js";

export const PAGE_DEFAULT = 200;
export const PAGE_MAX = 500;
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FY_RE = /^(\d{4})-(\d{2})$/;
const YM_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const SOURCE_CUTOFF = "2026-06";

export type ExternalMonth = { ym: string; label: string };
export type ExternalRequest = {
  fy: string;
  from: string;
  to: string;
  months: ExternalMonth[];
  limit: number;
  cursor: ExternalCursor | null;
};

export type ExternalCursor = {
  month: string;
  code: string;
  segment?: string;
  query_hash: string;
  source_version: string;
  endpoint: "sales" | "margin";
};

export type ExternalCoverage = {
  requested: { from: string; to: string };
  returned: string[];
  held: Array<{
    months: string[];
    scope: string;
    reason: string;
    hold_id: string;
  }>;
  unavailable: Array<{ months: string[]; reason: string }>;
  provisional: string[];
  read_at: string;
  /** Additive aliases make the machine-readable period sets unambiguous. */
  requested_periods: string[];
  reconciliation: {
    fy: "2026-27";
    control: 135340056814;
    actual: 135232056020;
    variance: -108000794;
    variance_pct: -0.0008;
    status: "unreconciled";
    reference: "P003";
  };
};

export const P003_RECONCILIATION: ExternalCoverage["reconciliation"] = {
  fy: "2026-27",
  control: 135340056814,
  actual: 135232056020,
  variance: -108000794,
  variance_pct: -0.0008,
  status: "unreconciled",
  reference: "P003",
};

type QueryRow = Record<string, unknown>;

export function queryHash(fy: string, from: string, to: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ fy: fy.trim(), from: from.trim(), to: to.trim() }))
    .digest("hex");
}

export class ExternalSourceChangedError extends Error {
  readonly code = "source_changed";
  constructor() {
    super("The external source or normalized query changed while paging.");
    this.name = "ExternalSourceChangedError";
  }
}

export class ProvenanceUnavailableError extends Error {
  readonly code = "provenance_unavailable";
  constructor() {
    super("External data-source provenance is not configured.");
    this.name = "ProvenanceUnavailableError";
  }
}

/**
 * Resolve the fiscal months without relying on database date parsing.  This
 * is deliberately pure so clients and route tests can share the exact
 * validation rule.
 */
export function fiscalMonths(fy: string): ExternalMonth[] {
  const match = FY_RE.exec(fy);
  if (!match || Number(match[2]) !== (Number(match[1]) + 1) % 100) return [];
  const startYear = Number(match[1]);
  return Array.from({ length: 12 }, (_, index) => {
    const month = (index + 3) % 12;
    const year = startYear + (month < 3 ? 1 : 0);
    return {
      ym: `${year}-${String(month + 1).padStart(2, "0")}`,
      label: `${MONTH_ABBR[month]}-${String(year % 100).padStart(2, "0")}`,
    };
  });
}

export function parseExternalRequest(query: Record<string, unknown>): ExternalRequest {
  const fy = typeof query.fy === "string" ? query.fy.trim() : "";
  const from = typeof query.from === "string" ? query.from.trim() : "";
  const to = typeof query.to === "string" ? query.to.trim() : "";
  const months = fiscalMonths(fy);
  if (!FY_RE.test(fy) || months.length !== 12) throw new Error("fy is required and must be YYYY-YY");
  if (!YM_RE.test(from) || !YM_RE.test(to)) throw new Error("from and to are required and must be YYYY-MM");
  const fromIndex = months.findIndex((month) => month.ym === from);
  const toIndex = months.findIndex((month) => month.ym === to);
  if (fromIndex < 0 || toIndex < 0 || fromIndex > toIndex) {
    throw new Error("from and to must be within fy and from must not be after to");
  }

  const rawLimit = query.limit ?? query.page_size ?? PAGE_DEFAULT;
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) {
    throw new Error(`limit must be an integer between 1 and ${PAGE_MAX}`);
  }
  const cursor = decodeCursor(typeof query.cursor === "string" ? query.cursor : null);
  const selected = months.slice(fromIndex, toIndex + 1);
  if (cursor && !selected.some((month) => month.label === cursor.month)) {
    throw new Error("cursor month is outside the requested range");
  }
  if (cursor && (
    !cursor.query_hash ||
    !cursor.source_version ||
    !cursor.endpoint ||
    cursor.query_hash !== queryHash(fy, from, to)
  )) {
    throw new ExternalSourceChangedError();
  }
  return { fy, from, to, months: selected, limit, cursor };
}

export function encodeCursor(cursor: ExternalCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null): ExternalCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<ExternalCursor>;
    if (
      typeof value.month !== "string" ||
      typeof value.code !== "string" ||
      typeof value.query_hash !== "string" ||
      typeof value.source_version !== "string" ||
      (value.endpoint !== "sales" && value.endpoint !== "margin")
    ) throw new Error("invalid");
    if (value.segment !== undefined && typeof value.segment !== "string") throw new Error("invalid");
    return {
      month: value.month,
      code: value.code,
      query_hash: value.query_hash,
      source_version: value.source_version,
      endpoint: value.endpoint,
      ...(value.segment === undefined ? {} : { segment: value.segment }),
    };
  } catch {
    throw new Error("cursor is not valid");
  }
}

export type ExternalDataSource = "heliumdb" | "neondb";

export function dataSourceFromDatabaseName(databaseName: string): ExternalDataSource {
  if (databaseName === "heliumdb" || databaseName === "neondb") return databaseName;
  throw new ProvenanceUnavailableError();
}

/** Read provenance from PostgreSQL itself; never infer it from a URL or env. */
export async function dataSource(): Promise<ExternalDataSource> {
  const result = await pool.query<{ database_name: string }>(
    "SELECT current_database() AS database_name",
  );
  return dataSourceFromDatabaseName(String(result.rows[0]?.database_name ?? ""));
}

export function monthUnavailableForMargin(ym: string): boolean {
  return ym > SOURCE_CUTOFF;
}

function monthLabels(months: ExternalMonth[]): string[] {
  return months.map((month) => month.label);
}

function monthYm(label: string): string {
  const match = /^([A-Z][a-z]{2})-(\d{2})$/.exec(label);
  const month = match ? MONTH_ABBR.indexOf(match[1]!) + 1 : 0;
  return match && month > 0 ? `20${match[2]}-${String(month).padStart(2, "0")}` : label;
}

function builtInHolds(): ResolutionHold[] {
  // Keep these exact scopes in the resolver input even during the period
  // between seeding the resolution register and a deployment reading it.
  return [
    {
      id: "PTMT-COST-2026",
      code: "H1",
      type: "HOLD",
      title: "PTMT margin cost basis",
      scope: "PTMT · margin, gross contribution, BOM cost",
      reason: "Factory cost is approximately 40% of the true level; gross margin is overstated.",
      fiscalYear: "2025-26",
      month: "Jan-26, Feb-26, Mar-26",
      scopeProduct: "PTMT",
      scopeMeasure: "margin, gross contribution, BOM cost",
      resolutionUrl: "/settings/resolution/PTMT-COST-2026",
    },
    {
      id: "PTMT-COST-2026",
      code: "H1",
      type: "HOLD",
      title: "PTMT margin cost basis",
      scope: "PTMT · margin, gross contribution, BOM cost",
      reason: "Factory cost is approximately 40% of the true level; gross margin is overstated.",
      fiscalYear: "2026-27",
      month: "Apr-26",
      scopeProduct: "PTMT",
      scopeMeasure: "margin, gross contribution, BOM cost",
      resolutionUrl: "/settings/resolution/PTMT-COST-2026",
    },
    {
      id: "FY2425-MONTHLY-ATTRIBUTION",
      code: "H3",
      type: "HOLD",
      title: "FY2024-25 monthly attribution",
      scope: "FY2024-25 · monthly and quarterly figures",
      reason: "28,613 rows retain reversed day and month; annual total is correct but monthly attribution is not.",
      fiscalYear: "2024-25",
      month: monthlyAttributionPeriodLabels().join(", "),
      scopeProduct: null,
      scopeMeasure: "monthly attribution, quarterly figures",
      resolutionUrl: "/settings/resolution/FY2425-MONTHLY-ATTRIBUTION",
    },
  ];
}

export function monthlyAttributionPeriodLabels(): string[] {
  return fiscalMonths("2024-25").map((month) => month.label);
}

function uniqueHolds(rows: ResolutionHold[]): ResolutionHold[] {
  const byKey = new Map<string, ResolutionHold>();
  for (const row of rows) byKey.set(`${row.id}:${row.fiscalYear}:${row.month}`, row);
  return [...byKey.values()];
}

function normal(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A seeded fallback is used only when the live register has no equivalent. */
function semanticallySameHold(a: ResolutionHold, b: ResolutionHold): boolean {
  if (a.code || b.code) return a.code === b.code;
  const aProduct = normal(a.scopeProduct);
  const bProduct = normal(b.scopeProduct);
  if (aProduct !== bProduct &&
      !(aProduct && bProduct && (aProduct.includes(bProduct) || bProduct.includes(aProduct)))) {
    return false;
  }
  const aMeasure = normal(a.scopeMeasure);
  const bMeasure = normal(b.scopeMeasure);
  const measureParts = (value: string) => value.split(/[;,|]/).map((part) => part.trim()).filter(Boolean);
  if (aMeasure !== bMeasure &&
      !(aMeasure && bMeasure && (
        aMeasure.includes(bMeasure) ||
        bMeasure.includes(aMeasure) ||
        measureParts(aMeasure).some((part) => measureParts(bMeasure).includes(part))
      ))) {
    return false;
  }
  if (a.fiscalYear && b.fiscalYear && a.fiscalYear !== b.fiscalYear) return false;
  // Same product/measure/FY is the stable identity for the register's H1
  // split rows, even when one source records "Jan-Apr 2026" as a range.
  return true;
}

function holdRowsForCode(rows: ResolutionHold[], code: string): ResolutionHold[] {
  return rows.filter((row) => row.code === code);
}

export function resolveExternalHoldRows(
  input: HoldResolutionInput,
  rows: ResolutionHold[],
  code: string,
): StructuredExclusion[] {
  return resolveHoldExclusionsFromRows(
    { ...input, strictFiscalYear: true },
    holdRowsForCode(rows, code),
  );
}

export async function resolveExternalHolds(
  months: ExternalMonth[],
  measure: string,
  product: string | null = null,
  code: string,
): Promise<StructuredExclusion[]> {
  const dbRows = await getOpenResolutionHolds();
  const fallbackRows = holdRowsForCode(builtInHolds(), code);
  const registeredRows = holdRowsForCode(dbRows, code).map((registered) => {
    const matchingFallbacks = fallbackRows.filter((fallback) =>
      semanticallySameHold(registered, fallback),
    );
    if (matchingFallbacks.length === 0) return registered;
    // Preserve the register's id/title/reason, but use the canonical seeded
    // month span because the persisted H3 row historically says only
    // "FY2024-25", which the generic period parser cannot expand.
    return {
      ...registered,
      month: matchingFallbacks.map((fallback) => fallback.month).join(", "),
    };
  });
  const unmatchedFallbacks = fallbackRows.filter(
    (fallback) => !holdRowsForCode(dbRows, code).some((registered) => semanticallySameHold(registered, fallback)),
  );
  return resolveHoldExclusionsFromRows(
    { measure, product, requestedPeriods: monthLabels(months), strictFiscalYear: true },
    uniqueHolds([...registeredRows, ...unmatchedFallbacks]),
  );
}

function exclusionMonths(exclusions: StructuredExclusion[]): string[] {
  return [...new Set(exclusions.flatMap((item) => item.coverage.heldPeriods))];
}

function uniqueExclusions(exclusions: StructuredExclusion[]): StructuredExclusion[] {
  const seen = new Set<string>();
  return exclusions.filter((item) => {
    const key = `${item.resolutionItemId}:${item.coverage.heldPeriods.slice().sort().join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveMonthlyAttributionHolds(
  months: ExternalMonth[],
): Promise<StructuredExclusion[]> {
  // H3's live register uses "monthly figures"; the external contract uses
  // "monthly attribution". Resolve both explicit aliases through the central
  // resolver, then collapse the same registered hold into one exclusion.
  const [attribution, figures] = await Promise.all([
    resolveExternalHolds(months, "monthly attribution", null, "H3"),
    resolveExternalHolds(months, "monthly figures", null, "H3"),
  ]);
  return uniqueExclusions([...attribution, ...figures]);
}

function globalExclusionMonths(exclusions: StructuredExclusion[]): string[] {
  return [
    ...new Set(
      exclusions
        .filter((item) => item.scopeProduct == null)
        .flatMap((item) => item.coverage.heldPeriods),
    ),
  ];
}

function toHeldCoverage(exclusions: StructuredExclusion[]): ExternalCoverage["held"] {
  return exclusions.map((item) => ({
    months: item.coverage.heldPeriods.map(monthYm),
    scope: item.scopeProduct ?? item.scopeLabel,
    reason: item.reason,
    hold_id: String(item.resolutionItemId),
  }));
}

function toNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numeric(value: unknown): number {
  return toNumber(value) ?? 0;
}

export type CatalogueStatus = "matched" | "present_unpriced" | "absent";

export function resolveCatalogueStatus(
  existsInActiveCatalogue: boolean,
  hasActivePrice: boolean,
): CatalogueStatus {
  if (hasActivePrice) return "matched";
  if (existsInActiveCatalogue) return "present_unpriced";
  return "absent";
}

export function requestedCoverage(
  request: ExternalRequest,
  exclusions: StructuredExclusion[],
  readAt: string,
  unavailableAfterCutoff: boolean,
): ExternalCoverage {
  const unavailableMonths = unavailableAfterCutoff
    ? request.months.filter((month) => monthUnavailableForMargin(month.ym))
    : [];
  const held = globalExclusionMonths(exclusions);
  const returned = request.months
    .filter((month) => !held.includes(month.label) && !unavailableMonths.some((item) => item.label === month.label))
    .map((month) => month.ym);
  const provisional = openMonthLabels(request.fy)
    .filter((label) => returned.includes(monthYm(label)))
    .map(monthYm);
  return {
    requested: { from: request.from, to: request.to },
    requested_periods: request.months.map((month) => month.ym),
    returned,
    held: toHeldCoverage(exclusions),
    unavailable: unavailableMonths.length
      ? [{ months: unavailableMonths.map((month) => month.ym), reason: "Source data is unavailable after Jun-26." }]
      : [],
    provisional,
    read_at: readAt,
    reconciliation: P003_RECONCILIATION,
  };
}

function binaryCompare(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function rowCompare<T extends { month_label: string; code?: string; item_code?: string; segment?: string }>(
  a: T,
  b: T,
  labels: Map<string, number>,
): number {
  const monthDelta = (labels.get(a.month_label) ?? 0) - (labels.get(b.month_label) ?? 0);
  if (monthDelta) return monthDelta < 0 ? -1 : 1;
  const codeDelta = binaryCompare(a.code ?? a.item_code ?? "", b.code ?? b.item_code ?? "");
  if (codeDelta) return codeDelta;
  return binaryCompare(a.segment ?? "", b.segment ?? "");
}

export function applyCursor<T extends { month_label: string; code?: string; item_code?: string; segment?: string }>(
  rows: T[],
  request: ExternalRequest,
): T[] {
  const labels = new Map(request.months.map((month, index) => [month.label, index]));
  const sorted = [...rows].sort((a, b) => rowCompare(a, b, labels));
  if (!request.cursor) return sorted;
  const cursor = request.cursor;
  const cursorRow = {
    month_label: cursor.month,
    ...(cursor.endpoint === "margin" ? { item_code: cursor.code } : { code: cursor.code }),
    segment: cursor.segment,
  } as T;
  return sorted.filter((row) => rowCompare(row, cursorRow, labels) > 0);
}

export type ExternalSalesRow = {
  code: string;
  month_label: string;
  fy: string;
  qty: number | null;
  qty_ltr?: number | null;
  amount: number;
  row_count: number;
  catalogue_status: "matched" | "absent" | "present_unpriced";
  qty_unresolved?: boolean;
  last_modified: string | null;
};

export type SourceMetadata = {
  sourceVersion: string;
  dataSource: ExternalDataSource;
  lastModified: Record<string, string | null>;
};

/**
 * Revision invariant for the supported loaders: every sale-line mutation
 * assigns a new ingested_at, every margin-fact load assigns a new loaded_at,
 * and an active MRP generation is immutable after publication. The
 * external_source_revision triggers are the durable mutation control; the
 * timestamps remain the response's last-modified metadata without requiring
 * source-row serialization or transfer.
 */
async function salesSourceMetadata(request: ExternalRequest): Promise<SourceMetadata> {
  const result = await pool.query<{
    source_version: string;
    database_name: string;
    month_last_modified: string;
  }>(
    `WITH source_month AS (
          SELECT requested.month_label,
                 COALESCE(revision.revision, 0)::text AS revision,
                 (
                   SELECT MAX(sl.ingested_at)::text
                     FROM sale_line_current sl
                    WHERE sl.fy = $1
                      AND sl.month_label = requested.month_label
                 ) AS latest_read
            FROM unnest($2::text[]) AS requested(month_label)
            LEFT JOIN external_source_revision revision
              ON revision.source = 'sales'
             AND revision.fy = $1
             AND revision.month_label = requested.month_label
       )
       SELECT current_database() AS database_name,
              COALESCE((SELECT jsonb_object_agg(month_label, latest_read)
                          FROM source_month), '{}'::jsonb)::text AS month_last_modified,
            md5(
              'DB|' || current_database() || E'\\x1eROWS|' ||
              COALESCE((SELECT string_agg(
                concat_ws(':', month_label, revision),
                '|' ORDER BY month_label COLLATE "C"
              ) FROM source_month), '') ||
              E'\\x1eHOLD|' ||
              COALESCE((
                SELECT COUNT(*)::text || ':' || COALESCE(MAX(ri.updated_at)::text, '')
                  FROM resolution_item ri
                 WHERE upper(COALESCE(ri.type, '')) = 'HOLD'
                   AND lower(COALESCE(ri.status, '')) = 'open'
                   AND COALESCE(ri.blocks_api, TRUE) = TRUE
              ), '0:') ||
              E'\\x1eHOLD_DIGEST|' ||
              md5(COALESCE((
                SELECT string_agg(
                  concat_ws(':', ri.id, ri.type, ri.status, ri.updated_at::text, ri.blocks_api),
                  '|' ORDER BY ri.id
                )
                  FROM resolution_item ri
                 WHERE upper(COALESCE(ri.type, '')) = 'HOLD'
                   AND lower(COALESCE(ri.status, '')) = 'open'
                   AND COALESCE(ri.blocks_api, TRUE) = TRUE
              ), '')) ||
              E'\\x1eMRP_GENERATION|' ||
              COALESCE((
                SELECT string_agg(
                  concat_ws(':', mg.generation_id::text, mg.checksum),
                  '|' ORDER BY mg.generation_id
                )
                  FROM mrp_sync_generation mg
                 WHERE mg.is_active = TRUE
              ), '')
            ) AS source_version`,
    [request.fy, request.months.map((month) => month.label)],
  );
  const row = result.rows[0];
  return {
    sourceVersion: String(row?.source_version ?? ""),
    dataSource: dataSourceFromDatabaseName(String(row?.database_name ?? "")),
    lastModified: row?.month_last_modified ? JSON.parse(row.month_last_modified) as Record<string, string | null> : {},
  };
}

async function marginSourceMetadata(request: ExternalRequest): Promise<SourceMetadata> {
  const result = await pool.query<{
    source_version: string;
    database_name: string;
    month_last_modified: string;
  }>(
    `WITH source_month AS (
          SELECT requested.month_label,
                 COALESCE(revision.revision, 0)::text AS revision,
                 (
                   SELECT MAX(mf.loaded_at)::text
                     FROM margin_fact mf
                    WHERE mf.fy = $1
                      AND mf.month_label = requested.month_label
                 ) AS latest_read
            FROM unnest($2::text[]) AS requested(month_label)
            LEFT JOIN external_source_revision revision
              ON revision.source = 'margin'
             AND revision.fy = $1
             AND revision.month_label = requested.month_label
       )
       SELECT current_database() AS database_name,
              COALESCE((SELECT jsonb_object_agg(month_label, latest_read)
                          FROM source_month), '{}'::jsonb)::text AS month_last_modified,
            md5(
              'DB|' || current_database() || E'\\x1eROWS|' ||
              COALESCE((SELECT string_agg(
                concat_ws(':', month_label, revision),
                '|' ORDER BY month_label COLLATE "C"
              ) FROM source_month), '') ||
              E'\\x1eHOLD|' ||
              COALESCE((
                SELECT COUNT(*)::text || ':' || COALESCE(MAX(ri.updated_at)::text, '')
                  FROM resolution_item ri
                 WHERE upper(COALESCE(ri.type, '')) = 'HOLD'
                   AND lower(COALESCE(ri.status, '')) = 'open'
                   AND COALESCE(ri.blocks_api, TRUE) = TRUE
              ), '0:') ||
              E'\\x1eHOLD_DIGEST|' ||
              md5(COALESCE((
                SELECT string_agg(
                  concat_ws(':', ri.id, ri.type, ri.status, ri.updated_at::text, ri.blocks_api),
                  '|' ORDER BY ri.id
                )
                  FROM resolution_item ri
                 WHERE upper(COALESCE(ri.type, '')) = 'HOLD'
                   AND lower(COALESCE(ri.status, '')) = 'open'
                   AND COALESCE(ri.blocks_api, TRUE) = TRUE
              ), ''))
            ) AS source_version`,
    [request.fy, request.months.map((month) => month.label)],
  );
  const row = result.rows[0];
  return {
    sourceVersion: String(row?.source_version ?? ""),
    dataSource: dataSourceFromDatabaseName(String(row?.database_name ?? "")),
    lastModified: row?.month_last_modified ? JSON.parse(row.month_last_modified) as Record<string, string | null> : {},
  };
}

export function checkCursor(
  request: ExternalRequest,
  sourceVersion: string,
  endpoint: ExternalCursor["endpoint"],
): void {
  if (!request.cursor) return;
  if (
    request.cursor.endpoint !== endpoint ||
    request.cursor.query_hash !== queryHash(request.fy, request.from, request.to) ||
    request.cursor.source_version !== sourceVersion
  ) {
    throw new ExternalSourceChangedError();
  }
}

type SalesRangeTotals = {
  qty: number | null;
  qty_ltr: number;
  amount: number;
  row_count: number;
  qty_unresolved: boolean;
};

const salesRangeTotalsCache = new Map<string, SalesRangeTotals>();
const SALES_RANGE_TOTALS_CACHE_MAX = 64;

type SalesRangeTotalsRead = {
  totals: SalesRangeTotals;
  cached: boolean;
  cacheKey: string;
};

async function readSalesRangeTotals(
  request: ExternalRequest,
  available: string[],
  sourceVersion: string,
): Promise<SalesRangeTotalsRead> {
  const cacheKey = `${queryHash(request.fy, request.from, request.to)}:${sourceVersion}`;
  const cached = salesRangeTotalsCache.get(cacheKey);
  if (cached) return { totals: { ...cached }, cached: true, cacheKey };
  const result = await pool.query<QueryRow>(
    `SELECT
        CASE WHEN COALESCE(BOOL_OR(
          upper(btrim(COALESCE(sl.group_canon, sl.group_raw, ''))) = 'WATER TANK'
          AND sl.qty_ltr IS NULL
        ), FALSE)
        THEN NULL ELSE COALESCE(SUM(sl.qty), 0) END::text AS qty,
        COALESCE(SUM(
          CASE WHEN upper(btrim(COALESCE(sl.group_canon, sl.group_raw, ''))) = 'WATER TANK'
               THEN COALESCE(sl.qty_ltr, sl.qty) ELSE 0 END
        ), 0)::text AS qty_ltr,
        COALESCE(SUM(sl.amount), 0)::text AS amount,
        COUNT(*)::text AS row_count,
        COALESCE(BOOL_OR(
          upper(btrim(COALESCE(sl.group_canon, sl.group_raw, ''))) = 'WATER TANK'
          AND sl.qty_ltr IS NULL
        ), FALSE) AS qty_unresolved
       FROM sale_line_current sl
      WHERE sl.fy = $1 AND sl.month_label = ANY($2::text[])`,
    [request.fy, available],
  );
  const row = result.rows[0] ?? {};
  const totals: SalesRangeTotals = {
    qty: row.qty == null ? null : toNumber(row.qty),
    qty_ltr: numeric(row.qty_ltr),
    amount: numeric(row.amount),
    row_count: Math.trunc(numeric(row.row_count)),
    qty_unresolved: Boolean(row.qty_unresolved),
  };
  return { totals, cached: false, cacheKey };
}

function cacheSalesRangeTotals(read: SalesRangeTotalsRead): void {
  if (read.cached) return;
  if (salesRangeTotalsCache.size >= SALES_RANGE_TOTALS_CACHE_MAX) {
    const oldest = salesRangeTotalsCache.keys().next().value;
    if (oldest) salesRangeTotalsCache.delete(oldest);
  }
  salesRangeTotalsCache.set(read.cacheKey, read.totals);
}

export function ensureSourceStable(before: SourceMetadata, after: SourceMetadata): void {
  if (
    before.sourceVersion !== after.sourceVersion ||
    before.dataSource !== after.dataSource
  ) {
    throw new ExternalSourceChangedError();
  }
}

export async function readSalesByItem(request: ExternalRequest, readAt: string) {
  const metadata = await salesSourceMetadata(request);
  const sourceVersion = metadata.sourceVersion;
  checkCursor(request, sourceVersion, "sales");
  const exclusions = await resolveMonthlyAttributionHolds(request.months);
  const coverage = requestedCoverage(request, exclusions, readAt, false);
  const heldMonths = globalExclusionMonths(exclusions);
  const available = request.months
    .filter((month) => !heldMonths.includes(month.label))
    .map((month) => month.label);
  const result = await pool.query<QueryRow>(
    `WITH grouped_sales AS (
          SELECT upper(btrim(sl.code)) AS code, sl.month_label, sl.fy,
                 SUM(sl.qty)::text AS qty,
                 CASE WHEN BOOL_OR(upper(btrim(COALESCE(sl.group_canon, sl.group_raw, ''))) = 'WATER TANK')
                      THEN SUM(COALESCE(sl.qty_ltr, sl.qty)) FILTER (
                             WHERE upper(btrim(COALESCE(sl.group_canon, sl.group_raw, ''))) = 'WATER TANK'
                           )
                      ELSE NULL END::text AS qty_ltr,
                 BOOL_OR(upper(btrim(COALESCE(sl.group_canon, sl.group_raw, ''))) = 'WATER TANK') AS is_tank,
                 BOOL_OR(
                   upper(btrim(COALESCE(sl.group_canon, sl.group_raw, ''))) = 'WATER TANK'
                   AND sl.qty_ltr IS NULL
                 ) AS qty_unresolved,
                 SUM(sl.amount)::text AS amount, COUNT(*)::text AS row_count,
                 MAX(sl.ingested_at)::text AS last_modified
            FROM sale_line_current sl
           WHERE sl.fy = $1
             AND sl.month_label = ANY($2::text[])
             AND sl.month_label = ANY($3::text[])
           GROUP BY upper(btrim(sl.code)), sl.month_label, sl.fy
       ),
       active_catalogue AS (
          SELECT upper(btrim(ms.item_code)) AS code,
                 BOOL_OR(ms.mrp IS NOT NULL AND ms.mrp > 0) AS has_active_price
            FROM mrp_synced ms
            JOIN mrp_sync_generation mg
              ON mg.generation_id = ms.generation_id
             AND mg.is_active = TRUE
           GROUP BY upper(btrim(ms.item_code))
       )
       SELECT gs.code, gs.month_label, gs.fy, gs.qty, gs.qty_ltr,
              gs.is_tank, gs.qty_unresolved, gs.amount, gs.row_count,
              CASE WHEN ac.has_active_price THEN 'matched'
                   WHEN ac.code IS NOT NULL THEN 'present_unpriced'
                   ELSE 'absent' END AS catalogue_status,
              gs.last_modified
         FROM grouped_sales gs
         LEFT JOIN active_catalogue ac ON ac.code = gs.code
        WHERE
          (
            $4::text IS NULL OR
            array_position($3::text[], gs.month_label) >
              array_position($3::text[], $4::text) OR
            (
              array_position($3::text[], gs.month_label) =
                array_position($3::text[], $4::text)
              AND gs.code COLLATE "C" >
                COALESCE($5::text, '') COLLATE "C"
            )
          )
        ORDER BY array_position($3::text[], gs.month_label),
                 gs.code COLLATE "C"
        LIMIT $6`,
    [
      request.fy,
      available,
      request.months.map((month) => month.label),
      request.cursor?.month ?? null,
      request.cursor?.code ?? null,
      request.limit + 1,
    ],
  );
  const fetchedData: ExternalSalesRow[] = (result.rows as QueryRow[]).map((row) => {
    const isTank = Boolean(row.is_tank);
    const qtyUnresolved = isTank && Boolean(row.qty_unresolved);
    const qtyLtr = toNumber(row.qty_ltr);
    return {
      code: String(row.code),
      month_label: String(row.month_label),
      fy: String(row.fy),
      qty: qtyUnresolved ? null : numeric(row.qty),
      ...(isTank ? { qty_ltr: qtyLtr } : {}),
      amount: numeric(row.amount),
      row_count: Math.trunc(numeric(row.row_count)),
      catalogue_status: resolveCatalogueStatus(
        row.catalogue_status !== "absent",
        row.catalogue_status === "matched",
      ),
      ...(qtyUnresolved ? { qty_unresolved: true } : {}),
      last_modified: row.last_modified ? new Date(String(row.last_modified)).toISOString() : null,
    };
  });
  const hasMore = fetchedData.length > request.limit;
  const page = fetchedData.slice(0, request.limit);
  const last = page.at(-1);
  const rangeTotalsRead = await readSalesRangeTotals(request, available, sourceVersion);
  // Totals may be cached, but the final revision check is mandatory after
  // both page and aggregate reads. A fresh aggregate enters the cache only
  // after this check succeeds.
  ensureSourceStable(metadata, await salesSourceMetadata(request));
  cacheSalesRangeTotals(rangeTotalsRead);
  const rangeTotals = rangeTotalsRead.totals;
  const publicPage = page.map(({ last_modified: _lastModified, ...row }) => row);
  return {
    data: publicPage,
    range_totals: rangeTotals,
    coverage,
    dataSource: metadata.dataSource,
    pagination: {
      limit: request.limit,
      cursor: request.cursor ? encodeCursor(request.cursor) : null,
      next_cursor: hasMore && last ? encodeCursor({
        month: last.month_label,
        code: last.code,
        query_hash: queryHash(request.fy, request.from, request.to),
        source_version: sourceVersion,
        endpoint: "sales",
      }) : null,
      has_more: hasMore,
    },
    last_modified: Object.fromEntries(
      request.months.map((month) => [
        month.label,
        metadata.lastModified[month.label] ?? null,
      ]),
    ),
    reconciliation: reconciliation(request, rangeTotals, coverage),
  };
}

export type ExternalMarginRow = {
  item_code: string;
  month_label: string;
  fy: string;
  segment: string;
  qty: number;
  sale_value: number;
  bom_value: number;
  gross_margin_pct: number | null;
  mrp: number | null;
  avg_sale: number | null;
  discount_frac: number | null;
  last_modified: string | null;
};

export async function readMarginByItem(request: ExternalRequest, readAt: string) {
  const metadata = await marginSourceMetadata(request);
  const sourceVersion = metadata.sourceVersion;
  checkCursor(request, sourceVersion, "margin");
  const exclusions = await resolveExternalHolds(request.months, "margin", "PTMT", "H1");
  const h3 = await resolveMonthlyAttributionHolds(request.months);
  const allExclusions = uniqueExclusions([...exclusions, ...h3]);
  const coverage = requestedCoverage(request, allExclusions, readAt, true);
  const heldMonths = globalExclusionMonths(allExclusions);
  const scopedHeldMonths = exclusionMonths(allExclusions);
  const available = request.months
    .filter((month) => !heldMonths.includes(month.label) && monthUnavailableForMargin(month.ym) === false)
    .map((month) => month.label);
  const result = await pool.query<QueryRow>(
    `SELECT upper(btrim(item_code)) AS item_code, month_label, fy, btrim(segment) AS segment,
            SUM(qty)::text AS qty, SUM(sale_value)::text AS sale_value,
            SUM(bom_value)::text AS bom_value,
            CASE WHEN SUM(sale_value) = 0 THEN NULL
                 ELSE ((SUM(sale_value) - SUM(bom_value)) / SUM(sale_value)) END::text AS gross_margin_pct,
            AVG(mrp)::text AS mrp, AVG(avg_sale)::text AS avg_sale,
            AVG(discount_frac)::text AS discount_frac, MAX(loaded_at)::text AS last_modified
       FROM margin_fact
      WHERE fy = $1
        AND month_label = ANY($2::text[])
        AND month_label = ANY($3::text[])
        AND NOT (
          month_label = ANY($4::text[])
          AND upper(btrim(segment)) LIKE '%PTMT%'
        )
         AND (
           $5::text IS NULL OR
           array_position($3::text[], month_label) >
             array_position($3::text[], $5::text) OR
           (
             array_position($3::text[], month_label) =
               array_position($3::text[], $5::text)
             AND (
               upper(btrim(item_code)) COLLATE "C" >
                 COALESCE($6::text, '') COLLATE "C" OR
               (
                 upper(btrim(item_code)) COLLATE "C" =
                   COALESCE($6::text, '') COLLATE "C"
                 AND btrim(segment) COLLATE "C" >
                   COALESCE($7::text, '') COLLATE "C"
               )
             )
           )
         )
       GROUP BY upper(btrim(item_code)), month_label, fy, btrim(segment)
       ORDER BY array_position($3::text[], month_label),
                upper(btrim(item_code)) COLLATE "C",
                btrim(segment) COLLATE "C"
       LIMIT $8`,
    [
      request.fy,
      available,
      request.months.map((month) => month.label),
      scopedHeldMonths,
      request.cursor?.month ?? null,
      request.cursor?.code ?? null,
      request.cursor?.segment ?? null,
      request.limit + 1,
    ],
  );
  ensureSourceStable(metadata, await marginSourceMetadata(request));
  const fetchedData: ExternalMarginRow[] = (result.rows as QueryRow[]).map((row) => ({
    item_code: String(row.item_code),
    month_label: String(row.month_label),
    fy: String(row.fy),
    segment: String(row.segment),
    qty: numeric(row.qty),
    sale_value: numeric(row.sale_value),
    bom_value: numeric(row.bom_value),
    gross_margin_pct: toNumber(row.gross_margin_pct),
    mrp: toNumber(row.mrp),
    avg_sale: toNumber(row.avg_sale),
    discount_frac: toNumber(row.discount_frac),
    last_modified: row.last_modified ? new Date(String(row.last_modified)).toISOString() : null,
  }));
  const hasMore = fetchedData.length > request.limit;
  const page = fetchedData.slice(0, request.limit);
  const last = page.at(-1);
  const publicPage = page.map(({ last_modified: _lastModified, ...row }) => row);
  return {
    data: publicPage,
    coverage,
    dataSource: metadata.dataSource,
    pagination: {
      limit: request.limit,
      cursor: request.cursor ? encodeCursor(request.cursor) : null,
      next_cursor: hasMore && last
          ? encodeCursor({
            month: last.month_label,
            code: last.item_code,
            segment: last.segment,
            query_hash: queryHash(request.fy, request.from, request.to),
            source_version: sourceVersion,
            endpoint: "margin",
          })
        : null,
      has_more: hasMore,
    },
    last_modified: Object.fromEntries(
      request.months.map((month) => [
        month.label,
        metadata.lastModified[month.label] ?? null,
      ]),
    ),
  };
}

export function reconciliation(
  request: ExternalRequest,
  actual: { row_count: number; amount: number },
  coverage: ExternalCoverage,
) {
  const isFy2526 = request.fy === "2025-26" && request.from === "2025-04" && request.to === "2026-03";
  const isFy2627AprAug = request.fy === "2026-27" && request.from === "2026-04" && request.to === "2026-08";
  const expected = isFy2526
    ? { rows: 145613, amount: 3609953808.51 }
    : isFy2627AprAug
      ? { rows: null, amount: 1353400568.14 }
      : null;
  if (!expected) return { status: "not_applicable", expected: null, actual };
  const amountDelta = actual.amount - expected.amount;
  const rowDelta = expected.rows == null ? null : actual.row_count - expected.rows;
  const status = Math.abs(amountDelta) < 0.01 && (rowDelta == null || rowDelta === 0)
    ? "match"
    : "mismatch";
  return {
    status,
    expected,
    actual,
    amount_delta: amountDelta,
    row_delta: rowDelta,
    excluded_months: [...coverage.held.flatMap((hold) => hold.months), ...coverage.unavailable.flatMap((item) => item.months)],
    note: status === "mismatch" ? "Returned values are source totals; no adjustment has been fabricated." : null,
  };
}
