// Customer Master — editable DB-backed customer attribution master.
//
// Attribution rules:
// - This table owns which customer belongs to which State Head.
// - The live sale sheets own rupee/quantity values. Never the reverse.
// - Sale-sheet head mismatches surface in customer_mismatch_queue; they
//   NEVER auto-update this master. A human approves or dismisses each one.
//
// ROUTE ORDER: specific paths (/export, /mismatch/*, /import/*) MUST be
// registered before /:id so Express matches them first.
import { Router, type Request, type Response } from "express";
import express from "express";
import { db } from "@workspace/db";
import {
  customerMaster,
  customerMasterLog,
  customerMismatchQueue,
  type CustomerMaster,
} from "@workspace/db";
import {
  eq,
  and,
  ilike,
  or,
  isNull,
  asc,
  desc,
  sql,
  inArray,
} from "drizzle-orm";
import ExcelJS from "exceljs";
import { randomUUID } from "crypto";
import { stateVariants } from "../lib/stateCanon.js";

const router = Router();

const VALID_TYPES = new Set(["Distributor", "Direct Dealer", "Retailer"]);
const VALID_STATUSES = new Set(["Active", "Inactive", "Closed", "Converted"]);
const VALID_CONFIDENCE = new Set(["Confirmed", "Guessed"]);

const EXPORT_COLUMNS: Array<{ key: keyof CustomerMaster; header: string; width: number }> = [
  { key: "id", header: "ID", width: 14 },
  { key: "company", header: "Company", width: 36 },
  { key: "type", header: "Type", width: 14 },
  { key: "status", header: "Status", width: 12 },
  { key: "contact", header: "Contact", width: 20 },
  { key: "mobile", header: "Mobile", width: 14 },
  { key: "state", header: "State", width: 16 },
  { key: "district", header: "District", width: 18 },
  { key: "city", header: "City", width: 16 },
  { key: "stateHead", header: "State Head", width: 22 },
  { key: "headConfidence", header: "Head Confidence", width: 16 },
  { key: "supplyingDistributor", header: "Supplying Distributor", width: 30 },
  { key: "notes", header: "Notes", width: 30 },
];

async function logChange(
  customerId: string,
  field: string,
  oldValue: string | null | undefined,
  newValue: string | null | undefined,
  changedBy: string,
  reason?: string,
  importBatch?: string,
) {
  await db.insert(customerMasterLog).values({
    customerId,
    field,
    oldValue: oldValue ?? null,
    newValue: newValue ?? null,
    changedBy,
    reason: reason ?? null,
    importBatch: importBatch ?? null,
  });
}

const UPDATABLE_FIELDS: (keyof CustomerMaster)[] = [
  "company", "type", "status", "contact", "mobile", "state",
  "district", "city", "stateHead", "headConfidence", "supplyingDistributor", "notes",
];

// ── LIST ───────────────────────────────────────────────────────────────────────

router.get("/customer-master", async (req: Request, res: Response): Promise<void> => {
  const { type, stateHead, state, status, confidence, q, limit: lQ, offset: oQ } = req.query as Record<string, string | undefined>;
  const pageLimit = Math.min(Number(lQ) || 200, 500);
  const pageOffset = Number(oQ) || 0;
  try {
    const conds = [];
    if (type && VALID_TYPES.has(type)) conds.push(eq(customerMaster.type, type));
    if (stateHead) conds.push(eq(customerMaster.stateHead, stateHead));
    if (state) { const sv = stateVariants(state); conds.push(sv.length === 1 ? eq(customerMaster.state, state) : inArray(customerMaster.state, sv)); }
    if (status && VALID_STATUSES.has(status)) conds.push(eq(customerMaster.status, status));
    if (confidence && VALID_CONFIDENCE.has(confidence)) conds.push(eq(customerMaster.headConfidence, confidence));
    if (q) {
      const p = `%${q.trim()}%`;
      conds.push(or(ilike(customerMaster.company, p), ilike(customerMaster.city, p), ilike(customerMaster.district, p), ilike(customerMaster.contact, p)));
    }
    const where = conds.length > 0 ? and(...conds) : undefined;
    const [rows, [{ count }]] = await Promise.all([
      db.select().from(customerMaster).where(where).orderBy(asc(customerMaster.company)).limit(pageLimit).offset(pageOffset),
      db.select({ count: sql<number>`count(*)::int` }).from(customerMaster).where(where),
    ]);
    res.json({ total: count, limit: pageLimit, offset: pageOffset, rows });
  } catch (err) {
    req.log.error({ err }, "customer-master list failed");
    res.status(500).json({ error: "Could not list customer master." });
  }
});

