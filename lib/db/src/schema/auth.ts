import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Application login accounts deliberately live apart from HR/person tables.
 * Password material is always a one-way hash and is never selected for API output.
 */
export const authUsers = pgTable(
  "auth_users",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull().unique(),
    emailNormalized: text("email_normalized").notNull().unique(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("normal"),
    isActive: boolean("is_active").notNull().default(true),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  },
  (t) => [
    check("auth_users_role_check", sql`${t.role} IN ('admin', 'normal')`),
    index("auth_users_email_normalized_idx").on(t.emailNormalized),
    index("auth_users_active_role_idx").on(t.isActive, t.role),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => authUsers.id),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
  },
  (t) => [
    index("auth_sessions_user_idx").on(t.userId),
    index("auth_sessions_active_idx").on(t.expiresAt, t.revokedAt),
  ],
);

export const authAudit = pgTable(
  "auth_audit",
  {
    id: serial("id").primaryKey(),
    actorUserId: integer("actor_user_id").references(() => authUsers.id),
    targetUserId: integer("target_user_id").references(() => authUsers.id),
    event: text("event").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("auth_audit_target_idx").on(t.targetUserId, t.createdAt),
    index("auth_audit_actor_idx").on(t.actorUserId, t.createdAt),
  ],
);
