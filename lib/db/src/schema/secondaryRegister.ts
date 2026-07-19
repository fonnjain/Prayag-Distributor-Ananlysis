import {
  pgTable,
  text,
  numeric,
  boolean,
  timestamp,
  serial,
  integer,
  jsonb,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── Table 1: secondary_register_line ─────────────────────────────────────────
//
// One row per line from a secondary sales register (distributor → retailer).
// Source: per-FY secondary register spreadsheets (FY2021-22 → FY2025-26).
// Distinct from primary sale_line — the two must NEVER be summed together.
//
// line_uid: sha1 of (fy|month_label|head_raw|state_raw|customer|brand_raw|amount|occurrence).
// Occurrence counter counts across all rows for the same natural key in
// source order, preserving legitimate duplicate order lines.
export const secondaryRegisterLines = pgTable(
  "secondary_register_line",
  {
    lineUid: text("line_uid").primaryKey(),
    fy: text("fy").notNull(),                     // '2021-22'
    monthLabel: text("month_label").notNull(),     // 'Apr-21'
    headRaw: text("head_raw"),
    headCanon: text("head_canon"),
    stateRaw: text("state_raw"),
    stateCanon: text("state_canon"),
    customer: text("customer"),
    brandRaw: text("brand_raw"),                  // product brand/group as written in source
    brandCanon: text("brand_canon"),              // canonical brand after alias mapping
    amount: numeric("amount").notNull(),
    qty: numeric("qty"),
    isTerritory: boolean("is_territory"),
    source: text("source").notNull(),             // 'sheets' | 'xlsx_backfill'
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("sec_reg_line_fy_month_idx").on(t.fy, t.monthLabel),
    index("sec_reg_line_fy_head_idx").on(t.fy, t.headCanon),
    index("sec_reg_line_fy_state_idx").on(t.fy, t.stateCanon),
  ],
);

// ── Table 2: secondary_head_month ─────────────────────────────────────────────
//
// Aggregated monthly secondary metrics per State Head, sourced from the
// "STATE HEAD DASHBOARD" / "ORDER BOOKING REPORT" spreadsheets.
// One row per (fy, head_canon, month_label). Upserted on reload.
//
// Achievement is RECOMPUTED here as received / plan (never ordered / plan).
// The sheet's own achievement column uses ordered / plan and is WRONG.
//
// is_anomaly: true when salesAmount > orderedAmount × 1.5 AND orderedAmount > 0.
//   Anomalous months must be excluded from rankings and YTD achievement.
//   The raw values are still stored exactly as read from the sheet.
// not_yet_recorded: true when the calendar month has not yet closed and the
//   sheet shows no data. These are never treated as 0% achievement.
export const secondaryHeadMonths = pgTable(
  "secondary_head_month",
  {
    id: serial("id").primaryKey(),
    fy: text("fy").notNull(),
    headRaw: text("head_raw"),
    headCanon: text("head_canon").notNull(),
    stateHead: text("state_head"),
    monthLabel: text("month_label").notNull(),   // 'Apr-25'
    monthIdx: integer("month_idx").notNull(),    // 0=Apr .. 11=Mar
    planAmount: numeric("plan_amount"),
    orderedAmount: numeric("ordered_amount"),
    receivedAmount: numeric("received_amount"),
    // Recomputed: received / plan. Null when plan = 0 or month not yet closed.
    achievementPct: numeric("achievement_pct"),
    isAnomaly: boolean("is_anomaly").notNull().default(false),
    notYetRecorded: boolean("not_yet_recorded").notNull().default(false),
    sourceSheetId: text("source_sheet_id"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique("sec_head_month_fy_head_month_uniq").on(t.fy, t.headCanon, t.monthLabel),
    index("sec_head_month_fy_idx").on(t.fy),
    index("sec_head_month_fy_head_idx").on(t.fy, t.headCanon),
  ],
);

// ── Table 3: secondary_ingest_run ─────────────────────────────────────────────
//
// Audit log for every secondary ingestion attempt (register backfill,
// Sheets register sync, or State Head Dashboard sync).
// status: 'ok' | 'fail' | 'dry_run'
export const secondaryIngestRuns = pgTable("secondary_ingest_run", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  source: text("source"),   // 'register_xlsx' | 'register_sheets' | 'state_head_dashboard'
  fy: text("fy"),
  rowsRead: integer("rows_read"),
  rowsInserted: integer("rows_inserted"),
  rowsSkipped: integer("rows_skipped"),
  unmapped: jsonb("unmapped"),
  assertions: jsonb("assertions"),
  status: text("status"),   // 'ok' | 'fail' | 'dry_run'
});

// ── Insert schemas and types ─────────────────────────────────────────────────

export const insertSecRegLineSchema = createInsertSchema(secondaryRegisterLines).omit({
  ingestedAt: true,
});
export const insertSecHeadMonthSchema = createInsertSchema(secondaryHeadMonths).omit({
  id: true,
  ingestedAt: true,
});
export const insertSecIngestRunSchema = createInsertSchema(secondaryIngestRuns).omit({
  id: true,
});

export type InsertSecRegLine = z.infer<typeof insertSecRegLineSchema>;
export type SecRegLine = typeof secondaryRegisterLines.$inferSelect;
export type InsertSecHeadMonth = z.infer<typeof insertSecHeadMonthSchema>;
export type SecHeadMonth = typeof secondaryHeadMonths.$inferSelect;
export type InsertSecIngestRun = z.infer<typeof insertSecIngestRunSchema>;
export type SecIngestRun = typeof secondaryIngestRuns.$inferSelect;
