import { pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const distributorTierOverrideTable = pgTable(
  "distributor_tier_override",
  {
    id:           serial("id").primaryKey(),
    stateHead:    text("state_head").notNull(),
    fy:           text("fy").notNull(),
    normKey:      text("norm_key").notNull(),
    tier:         text("tier").notNull(),
    reason:       text("reason").notNull(),
    overriddenAt: timestamp("overridden_at").defaultNow().notNull(),
  },
  (t) => [unique("distributor_tier_override_uk").on(t.stateHead, t.fy, t.normKey)],
);

export const insertDistributorTierOverrideSchema = createInsertSchema(distributorTierOverrideTable)
  .omit({ id: true, overriddenAt: true })
  .extend({ tier: z.enum(["A", "B", "C"]) });

export type InsertDistributorTierOverride = z.infer<typeof insertDistributorTierOverrideSchema>;
export type DistributorTierOverride = typeof distributorTierOverrideTable.$inferSelect;
