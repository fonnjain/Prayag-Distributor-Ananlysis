import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

// ── route_payload_snapshot ────────────────────────────────────────────────────
//
// Generic cold-start fast path for heavy read-only API routes: the last
// successful JSON payload, one row per snapshot key (route + params, e.g.
// "company-reports|2026-27" or "warnings|2026-27|anant singh").
//
// Purpose: production runs on autoscale, so instances cold-start often and the
// first request to a Sheets/DB-heavy route used to block many seconds. On a
// cold in-process cache the route serves the latest snapshot immediately
// (marked with meta.snapshotSavedAt + meta.refreshing) and rebuilds in the
// background — the same pattern as mgmt_data_snapshot, generalised.
//
// payload shape: whatever the route returns (stored as plain JSON so the DB
// stays schema-agnostic).

export const routePayloadSnapshots = pgTable("route_payload_snapshot", {
  key: text("key").primaryKey(),
  payload: jsonb("payload").notNull(),
  savedAt: timestamp("saved_at", { withTimezone: true }).defaultNow().notNull(),
});
