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
export const insertCostMasterSchema = createInsertSchema(costMaster);
export const insertIngestRunSchema = createInsertSchema(ingestRuns).omit({
  id: true,
});

export type InsertSaleLine = z.infer<typeof insertSaleLineSchema>;
export type SaleLine = typeof saleLines.$inferSelect;
export type InsertItemMaster = z.infer<typeof insertItemMasterSchema>;
export type ItemMaster = typeof itemMaster.$inferSelect;
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
