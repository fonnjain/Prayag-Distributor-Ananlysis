import {
  pgTable,
  text,
  numeric,
  timestamp,
  integer,
  boolean,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── secondary_order_line ──────────────────────────────────────────────────────
//
// One row per product-code line from the Product-Wise Secondary Order Report.
// This is ORDER BOOKING data, NOT dispatch. Never sum or compare with
// secondary_sku_line or secondary_register_line — they are different measures.
//
// Source: Product-Wise-Secondary-Order-Report XLSX exports.
//
// The source occasionally contains more than one line for the same
// (order_id, product_code). occurrence is the one-based source-file position
// within that pair, making a re-upload idempotent without losing either line.
// content_hash makes the identity auditable and detects a changed source row.
//
// Identity joins:
//   dealer_id  (RET#) → customer_master for retailer identity
//   cp_code    (DIST#) → customer_master for distributor identity
//   sales_user_id (nullable) → person_registry for salesperson
//
// Amounts:
//   basic_order_value  excludes GST  — use for every commercial figure
//   dealer_order_value includes GST  — stored for completeness, never used
//                                       in aggregate analysis
export const secondaryOrderLines = pgTable(
  "secondary_order_line",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    orderId: text("order_id").notNull(),                // SORD-nnnn
    orderDatetime: timestamp("order_datetime", { withTimezone: true }).notNull(),
    orderStatus: text("order_status").notNull(),        // APPROVED | PENDING
    salesUserName: text("sales_user_name"),             // as given
    salesUserId: integer("sales_user_id"),              // resolved to person.person_id, nullable
    customerName: text("customer_name"),                // retailer name as given
    dealerId: text("dealer_id").notNull(),              // RET#
    dealerMobile: text("dealer_mobile"),
    cpName: text("cp_name"),                            // distributor name as given
    cpCode: text("cp_code").notNull(),                  // DIST#
    state: text("state"),
    district: text("district"),
    city: text("city"),
    pincode: text("pincode"),
    categoryName: text("category_name"),                // verbatim — never overwritten
    segmentCanon: text("segment_canon"),                // mapped via group_map.json, nullable
    productCode: text("product_code").notNull(),
    occurrence: integer("occurrence").notNull(),          // one-based within (order_id, product_code), source order
    sourceRowNumber: integer("source_row_number").notNull(),
    contentHash: text("content_hash").notNull(),          // SHA-256 of stored source values
    // True only for the later copy of an exact repeated source row. It is
    // retained so page totals reconcile to the source export.
    isExactDuplicateExport: boolean("is_exact_duplicate_export").notNull().default(false),
    gstPct: numeric("gst_pct"),
    gstAmount: numeric("gst_amount"),
    qty: numeric("qty"),
    discountPct: numeric("discount_pct"),
    discountAmount: numeric("discount_amount"),
    dealerOrderValue: numeric("dealer_order_value"),    // includes GST
    basicOrderValue: numeric("basic_order_value"),      // excludes GST — use this
    sourceFile: text("source_file").notNull(),
    loadedAt: timestamp("loaded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("secondary_order_line_uq").on(t.orderId, t.productCode, t.occurrence),
    index("sol_dealer_id_idx").on(t.dealerId),
    index("sol_cp_code_idx").on(t.cpCode),
    index("sol_order_datetime_idx").on(t.orderDatetime),
    index("sol_product_code_idx").on(t.productCode),
    index("sol_order_status_idx").on(t.orderStatus),
    index("sol_state_idx").on(t.state),
  ],
);

// ── Insert schema and types ───────────────────────────────────────────────────

export const insertSecondaryOrderLineSchema = createInsertSchema(secondaryOrderLines).omit({
  id: true,
  loadedAt: true,
});
export type InsertSecondaryOrderLine = z.infer<typeof insertSecondaryOrderLineSchema>;
export type SecondaryOrderLine = typeof secondaryOrderLines.$inferSelect;
