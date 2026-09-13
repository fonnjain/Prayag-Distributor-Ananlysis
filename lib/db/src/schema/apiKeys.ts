import {
  check,
  pgTable,
  text,
  timestamp,
  serial,
  boolean,
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
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check("api_keys_scope_check", sql`${t.scope} IN ('full_api', 'verification')`),
    index("api_keys_hash_idx").on(t.keyHash),
    index("api_keys_scope_idx").on(t.scope),
    uniqueIndex("api_keys_single_verification_identity_idx")
      .on(t.scope)
      .where(sql`${t.scope} = 'verification'`),
  ],
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type InsertApiKey = typeof apiKeys.$inferInsert;
