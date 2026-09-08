import {
  pgTable,
  text,
  numeric,
  boolean,
  date,
  timestamp,
  serial,
  integer,
  jsonb,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Invoice-line sales register. One row per invoice line, deduplicated across
// overlapping source files via line_uid.
//
// VERSION MODEL (added Jul 2026):
//   version_status = 'current'    — the authoritative version of this line
//   version_status = 'superseded' — an older version (stale rate, etc.)
//   superseded_at  — when this row was superseded (= ingested_at of its replacement)
//   superseded_by  — line_uid of the row that replaced this one
//
// EVERY reported figure must filter to version_status = 'current'.
// The sale_line_current view applies this filter automatically for raw SQL.
//
// IDENTITY KEY (stable across rate edits):
//   (fy, invoice_no, code, color, qty, month_label)
//   When a sync finds an identity-matched row with changed (amount, rate, serial_no),
//   it marks the old row superseded and inserts the new values as current.
//
// serial_no is column A of the source sheet ("Serial no"); it is unique per
// physical dispatch line, including colour/variant lines that share the same
// (invoice_no, code, qty, amount). Null for historical FYs whose sheets lack
// the column.
export const saleLines = pgTable(
  "sale_line_all",
  {
    lineUid: text("line_uid").primaryKey(),
    fy: text("fy").notNull(), // '2026-27'
    serialNo: integer("serial_no"), // source sheet column A; null for older FYs
    invoiceNo: text("invoice_no"),
    invoiceDate: date("invoice_date"),
    monthLabel: text("month_label"), // 'Apr-26'
    customer: text("customer"),
    code: text("code").notNull(),
    color: text("color"), // e.g. "WHITE", "IVORY"; null for FYs whose sheets lack the column
    qty: numeric("qty"),
    // Derived litres for tank (WCT/WT) codes. Null for all non-tank rows.
    // qty = SAP pieces (billing unit); qty_ltr = qty × per-tank-litres (volume).
    // Reports needing volume (Report 4 Ltr unit) read qty_ltr; all other analytics read qty.
    qtyLtr: numeric("qty_ltr"),
    saleRate: numeric("sale_rate"),
    amount: numeric("amount").notNull(),
    groupRaw: text("group_raw"),
    groupCanon: text("group_canon"),
    station: text("station"),
    stateRaw: text("state_raw"),
    stateCanon: text("state_canon"),
    headRaw: text("head_raw"),
    headCanon: text("head_canon"),
    isTerritory: boolean("is_territory"),
    // Rate-list channel: Retail | Govt | Project | JJM | Gem | Export | Unmapped.
    // NULL = customer not found in the rate-list customer master (never defaults
    // to 'Retail'). Populated by the backfill route and by future ingest passes.
    channel: text("channel"),
    typeRaw: text("type_raw"),
    source: text("source").notNull(), // 'sheets' | 'xlsx_backfill'
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow(),
    // Stamped each time a live-sheet read confirms this row is still present in
    // the source sheet. Null means the row has never been confirmed (either
    // pre-migration, or absent from every live read since insertion).
    // After the first post-migration backfill: null → sheet removed the row
    // (disputed); non-null → sheet still carries it (confirmed).
    sheetConfirmedAt: timestamp("sheet_confirmed_at", { withTimezone: true }),
    // Version tracking — see VERSION MODEL above.
    versionStatus: text("version_status").notNull().default("current"), // 'current' | 'superseded'
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededBy: text("superseded_by"), // line_uid of the replacement row
  },
  (t) => [
    index("sale_line_fy_month_idx").on(t.fy, t.monthLabel),
    index("sale_line_fy_head_idx").on(t.fy, t.headCanon),
    index("sale_line_fy_group_idx").on(t.fy, t.groupCanon),
    index("sale_line_version_idx").on(t.versionStatus),
    index("sale_line_identity_idx").on(t.fy, t.invoiceNo, t.code, t.qty, t.monthLabel),
    index("sale_line_fy_channel_idx").on(t.fy, t.channel),
  ],
);

// Item master from the rate list (item group, unit, MRP, name lookup).
// NOTE: Purchase Price is a list price, NOT a manufacturing cost — it is
// intentionally not stored here and must never be used for margins.
export const itemMaster = pgTable("item_master", {
  code: text("code").primaryKey(),
  itemName: text("item_name"),
  itemGroup: text("item_group"),
  unit: text("unit"),
  mrp: numeric("mrp"),
  // Product_Upload_Sample_File.csv attributes (migration 014). The master
  // stays keyed on code; per-colour/length variants live in itemMasterVariant.
  segmentSource: text("segment_source"),
  segmentCanon: text("segment_canon"),
  uploadName: text("upload_name"),
  // 'product_upload' where MRP was backfilled from the upload (only where the
  // rate-list MRP was NULL — the rate-list MRP is never overwritten).
  mrpSource: text("mrp_source"),
});

// Colour/length variants of an item_master code, each with its own MRP.
// A child table of item_master (NOT a parallel catalogue): variant-level
// keys, dedup and MRP conflicts live here so item_master can stay keyed on
// code (exact-code joins in productReports/companyReports/sku depend on it).
// The natural key is (code, UPPER(TRIM(feature))); conflicts (a code listed
// under two segments with different MRP) keep BOTH rows, so the uniqueness
// constraint also includes segment_source.
export const itemMasterVariant = pgTable("item_master_variant", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  featureName: text("feature_name").notNull().default(""),
  productName: text("product_name"),
  segmentSource: text("segment_source"),
  segmentCanon: text("segment_canon"),
  mrp: numeric("mrp"),
  mrpConflict: boolean("mrp_conflict").notNull().default(false),
  imageLink: text("image_link"),
  sourceFile: text("source_file"),
  loadedAt: timestamp("loaded_at", { withTimezone: true }).defaultNow(),
});

