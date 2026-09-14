import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * The single register of things waiting on an answer.  HOLD rows can block
 * named measures; PENDING rows are informational and must never block an API.
 */
export const resolutionItems = pgTable(
  "resolution_item",
  {
    id: serial("id").primaryKey(),
    code: text("code").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    category: text("category").notNull(),
    fiscalYear: text("fiscal_year"),
    month: text("month"),
    scopeProduct: text("scope_product"),
    scopeMeasure: text("scope_measure"),
    reason: text("reason").notNull(),
    evidence: text("evidence").notNull(),
    valueAtStake: numeric("value_at_stake"),
    raisedOn: date("raised_on", { mode: "string" }).notNull(),
    raisedBy: text("raised_by").notNull(),
    owner: text("owner").notNull(),
    status: text("status").notNull().default("open"),
    resolvedOn: date("resolved_on", { mode: "string" }),
    resolvedBy: text("resolved_by"),
    resolutionNote: text("resolution_note"),
    blocksApi: boolean("blocks_api").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("resolution_item_code_uq").on(t.code),
    index("resolution_item_status_idx").on(t.status),
    index("resolution_item_type_idx").on(t.type),
    index("resolution_item_owner_idx").on(t.owner),
  ],
);

export const insertResolutionItemSchema = createInsertSchema(resolutionItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertResolutionItem = z.infer<typeof insertResolutionItemSchema>;
export type ResolutionItem = typeof resolutionItems.$inferSelect;