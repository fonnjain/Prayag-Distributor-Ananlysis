import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  frozenDriftArchives,
  frozenDriftChecks,
  registerMonthState,
  saleLines,
  type InsertSaleLine,
} from "@workspace/db";
import { currentOpenFy } from "../fyAnchors.js";
import { REGISTER_SHEET_IDS } from "../customers/registerSync.js";
import { allowDelete } from "../deleteGuard.js";
import { logger } from "../logger.js";
import { OccurrenceCounter, emptyUnmapped, parseRegisterRow, toSaleLine } from "./normalize.js";
import { readRegisterFromSheets } from "./sheetsRegister.js";
import { transformRegisterLinesForMonthlyReplace } from "../customers/registerSync.js";

const BATCH_SIZE = 1000;
type Totals = { rows: number; amount: number };
export type DriftStatus = "match" | "drift" | "sheet_unreadable";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function monthTime(label: string): number {
  const m = /^([A-Z][a-z]{2})-(\d{2})$/.exec(label);
  if (!m) return 0;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return Date.UTC(2000 + Number(m[2]), months.indexOf(m[1]), 1);
}

async function frozenMonths(fy: string): Promise<Array<{ month: string; frozenAt: Date }>> {
  const rows = await db.select({ month: registerMonthState.monthLabel, frozenAt: registerMonthState.frozenAt })
    .from(registerMonthState)
    .where(and(eq(registerMonthState.fy, fy), sql`${registerMonthState.frozenAt} is not null`));
  return rows.filter((r): r is { month: string; frozenAt: Date } => r.frozenAt != null)
    .sort((a, b) => monthTime(b.month) - monthTime(a.month)).slice(0, 3);
}

/** The sole eligibility rule for exceptional frozen-month operations. */
export async function isLatestFrozenMonth(fy: string, month: string): Promise<boolean> {
  return (await frozenMonths(fy)).some((entry) => entry.month === month);
}

async function appLines(fy: string, month: string): Promise<InsertSaleLine[]> {
  const rows = await db.select().from(saleLines)
    .where(and(eq(saleLines.fy, fy), eq(saleLines.monthLabel, month), eq(saleLines.versionStatus, "current")));
  return rows.map(({ ingestedAt: _ingestedAt, sheetConfirmedAt: _sheetConfirmedAt, supersededAt: _supersededAt, supersededBy: _supersededBy, ...line }) => line);
}

/** Archive/delete scope intentionally includes current AND historical versions. */
async function allMonthLines(fy: string, month: string) {
  // Do not project/normalise this before archiving: it is the before-image of
  // every physical row the protected DELETE removes, including superseded rows.
  return db.select().from(saleLines)
    .where(and(eq(saleLines.fy, fy), eq(saleLines.monthLabel, month)));
}

async function appLinesIn(tx: typeof db, fy: string, month: string): Promise<InsertSaleLine[]> {
  const rows = await tx.select().from(saleLines)
    .where(and(eq(saleLines.fy, fy), eq(saleLines.monthLabel, month), eq(saleLines.versionStatus, "current")));
  return rows.map(({ ingestedAt: _ingestedAt, sheetConfirmedAt: _sheetConfirmedAt, supersededAt: _supersededAt, supersededBy: _supersededBy, ...line }) => line);
}

async function allMonthLinesIn(tx: typeof db, fy: string, month: string) {
  return tx.select().from(saleLines)
    .where(and(eq(saleLines.fy, fy), eq(saleLines.monthLabel, month)));
}

async function isLatestFrozenMonthIn(tx: typeof db, fy: string, month: string): Promise<boolean> {
  const rows = await tx.select({ month: registerMonthState.monthLabel, frozenAt: registerMonthState.frozenAt })
    .from(registerMonthState)
    .where(and(eq(registerMonthState.fy, fy), sql`${registerMonthState.frozenAt} is not null`));
  return rows.filter((row): row is { month: string; frozenAt: Date } => row.frozenAt != null)
    .sort((a, b) => monthTime(b.month) - monthTime(a.month)).slice(0, 3)
    .some((row) => row.month === month);
}

type InvoiceSummary = { invoice: string; date: string | null; lineCount: number; net: number };
function invoices(lines: InsertSaleLine[]): Map<string, InvoiceSummary> {
  const out = new Map<string, InvoiceSummary>();
  for (const line of lines) {
    const key = line.invoiceNo?.trim() || `(no-invoice):${line.lineUid}`;
    const item = out.get(key) ?? { invoice: key, date: line.invoiceDate ?? null, lineCount: 0, net: 0 };
    item.lineCount++;
    item.net += Number(line.amount) || 0;
    out.set(key, item);
  }
  return out;
}