// ── EXPORT xlsx — must be before /:id ────────────────────────────────────────

router.get("/customer-master/export", async (req: Request, res: Response): Promise<void> => {
  const { type, stateHead, state, status, confidence } = req.query as Record<string, string | undefined>;
  try {
    const conds = [];
    if (type && VALID_TYPES.has(type)) conds.push(eq(customerMaster.type, type));
    if (stateHead) conds.push(eq(customerMaster.stateHead, stateHead));
    if (state) { const sv = stateVariants(state); conds.push(sv.length === 1 ? eq(customerMaster.state, state) : inArray(customerMaster.state, sv)); }
    if (status) conds.push(eq(customerMaster.status, status));
    if (confidence) conds.push(eq(customerMaster.headConfidence, confidence));
    const rows = await db.select().from(customerMaster)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(asc(customerMaster.type), asc(customerMaster.company));

    const wb = new ExcelJS.Workbook();
    wb.creator = "Prayag Sales Intelligence";
    const ws = wb.addWorksheet("Customer Master");
    ws.columns = EXPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    ws.getRow(1).eachCell((cell) => {
      cell.font = { bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF5" } };
    });
    for (const row of rows) {
      ws.addRow(EXPORT_COLUMNS.map((c) => (row[c.key] as string | null | undefined) ?? ""));
    }
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="customer_master_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    req.log.error({ err }, "customer-master export failed");
    res.status(500).json({ error: "Export failed." });
  }
});

// ── IMPORT PREVIEW — must be before /:id ─────────────────────────────────────

router.post(
  "/customer-master/import/preview",
  express.raw({ type: "application/octet-stream", limit: "20mb" }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: "Send the xlsx file as application/octet-stream body." });
        return;
      }
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.body as unknown as Parameters<typeof wb.xlsx.load>[0]);
      const ws = wb.worksheets[0];
      if (!ws) { res.status(422).json({ error: "No worksheet found." }); return; }

      const headers: string[] = [];
      ws.getRow(1).eachCell({ includeEmpty: true }, (cell) => headers.push(String(cell.value ?? "").trim()));
      const ci = (h: string) => headers.indexOf(h);
      if (ci("ID") < 0) { res.status(422).json({ error: "xlsx must have an 'ID' column." }); return; }

      const incoming: Record<string, Partial<CustomerMaster>> = {};
      ws.eachRow((row, rn) => {
        if (rn === 1) return;
        const id = String(row.getCell(ci("ID") + 1).value ?? "").trim();
        if (!id) return;
        const g = (h: string) => { const i = ci(h); return i < 0 ? undefined : (String(row.getCell(i + 1).value ?? "").trim() || undefined); };
        incoming[id] = {
          id,
          company: g("Company") ?? "",
          type: g("Type") ?? "",
          status: g("Status") ?? "Active",
          contact: g("Contact"),
          mobile: g("Mobile"),
          state: g("State"),
          district: g("District"),
          city: g("City"),
          stateHead: g("State Head"),
          headConfidence: (g("Head Confidence") ?? "Guessed") as "Confirmed" | "Guessed",
          supplyingDistributor: g("Supplying Distributor"),
          notes: g("Notes"),
        };
      });

      if (Object.keys(incoming).length === 0) { res.status(422).json({ error: "No data rows found." }); return; }

      const incomingIds = Object.keys(incoming);
      const existing = incomingIds.length === 0 ? [] : await db.select().from(customerMaster)
        .where(inArray(customerMaster.id, incomingIds));
      const existingMap = new Map(existing.map((r) => [r.id, r]));

      const updates: Array<{ id: string; company: string; changes: Record<string, { old: string; new: string }> }> = [];
      const inserts: Array<Partial<CustomerMaster>> = [];
      let unchanged = 0;

      for (const [id, row] of Object.entries(incoming)) {
        const old = existingMap.get(id);
        if (!old) {
          inserts.push(row);
        } else {
          const changes: Record<string, { old: string; new: string }> = {};
          for (const f of UPDATABLE_FIELDS) {
            const ov = String(old[f] ?? "");
            const nv = String((row as Record<string, unknown>)[f] ?? "");
            if (ov !== nv) changes[f] = { old: ov, new: nv };
          }
          if (Object.keys(changes).length > 0) updates.push({ id, company: old.company, changes });
          else unchanged++;
        }
      }

      const batchId = randomUUID();
      res.json({ batchId, totalRows: incomingIds.length, updates: updates.length, inserts: inserts.length, unchanged, updateDetails: updates, insertSample: inserts.slice(0, 10), rows: incoming });
    } catch (err) {
      req.log.error({ err }, "customer-master import preview failed");
      res.status(500).json({ error: "Could not parse xlsx." });
    }
  },
);

