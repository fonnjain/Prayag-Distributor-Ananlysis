import {
  pgTable,
  text,
  timestamp,
  serial,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

// ── Organisation — State Head model ──────────────────────────────────────────
//
// Rules:
// - id is an immutable slug (e.g. "sandeep-dadheech"). Never recycled.
// - status: "active" | "left" | "inactive". Marking someone "left" sets
//   effective_to; it NEVER hard-deletes the record.
// - Hard deletes are only permitted for records that never had transactional
//   data attached, and every hard delete is still logged.
// - This table is the APP ROSTER — an overlay on top of the Google Sheet.
//   The sheet remains READ-ONLY. Divergence between app and sheet is surfaced
//   as a data-quality flag.

export const orgStateHeads = pgTable(
  "org_state_heads",
  {
    id: text("id").primaryKey(), // immutable slug
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("active"), // active | left | inactive
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    hq: text("hq"),
    notes: text("notes"),
    isDualRole: boolean("is_dual_role").notNull().default(false),
    dualRoleDetail: text("dual_role_detail"),
    sheetRowRef: text("sheet_row_ref"), // e.g. "row_153"
    seededAt: timestamp("seeded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("osh_status_idx").on(t.status),
    index("osh_name_idx").on(t.displayName),
  ],
);

// Known name aliases — confirmed by the business as the same person.
// Each alias records which FY it was first seen in (for traceability).
export const orgHeadAliases = pgTable(
  "org_head_aliases",
  {
    id: serial("id").primaryKey(),
    headId: text("head_id").notNull(),
    alias: text("alias").notNull(),
    fySeen: text("fy_seen"), // null = applies across all FYs
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("oha_head_idx").on(t.headId),
    index("oha_alias_idx").on(t.alias),
  ],
);

// Full audit trail — every create/update/delete is logged here.
export const orgHeadAudit = pgTable(
  "org_head_audit",
  {
    id: serial("id").primaryKey(),
    headId: text("head_id").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
    changedBy: text("changed_by"),
    action: text("action").notNull(), // created | status_changed | alias_added | alias_removed | seeded | notes_updated
    detail: jsonb("detail"),
  },
  (t) => [index("ohaud_head_idx").on(t.headId)],
);

// Data-quality flags — dual-role members, leavers with orphan customers,
// unresolved head_canon values, etc. Status tracks the review lifecycle.
export const orgHeadFlags = pgTable(
  "org_head_flags",
  {
    id: serial("id").primaryKey(),
    headId: text("head_id"), // null = global flag (e.g. non-territory)
    flagType: text("flag_type").notNull(), // dual_role | leaver_with_orphans | canon_resolved | non_territory
    severity: text("severity").notNull().default("warning"), // info | warning | error
    title: text("title").notNull(),
    detail: jsonb("detail").notNull(),
    status: text("status").notNull().default("open"), // open | acknowledged | resolved
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
  },
  (t) => [
    index("ohf_head_idx").on(t.headId),
    index("ohf_status_idx").on(t.status),
  ],
);

export type OrgStateHead = typeof orgStateHeads.$inferSelect;
export type OrgHeadAlias = typeof orgHeadAliases.$inferSelect;
export type OrgHeadAudit = typeof orgHeadAudit.$inferSelect;
export type OrgHeadFlag = typeof orgHeadFlags.$inferSelect;
