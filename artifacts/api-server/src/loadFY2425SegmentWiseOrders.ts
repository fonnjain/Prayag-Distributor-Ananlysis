/**
 * Approved, isolated FY2024-25 Segment Wise order-booking load.
 * Default mode is read-only. Production writes require the dedicated admin route.
 */
import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import anchorsConfig from "../config/secondary_order_anchors.json";
import { assertSegmentWiseDateSignature } from "./lib/mgmt/names.js";
import {
  fiscalYearForLiteralDate,
  literalParseOrderDate,
  parseLegacyV1Rows,
  type LegacyOrderLine,
} from "./lib/secondaryOrders/legacyV1Parser.js";
import { readTabRowsChunked, type SheetCellValue } from "./lib/registers/sheetsApi.js";

const FY = "2024-25";
const anchor = anchorsConfig.years[FY];
const EPSILON = 0.005;

type EnrichedLine = LegacyOrderLine & {
  occurrence: number;
  contentHash: string;
};

type Exclusion = {
  source_row_number: number;
  order_id: string;
  date: string;
  dealer_id: string;
  product_code: string;
  value_rupees: number;
  reason: string;
};

type ProtectedCounts = {
  secondaryRegister: string;
  secondarySku: string;
  saleAllRows: string;
  saleCurrentRows: string;
  fy2526Rows: string;
  fy2526Value: string;
  fy2627Rows: string;
  fy2627Value: string;
  nonTargetOrderRows: string;
  nonTargetOrderValue: string;
};

export type FY2425LoadReport = {
  entryPoint: "load-fy2425-segment-wise-orders";
  dryRun: boolean;
  pass: boolean;
  source: {
    sheetId: string;
    tab: string;
    sha256: string;
    bytes: number;
    physicalRows: number;
    datedRows: number;
    sourceSubtotal: number;
    literalMinDate: string | null;
    literalMaxDate: string | null;
    literalOutsideFiscalYearRows: number;
  };
  controls: {
    dateSignature: ReturnType<typeof parseLegacyV1Rows>["signature"];
    parsedRows: number;
    distinctOrders: number;
    parsedValue: number;
    exclusions: Exclusion[];
    collisions: { orders: number; orderProducts: number };
  };
  monthly: Array<{ month: string; rows: number; orders: number; value: number }>;
  protectedCounts: {
    before: ProtectedCounts;
    transactional?: { before: ProtectedCounts; after: ProtectedCounts };
  };
  loaded?: { rows: number; orders: number; value: number };
};

const text = (value: unknown) => String(value ?? "").trim();
const numberOrNull = (value: unknown): number | null => {
  const raw = text(value).replace(/[₹,\s]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};
const columnsFor = (row: SheetCellValue[]) => {
  const columns: Record<string, number> = {};
  row.forEach((value, index) => {
    const key = text(value).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (key && columns[key] == null) columns[key] = index;
  });
  return columns;
};
const find = (columns: Record<string, number>, ...names: string[]) =>
  names.map((name) => columns[name]).find((index) => index != null) ?? -1;

export function inspectFY2425SourceRows(rawRows: SheetCellValue[][]): {
  datedRows: number;
  sourceSubtotal: number;
  exclusions: Exclusion[];
  literalMinDate: string | null;
  literalMaxDate: string | null;
  literalOutsideFiscalYearRows: number;
} {
  let columns: Record<string, number> | null = null;
  const carry: Record<string, unknown> = {};
  const exclusions: Exclusion[] = [];
  let datedRows = 0;
  let sourceSubtotal = 0;
  let literalMin: Date | null = null;
  let literalMax: Date | null = null;
  let literalOutsideFiscalYearRows = 0;

  for (let rowIndex = 0; rowIndex < rawRows.length; rowIndex++) {
    const row = rawRows[rowIndex] ?? [];
    if (!columns) {
      const candidate = columnsFor(row);
      if (
        find(candidate, "date", "orderdate") >= 0 &&
        find(candidate, "orderid", "orderno", "sordno", "sord") >= 0 &&
        find(candidate, "subtotal", "netamount", "net") >= 0 &&
        find(candidate, "productcode", "itemcode", "item", "product", "catno", "segment") >= 0 &&
        find(candidate, "retailerid", "retid", "id", "retailer") >= 0
      ) columns = candidate;
      continue;
    }

    const dateIndex = find(columns, "date", "orderdate");
    const orderIndex = find(columns, "orderid", "orderno", "sordno", "sord");
    const dealerIndex = find(columns, "retailerid", "retid", "id", "retailer");
    const productIndex = find(columns, "productcode", "itemcode", "item", "product", "catno", "segment");
    const valueIndex = find(columns, "subtotal", "netamount", "net");
    const setCarry = (key: string, index: number) => {
      if (index >= 0 && text(row[index])) carry[key] = key === "date" ? row[index] : text(row[index]);
    };
    setCarry("date", dateIndex);
    setCarry("order", orderIndex);
    setCarry("dealer", dealerIndex);

    const date = literalParseOrderDate(carry.date);
    if (!date) continue;
    if (!literalMin || date < literalMin) literalMin = date;
    if (!literalMax || date > literalMax) literalMax = date;
    if (fiscalYearForLiteralDate(date) !== FY) {
      literalOutsideFiscalYearRows++;
      continue;
    }
    datedRows++;
    const value = numberOrNull(row[valueIndex]) ?? 0;
    sourceSubtotal += value;
    const productCode = text(row[productIndex]);
    if (!productCode) {
      exclusions.push({
        source_row_number: rowIndex + 1,
        order_id: text(carry.order),
        date: date.toISOString().slice(0, 10),
        dealer_id: text(carry.dealer),
        product_code: "",
        value_rupees: value,
        reason: "blank_product_code_explicitly_excluded",
      });
    }
  }
  return {
    datedRows,
    sourceSubtotal,
    exclusions,
    literalMinDate: literalMin?.toISOString().slice(0, 10) ?? null,
    literalMaxDate: literalMax?.toISOString().slice(0, 10) ?? null,
    literalOutsideFiscalYearRows,
  };
}

export function assertApprovedExclusions(actual: Exclusion[]): void {
  if (JSON.stringify(actual) !== JSON.stringify(anchor.approved_exclusions)) {
    throw new Error(`FY2024-25 blank-code exclusions changed: expected ${JSON.stringify(anchor.approved_exclusions)}, received ${JSON.stringify(actual)}`);
  }
}

function enrich(lines: LegacyOrderLine[]): EnrichedLine[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const key = `${line.orderId}\0${line.productCode}`;
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return {
      ...line,
      occurrence,
      contentHash: createHash("sha256").update(JSON.stringify(line)).digest("hex"),
    };
  });
}

