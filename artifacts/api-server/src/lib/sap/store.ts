// Persistence for uploaded SAP months. Each (fy, monthLabel) is a single row in
// sap_upload; re-uploading the same month overwrites it (see the unique index),
// so a month never accumulates duplicate imports. The derived MonthSummary is
// cached in the jsonb `summary` column so the verify panel and the analytics
// cutover read without re-streaming the workbook.
import { and, eq } from "drizzle-orm";
import { db, sapUploads, type SapUpload } from "@workspace/db";
import type { MonthSummary } from "./derive.js";

export async function upsertUpload(args: {
  fy: string;
  monthLabel: string;
  objectPath: string;
  originalName: string | null;
  summary: MonthSummary;
}): Promise<void> {
  const values = {
    fy: args.fy,
    monthLabel: args.monthLabel,
    objectPath: args.objectPath,
    originalName: args.originalName,
    rowsRead: args.summary.rowsRead,
    amount: String(args.summary.amount),
    summary: args.summary,
  };
  await db
    .insert(sapUploads)
    .values(values)
    .onConflictDoUpdate({
      target: [sapUploads.fy, sapUploads.monthLabel],
      set: {
        objectPath: values.objectPath,
        originalName: values.originalName,
        rowsRead: values.rowsRead,
        amount: values.amount,
        summary: values.summary,
        uploadedAt: new Date(),
      },
    });
}

export async function getUploadsForFy(fy: string): Promise<SapUpload[]> {
  return db.select().from(sapUploads).where(eq(sapUploads.fy, fy));
}

export async function getUploadSummaries(fy: string): Promise<MonthSummary[]> {
  const rows = await getUploadsForFy(fy);
  return rows
    .map((r) => r.summary as MonthSummary | null)
    .filter((s): s is MonthSummary => s != null);
}

export async function deleteUpload(
  fy: string,
  monthLabel: string,
): Promise<{ objectPath: string | null }> {
  const [existing] = await db
    .select()
    .from(sapUploads)
    .where(and(eq(sapUploads.fy, fy), eq(sapUploads.monthLabel, monthLabel)));
  if (!existing) return { objectPath: null };
  await db
    .delete(sapUploads)
    .where(and(eq(sapUploads.fy, fy), eq(sapUploads.monthLabel, monthLabel)));
  return { objectPath: existing.objectPath };
}
