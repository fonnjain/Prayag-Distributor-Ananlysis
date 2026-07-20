import {
  pgTable,
  text,
  numeric,
  boolean,
  date,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// Primary order booking lines — one row per data row read from an Order Book
// workbook tab.  Line uid is a deterministic sha1 of identifying fields so
// xlsx backfill and live-sheet reads are idempotent (ON CONFLICT DO NOTHING).
//
// Litre Rule: qty_unit = 'Ltr' for water-tank rows (Unit.Name = "Ltr." in
// source); 'Pcs' otherwise.  NEVER sum qty across different unit types.
//
// Tab classification is by CONTENT (two-pass fingerprint verification) so
// duplicate per-head and combined tabs are excluded automatically.  Only
// rows from monthly tabs (and per-head tabs confirmed to have unique rows)
// are inserted.  source_tab records which tab each row came from.
export const primaryOrderLines = pgTable(
  "primary_order_line",
  {
    lineUid: text("line_uid").primaryKey(),
    fy: text("fy").notNull(),                     // e.g. "2026-27"
    invoiceDate: date("invoice_date"),             // null for rows without a date column
    monthLabel: text("month_label"),               // e.g. "Apr-26" (derived from invoice date)
    customer: text("customer"),
    code: text("code"),
    qty: numeric("qty"),
    qtyUnit: text("qty_unit"),                     // "Ltr" | "Pcs"
    taxableValue: numeric("taxable_value").notNull(),
    headRaw: text("head_raw"),                     // raw STATE HEAD cell value
    headCanon: text("head_canon"),                 // canonHead() output
    isTerritory: boolean("is_territory"),
    channel: text("channel"),                      // "Retail" | "Govt" | null
    sourceTab: text("source_tab").notNull(),        // tab title this row came from
    sheetId: text("sheet_id").notNull(),           // Drive spreadsheet ID
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("pol_fy_month_idx").on(t.fy, t.monthLabel),
    index("pol_fy_head_idx").on(t.fy, t.headCanon),
    index("pol_fy_source_idx").on(t.fy, t.sheetId, t.sourceTab),
  ],
);

export type PrimaryOrderLine = typeof primaryOrderLines.$inferSelect;
export type InsertPrimaryOrderLine = typeof primaryOrderLines.$inferInsert;
