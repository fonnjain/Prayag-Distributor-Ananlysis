// Three-way reconciliation for a fiscal year: xlsx-as-ingested vs live
// Sheets (read now) vs the DB. Proves the sale_line foundation matches the
// sources and lists any live rows missing from the DB.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, saleLines, type InsertSaleLine } from "@workspace/db";
import registerSheets from "../../../config/register_sheets.json";
import { logger } from "../logger.js";
import {
  OccurrenceCounter,
  emptyUnmapped,
  parseRegisterRow,
  toSaleLine,
} from "../registers/normalize.js";
import { readRegisterFromSheets } from "../registers/sheetsRegister.js";
import {
  insertSaleLineBatches,
  markSheetConfirmed,
  assertNoNegativeAmounts,
  assertSumConsistency,
  recordIngestRun,
  BATCH_SIZE,
} from "../registers/ingest.js";

export const REGISTER_SHEET_IDS: Record<string, string> =
  registerSheets.registers;

export const DELTA_THRESHOLD_PCT = 0.5;

export type Breakdown = { key: string; amount: number };

export type SourceAggregates = {
  rows: number;
  amount: number;
  invoices: number;
  customers: number;
  byGroup: Breakdown[];
  byHead: Breakdown[];
};

export type MissingRow = {
  invoiceNo: string | null;
  code: string;
  qty: number | null;
  amount: number;
  monthLabel: string | null;
  customer: string | null;
};

function sortBreakdown(map: Map<string, number>): Breakdown[] {
  return [...map.entries()]
    .map(([key, amount]) => ({ key, amount: Math.round(amount) }))
    .sort((a, b) => b.amount - a.amount);
}

// Aggregates sale_line rows for one FY, optionally restricted to a source.
export async function dbAggregates(
  fy: string,
  source?: string,
): Promise<SourceAggregates> {
  const where = source
    ? and(eq(saleLines.fy, fy), eq(saleLines.source, source))
    : eq(saleLines.fy, fy);

  const [totals] = await db
    .select({
      rows: sql<number>`count(*)::int`,
      amount: sql<number>`coalesce(sum(${saleLines.amount}), 0)::float8`,
      invoices: sql<number>`count(distinct ${saleLines.invoiceNo})::int`,
      customers: sql<number>`count(distinct ${saleLines.customer})::int`,
    })
    .from(saleLines)
    .where(where);

  const byGroupRows = await db
    .select({
      key: sql<string>`coalesce(${saleLines.groupCanon}, 'Unmapped')`,
      amount: sql<number>`coalesce(sum(${saleLines.amount}), 0)::float8`,
    })
    .from(saleLines)
    .where(where)
    .groupBy(sql`1`);

  const byHeadRows = await db
    .select({
      key: sql<string>`coalesce(${saleLines.headCanon}, 'Unmapped')`,
      amount: sql<number>`coalesce(sum(${saleLines.amount}), 0)::float8`,
    })
    .from(saleLines)
    .where(where)
    .groupBy(sql`1`);

  return {
    rows: totals?.rows ?? 0,
    amount: Math.round(totals?.amount ?? 0),
    invoices: totals?.invoices ?? 0,
    customers: totals?.customers ?? 0,
    byGroup: sortBreakdown(
      new Map(byGroupRows.map((r) => [r.key, r.amount])),
    ),
    byHead: sortBreakdown(new Map(byHeadRows.map((r) => [r.key, r.amount]))),
  };
}

export type SheetsDebug = {
  rowsScanned: number;   // data rows seen by readRegisterFromSheets (after header)
  tabsRead: string[];    // tabs that had a recognised header row
  skippedNotRow: number; // parseRegisterRow returned kind !== "row"
  skippedWrongFy: number;// line.fy !== requested fy (FY-column mismatch)
};

export type SheetsReadResult = {
  aggregates: SourceAggregates;
  lines: InsertSaleLine[];
  debug: SheetsDebug;
};

