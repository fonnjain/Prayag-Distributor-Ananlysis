import {
  pgTable,
  text,
  timestamp,
  serial,
  integer,
  boolean,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// The editable customer master — single source of truth for customer attribution
// (which customer belongs to which State Head). Seeded once from the cleaned
// Excel file; maintained inside the app thereafter.
//
// Rules:
// - id is the primary key (e.g. DIST#91583, RET#92823); imports always match on id.
// - Sales values (rupees, quantity) never come from this table; the live sale
//   sheets own those. This table owns ATTRIBUTION only.
// - A mismatch between the sale sheet's head tag and master.state_head surfaces
//   in customer_mismatch_queue for human review; the master is never silently
//   overwritten by a sale-sheet sync.
export const customerMaster = pgTable(
  "customer_master",
  {
    id: text("id").primaryKey(),
    company: text("company").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull().default("Active"),
    contact: text("contact"),
    mobile: text("mobile"),
    state: text("state"),
    district: text("district"),
    city: text("city"),
    stateHead: text("state_head"),
    headConfidence: text("head_confidence").notNull().default("Guessed"),
    supplyingDistributor: text("supplying_distributor"),
    notes: text("notes"),
    // Upload-sourced attributes (migration 015_customer_upload_junctions).
    gst: text("gst"),
    pincode: text("pincode"),
    area: text("area"),
    email: text("email"),
    address: text("address"),
    // Retailer "Lead Status" (Pending/Approved). Kept SEPARATE from the status
    // column so the two file vocabularies are never normalised together.
    leadStatus: text("lead_status"),
    // Raw status string exactly as the source file spelled it.
    statusSource: text("status_source"),
    // Real entity classification from the distributor file "Customer Type"
    // column: "Distributors" / "Direct Dealers". Fixes the broken
    // type_raw ILIKE '%direct%' filter (type_raw holds product groups).
    entityType: text("entity_type"),
    assignedSegment: text("assigned_segment"),
    createdDate: text("created_date"),
    createdBy: text("created_by"),
    sourceFile: text("source_file"),
    // Non-null ONLY for the 59 same-state+district, different-phone duplicate
    // groups that need human review. Never used to auto-merge.
    reviewGroup: integer("review_group"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    editedBy: text("edited_by"),
  },
  (t) => [
    index("cm_type_idx").on(t.type),
    index("cm_state_head_idx").on(t.stateHead),
    index("cm_state_idx").on(t.state),
    index("cm_status_idx").on(t.status),
  ],
);

// Junction: one row per retailer per named salesperson in the comma-separated
// (quote-aware) "Assign User" cell. Never store the raw string as the
// relationship. user_norm_key uses normSecKey from the api-server names lib.
export const retailerUser = pgTable(
  "retailer_user",
  {
    id: serial("id").primaryKey(),
    retailerId: text("retailer_id").notNull(),
    userName: text("user_name").notNull(),
    userNormKey: text("user_norm_key").notNull(),
    resolved: boolean("resolved").notNull().default(false),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("ru_user_idx").on(t.userNormKey),
    unique("retailer_user_uk").on(t.retailerId, t.userNormKey),
  ],
);

// Junction: one row per retailer per named distributor in the comma-separated
// (quote-aware) "Assign Distributor Name" cell. dist_norm_key uses the
// distributor identity registry's normDistKey; resolved_dist_id is the matched
// distributor's DIST# id.
export const retailerDistributor = pgTable(
  "retailer_distributor",
  {
    id: serial("id").primaryKey(),
    retailerId: text("retailer_id").notNull(),
    distributorName: text("distributor_name").notNull(),
    distNormKey: text("dist_norm_key").notNull(),
    resolvedDistId: text("resolved_dist_id"),
    resolved: boolean("resolved").notNull().default(false),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("rd_dist_idx").on(t.distNormKey),
    unique("retailer_distributor_uk").on(t.retailerId, t.distNormKey),
  ],
);

// Full change history for every field edit. Reversible: old_value is always stored.
export const customerMasterLog = pgTable(
  "customer_master_log",
  {
    id: serial("id").primaryKey(),
    customerId: text("customer_id").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
    changedBy: text("changed_by"),
    field: text("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    reason: text("reason"),
    importBatch: text("import_batch"),
  },
  (t) => [index("cml_customer_idx").on(t.customerId)],
);

// Review queue for head-attribution mismatches detected during sale-sheet syncs.
// The master is NEVER automatically updated; a human must approve/dismiss each
// mismatch. On approval the master updates and the log records the resolution.
export const customerMismatchQueue = pgTable(
  "customer_mismatch_queue",
  {
    id: serial("id").primaryKey(),
    customerId: text("customer_id"),
    customerName: text("customer_name").notNull(),
    masterHead: text("master_head"),
    sheetHead: text("sheet_head").notNull(),
    fy: text("fy").notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    resolution: text("resolution"),
    reason: text("reason"),
  },
  (t) => [
    index("cmq_resolved_idx").on(t.resolvedAt),
    index("cmq_fy_idx").on(t.fy),
  ],
);

export const insertCustomerMasterSchema = createInsertSchema(customerMaster).omit({
  createdAt: true,
  updatedAt: true,
});
export const insertCustomerMasterLogSchema = createInsertSchema(customerMasterLog).omit({
  id: true,
  changedAt: true,
});
export const insertCustomerMismatchSchema = createInsertSchema(customerMismatchQueue).omit({
  id: true,
  detectedAt: true,
});

export type CustomerMaster = typeof customerMaster.$inferSelect;
export type InsertCustomerMaster = z.infer<typeof insertCustomerMasterSchema>;
export type CustomerMasterLog = typeof customerMasterLog.$inferSelect;
export type CustomerMismatch = typeof customerMismatchQueue.$inferSelect;
export type RetailerUser = typeof retailerUser.$inferSelect;
export type RetailerDistributor = typeof retailerDistributor.$inferSelect;
