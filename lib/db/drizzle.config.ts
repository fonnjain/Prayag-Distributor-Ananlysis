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
  // scheme_def and scheme_slab (old schema) are managed by migration 017 in
  // runMigrations.ts — NOT by drizzle-kit push. Excluding them here prevents
  // the deployment provision step from generating a destructive DROP/ALTER when
  // comparing the new Drizzle schema against the production database, which
  // still carries the pre-017 table shapes. Migration 017 drops the old tables
  // and creates the new scheme_slab on app startup, after provision completes.
  tablesFilter: ["!scheme_def", "!scheme_slab"],
});