function totals(lines: InsertSaleLine[]): Totals {
  return { rows: lines.length, amount: lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0) };
}

const NON_REPLACEMENT_FIELDS = new Set([
  "ingestedAt",
  "sheetConfirmedAt",
  "supersededAt",
  "supersededBy",
]);

/** Canonical full replacement-row fingerprint, insensitive to key/input order. */
export function replacementLinesFingerprint(lines: InsertSaleLine[]): string {
  const canonical = lines.map((line) => {
    const entries = Object.entries(line)
      .filter(([key]) => !NON_REPLACEMENT_FIELDS.has(key))
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  }).map((line) => JSON.stringify(line)).sort();
  return hash(canonical);
}

export function refreshPreviewHash(fy: string, month: string, app: InsertSaleLine[], sheet: InsertSaleLine[]): string {
  return hash({
    fy, month,
    app: { totals: totals(app), fingerprint: replacementLinesFingerprint(app) },
    sheet: { totals: totals(sheet), fingerprint: replacementLinesFingerprint(sheet) },
  });
}

export function isFrozenDrift(rowDelta: number, netDelta: number): boolean {
  return rowDelta !== 0 || Math.abs(netDelta) > 1000;
}

export function invoiceDifferences(app: InsertSaleLine[], sheet: InsertSaleLine[]): {
  additions: InvoiceSummary[]; removals: InvoiceSummary[]; changes: Array<{ invoice: string; app: InvoiceSummary; sheet: InvoiceSummary }>;
} {
  const appByInvoice = invoices(app);
  const sheetByInvoice = invoices(sheet);
  const additions: InvoiceSummary[] = [];
  const removals: InvoiceSummary[] = [];
  const changes: Array<{ invoice: string; app: InvoiceSummary; sheet: InvoiceSummary }> = [];
  for (const [invoice, sheetValue] of sheetByInvoice) {
    const appValue = appByInvoice.get(invoice);
    if (!appValue) additions.push(sheetValue);
    else if (appValue.lineCount !== sheetValue.lineCount || Math.abs(appValue.net - sheetValue.net) > 0.001 || appValue.date !== sheetValue.date) {
      changes.push({ invoice, app: appValue, sheet: sheetValue });
    }
  }
  for (const [invoice, appValue] of appByInvoice) if (!sheetByInvoice.has(invoice)) removals.push(appValue);
  return { additions, removals, changes };
}

async function sourceLines(
  fy: string,
  onlyMonthLabels?: readonly string[],
): Promise<Map<string, InsertSaleLine[]>> {
  const spreadsheetId = REGISTER_SHEET_IDS[fy];
  if (!spreadsheetId) throw new Error(`No spreadsheet configured for FY ${fy}`);
  const occurrence = new OccurrenceCounter();
  const unmapped = emptyUnmapped();
  const lines: InsertSaleLine[] = [];
  await readRegisterFromSheets(
    spreadsheetId,
    fy,
    (values, columns, tabMonthLabel) => {
      const parsed = parseRegisterRow(values, columns, fy, tabMonthLabel);
      if (parsed.kind === "row") lines.push(toSaleLine(parsed.row, occurrence, unmapped, "sheets"));
    },
    onlyMonthLabels == null ? undefined : { onlyMonthLabels: new Set(onlyMonthLabels) },
  );
  // This is the exact tank/UID transform used immediately before monthlyReplace.
  return groupByMonth(await transformRegisterLinesForMonthlyReplace(fy, lines));
}

function groupByMonth(lines: InsertSaleLine[]): Map<string, InsertSaleLine[]> {
  const grouped = new Map<string, InsertSaleLine[]>();
  for (const line of lines) {
    if (!line.monthLabel) continue;
    const bucket = grouped.get(line.monthLabel) ?? [];
    bucket.push(line);
    grouped.set(line.monthLabel, bucket);
  }
  return grouped;
}

export type FrozenDriftPreview = {
  id: number;
  fy: string;
  monthLabel: string;
  frozenAt: Date;
  status: DriftStatus;
  app: Totals;
  sheet: Totals | null;
  rowDelta: number | null;
  netDelta: number | null;
  sourceFingerprint: string | null;
  previewHash: string | null;
};

