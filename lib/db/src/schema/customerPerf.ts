// Customer Performance schema:
//   price_multiplier — frozen Laspeyres multipliers per (fy_ly, fy_cy, scope)
//   scheme_def       — configurable scheme definitions
//   scheme_slab      — ordered slab tiers for each scheme
import {
  pgTable,
  text,
  numeric,
  boolean,
  date,
  timestamp,
  serial,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Frozen Laspeyres price multipliers.
// multiplier = Σ(qty_LY × price_CY) / Σ(qty_LY × price_LY)
// Never retro-edit a row where frozen = true (closed year audit trail).
export const priceMultipliers = pgTable(
  "price_multiplier",
  {
    id: serial("id").primaryKey(),
    fyLy: text("fy_ly").notNull(),
    fyCy: text("fy_cy").notNull(),
    // 'company' | 'category' | 'customer'
    scope: text("scope").notNull(),
    // null for company; category name or customer name otherwise
    scopeValue: text("scope_value"),
    multiplier: numeric("multiplier").notNull(),
    sharedItemCount: integer("shared_item_count"),
    lyValueCovered: numeric("ly_value_covered"),
    // Once a FY closes, freeze the row so it can never be retro-edited.
    frozen: boolean("frozen").default(false).notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("price_multiplier_fy_scope_idx").on(
      t.fyLy,
      t.fyCy,
      t.scope,
      t.scopeValue,
    ),
  ],
);

// Scheme definitions. Not hardcoded — the client supplies actual slabs.
// appliesTo: subset of ['distributor','direct_dealer','retailer']
// basis: 'value' (₹) | 'qty' (pcs)
// scopeType: 'all' | 'category' | 'product_list'
export const schemeDefs = pgTable("scheme_def", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  appliesTo: text("applies_to").array().notNull(),
  periodType: text("period_type").notNull(), // 'month'|'quarter'|'fy'|'custom'
  fy: text("fy"),
  periodStart: date("period_start"),
  periodEnd: date("period_end"),
  basis: text("basis").notNull(),
  scopeType: text("scope_type").notNull(),
  scopeValues: text("scope_values").array(),
  namedEntityList: text("named_entity_list").array(),
  usePriceMultiplier: boolean("use_price_multiplier").default(false).notNull(),
  desiredRealGrowthPct: numeric("desired_real_growth_pct"),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Ordered slab tiers for a scheme. slabOrder 1 = lowest threshold.
// benefitType: 'pct' (percentage of value) | 'flat' (fixed ₹ amount)
export const schemeSlabs = pgTable(
  "scheme_slab",
  {
    id: serial("id").primaryKey(),
    schemeId: integer("scheme_id")
      .notNull()
      .references(() => schemeDefs.id, { onDelete: "cascade" }),
    slabOrder: integer("slab_order").notNull(),
    threshold: numeric("threshold").notNull(),
    benefitType: text("benefit_type").notNull(),
    benefitValue: numeric("benefit_value").notNull(),
  },
  (t) => [index("scheme_slab_scheme_idx").on(t.schemeId, t.slabOrder)],
);

export const insertSchemeDefSchema = createInsertSchema(schemeDefs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertSchemeSlabSchema = createInsertSchema(schemeSlabs).omit({
  id: true,
});

export type PriceMultiplierRow = typeof priceMultipliers.$inferSelect;
export type SchemeDef = typeof schemeDefs.$inferSelect;
export type InsertSchemeDef = z.infer<typeof insertSchemeDefSchema>;
export type SchemeSlab = typeof schemeSlabs.$inferSelect;
export type InsertSchemeSlab = z.infer<typeof insertSchemeSlabSchema>;
