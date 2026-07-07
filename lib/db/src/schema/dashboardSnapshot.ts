import { pgTable, serial, jsonb, timestamp, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// A point-in-time snapshot of the aggregated dashboard dataset, built from the
// user's Google Sheets. The dashboard always serves the most recent snapshot so
// that a failed refresh gracefully falls back to the last good data.
export const dashboardSnapshots = pgTable("dashboard_snapshots", {
  id: serial("id").primaryKey(),
  // The aggregate dashboard payload (matches the frontend `data` contract).
  data: jsonb("data").notNull(),
  // Source manifest (file listing, counts, notes) shown on the Data Sources tab.
  manifest: jsonb("manifest").notNull(),
  // "live"  -> fully rebuilt from Google Sheets
  // "seed"  -> initial baseline seeded from the bundled static dataset
  sourceStatus: text("source_status").notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertDashboardSnapshotSchema = createInsertSchema(
  dashboardSnapshots,
).omit({ id: true, syncedAt: true });

export type InsertDashboardSnapshot = z.infer<
  typeof insertDashboardSnapshotSchema
>;
export type DashboardSnapshot = typeof dashboardSnapshots.$inferSelect;
