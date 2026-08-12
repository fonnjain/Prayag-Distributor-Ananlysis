// MRP (Maximum Retail Price) master — effective-dated, append-only.
//
// Two tables:
//   mrp_master   — one row per normalised item code (join key to sale_line.code)
//   mrp_history  — effective-dated price rows; effective_to = NULL means current
//
// NOTE: these tables are intentionally NOT exported from schema/index.ts.
// They are managed exclusively by migration 022 in runMigrations.ts (raw SQL,
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
} from "drizzle-orm/pg-core";

// One row per item code — the "catalogue card" for MRP purposes.
// item_code is already normalised (CNS-15, PS-1, HG-2316 …) — it is the
// master side of the resolver; sale_line.code is the register side.
export const mrpMaster = pgTable("mrp_master", {
  itemCode: text("item_code").primaryKey(),
  itemName: text("item_name"),
  segment: text("segment").notNull(),   // PTMT | CP | Pipe & Fitting | Sanitaryware | Hardware | QUAA & FERN
  series: text("series"),               // Allied, Quadra, CPVC PIPE, ALLIED, DRENCHE, QUAA …
  packing: text("packing"),
});

// Effective-dated price rows.
// The OLD MRP / NEW MRP pair in each workbook produces TWO rows:
//   is_current = false  — old row, effective_to = w.e.f. date
//   is_current = true   — new row, effective_from = w.e.f. date, effective_to = NULL
// Where OLD MRP is absent or equal to NEW MRP, only the current row is written.
export const mrpHistory = pgTable("mrp_history", {
  id: serial("id").primaryKey(),
  itemCode: text("item_code").notNull(),   // FK to mrp_master.item_code
  mrp: numeric("mrp").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),        // NULL = current
  sourceFile: text("source_file").notNull(),
  isCurrent: boolean("is_current").notNull().default(true),
});

export type MrpMaster = typeof mrpMaster.$inferSelect;
export type MrpHistory = typeof mrpHistory.$inferSelect;
