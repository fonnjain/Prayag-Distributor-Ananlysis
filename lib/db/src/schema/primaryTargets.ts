import {
  pgTable,
  text,
  timestamp,
  serial,
  jsonb,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// DB-persisted cadence-based primary targets for state heads and primary team
// members.  Completely separate from the Prayag Target Master Google Sheet,
// which covers secondary targets.
//
// Cadences and the number of values[] elements:
//   "annual"      — 1   (full-year total)
//   "half_yearly" — 2   (H1: Apr-Sep, H2: Oct-Mar)
//   "quarterly"   — 4   (Q1: Apr-Jun, Q2: Jul-Sep, Q3: Oct-Dec, Q4: Jan-Mar)
//   "monthly"     — 12  (Apr … Mar, fiscal order)
//
// Seasonal weights are applied server-side to split coarser cadences into
// monthly breakdowns for period-target and achievement calculations.
export const primaryTargetEntries = pgTable(
  "primary_target_entries",
  {
    id: serial("id").primaryKey(),
    fy: text("fy").notNull(),
    name: text("name").notNull(),        // display name as entered
    role: text("role").notNull(),        // "state_head" | "team_member"
    cadence: text("cadence").notNull(),  // "annual" | "half_yearly" | "quarterly" | "monthly"
    values: jsonb("values").notNull(),   // number[] — rupees, fiscal order
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("primary_target_entries_fy_name_uq").on(t.fy, t.name)],
);

export const insertPrimaryTargetEntrySchema = createInsertSchema(primaryTargetEntries).omit({
  id: true,
  updatedAt: true,
});
export type InsertPrimaryTargetEntry = z.infer<typeof insertPrimaryTargetEntrySchema>;
export type PrimaryTargetEntry = typeof primaryTargetEntries.$inferSelect;