// ── IMPORT COMMIT — must be before /:id ──────────────────────────────────────

// "Guessed (MH dominant)" and any other "Guessed*" variants normalise to "Guessed"
// so inline-edit validation (which only allows "Confirmed" / "Guessed") continues to work.
const normaliseConfidence = (v: string | undefined | null): "Confirmed" | "Guessed" =>
  v && v.startsWith("Confirmed") ? "Confirmed" : "Guessed";

const CHUNK = 200; // safe well under Postgres 65535-parameter limit
function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

router.post(
  "/customer-master/import/commit",
  express.json({ limit: "20mb" }),
  async (req: Request, res: Response): Promise<void> => {
    const body = req.body as { rows: Record<string, Partial<CustomerMaster>>; editedBy?: string; batchId?: string };
    if (!body?.rows || typeof body.rows !== "object") {
      res.status(400).json({ error: "rows is required." }); return;
    }

    const editedBy = typeof body.editedBy === "string" && body.editedBy.trim() ? body.editedBy.trim() : "import";
    const batchId = body.batchId ?? randomUUID();
    const now = new Date();

    // ── Upfront validation (before touching the DB) ──────────────────────────
    for (const [id, row] of Object.entries(body.rows)) {
      const t = row.type ?? "";
      const s = row.status ?? "Active";
      if (t && !VALID_TYPES.has(t)) {
        res.status(422).json({
          error: `Row ${id}: invalid type "${t}". Allowed values: Distributor, Direct Dealer, Retailer.`,
        }); return;
      }
      if (s && !VALID_STATUSES.has(s)) {
        res.status(422).json({
          error: `Row ${id}: invalid status "${s}". Allowed values: Active, Inactive, Closed, Converted.`,
        }); return;
      }
    }

    try {
      const ids = Object.keys(body.rows);
      const existing = ids.length === 0 ? [] : await db.select().from(customerMaster)
        .where(inArray(customerMaster.id, ids));
      const existingMap = new Map(existing.map((r) => [r.id, r]));

      // Separate inserts from updates upfront
      const toInsert: Array<typeof customerMaster.$inferInsert> = [];
      const toUpdate: Array<{ id: string; patch: Record<string, unknown>; logEntries: Array<typeof customerMasterLog.$inferInsert> }> = [];

      for (const [id, row] of Object.entries(body.rows)) {
        const old = existingMap.get(id);
        const hc = normaliseConfidence(row.headConfidence);
        if (!old) {
          toInsert.push({
            id, company: row.company ?? "", type: row.type ?? "", status: row.status ?? "Active",
            contact: row.contact ?? null, mobile: row.mobile ?? null, state: row.state ?? null,
            district: row.district ?? null, city: row.city ?? null, stateHead: row.stateHead ?? null,
            headConfidence: hc,
            supplyingDistributor: row.supplyingDistributor ?? null, notes: row.notes ?? null, editedBy,
          });
        } else {
          const normalised = { ...row, headConfidence: hc } as Record<string, unknown>;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const patch: Record<string, any> = { updatedAt: now, editedBy };
          const logEntries: Array<typeof customerMasterLog.$inferInsert> = [];
          for (const f of UPDATABLE_FIELDS) {
            const ov = String(old[f] ?? "");
            const nv = String(normalised[f] ?? "");
            if (ov !== nv) {
              patch[f] = normalised[f];
              logEntries.push({ customerId: id, field: f, oldValue: ov, newValue: nv, changedBy: editedBy, reason: "import", importBatch: batchId });
            }
          }
          if (logEntries.length > 0) toUpdate.push({ id, patch, logEntries });
        }
      }

      // ── All-or-nothing transaction ────────────────────────────────────────
      await db.transaction(async (tx) => {
        // Bulk-insert new rows in chunks
        for (const chunk of chunks(toInsert, CHUNK)) {
          await tx.insert(customerMaster).values(chunk);
        }
        // Bulk-insert creation log entries
        const createLogs: Array<typeof customerMasterLog.$inferInsert> = toInsert.map((r) => ({
          customerId: r.id, field: "_created", oldValue: null, newValue: "imported",
          changedBy: editedBy, reason: "import", importBatch: batchId,
        }));
        for (const chunk of chunks(createLogs, CHUNK)) {
          await tx.insert(customerMasterLog).values(chunk);
        }
        // Apply updates and their logs
        for (const { id, patch, logEntries } of toUpdate) {
          await tx.update(customerMaster).set(patch).where(eq(customerMaster.id, id));
          for (const chunk of chunks(logEntries, CHUNK)) {
            await tx.insert(customerMasterLog).values(chunk);
          }
        }
      });

      const inserted = toInsert.length;
      const updated = toUpdate.length;
      const unchanged = ids.length - inserted - updated;

      // Per-type counts across everything committed
      const typeCounts: Record<string, number> = {};
      for (const row of Object.values(body.rows)) {
        const t = row.type ?? "Unknown";
        typeCounts[t] = (typeCounts[t] ?? 0) + 1;
      }

      req.log.info({ batchId, inserted, updated, unchanged, typeCounts }, "customer-master import committed");
      res.json({ batchId, inserted, updated, unchanged, typeCounts });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err, batchId }, "customer-master import commit failed");
      res.status(500).json({ error: `Import failed: ${msg}` });
    }
  },
);

