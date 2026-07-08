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
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Invoice-line sales register. One row per invoice line, deduplicated across
// overlapping source files via line_uid (sha1 of the identifying tuple plus an
// occurrence counter that preserves legitimate duplicate lines).
export const saleLines = pgTable(
  "sale_line",
  {
    lineUid: text("line_uid").primaryKey(),
    fy: text("fy").notNull(), // '2026-27'
    invoiceNo: text("invoice_no"),
    invoiceDate: date("invoice_date"),
    monthLabel: text("month_label"), // 'Apr-26'
    customer: text("customer"),
    code: text("code").notNull(),
    qty: numeric("qty"),
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
  },
  (t) => [
    index("sale_line_fy_month_idx").on(t.fy, t.monthLabel),
    index("sale_line_fy_head_idx").on(t.fy, t.headCanon),
    index("sale_line_fy_group_idx").on(t.fy, t.groupCanon),
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
