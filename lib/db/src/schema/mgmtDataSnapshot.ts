import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ── mgmt_data_snapshot ────────────────────────────────────────────────────────
//
// Last successful GET /api/mgmt/data payload, one row per (fy, month_from,
// month_to) — upserted after every successful live build.
//
// Purpose: production runs on autoscale, so instances cold-start often and the
// first /mgmt/data request used to block ~20s on a full STATE HEAD DASHBOARD
// Sheets read. On a cold in-process cache the route now serves the latest
// snapshot immediately (marked with savedAt + a refreshing flag) and rebuilds
// from Sheets in the background, then swaps the fresh payload into the cache.
//
// payload shape: { rows: unknown[], meta: Record<string, unknown> } — exactly
// what the route returns (stored as plain JSON so the DB stays schema-agnostic).

export const mgmtDataSnapshots = pgTable(
  "mgmt_data_snapshot",
  {
    id: serial("id").primaryKey(),
    fy: text("fy").notNull(),
    monthFrom: integer("month_from").notNull(),
    monthTo: integer("month_to").notNull(),
    payload: jsonb("payload").notNull(),
    savedAt: timestamp("saved_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("mgmt_data_snap_key_idx").on(t.fy, t.monthFrom, t.monthTo),
  ],
);
