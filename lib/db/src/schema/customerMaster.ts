import {
  pgTable,
  text,
  timestamp,
  serial,
  index,
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
