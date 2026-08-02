import {
  pgTable,
  text,
  serial,
  jsonb,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Member-level targets — the writable replacement for the (now read-only,
// effectively abandoned) Prayag Target Master Google Sheet.
//
// One row per (fy, team_member): four annual measures plus four 12-slot
// monthly-override arrays, mirroring the TargetRow shape the app already
// uses. `source` marks who wrote the row: 'user' rows are only ever
// written by an explicit save from the Targets page and are never
// overwritten by any seed or background job.
//
// annual:  { primary, secondary, directDealer, businessPlan } — rupees or null
// monthly: same keys, each an array of 12 (Apr..Mar) rupees-or-null
export const memberTargets = pgTable(
  "member_targets",
  {
    id: serial("id").primaryKey(),
    fy: text("fy").notNull(),
    teamMember: text("team_member").notNull(),
    stateHead: text("state_head").notNull().default(""),
    level: text("level").notNull().default("TM"),
    annual: jsonb("annual").notNull(),
    monthly: jsonb("monthly").notNull(),
    source: text("source").notNull().default("user"),
    updatedBy: text("updated_by").notNull().default(""),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("member_targets_uq").on(t.fy, t.teamMember)],
);

export const insertMemberTargetSchema = createInsertSchema(memberTargets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertMemberTarget = z.infer<typeof insertMemberTargetSchema>;
export type MemberTarget = typeof memberTargets.$inferSelect;