// Reads the live register for a FY and aggregates it in memory using the
// exact normalization path the backfill used, so line_uids are comparable.
export async function readLiveRegister(fy: string): Promise<SheetsReadResult> {
  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) {
    throw new Error(`No live register spreadsheet on record for FY ${fy}`);
  }

  const occurrence = new OccurrenceCounter();
  const unmapped = emptyUnmapped();
  const lines: InsertSaleLine[] = [];
  const invoices = new Set<string>();
  const customers = new Set<string>();
  const byGroup = new Map<string, number>();
  const byHead = new Map<string, number>();
  let amount = 0;

  let skippedNotRow = 0;
  let skippedWrongFy = 0;
  const invalidSample: string[] = [];

  const sheetsResult = await readRegisterFromSheets(spreadsheetId, fy, (values, columns) => {
    const result = parseRegisterRow(values, columns, fy);
    if (result.kind !== "row") {
      skippedNotRow++;
      if (invalidSample.length < 5) {
        const reason = result.kind === "invalid" ? result.reason : "empty";
        const snippet = values.slice(0, 12).map((v) => JSON.stringify(v)).join(", ");
        invalidSample.push(`[${reason}] ${snippet}`);
      }
      return;
    }
    // The occurrence counter must see every row (both FY blocks) in source
    // order to reproduce the backfill's uids exactly.
    const line = toSaleLine(result.row, occurrence, unmapped, "sheets");
    if (line.fy !== fy) { skippedWrongFy++; return; }
    lines.push(line);
    amount += result.row.amount;
    if (line.invoiceNo) invoices.add(line.invoiceNo);
    if (line.customer) customers.add(line.customer);
    const g = line.groupCanon ?? "Unmapped";
    byGroup.set(g, (byGroup.get(g) ?? 0) + result.row.amount);
    const h = line.headCanon ?? "Unmapped";
    byHead.set(h, (byHead.get(h) ?? 0) + result.row.amount);
  });

  if (skippedNotRow > 0 && lines.length === 0) {
    logger.warn(
      { fy, skippedNotRow, skippedWrongFy, invalidSample },
      "readLiveRegister: all rows skipped — see invalidSample for first rows",
    );
  }

  return {
    aggregates: {
      rows: lines.length,
      amount: Math.round(amount),
      invoices: invoices.size,
      customers: customers.size,
      byGroup: sortBreakdown(byGroup),
      byHead: sortBreakdown(byHead),
    },
    lines,
    debug: {
      rowsScanned: sheetsResult.rowsScanned,
      tabsRead: sheetsResult.tabsRead,
      skippedNotRow,
      skippedWrongFy,
    },
  };
}

// Finds live lines whose uid is not in the DB yet.
export async function findMissingLines(
  lines: InsertSaleLine[],
): Promise<InsertSaleLine[]> {
  const missing: InsertSaleLine[] = [];
  for (let i = 0; i < lines.length; i += BATCH_SIZE) {
    const batch = lines.slice(i, i + BATCH_SIZE);
    const existing = await db
      .select({ lineUid: saleLines.lineUid })
      .from(saleLines)
      .where(
        inArray(
          saleLines.lineUid,
          batch.map((l) => l.lineUid),
        ),
      );
    const found = new Set(existing.map((r) => r.lineUid));
    for (const line of batch) {
      if (!found.has(line.lineUid)) missing.push(line);
    }
  }
  return missing;
}

export type Delta = {
  metric: string;
  a: number;
  b: number;
  deltaPct: number;
  flagged: boolean;
};

function pctDelta(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  const base = Math.max(Math.abs(a), Math.abs(b));
  return (Math.abs(a - b) / base) * 100;
}

export function compareSources(
  labelA: string,
  a: SourceAggregates,
  labelB: string,
  b: SourceAggregates,
): { label: string; deltas: Delta[]; flagged: boolean } {
  const make = (metric: string, va: number, vb: number): Delta => {
    const deltaPct = pctDelta(va, vb);
    return {
      metric,
      a: va,
      b: vb,
      deltaPct: Math.round(deltaPct * 1000) / 1000,
      flagged: deltaPct > DELTA_THRESHOLD_PCT,
    };
  };
  const deltas = [
    make("rows", a.rows, b.rows),
    make("amount", a.amount, b.amount),
    make("invoices", a.invoices, b.invoices),
    make("customers", a.customers, b.customers),
  ];
  return {
    label: `${labelA} vs ${labelB}`,
    deltas,
    flagged: deltas.some((d) => d.flagged),
  };
}

