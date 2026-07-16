import {
  pgTable,
  text,
  real,
  serial,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// State-bifurcated primary order-booking targets for FY2026-27.
// Each row is one (state_head, state, month) target cell imported from the
// management plan workbook.  Separate from primary_target_entries which stores
// coarser cadence-based totals per person.
//
// target_lakh: value in Lakh rupees (1 Lakh = 1,00,000 rupees).
// source: "given" = from the plan document as-is; "derived" = seasonal estimate.
// month_label: fiscal-label format matching sale_line.month_label ("Apr-26"…).
export const primaryStateTargets = pgTable(
  "primary_state_targets",
  {
    id: serial("id").primaryKey(),
    fy: text("fy").notNull(),
    stateHead: text("state_head").notNull(),
    state: text("state").notNull(),
    monthLabel: text("month_label").notNull(),
    targetLakh: real("target_lakh").notNull(),
    source: text("source").notNull().default("given"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("primary_state_targets_uq").on(t.fy, t.stateHead, t.state, t.monthLabel),
  ],
);

export const insertPrimaryStateTargetSchema = createInsertSchema(primaryStateTargets).omit({
  id: true,
  createdAt: true,
});
export type InsertPrimaryStateTarget = z.infer<typeof insertPrimaryStateTargetSchema>;
export type PrimaryStateTarget = typeof primaryStateTargets.$inferSelect;