function summary(lines: EnrichedLine[]) {
  return {
    rows: lines.length,
    orders: new Set(lines.map((line) => line.orderId)).size,
    value: lines.reduce((sum, line) => sum + (line.basicOrderValue ?? 0), 0),
  };
}

function monthlySummary(lines: EnrichedLine[]) {
  const order = ["Apr-24", "May-24", "Jun-24", "Jul-24", "Aug-24", "Sep-24", "Oct-24", "Nov-24", "Dec-24", "Jan-25", "Feb-25", "Mar-25"];
  return order.map((month) => {
    const [name, year] = month.split("-");
    const monthIndex = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(name);
    const scoped = lines.filter((line) => line.orderDatetime.getUTCMonth() === monthIndex && String(line.orderDatetime.getUTCFullYear()).slice(-2) === year);
    const result = summary(scoped);
    return { month, rows: result.rows, orders: result.orders, value: result.value };
  });
}

const PROTECTED_COUNTS_SQL = `
  SELECT
    (SELECT count(*) FROM secondary_register_line)::text AS "secondaryRegister",
    (SELECT count(*) FROM secondary_sku_line)::text AS "secondarySku",
    (SELECT count(*) FROM sale_line_all)::text AS "saleAllRows",
    (SELECT count(*) FROM sale_line)::text AS "saleCurrentRows",
    (SELECT count(*) FROM secondary_order_line WHERE fiscal_year='2025-26')::text AS "fy2526Rows",
    (SELECT COALESCE(sum(basic_order_value),0)::numeric::text FROM secondary_order_line WHERE fiscal_year='2025-26') AS "fy2526Value",
    (SELECT count(*) FROM secondary_order_line WHERE fiscal_year='2026-27')::text AS "fy2627Rows",
    (SELECT COALESCE(sum(basic_order_value),0)::numeric::text FROM secondary_order_line WHERE fiscal_year='2026-27') AS "fy2627Value",
    (SELECT count(*) FROM secondary_order_line
      WHERE NOT (COALESCE(source_era,'')='legacy_crm'
             AND COALESCE(source_kind,'')='segment_wise'
             AND COALESCE(fiscal_year,'')='2024-25'
             AND COALESCE(period_completeness,'')='complete'
             AND COALESCE(source_id,'')='${anchor.sheet_id}'))::text AS "nonTargetOrderRows",
    (SELECT COALESCE(sum(basic_order_value),0)::numeric::text FROM secondary_order_line
      WHERE NOT (COALESCE(source_era,'')='legacy_crm'
             AND COALESCE(source_kind,'')='segment_wise'
             AND COALESCE(fiscal_year,'')='2024-25'
             AND COALESCE(period_completeness,'')='complete'
             AND COALESCE(source_id,'')='${anchor.sheet_id}')) AS "nonTargetOrderValue"
`;