export type VerifyReport = {
  fy: string;
  generatedAt: string;
  sources: {
    xlsx: SourceAggregates;
    sheets: SourceAggregates;
    db: SourceAggregates;
  };
  comparisons: Array<{ label: string; deltas: Delta[]; flagged: boolean }>;
  missingFromDb: { count: number; sample: MissingRow[] };
  healthy: boolean;
  // Diagnostic breakdown for the Sheets read — exposes why rows may be
  // missing from the DB even when the Sheets register has data.
  sheetsDebug: SheetsDebug;
};

export async function buildVerifyReport(fy: string): Promise<VerifyReport> {
  const [xlsx, dbAgg, live] = await Promise.all([
    dbAggregates(fy, "xlsx_backfill"),
    dbAggregates(fy),
    readLiveRegister(fy),
  ]);

  const missing = await findMissingLines(live.lines);
  const comparisons = [
    compareSources("sheets", live.aggregates, "db", dbAgg),
    compareSources("xlsx", xlsx, "db", dbAgg),
  ];

  return {
    fy,
    generatedAt: new Date().toISOString(),
    sources: { xlsx, sheets: live.aggregates, db: dbAgg },
    comparisons,
    missingFromDb: {
      count: missing.length,
      sample: missing.slice(0, 50).map((l) => ({
        invoiceNo: l.invoiceNo ?? null,
        code: l.code,
        qty: l.qty == null ? null : Number(l.qty),
        amount: Number(l.amount),
        monthLabel: l.monthLabel ?? null,
        customer: l.customer ?? null,
      })),
    },
    healthy: missing.length === 0 && comparisons.every((c) => !c.flagged),
    sheetsDebug: live.debug,
  };
}

// One-click backfill: inserts live Sheets lines missing from the DB.
export async function backfillMissingFromSheets(
  fy: string,
): Promise<{ rowsRead: number; inserted: number }> {
  const startedAt = new Date();
  const live = await readLiveRegister(fy);
  const missing = await findMissingLines(live.lines);

  // Same ingestion guardrails as the xlsx backfill: never insert rows from a
  // batch with inconsistent sums or unexplained negative amounts.
  const assertions = [
    ...assertSumConsistency(missing),
    ...assertNoNegativeAmounts(missing),
  ];
  const failed = assertions.filter((a) => !a.passed);
  if (failed.length > 0) {
    await recordIngestRun({
      startedAt,
      source: "sheets_verify_backfill",
      fy,
      rowsRead: live.lines.length,
      rowsInserted: 0,
      rowsSkipped: live.lines.length,
      unmapped: {},
      assertions,
      status: "fail",
    });
    throw new Error(
      `Backfill blocked by failed assertions: ${failed.map((a) => `${a.name} (${a.detail})`).join("; ")}`,
    );
  }

  let inserted = 0;
  if (missing.length > 0) {
    inserted = (await insertSaleLineBatches(missing)).inserted;
  }

  // Stamp sheet_confirmed_at on every row currently in the live sheet,
  // regardless of whether it was newly inserted.  Rows absent from this read
  // (e.g. July ghost rows) keep their prior sheet_confirmed_at (null or old).
  await markSheetConfirmed(live.lines.map((l) => l.lineUid), startedAt);

  await recordIngestRun({
    startedAt,
    source: "sheets_verify_backfill",
    fy,
    rowsRead: live.lines.length,
    rowsInserted: inserted,
    rowsSkipped: live.lines.length - inserted,
    unmapped: {},
    assertions,
    status: "ok",
  });
  return { rowsRead: live.lines.length, inserted };
}