/** Read-only comparison of the only three most recent frozen months. */
export async function detectFrozenDrift(fy = currentOpenFy()): Promise<FrozenDriftPreview[]> {
  if (fy !== currentOpenFy()) throw new Error("frozen drift detection is available for the current FY only");
  const months = await frozenMonths(fy);
  let source: Map<string, InsertSaleLine[]> | null = null;
  let sourceError: string | null = null;
  try {
    source = await sourceLines(fy, months.map(({ month }) => month));
  } catch (err) {
    sourceError = err instanceof Error ? err.message : String(err);
  }
  const results: FrozenDriftPreview[] = [];
  for (const { month, frozenAt } of months) {
    const app = await appLines(fy, month);
    const appTotal = totals(app);
    const sheet = source?.get(month);
    const sheetTotal = sheet ? totals(sheet) : null;
    const rowDelta = sheetTotal == null ? null : appTotal.rows - sheetTotal.rows;
    const netDelta = sheetTotal == null ? null : appTotal.amount - sheetTotal.amount;
    const status: DriftStatus = sheetTotal == null
      ? "sheet_unreadable"
      : (isFrozenDrift(rowDelta!, netDelta!) ? "drift" : "match");
    const fingerprint = sheet ? replacementLinesFingerprint(sheet) : null;
    const evidence = sheet
      ? invoiceDifferences(app, sheet)
      : { sourceError: sourceError ?? "source tab unavailable", appSummary: { rows: appTotal.rows, net: appTotal.amount } };
    const previewHash = sheet ? refreshPreviewHash(fy, month, app, sheet) : null;
    const inserted = await db.insert(frozenDriftChecks).values({
      fy, monthLabel: month, appRows: appTotal.rows, appAmount: String(appTotal.amount),
      sheetRows: sheetTotal?.rows ?? null, sheetAmount: sheetTotal == null ? null : String(sheetTotal.amount),
      rowDelta, netDelta: netDelta == null ? null : String(netDelta), status, evidence,
      sourceFingerprint: fingerprint, previewHash,
    }).returning({ id: frozenDriftChecks.id });
    results.push({ id: inserted[0].id, fy, monthLabel: month, frozenAt, status, app: appTotal, sheet: sheetTotal, rowDelta, netDelta, sourceFingerprint: fingerprint, previewHash });
  }
  return results;
}

export async function previewFrozenRefresh(id: number): Promise<{
  previewHash: string; additions: InvoiceSummary[]; removals: InvoiceSummary[];
  changes: Array<{ invoice: string; app: InvoiceSummary; sheet: InvoiceSummary }>; rowImpact: number; netImpact: number;
}> {
  const check = (await db.select().from(frozenDriftChecks).where(eq(frozenDriftChecks.id, id)))[0];
  if (!check || check.fy !== currentOpenFy() || !await isLatestFrozenMonth(check.fy, check.monthLabel)) {
    throw new Error("drift check not found for the current FY review scope");
  }
  const app = await appLines(check.fy, check.monthLabel);
  const source = await sourceLines(check.fy, [check.monthLabel]);
  const sheet = source.get(check.monthLabel);
  if (!sheet) throw new Error("source tab is unreadable or absent");
  const appTotal = totals(app);
  const sheetTotal = totals(sheet);
  return {
    previewHash: refreshPreviewHash(check.fy, check.monthLabel, app, sheet),
    ...invoiceDifferences(app, sheet), rowImpact: sheetTotal.rows - appTotal.rows, netImpact: sheetTotal.amount - appTotal.amount,
  };
}