async function protectedCounts(queryable: { query: (...args: any[]) => Promise<any> } = pool): Promise<ProtectedCounts> {
  const result = await queryable.query(PROTECTED_COUNTS_SQL);
  return result.rows[0] as ProtectedCounts;
}

async function collisionCounts(lines: EnrichedLine[]) {
  const orderIds = [...new Set(lines.map((line) => line.orderId))];
  const result = await pool.query<{ order_id: string; product_code: string }>(
    `SELECT DISTINCT order_id, product_code
       FROM secondary_order_line
      WHERE fiscal_year IN ('2025-26','2026-27')
        AND order_id = ANY($1::text[])`,
    [orderIds],
  );
  const pairs = new Set(lines.map((line) => `${line.orderId}\0${line.productCode}`));
  return {
    orders: new Set(result.rows.map((row) => row.order_id)).size,
    orderProducts: result.rows.filter((row) => pairs.has(`${row.order_id}\0${row.product_code}`)).length,
  };
}

function assertControl(name: string, actual: number, expected: number): void {
  if (Math.abs(actual - expected) > EPSILON) {
    throw new Error(`FY2024-25 ${name} control failed: expected ${expected}, received ${actual}`);
  }
}

async function insertLines(client: { query: (...args: any[]) => Promise<any> }, lines: EnrichedLine[]): Promise<void> {
  const columns = 21;
  const batchSize = 250;
  for (let offset = 0; offset < lines.length; offset += batchSize) {
    const batch = lines.slice(offset, offset + batchSize);
    const params: unknown[] = [];
    const values = batch.map((line, rowIndex) => {
      const start = rowIndex * columns;
      params.push(
        anchor.source_era, anchor.source_kind, FY, anchor.period_completeness, anchor.sheet_id,
        line.orderId, line.orderDatetime, null, line.salesUserName, line.customerName,
        line.dealerId, line.cpName, null, line.categoryName, line.productCode,
        line.occurrence, line.sourceRowNumber, line.contentHash, line.qty, line.basicOrderValue,
        `google-sheet:${anchor.sheet_id}/${anchor.tab}`,
      );
      return `(${Array.from({ length: columns }, (_, index) => `$${start + index + 1}`).join(",")})`;
    });
    await client.query(
      `INSERT INTO secondary_order_line
       (source_era,source_kind,fiscal_year,period_completeness,source_id,order_id,order_datetime,
        order_status,sales_user_name,customer_name,dealer_id,cp_name,cp_code,category_name,product_code,
        occurrence,source_row_number,content_hash,qty,basic_order_value,source_file)
       VALUES ${values.join(",")}`,
      params,
    );
  }
}

