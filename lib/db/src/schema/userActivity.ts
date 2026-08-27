import {
  bigint,
  check,
  date,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { authSessions, authUsers } from "./auth";

/** Privacy-preserving product activity; event payloads and URLs are never stored. */
export const userActivitySessions = pgTable(
  "user_activity_sessions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    authSessionId: integer("auth_session_id").notNull().references(() => authSessions.id, { onDelete: "cascade" }),
    clientTabId: text("client_tab_id").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastState: text("last_state").notNull().default("active"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    unique("user_activity_sessions_user_session_tab_unique").on(t.userId, t.authSessionId, t.clientTabId),
    index("user_activity_sessions_user_seen_idx").on(t.userId, t.lastSeenAt),
    check("user_activity_sessions_state_check", sql`${t.lastState} IN ('active', 'idle')`),
  ],
);

export const userActivityDailyRollups = pgTable(
  "user_activity_daily_rollups",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    activityDate: date("activity_date").notNull(),
    activeMs: bigint("active_ms", { mode: "number" }).notNull().default(0),
    idleMs: bigint("idle_ms", { mode: "number" }).notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    pageViews: integer("page_views").notNull().default(0),
    actionCount: integer("action_count").notNull().default(0),
  },
  (t) => [
    unique("user_activity_daily_rollups_user_date_unique").on(t.userId, t.activityDate),
    index("user_activity_daily_rollups_date_idx").on(t.activityDate, t.userId),
  ],
);

export const userActivityEvents = pgTable(
  "user_activity_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    activitySessionId: integer("activity_session_id").notNull().references(() => userActivitySessions.id, { onDelete: "cascade" }),
    clientEventId: text("client_event_id").notNull(),
    kind: text("kind").notNull(),
    path: text("path"),
    action: text("action"),
    state: text("state").notNull().default("active"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("user_activity_events_session_client_event_unique").on(t.activitySessionId, t.clientEventId),
    index("user_activity_events_user_occurred_idx").on(t.userId, t.occurredAt),
    index("user_activity_events_session_occurred_idx").on(t.activitySessionId, t.occurredAt),
    check("user_activity_events_kind_check", sql`${t.kind} IN ('page_view', 'heartbeat', 'action', 'session_end')`),
    check("user_activity_events_state_check", sql`${t.state} IN ('active', 'idle')`),
  ],
);