// Export your models here. Add one export per file
// export * from "./posts";
//
// Each model/table should ideally be split into different files.
// Each model/table should define a Drizzle table, insert schema, and types:
//
//   import { pgTable, text, serial } from "drizzle-orm/pg-core";
//   import { createInsertSchema } from "drizzle-zod";
//   import { z } from "zod/v4";
//
//   export const postsTable = pgTable("posts", {
//     id: serial("id").primaryKey(),
//     title: text("title").notNull(),
//   });
//
//   export const insertPostSchema = createInsertSchema(postsTable).omit({ id: true });
//   export type InsertPost = z.infer<typeof insertPostSchema>;
//   export type Post = typeof postsTable.$inferSelect;

export * from "./dashboardSnapshot";
export * from "./salesRegister";
export * from "./sapSales";
export * from "./customerPerf";
export * from "./primaryTargets";
export * from "./primaryStateTargets";
export * from "./customerMaster";
export * from "./apiKeys";
export * from "./secondaryRegister";
export * from "./orderLines";
export * from "./deepDiveSnapshot";
export * from "./memberTargets";
export * from "./distributorTierOverride";
export * from "./orgStateHeads";
export * from "./secondarySkuRegister";
export * from "./routePayloadSnapshot";
export * from "./distributorIdentity";
export * from "./personRegistry";
// NOTE: schemes.ts is intentionally NOT exported from this index.
// All five scheme tables (scheme, scheme_reward_slab, territory_group,
// scheme_item_group, special_pricing) are managed exclusively by
// migration 017 in runMigrations.ts using raw SQL, in the correct
// FK-dependency order.  Exporting them here would cause Replit's
// deployment provision step to diff them against production and
// generate a failing migration (it does not respect tablesFilter
// in drizzle.config.ts).  The tablesFilter entries remain as
// documentation but are not relied upon for correctness.