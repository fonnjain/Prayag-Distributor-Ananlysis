import {
  check,
  pgTable,
  text,
  timestamp,
  serial,
  boolean,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// API keys — hashed credentials issued to external apps.
// The raw key is shown to the user exactly once at creation time.
// We only ever store the SHA-256 hex hash.
export const apiKeys = pgTable(
  "api_keys",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    // First 8 chars of the raw key, for display ("pk_live_abcd1234…")
    prefix: text("prefix").notNull(),
    // SHA-256 hex of the full raw key
    keyHash: text("key_hash").notNull().unique(),
    scope: text("scope").notNull().default("full_api"),
    isRevoked: boolean("is_revoked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastUsedMethod: text("last_used_method"),
    lastUsedPath: text("last_used_path"),
    lastUsedStatus: integer("last_used_status"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check("api_keys_scope_check", sql`${t.scope} IN ('full_api', 'verification', 'external_read')`),
    index("api_keys_hash_idx").on(t.keyHash),
    index("api_keys_scope_idx").on(t.scope),
    uniqueIndex("api_keys_single_verification_identity_idx")
      .on(t.scope)
      .where(sql`${t.scope} = 'verification'`),
  ],
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type InsertApiKey = typeof apiKeys.$inferInsert;

/**
 * The fixed-window counter used by the external read API.  There is one row
 * per key and the counter is atomically advanced by the API middleware.
 * Keeping this separate from api_keys means revocation and key metadata remain
 * independently auditable.
 */
export const apiKeyRateLimit = pgTable(
  "api_key_rate_limit",
  {
    apiKeyId: integer("api_key_id")
      .primaryKey()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    windowStarted: timestamp("window_started", { withTimezone: true }).notNull(),
    requestCount: integer("request_count").notNull().default(0),
  },
  (t) => [
    check("api_key_rate_limit_request_count_check", sql`${t.requestCount} >= 0`),
    index("api_key_rate_limit_window_idx").on(t.windowStarted),
  ],
);

export type ApiKeyRateLimit = typeof apiKeyRateLimit.$inferSelect;
export type InsertApiKeyRateLimit = typeof apiKeyRateLimit.$inferInsert;
