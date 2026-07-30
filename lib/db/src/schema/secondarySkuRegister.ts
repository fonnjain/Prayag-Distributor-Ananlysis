import {
  pgTable,
  text,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── secondary_sku_line ────────────────────────────────────────────────────────
//
// One row per Cat. No. line from a secondary sales register (distributor → retailer),
// stored at item-code granularity for the SKU Deep Dive feature.
//
// This is DISTINCT from secondary_register_line (which stores at brand/segment level).
// The two must never be summed together; each is authoritative for its own purpose.
//
// Source: closed-year secondary register Sheets for FY2024-25 and FY2025-26.
// The FY2026-27 register is not yet loaded; that year returns NOT_AVAILABLE.
//
// line_uid: sha1 of (fy|month_label|head_raw|retailer|distributor|item_code|gross_amount|occurrence).
//
// net_amount:   Sub Total column — the Net amount after discount. This is the
//               authoritative NET measure; Order Total is never used here.
// gross_amount: Order Value column — the gross amount before discount.
// segment_raw:  Segment column as read from the source sheet.
// segment_canon: Derived from segment_raw via group_map.json at ingestion time.
//               Codes whose segment_raw matches no group go into an explicit
//               'Unmapped' bucket — they are never dropped.
export const secondarySkuLines = pgTable(
  "secondary_sku_line",
  {
    lineUid: text("line_uid").primaryKey(),
    fy: text("fy").notNull(),
    monthLabel: text("month_label").notNull(),
    headRaw: text("head_raw"),             // Team Member Name as in sheet
    headCanon: text("head_canon"),          // normalised key (lowercase, no special chars)
    stateRaw: text("state_raw"),            // not in source; may be null
    stateCanon: text("state_canon"),        // not in source; may be null
    retailer: text("retailer"),             // Retailer column
    retailerId: text("retailer_id"),        // Sr.No / Retailer Id column
    distributor: text("distributor"),       // Distributor column
    itemCode: text("item_code").notNull(),  // Cat. No. column
    segmentRaw: text("segment_raw"),        // Segment column
    segmentCanon: text("segment_canon"),    // canonicalised via group_map.json
    qty: numeric("qty"),
    mrp: numeric("mrp"),
    netAmount: numeric("net_amount"),       // Sub Total — the authoritative NET
    grossAmount: numeric("gross_amount"),   // Order Value
    discountPct: numeric("discount_pct"),
    source: text("source").notNull(),       // 'sheets_sku_backfill'
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("sec_sku_line_fy_month_idx").on(t.fy, t.monthLabel),
    index("sec_sku_line_fy_retailer_idx").on(t.fy, t.retailer),
    index("sec_sku_line_fy_dist_idx").on(t.fy, t.distributor),
    index("sec_sku_line_fy_code_idx").on(t.fy, t.itemCode),
    index("sec_sku_line_fy_seg_idx").on(t.fy, t.segmentCanon),
    index("sec_sku_line_fy_head_idx").on(t.fy, t.headCanon),
  ],
);

// ── Insert schema and types ───────────────────────────────────────────────────

export const insertSecSkuLineSchema = createInsertSchema(secondarySkuLines).omit({
  ingestedAt: true,
});
export type InsertSecSkuLine = z.infer<typeof insertSecSkuLineSchema>;
export type SecSkuLine = typeof secondarySkuLines.$inferSelect;