async function writeSlice(
  lines: EnrichedLine[],
  source: FY2425LoadReport["source"],
  monthly: FY2425LoadReport["monthly"],
  exclusions: Exclusion[],
): Promise<{ before: ProtectedCounts; after: ProtectedCounts }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('fy2425-segment-wise-order-load'))");
    const before = await protectedCounts(client);
    await client.query(
      `DELETE FROM secondary_order_line
        WHERE source_era=$1 AND source_kind=$2 AND fiscal_year=$3
          AND period_completeness=$4 AND source_id=$5`,
      [anchor.source_era, anchor.source_kind, FY, anchor.period_completeness, anchor.sheet_id],
    );
    await insertLines(client, lines);
    await client.query(
      `INSERT INTO secondary_order_upload
       (source_file,source_id,entry_point,source_sha256,source_bytes,verification,comparison,assessment,material_reasons,analytics_status)
       VALUES ($1,$2,'load-fy2425-segment-wise-orders',$3,$4,$5::jsonb,$6::jsonb,
               'FY2425_APPROVED_CORRECTED_SOURCE_LOADED',$7::text[],'ISOLATED_PENDING_RELIABILITY')`,
      [
        `google-sheet:${anchor.sheet_id}/${anchor.tab}`,
        anchor.sheet_id,
        source.sha256,
        source.bytes,
        JSON.stringify({
          anchor,
          exclusions,
          monthly,
          loaded: summary(lines),
        }),
        JSON.stringify({
          previousAnchor: anchor.previous_anchor,
          acceptedDifference: { physicalRows: -4, sourceSubtotalRupees: -5594.91 },
        }),
        [anchor.reason, "One approved blank-product-code row excluded explicitly."],
      ],
    );
    const after = await protectedCounts(client);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`protected counts changed: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    }
    const loadedResult = await client.query<{ rows: string; orders: string; value: string }>(
      `SELECT count(*)::text rows, count(DISTINCT order_id)::text orders,
              COALESCE(sum(basic_order_value),0)::numeric::text value
         FROM secondary_order_line
        WHERE source_era=$1 AND source_kind=$2 AND fiscal_year=$3 AND period_completeness=$4`,
      [anchor.source_era, anchor.source_kind, FY, anchor.period_completeness],
    );
    const loaded = loadedResult.rows[0];
    assertControl("loaded rows", Number(loaded.rows), anchor.parser_rows);
    assertControl("loaded orders", Number(loaded.orders), anchor.distinct_orders);
    assertControl("loaded value", Number(loaded.value), anchor.parser_value_rupees);
    await client.query("COMMIT");
    return { before, after };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function runFY2425SegmentWiseOrders(writeMode = false): Promise<FY2425LoadReport> {
  const rawRows: SheetCellValue[][] = [];
  await readTabRowsChunked(anchor.sheet_id, anchor.tab, (batch) => rawRows.push(...batch));
  const raw = JSON.stringify(rawRows);
  const source = {
    sheetId: anchor.sheet_id,
    tab: anchor.tab,
    sha256: createHash("sha256").update(raw).digest("hex"),
    bytes: Buffer.byteLength(raw),
    physicalRows: rawRows.length,
    ...inspectFY2425SourceRows(rawRows),
  };
  if (source.sha256 !== anchor.approved_source_sha256 || source.bytes !== anchor.approved_source_bytes) {
    throw new Error(
      `FY2024-25 approved source fingerprint changed: expected ${anchor.approved_source_sha256}/${anchor.approved_source_bytes}, received ${source.sha256}/${source.bytes}`,
    );
  }
  assertApprovedExclusions(source.exclusions);
  const parsed = parseLegacyV1Rows(rawRows, { kind: "column" });
  const dateSignature = {
    ...parsed.signature,
    literalOutsideFiscalYearRows: source.literalOutsideFiscalYearRows,
  };
  assertSegmentWiseDateSignature(FY, dateSignature);
  const lines = enrich(parsed.lines.filter((line) => line.fiscalYear === FY));
  const actual = summary(lines);
  assertControl("physical rows", source.physicalRows, anchor.physical_rows);
  assertControl("dated rows", source.datedRows, anchor.dated_rows);
  assertControl("outside-FY rows", source.literalOutsideFiscalYearRows, anchor.literal_outside_fiscal_year_rows);
  if (source.literalMinDate !== anchor.literal_min_date || source.literalMaxDate !== anchor.literal_max_date) {
    throw new Error(`FY2024-25 literal date range changed: expected ${anchor.literal_min_date}..${anchor.literal_max_date}, received ${source.literalMinDate}..${source.literalMaxDate}`);
  }
  assertControl("source Sub Total", source.sourceSubtotal, anchor.source_subtotal_rupees);
  assertControl("parser rows", actual.rows, anchor.parser_rows);
  assertControl("distinct orders", actual.orders, anchor.distinct_orders);
  assertControl("parser value", actual.value, anchor.parser_value_rupees);
  const collisions = await collisionCounts(lines);
  assertControl("order collisions", collisions.orders, 0);
  assertControl("order/product collisions", collisions.orderProducts, 0);
  const monthly = monthlySummary(lines);
  const before = await protectedCounts();
  const report: FY2425LoadReport = {
    entryPoint: "load-fy2425-segment-wise-orders",
    dryRun: !writeMode,
    pass: true,
    source: {
      sheetId: source.sheetId,
      tab: source.tab,
      sha256: source.sha256,
      bytes: source.bytes,
      physicalRows: source.physicalRows,
      datedRows: source.datedRows,
      sourceSubtotal: source.sourceSubtotal,
      literalMinDate: source.literalMinDate,
      literalMaxDate: source.literalMaxDate,
      literalOutsideFiscalYearRows: source.literalOutsideFiscalYearRows,
    },
    controls: {
      dateSignature,
      parsedRows: actual.rows,
      distinctOrders: actual.orders,
      parsedValue: actual.value,
      exclusions: source.exclusions,
      collisions,
    },
    monthly,
    protectedCounts: { before },
  };
  if (writeMode) {
    report.protectedCounts.transactional = await writeSlice(lines, report.source, monthly, source.exclusions);
    report.loaded = actual;
  }
  return report;
}

if (process.argv[1]?.includes("loadFY2425SegmentWiseOrders")) {
  runFY2425SegmentWiseOrders(process.argv.includes("--write"))
    .then(async (report) => {
      console.log(JSON.stringify(report, null, 2));
      await pool.end();
    })
    .catch(async (error) => {
      console.error(error);
      await pool.end();
      process.exit(1);
    });
}