// Real finished-good costs. Empty until a genuine Cost Master is supplied;
// margins are computed only over codes present here (no fallback allowed).
export const costMaster = pgTable("cost_master", {
  code: text("code").primaryKey(),
  fgCost: numeric("fg_cost").notNull(),
  asOf: date("as_of"),
  source: text("source"),
});

// Audit log for every ingestion run (backfill or live sheets sync).
export const ingestRuns = pgTable("ingest_run", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  source: text("source"),
  fy: text("fy"),
  rowsRead: integer("rows_read"),
  rowsInserted: integer("rows_inserted"),
  rowsSkipped: integer("rows_skipped"),
  unmapped: jsonb("unmapped"),
  assertions: jsonb("assertions"),
  status: text("status"),
  /** Per-month post-dedup row counts from the sheet read that produced this run.
   *  Shape: { "Apr-26": 5542, "May-26": 11809, ... }.
   *  Loaded on boot to populate the last-good-read baseline for Guard 2.5 and
   *  the revive guard, so tombstone/revive decisions survive process restarts. */
  rowsPerMonth: jsonb("rows_per_month"),
});

export const insertSaleLineSchema = createInsertSchema(saleLines).omit({
  ingestedAt: true,
});
export const insertItemMasterSchema = createInsertSchema(itemMaster);
export const insertItemMasterVariantSchema = createInsertSchema(itemMasterVariant).omit({
  id: true,
  loadedAt: true,
});
export const insertCostMasterSchema = createInsertSchema(costMaster);
export const insertIngestRunSchema = createInsertSchema(ingestRuns).omit({
  id: true,
});

export type InsertSaleLine = z.infer<typeof insertSaleLineSchema>;
export type SaleLine = typeof saleLines.$inferSelect;
export type InsertItemMaster = z.infer<typeof insertItemMasterSchema>;
export type ItemMaster = typeof itemMaster.$inferSelect;
export type InsertItemMasterVariant = z.infer<typeof insertItemMasterVariantSchema>;
export type ItemMasterVariant = typeof itemMasterVariant.$inferSelect;
export type InsertCostMaster = z.infer<typeof insertCostMasterSchema>;
export type CostMaster = typeof costMaster.$inferSelect;
export type InsertIngestRun = z.infer<typeof insertIngestRunSchema>;
export type IngestRun = typeof ingestRuns.$inferSelect;

// Per-month sync state for the monthly full-replace pipeline (Aug 2026).
//
// One row per (fy, month_label). Two roles:
//   1. Short-read guard baseline: last_good_rows/last_good_amount are the row
//      count and amount total of the last SUCCESSFUL full read of the month.
//      Stored in the DB — never in process memory — so the guard survives
//      restarts. A read materially below last_good_rows aborts the replace.
//   2. Freeze anchor: a month freezes permanently on the 7th of the following
//      month (derived from the clock, never a config list). frozen_at,
//      frozen_rows and frozen_amount are recorded once at freeze time and
//      asserted on every startup; a frozen month is never read or written again.
export const registerMonthState = pgTable("register_month_state", {
  fy: text("fy").notNull(),
  monthLabel: text("month_label").notNull(),
  lastGoodRows: integer("last_good_rows"),
  lastGoodAmount: numeric("last_good_amount"),
  lastReplacedAt: timestamp("last_replaced_at", { withTimezone: true }),
  frozenAt: timestamp("frozen_at", { withTimezone: true }),
  frozenRows: integer("frozen_rows"),
  frozenAmount: numeric("frozen_amount"),
}, (t) => [primaryKey({ columns: [t.fy, t.monthLabel] })]);

