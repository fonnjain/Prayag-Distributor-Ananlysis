import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

// ── Person Registry ───────────────────────────────────────────────────────────
//
// Single source of truth for the person/head identity model.
// Replaces head_alias.json + normalize.json territory_heads as pipeline sources.
//
// Key fields:
//   norm_key        — registry record key derived from name + reporting manager.
//                     Existing numeric values are legacy source aliases only;
//                     employee_code is never a person-identity key.
//   alias_primary   — raw register / rate-list forms (e.g. "SANDEEP JI").
//                     All entries that classify this person as a territory head
//                     when seen in the STATE HEAD column.
//   alias_secondary — CRM / working-sheet form (e.g. "Sandeep Dadheech").
//   alias_sheet     — working-sheet spelling when it differs from alias_secondary.
//   is_state_head   — true iff the person is a territory head in the primary chain.
//   is_person       — false for non-person heads: OTHER, PROJECT, GOVT, JJM, GEM.

export const personRegistry = pgTable(
  "person_registry",
  {
    id: serial("id").primaryKey(),
    employeeCode: text("employee_code"),
    // Current manually-reviewed canonical People link. Employee codes remain
    // source evidence only and must never be used as the identity key.
    personId: integer("person_id"),
    codePlausible: boolean("code_plausible").notNull().default(false),
    normKey: text("norm_key").notNull().unique(),
    canonicalName: text("canonical_name").notNull(),
    // Array of raw register/rate-list spellings that identify this person
    // (stored as Postgres TEXT[] — e.g. ["SANDEEP JI", "SNADEEP JI"]).
    aliasPrimary: text("alias_primary").array(),
    aliasSecondary: text("alias_secondary"),
    aliasSheet: text("alias_sheet"),
    reportingManager: text("reporting_manager"),
    stateHead: text("state_head"),
    isStateHead: boolean("is_state_head").notNull().default(false),
    isPerson: boolean("is_person").notNull().default(true),
    hrStatus: text("hr_status"),
    flagNotes: text("flag_notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("pr_canonical_name_idx").on(t.canonicalName),
    index("pr_is_state_head_idx").on(t.isStateHead),
    index("pr_is_person_idx").on(t.isPerson),
    index("pr_employee_code_idx").on(t.employeeCode),
  ],
);

export type PersonRegistry = typeof personRegistry.$inferSelect;
export type InsertPersonRegistry = typeof personRegistry.$inferInsert;
