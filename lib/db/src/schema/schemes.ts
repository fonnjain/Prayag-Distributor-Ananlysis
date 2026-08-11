// Q2 Scheme schema — DB-backed scheme model.
//
// Five tables:
//   scheme           — one row per distinct scheme block from the workbook
//   scheme_slab      — ordered slab tiers for each scheme
//   territory_group  — territory-group label → constituent states
//   scheme_item_group— basket map: item_group → scheme_id (can be M:M)
//   special_pricing  — customer-specific net billing rates (not scheme tables)
//
// Migration 017 drops the old scheme_def / scheme_slab tables (old generic
// schema) and creates these five tables.

import {
  pgTable,
  text,
  numeric,
  integer,
  serial,
  jsonb,
  date,
  index,
} from "drizzle-orm/pg-core";

// ── scheme ────────────────────────────────────────────────────────────────────

export const scheme = pgTable("scheme", {
  /** Stable short identifier, e.g. "CP_LALAN", "ANNUAL_WB". */
  schemeId: text("scheme_id").primaryKey(),
  /** Human-readable name for display. */
  name: text("name").notNull(),
  /**
   * Who this scheme applies to.
   * Values: 'sub_dealer' | 'distributor' | 'direct_dealer' |
   *         'super_distributor' | 'distributor_by_super_distributor'
   */
  audience: text("audience").array().notNull(),
  /**
   * Who settles the scheme with the customer.
   * 'company' = company pays directly; 'pass_through' = distributor
   * advances then claims back; 'primary' = settled on primary invoice.
   */
  settlement: text("settlement").notNull(),
  /**
   * Basis on which the slab thresholds are measured.
   * 'cumulative_value' | 'single_bill_value' | 'single_bill_quantity'
   */
  qualificationBasis: text("qualification_basis").notNull(),
  /**
   * FK to territory_group.group_raw — null means the scheme is national
   * (All States) or has no territory restriction encoded.
   */
  territoryGroup: text("territory_group"),
  /** Product scope note, e.g. 'CP (All Series) / SINK & SANITARYWARE'. */
  productScope: text("product_scope"),
  /** Start date of the scheme period. */
  periodFrom: date("period_from").notNull(),
  /** End date, null if open-ended ('till further change'). */
  periodTo: date("period_to"),
  /** Human-readable period note, e.g. '01-07-2026 to 30-09-2026'. */
  periodNote: text("period_note"),
  /** Verbatim audience label from the workbook header. */
  audienceSourceTerm: text("audience_source_term"),
  /** Funding / settlement note from the workbook, if any. */
  fundingNote: text("funding_note"),
});

// ── scheme_slab ───────────────────────────────────────────────────────────────

export const schemeSlab = pgTable(
  "scheme_slab",
  {
    id: serial("id").primaryKey(),
    schemeId: text("scheme_id")
      .notNull()
      .references(() => scheme.schemeId, { onDelete: "cascade" }),
    slabOrder: integer("slab_order").notNull(),
    /** Lower bound of this slab (inclusive). */
    thresholdFrom: numeric("threshold_from").notNull(),
    /**
     * Upper bound (inclusive). NULL = this is the top open-ended slab
     * ("& Above").
     */
    thresholdTo: numeric("threshold_to"),
    /**
     * Unit for threshold_from/to.
     * 'rupees' | 'master_cartons' | 'pieces'
     */
    unit: text("unit").notNull(),
    /**
     * % rate expressed as a decimal (0.025 = 2.5%).
     * NULL when the reward is a trip only or is ambiguous (needs_clarification).
     */
    rate: numeric("rate"),
    /**
     * Alternative reward description (trip text) when the slab offers
     * "X% OR <trip>". NULL for pure-% slabs.
     */
    altReward: text("alt_reward"),
    /**
     * Free goods description for quantity-based free-good slabs.
     * NULL for value-based slabs.
     */
    freeGoods: text("free_goods"),
    /**
     * 'ok' = slab is fully defined and usable by the nudge engine.
     * 'needs_clarification' = rate or reward is ambiguous; excluded from
     * nudge / Extra Earn / achievement calculations.
     */
    rewardStatus: text("reward_status").notNull().default("ok"),
    /** Verbatim text from the workbook cell (for audit). */
    rawText: text("raw_text"),
  },
  (t) => [index("scheme_slab_scheme_order_idx").on(t.schemeId, t.slabOrder)],
);

// ── territory_group ───────────────────────────────────────────────────────────

export const territoryGroup = pgTable("territory_group", {
  /** Verbatim group label from the workbook (used as FK target). */
  groupRaw: text("group_raw").primaryKey(),
  /** Short human label for display. */
  label: text("label").notNull(),
  /**
   * Constituent state abbreviations.
   * e.g. ['Delhi', 'NCR', 'WUP', 'UK', 'RAJ', 'HR', 'PB', 'HP', 'GUJ']
   */
  states: text("states").array().notNull(),
});

// ── scheme_item_group ─────────────────────────────────────────────────────────

export const schemeItemGroup = pgTable(
  "scheme_item_group",
  {
    id: serial("id").primaryKey(),
    /** sale_line.group_raw value (or group_canon) from the register. */
    itemGroup: text("item_group").notNull(),
    schemeId: text("scheme_id")
      .notNull()
      .references(() => scheme.schemeId, { onDelete: "cascade" }),
  },
  (t) => [index("scheme_item_group_item_idx").on(t.itemGroup)],
);

// ── special_pricing ───────────────────────────────────────────────────────────

export const specialPricing = pgTable("special_pricing", {
  id: serial("id").primaryKey(),
  customerName: text("customer_name").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  note: text("note"),
  /** JSON array of { serialNo, model, netRatePlusGst } rows. */
  rateRows: jsonb("rate_rows").notNull(),
});

// ── types ─────────────────────────────────────────────────────────────────────

export type Scheme = typeof scheme.$inferSelect;
export type SchemeSlab = typeof schemeSlab.$inferSelect;
export type TerritoryGroup = typeof territoryGroup.$inferSelect;
export type SchemeItemGroup = typeof schemeItemGroup.$inferSelect;
export type SpecialPricing = typeof specialPricing.$inferSelect;