// ── MISMATCH COUNT (for nav badges) — must be before /:id ────────────────────

router.get("/customer-master/mismatch/count", async (req: Request, res: Response): Promise<void> => {
  try {
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(customerMismatchQueue).where(isNull(customerMismatchQueue.resolvedAt));
    res.json({ pendingCount: count });
  } catch (err) {
    req.log.error({ err }, "mismatch count failed");
    res.status(500).json({ error: "Could not count mismatches." });
  }
});

// ── MISMATCH LIST — must be before /:id ──────────────────────────────────────

router.get("/customer-master/mismatch", async (req: Request, res: Response): Promise<void> => {
  try {
    const pendingOnly = req.query.pending === "true";
    const rows = await db.select().from(customerMismatchQueue)
      .where(pendingOnly ? isNull(customerMismatchQueue.resolvedAt) : undefined)
      .orderBy(desc(customerMismatchQueue.detectedAt)).limit(200);
    const pending = rows.filter((r) => !r.resolvedAt).length;
    res.json({ rows, pendingCount: pending });
  } catch (err) {
    req.log.error({ err }, "mismatch list failed");
    res.status(500).json({ error: "Could not list mismatch queue." });
  }
});

// ── MISMATCH RESOLVE — must be before /:id ───────────────────────────────────

