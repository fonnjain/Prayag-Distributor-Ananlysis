import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // ALL five scheme tables are managed exclusively by migration 017 in
  // runMigrations.ts, NOT by the deployment provision step.
  //
  // Why all five are excluded:
  //   scheme_def / scheme_slab  — old-schema tables that still exist in prod;
  //     excluding them prevents the provision step from generating a destructive
  //     DROP/ALTER before migration 017 has run.
  //   scheme / territory_group / scheme_item_group / scheme_item_group /
  //   special_pricing / scheme_slab (new shape) — new tables introduced in
  //     migration 017; excluding them prevents the provision step from trying to
  //     CREATE them in the wrong FK dependency order, which would fail.
  //
  // Migration 017 drops the old tables and creates the new ones at app startup,
  // in the correct dependency order, after provision completes.
  tablesFilter: [
    "!scheme_def",
    "!scheme_slab",
    "!scheme",
    "!territory_group",
    "!scheme_item_group",
    "!special_pricing",
  ],
});
