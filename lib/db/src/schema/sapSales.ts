import {
  pgTable,
  text,
  integer,
  numeric,
  timestamp,
  serial,
  jsonb,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// One row per uploaded SAP primary-sales file, keyed by fiscal year + month.
// Re-uploading the same (fy, month) overwrites the row (see the unique index),
// so a month never accumulates duplicate imports. The raw xlsx lives in object
// storage at object_path; the summary column caches the derived per-month
// totals so the verify panel renders without re-streaming every file.
export const sapUploads = pgTable(
  "sap_upload",
  {
    id: serial("id").primaryKey(),
    fy: text("fy").notNull(), // '2026-27'
    monthLabel: text("month_label").notNull(), // 'Apr-26'
    objectPath: text("object_path").notNull(), // '/objects/uploads/<uuid>'
    originalName: text("original_name"),
    rowsRead: integer("rows_read"),
    amount: numeric("amount"),
    summary: jsonb("summary"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [unique("sap_upload_fy_month_uq").on(t.fy, t.monthLabel)],
);

export const insertSapUploadSchema = createInsertSchema(sapUploads).omit({
  id: true,
  uploadedAt: true,
});

export type InsertSapUpload = z.infer<typeof insertSapUploadSchema>;
export type SapUpload = typeof sapUploads.$inferSelect;