router.post("/customer-master/mismatch/:mid/resolve", async (req: Request, res: Response): Promise<void> => {
  const mid = Number(req.params.mid);
  const body = req.body as { resolution: string; resolvedBy?: string; reason?: string };
  if (!["approved", "dismissed"].includes(body?.resolution)) {
    res.status(400).json({ error: "resolution must be 'approved' or 'dismissed'" }); return;
  }
  try {
    const items = await db.select().from(customerMismatchQueue).where(eq(customerMismatchQueue.id, mid));
    if (!items.length) { res.status(404).json({ error: "Not found." }); return; }
    const item = items[0];
    if (item.resolvedAt) { res.status(409).json({ error: "Already resolved." }); return; }

    const resolvedBy = typeof body.resolvedBy === "string" && body.resolvedBy.trim() ? body.resolvedBy.trim() : "unknown";
    const now = new Date();
    await db.update(customerMismatchQueue)
      .set({ resolvedAt: now, resolvedBy, resolution: body.resolution, reason: body.reason ?? null })
      .where(eq(customerMismatchQueue.id, mid));

    if (body.resolution === "approved" && item.customerId) {
      const existing = await db.select().from(customerMaster).where(eq(customerMaster.id, item.customerId));
      if (existing.length > 0) {
        await logChange(item.customerId, "stateHead", existing[0].stateHead, item.sheetHead, resolvedBy, body.reason ?? "sale-sheet reconciliation");
        await db.update(customerMaster)
          .set({ stateHead: item.sheetHead, updatedAt: now, editedBy: resolvedBy })
          .where(eq(customerMaster.id, item.customerId));
      }
    }
    res.json({ ok: true, resolution: body.resolution });
  } catch (err) {
    req.log.error({ err, mid }, "mismatch resolve failed");
    res.status(500).json({ error: "Could not resolve mismatch." });
  }
});

// ── SINGLE RECORD (with log) — must be AFTER all specific paths ───────────────

router.get("/customer-master/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  try {
    const rows = await db.select().from(customerMaster).where(eq(customerMaster.id, id));
    if (!rows.length) { res.status(404).json({ error: "Not found." }); return; }
    const log = await db.select().from(customerMasterLog)
      .where(eq(customerMasterLog.customerId, id))
      .orderBy(desc(customerMasterLog.changedAt)).limit(50);
    res.json({ row: rows[0], log });
  } catch (err) {
    req.log.error({ err }, "customer-master get failed");
    res.status(500).json({ error: "Could not fetch record." });
  }
});

// ── UPDATE (inline edit) — must be AFTER all specific paths ──────────────────

router.put("/customer-master/:id", async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id);
  const body = req.body as Partial<CustomerMaster> & { editedBy?: string; reason?: string };
  const editedBy = typeof body.editedBy === "string" && body.editedBy.trim() ? body.editedBy.trim() : "unknown";
  const reason = typeof body.reason === "string" ? body.reason.trim() : undefined;
  try {
    const existing = await db.select().from(customerMaster).where(eq(customerMaster.id, id));
    if (!existing.length) { res.status(404).json({ error: "Not found." }); return; }
    const old = existing[0];
    if (body.type && !VALID_TYPES.has(body.type)) { res.status(400).json({ error: `Invalid type: ${body.type}` }); return; }
    if (body.status && !VALID_STATUSES.has(body.status)) { res.status(400).json({ error: `Invalid status: ${body.status}` }); return; }
    if (body.headConfidence && !VALID_CONFIDENCE.has(body.headConfidence)) { res.status(400).json({ error: "headConfidence must be Confirmed or Guessed" }); return; }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const patch: Record<string, any> = { updatedAt: new Date(), editedBy };
    for (const f of UPDATABLE_FIELDS) {
      if (f in body) patch[f] = (body as Record<string, unknown>)[f];
    }
    await db.update(customerMaster).set(patch).where(eq(customerMaster.id, id));
    for (const f of UPDATABLE_FIELDS) {
      if (f in body) {
        await logChange(id, f, String(old[f] ?? ""), String((body as Record<string, unknown>)[f] ?? ""), editedBy, reason);
      }
    }
    const updated = await db.select().from(customerMaster).where(eq(customerMaster.id, id));
    res.json({ row: updated[0] });
  } catch (err) {
    req.log.error({ err, id }, "customer-master update failed");
    res.status(500).json({ error: "Could not update record." });
  }
});

export default router;
