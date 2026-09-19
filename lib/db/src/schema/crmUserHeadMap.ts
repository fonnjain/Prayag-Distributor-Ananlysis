import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const crmUserHeadMap = pgTable(
  "crm_user_head_map",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    employeeId: text("employee_id").notNull(),
    salesUserName: text("sales_user_name").notNull(),
    employeeIdKey: text("employee_id_key").notNull(),
    salesUserNameKey: text("sales_user_name_key").notNull(),
    stateHead: text("state_head").notNull(),
    basis: text("basis").notNull(),
    sourceFile: text("source_file").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    sourceRowNumber: integer("source_row_number").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("crm_user_head_map_key_uq").on(
      t.employeeIdKey,
      t.salesUserNameKey,
      t.effectiveFrom,
    ),
    index("crm_user_head_map_lookup_idx").on(
      t.employeeIdKey,
      t.salesUserNameKey,
      t.effectiveFrom,
    ),
    index("crm_user_head_map_head_idx").on(t.stateHead, t.effectiveFrom),
    index("crm_user_head_map_source_idx").on(t.sourceSha256),
  ],
);

export type CrmUserHeadMap = typeof crmUserHeadMap.$inferSelect;
export type InsertCrmUserHeadMap = typeof crmUserHeadMap.$inferInsert;