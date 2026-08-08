import { pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Persisted distributor identity registry.
//
// One row per known distributor identity. DIST# (distId) is the ONLY merge
// key: two rows with different DIST# are different distributors, always.
// Rows without a DIST# are identified by name + state + district.
// Source: the "Retailer-Distributor Data" workbook Distributor tab
// (source='roster-workbook'); DIST# rows seen only in the Party TM Map
// bridge persist with source='party-tm-bridge'.
export const distributorIdentityTable = pgTable(
  "distributor_identity",
  {
    id:        serial("id").primaryKey(),
    /** "DIST#12345" — null when the distributor has no stable ID. */
    distId:    text("dist_id"),
    /** Name exactly as the source spells it (display only). */
    name:      text("name").notNull(),
    /** normDistKey(name) — grouping key, NEVER a merge key on its own. */
    normKey:   text("norm_key").notNull(),
    state:     text("state"),
    district:  text("district"),
    source:    text("source").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("distributor_identity_uk").on(t.distId)],
);

// Alternate spellings observed in other sources, each mapped to its
// authoritative DIST#. Lets a differently-spelled transaction resolve to the
// same identity without ever merging on the name itself.
export const distributorIdentityAliasTable = pgTable(
  "distributor_identity_alias",
  {
    id:        serial("id").primaryKey(),
    distId:    text("dist_id").notNull(),
    /** Spelling exactly as the source uses it. */
    alias:     text("alias").notNull(),
    /** normDistKey(alias) — lookup key. */
    normKey:   text("norm_key").notNull(),
    source:    text("source").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [unique("distributor_identity_alias_uk").on(t.distId, t.normKey)],
);

export type DistributorIdentityAlias = typeof distributorIdentityAliasTable.$inferSelect;

export const insertDistributorIdentitySchema = createInsertSchema(distributorIdentityTable)
  .omit({ id: true, updatedAt: true })
  .extend({ distId: z.string().nullable() });

export type InsertDistributorIdentity = z.infer<typeof insertDistributorIdentitySchema>;
export type DistributorIdentity = typeof distributorIdentityTable.$inferSelect;
