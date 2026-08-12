// MRP (Maximum Retail Price) master — effective-dated, append-only.
//
// Two tables:
//   mrp_master   — one row per (item_code, segment) pair.
//                  is_ambiguous_code = TRUE when the same item_code exists in
//                  more than one segment (e.g. CNS-15 appears in both PTMT and CP).
//   mrp_history  — effective-dated price rows; effective_to = NULL means current.
//
// NOTE: these tables are intentionally NOT exported from schema/index.ts.
// They are managed exclusively by migrations in runMigrations.ts (raw SQL,
// correct FK-dependency order). Exporting them would let Replit's deployment
// provision step diff them against production and generate a conflicting push.
// Import directly from this file in any route that needs the Drizzle tables.
import {
  pgTable,
  text,
  numeric,
  boolean,
  date,
  serial,
  primaryKey,
} from "drizzle-orm/pg-core";

// One row per (item_code, segment) — the "catalogue card" for MRP purposes.
// item_code is already normalised (CNS-15, PS-1, HG-2316 …) — it is the
// master side of the resolver; sale_line.code is the register side.
//
// is_ambiguous_code = TRUE when this code appears in more than one segment.
// Register lookups for an ambiguous code MUST supply a segment; falling back
// to any single row would silently return the wrong product's price.
export const mrpMaster = pgTable(
  "mrp_master",
  {
    itemCode: text("item_code").notNull(),
    itemName: text("item_name"),
    segment: text("segment").notNull(),  // PTMT | CP | Pipe & Fitting | Sanitaryware | Hardware | QUAA & FERN
    series: text("series"),              // Allied, Quadra, CPVC PIPE, ALLIED, DRENCHE, QUAA …
    packing: text("packing"),
    isAmbiguousCode: boolean("is_ambiguous_code").notNull().default(false),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.itemCode, t.segment] }),
  }),
);

// Effective-dated price rows.
// The OLD MRP / NEW MRP pair in each workbook produces TWO rows:
//   is_current = false  — old row, effective_to = w.e.f. date
//   is_current = true   — new row, effective_from = w.e.f. date, effective_to = NULL
// Where OLD MRP is absent or equal to NEW MRP, only the current row is written.
//
// segment is stored here (mirrors mrp_master.segment) so callers can filter
// history by segment without a JOIN.
export const mrpHistory = pgTable("mrp_history", {
  id: serial("id").primaryKey(),
  itemCode: text("item_code").notNull(),   // Part of FK → mrp_master(item_code, segment)
  segment: text("segment").notNull(),       // Part of FK → mrp_master(item_code, segment)
  mrp: numeric("mrp").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),         // NULL = current
  sourceFile: text("source_file").notNull(),
  isCurrent: boolean("is_current").notNull().default(true),
});

export type MrpMaster = typeof mrpMaster.$inferSelect;
export type MrpHistory = typeof mrpHistory.$inferSelect;
