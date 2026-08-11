// Customer Performance schema:
//   price_multiplier — frozen Laspeyres multipliers per (fy_ly, fy_cy, scope)
//
// NOTE: scheme_def and scheme_slab were the old generic scheme tables.
// They have been replaced by the five-table scheme schema in schema/schemes.ts
// (migration 017). The old definitions are removed from here to prevent Drizzle
// from trying to manage the dropped tables.
import {
  pgTable,
  text,
  numeric,
  boolean,
  timestamp,
  serial,
  integer,
  index,
} from "drizzle-orm/pg-core";

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

export type PriceMultiplierRow = typeof priceMultipliers.$inferSelect;