export type RegisterMonthState = typeof registerMonthState.$inferSelect;

// Restart-safe due state and operational instrumentation for the hourly
// primary-register scheduler. One row per scheduled FY job.
export const registerSyncSchedulerState = pgTable("register_sync_scheduler_state", {
  jobName: text("job_name").primaryKey(),
  lastSuccessfulRunKey: text("last_successful_run_key"),
  lastAttemptedRunKey: text("last_attempted_run_key"),
  status: text("status").notNull().default("idle"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  driveRequests: integer("drive_requests"),
  elapsedMs: integer("elapsed_ms"),
  rowsScanned: integer("rows_scanned"),
  monthsTouched: integer("months_touched"),
  detail: text("detail"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Append-only evidence for every attempted primary-register month ingest.  The
// payload columns intentionally retain exact multisets and comparison inputs:
// this is an audit ledger, not a mutable operational state table.
export const registerMonthlyIngestLedger = pgTable("register_monthly_ingest_ledger", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull(),
  actor: text("actor").notNull(), // scheduler | manual
  operator: text("operator"),
  source: text("source").notNull(),
  fy: text("fy").notNull(),
  monthLabel: text("month_label").notNull(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  outcome: text("outcome").notNull(),
  writeAtomicity: text("write_atomicity").notNull(), // same-replacement-transaction | ledger-only-transaction | post-rollback
  rowsWritten: integer("rows_written"),
  projectedRowsWritten: integer("projected_rows_written"),
  beforeRows: integer("before_rows"), beforeAmount: numeric("before_amount"), beforeFingerprint: text("before_fingerprint"),
  sourceRows: integer("source_rows").notNull(), sourceAmount: numeric("source_amount").notNull(), sourceFingerprint: text("source_fingerprint").notNull(),
  afterRows: integer("after_rows"), afterAmount: numeric("after_amount"), afterFingerprint: text("after_fingerprint"),
  sourceRowDelta: integer("source_row_delta"), sourceAmountDelta: numeric("source_amount_delta"), sourceShrink: boolean("source_shrink"),
  actualRowDelta: integer("actual_row_delta"), actualAmountDelta: numeric("actual_amount_delta"), actualShrink: boolean("actual_shrink"),
  addedRows: integer("added_rows"), removedRows: integer("removed_rows"), changedRows: integer("changed_rows"),
  confidence: text("confidence"), unpairedResidualRows: integer("unpaired_residual_rows"),
  spreadsheetId: text("spreadsheet_id"), sourceEvidence: jsonb("source_evidence").notNull(),
  detail: text("detail"),
}, (t) => [
  index("register_monthly_ingest_ledger_fy_month_attempt_idx").on(t.fy, t.monthLabel, t.attemptedAt),
  index("register_monthly_ingest_ledger_run_idx").on(t.runId),
]);

// Evidence captured when a source workbook disagrees with an already-frozen
// month.  The evidence payload is deliberately immutable; only resolution
// fields may change after an operator reviews it.
export const frozenDriftChecks = pgTable("frozen_drift_check", {
  id: serial("id").primaryKey(),
  fy: text("fy").notNull(),
  monthLabel: text("month_label").notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  appRows: integer("app_rows").notNull(),
  appAmount: numeric("app_amount").notNull(),
  sheetRows: integer("sheet_rows"),
  sheetAmount: numeric("sheet_amount"),
  rowDelta: integer("row_delta"),
  netDelta: numeric("net_delta"),
  status: text("status").notNull(), // match | drift | sheet_unreadable
  evidence: jsonb("evidence").notNull(),
  sourceFingerprint: text("source_fingerprint"),
  previewHash: text("preview_hash"),
  resolution: text("resolution"), // accepted | ignored | refreshed
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: text("resolved_by"),
  resolutionReason: text("resolution_reason"),
}, (t) => [
  index("frozen_drift_check_fy_month_checked_idx").on(t.fy, t.monthLabel, t.checkedAt),
]);

// Durable before-image for the exceptional accepted frozen-month refresh.
// This is append-only and stores the exact rows removed by the refresh.
export const frozenDriftArchives = pgTable("frozen_drift_archive", {
  id: serial("id").primaryKey(),
  driftCheckId: integer("drift_check_id").notNull(),
  fy: text("fy").notNull(),
  monthLabel: text("month_label").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
  operator: text("operator").notNull(),
  reason: text("reason").notNull(),
  rows: jsonb("rows").notNull(),
});