export async function applyFrozenRefresh(input: {
  id: number; operator: string; reason: string; previewHash: string;
}): Promise<{ id: number; month: string; rows: number }> {
  if (!input.operator.trim()) throw new Error("operator is required");
  if (input.reason.trim().length < 10) throw new Error("reason must contain at least 10 characters");
  return allowDelete(async (tx) => {
    // The locks cover every mutable input to the approval decision.
    if (!input.operator.trim()) throw new Error("operator is required");
    if (input.reason.trim().length < 10) throw new Error("reason must contain at least 10 characters");
    await tx.execute(sql`SELECT id FROM frozen_drift_check WHERE id = ${input.id} FOR UPDATE`);
    const check = (await tx.select().from(frozenDriftChecks).where(eq(frozenDriftChecks.id, input.id)))[0];
    if (!check) throw new Error("drift check not found");
    await tx.execute(sql`SELECT fy FROM register_month_state WHERE fy = ${check.fy} AND month_label = ${check.monthLabel} FOR UPDATE`);
    if (check.fy !== currentOpenFy()) throw new Error("closed FY refresh is denied");
    if (!await isLatestFrozenMonthIn(tx, check.fy, check.monthLabel)) throw new Error("month is outside the latest three frozen-month review scope");
    if (check.status !== "drift" || check.resolution) throw new Error("only an unresolved drift check can be refreshed");
    const state = (await tx.select().from(registerMonthState).where(and(eq(registerMonthState.fy, check.fy), eq(registerMonthState.monthLabel, check.monthLabel))))[0];
    if (!state?.frozenAt) throw new Error("only frozen months may be refreshed");
    const existing = await appLinesIn(tx, check.fy, check.monthLabel);
    const archiveRows = await allMonthLinesIn(tx, check.fy, check.monthLabel);
    const source = await sourceLines(check.fy, [check.monthLabel]);
    const incoming = source.get(check.monthLabel);
    if (!incoming) throw new Error("source tab is unreadable or absent");
    if (refreshPreviewHash(check.fy, check.monthLabel, existing, incoming) !== input.previewHash) {
      throw new Error("stale or mismatched preview");
    }
    if (existing.length > 0 && incoming.length < existing.length * 0.60) {
      throw new Error("refresh refused: source is below the 0.60 wipe guard");
    }
    await tx.insert(frozenDriftArchives).values({
      driftCheckId: check.id, fy: check.fy, monthLabel: check.monthLabel,
      operator: input.operator, reason: input.reason.trim(), rows: archiveRows,
    });
    await tx.delete(saleLines).where(and(eq(saleLines.fy, check.fy), eq(saleLines.monthLabel, check.monthLabel)));
    for (let i = 0; i < incoming.length; i += BATCH_SIZE) {
      await tx.insert(saleLines).values(incoming.slice(i, i + BATCH_SIZE).map((line) => ({
        ...line, versionStatus: "current", supersededAt: null, supersededBy: null, sheetConfirmedAt: new Date(),
      })));
    }
    const total = totals(incoming);
    await tx.update(registerMonthState).set({
      frozenRows: total.rows, frozenAmount: String(total.amount), lastGoodRows: total.rows,
      lastGoodAmount: String(total.amount), lastReplacedAt: new Date(),
    }).where(and(eq(registerMonthState.fy, check.fy), eq(registerMonthState.monthLabel, check.monthLabel)));
    const resolution = await tx.update(frozenDriftChecks).set({
      resolution: "refreshed", resolvedAt: new Date(), resolvedBy: input.operator,
      resolutionReason: input.reason.trim(),
    }).where(and(eq(frozenDriftChecks.id, check.id), sql`${frozenDriftChecks.resolution} is null`))
      .returning({ id: frozenDriftChecks.id });
    if (resolution.length !== 1) throw new Error("drift check resolution changed concurrently");
    logger.warn({ id: check.id, fy: check.fy, month: check.monthLabel, operator: input.operator }, "frozen drift refresh applied and re-anchored");
    return { id: check.id, month: check.monthLabel, rows: incoming.length };
  });
}

export async function resolveFrozenDrift(id: number, resolution: "accepted" | "ignored", operator: string, reason: string): Promise<void> {
  if (!operator.trim()) throw new Error("operator is required");
  if (reason.trim().length < 10) throw new Error("reason must contain at least 10 characters");
  const check = (await db.select({ fy: frozenDriftChecks.fy, month: frozenDriftChecks.monthLabel }).from(frozenDriftChecks)
    .where(eq(frozenDriftChecks.id, id)))[0];
  if (!check || check.fy !== currentOpenFy() || !await isLatestFrozenMonth(check.fy, check.month)) {
    throw new Error("drift check not found for the current FY review scope");
  }
  const updated = await db.update(frozenDriftChecks).set({
    resolution, resolvedAt: new Date(), resolvedBy: operator.trim(), resolutionReason: reason.trim(),
  }).where(and(eq(frozenDriftChecks.id, id), sql`${frozenDriftChecks.resolution} is null`)).returning({ id: frozenDriftChecks.id });
  if (!updated.length) throw new Error("drift check not found or already resolved");
}