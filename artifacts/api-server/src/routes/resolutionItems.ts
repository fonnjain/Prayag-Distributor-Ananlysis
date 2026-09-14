import { Router, type Request } from "express";
import { pool } from "@workspace/db";
import { requireAdmin, requireAuthenticated, writeAudit } from "../lib/auth.js";

const router = Router();

const TYPES = new Set(["HOLD", "PENDING"]);
const CATEGORIES = new Set(["data quality", "master data", "access", "infrastructure", "commercial"]);
const STATUSES = new Set(["open", "answered", "resolved", "accepted-as-is"]);
const PRIORITIES = new Set(["urgent", "high", "medium", "low"]);
const MAX_TEXT = 20_000;
const CREATE_KEYS = new Set([
  "code", "type", "title", "category", "fiscalYear", "month", "scopeProduct",
  "scopeMeasure", "reason", "evidence", "valueAtStake", "raisedOn", "raisedBy",
  "owner", "priority", "status", "blocksApi",
]);
const EDIT_KEYS = new Set([
  "title", "category", "fiscalYear", "month", "scopeProduct", "scopeMeasure",
  "reason", "evidence", "valueAtStake", "raisedOn", "raisedBy", "owner", "priority",
  "blocksApi",
]);
const RESOLVE_KEYS = new Set(["status", "resolutionNote"]);

type ItemInput = {
  code: string;
  type: string;
  title: string;
  category: string;
  fiscalYear: string | null;
  month: string | null;
  scopeProduct: string | null;
  scopeMeasure: string | null;
  reason: string;
  evidence: string;
  valueAtStake: number | null;
  raisedOn: string;
  raisedBy: string;
  owner: string;
  priority: string;
  status: string;
  blocksApi: boolean;
};

function objectWithOnlyKeys(body: unknown, keys: Set<string>): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Object.keys(body).some((key) => !keys.has(key));
}

function textValue(value: unknown, field: string, required: boolean, max = 500): string | null {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (required && trimmed.length === 0) throw new Error(`${field} must not be empty`);
  if (trimmed.length > max) throw new Error(`${field} is too long`);
  return trimmed || null;
}

function dateValue(value: unknown, field: string, required: boolean): string | null {
  const result = textValue(value, field, required, 10);
  if (result === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error(`${field} must be YYYY-MM-DD`);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new Error(`${field} must be a valid calendar date`);
  }
  return result;
}

function nullableText(body: Record<string, unknown>, field: string, max = 500): string | null {
  return body[field] === undefined ? null : textValue(body[field], field, false, max);
}

function measureValue(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) throw new Error("scopeMeasure is required for a HOLD");
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 2_000) {
    throw new Error("scopeMeasure must be a nonempty string");
  }
  return value.trim();
}

function numberValue(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("valueAtStake must be a non-negative number");
  }
  return value;
}

export function validateResolutionItem(body: unknown): ItemInput {
  if (!objectWithOnlyKeys(body, CREATE_KEYS)) throw new Error("Unknown or invalid fields");
  const input = body as Record<string, unknown>;
  const type = textValue(input.type, "type", true, 10)!;
  if (!TYPES.has(type)) throw new Error("type must be HOLD or PENDING");
  const blocksApi = input.blocksApi === undefined ? type === "HOLD" : input.blocksApi;
  if (typeof blocksApi !== "boolean") throw new Error("blocksApi must be a boolean");
  if (type === "PENDING" && blocksApi) throw new Error("PENDING items cannot block the API");
  if (type === "PENDING" && input.scopeMeasure !== undefined && input.scopeMeasure !== null) {
    throw new Error("scopeMeasure is only valid for HOLD items");
  }
  const scopeMeasure = measureValue(input.scopeMeasure, type === "HOLD");
  if (type === "HOLD" && (!scopeMeasure || scopeMeasure.length === 0)) {
    throw new Error("HOLD items require scopeMeasure");
  }
  const status = input.status === undefined ? "open" : textValue(input.status, "status", true, 20)!;
  if (!STATUSES.has(status)) throw new Error("Invalid status");
  if (status !== "open") throw new Error("New resolution items must start with status open");
  const code = textValue(input.code, "code", true, 40)!;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(code)) throw new Error("code has invalid characters");
  return {
    code,
    type,
    title: textValue(input.title, "title", true, 300)!,
    category: (() => {
      const category = textValue(input.category, "category", true, 30)!;
      if (!CATEGORIES.has(category)) throw new Error("Invalid category");
      return category;
    })(),
    fiscalYear: nullableText(input, "fiscalYear", 30),
    month: nullableText(input, "month", 100),
    scopeProduct: nullableText(input, "scopeProduct", 300),
    scopeMeasure,
    reason: textValue(input.reason, "reason", true, MAX_TEXT)!,
    evidence: textValue(input.evidence, "evidence", true, MAX_TEXT)!,
    valueAtStake: numberValue(input.valueAtStake),
    raisedOn: dateValue(input.raisedOn, "raisedOn", true)!,
    raisedBy: textValue(input.raisedBy, "raisedBy", true, 200)!,
    owner: textValue(input.owner, "owner", true, 200)!,
    priority: (() => {
      const priority = textValue(input.priority, "priority", true, 20)!;
      if (!PRIORITIES.has(priority)) throw new Error("Invalid priority");
      return priority;
    })(),
    status,
    blocksApi,
  };
}

export function isResolutionItemClosed(status: unknown): boolean {
  return typeof status === "string" && status !== "open";
}

function validateEdit(body: unknown): Record<string, unknown> {
  if (!objectWithOnlyKeys(body, EDIT_KEYS)) throw new Error("Unknown or invalid fields");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).length === 0) throw new Error("No changes supplied");
  const result: Record<string, unknown> = {};
  if ("title" in input) result.title = textValue(input.title, "title", true, 300);
  if ("category" in input) {
    const category = textValue(input.category, "category", true, 30)!;
    if (!CATEGORIES.has(category)) throw new Error("Invalid category");
    result.category = category;
  }
  if ("fiscalYear" in input) result.fiscalYear = textValue(input.fiscalYear, "fiscalYear", false, 30);
  if ("month" in input) result.month = textValue(input.month, "month", false, 100);
  if ("scopeProduct" in input) result.scopeProduct = textValue(input.scopeProduct, "scopeProduct", false, 300);
  if ("scopeMeasure" in input) result.scopeMeasure = measureValue(input.scopeMeasure, false);
  if ("reason" in input) result.reason = textValue(input.reason, "reason", true, MAX_TEXT);
  if ("evidence" in input) result.evidence = textValue(input.evidence, "evidence", true, MAX_TEXT);
  if ("valueAtStake" in input) result.valueAtStake = numberValue(input.valueAtStake);
  if ("raisedOn" in input) result.raisedOn = dateValue(input.raisedOn, "raisedOn", true);
  if ("raisedBy" in input) result.raisedBy = textValue(input.raisedBy, "raisedBy", true, 200);
  if ("owner" in input) result.owner = textValue(input.owner, "owner", true, 200);
  if ("priority" in input) {
    const priority = textValue(input.priority, "priority", true, 20)!;
    if (!PRIORITIES.has(priority)) throw new Error("Invalid priority");
    result.priority = priority;
  }
  if ("blocksApi" in input) {
    if (typeof input.blocksApi !== "boolean") throw new Error("blocksApi must be a boolean");
    result.blocksApi = input.blocksApi;
  }
  return result;
}

function itemJson(row: Record<string, any>): Record<string, unknown> {
  const end = row.resolved_on && ["resolved", "answered", "accepted-as-is"].includes(row.status)
    ? new Date(`${String(row.resolved_on).slice(0, 10)}T00:00:00Z`)
    : new Date();
  const start = new Date(`${String(row.raised_on).slice(0, 10)}T00:00:00Z`);
  const daysOpen = Number.isNaN(start.getTime()) ? null : Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86_400_000));
  return {
    id: row.id,
    code: row.code,
    type: row.type,
    title: row.title,
    category: row.category,
    fiscalYear: row.fiscal_year,
    month: row.month,
    scopeProduct: row.scope_product,
    scopeMeasure: row.scope_measure,
    reason: row.reason,
    evidence: row.evidence,
    valueAtStake: row.value_at_stake === null || row.value_at_stake === undefined ? null : Number(row.value_at_stake),
    raisedOn: String(row.raised_on).slice(0, 10),
    raisedBy: row.raised_by,
    owner: row.owner,
    priority: row.priority,
    status: row.status,
    resolvedOn: row.resolved_on ? String(row.resolved_on).slice(0, 10) : null,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
    blocksApi: row.blocks_api,
    daysOpen,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function auditSnapshot(row: Record<string, any>): Record<string, unknown> {
  return {
    code: row.code,
    type: row.type,
    title: row.title,
    category: row.category,
    fiscalYear: row.fiscal_year,
    month: row.month,
    scopeProduct: row.scope_product,
    scopeMeasure: row.scope_measure,
    reason: row.reason,
    evidence: row.evidence,
    valueAtStake: row.value_at_stake,
    raisedOn: row.raised_on,
    raisedBy: row.raised_by,
    owner: row.owner,
    priority: row.priority,
    status: row.status,
    resolvedOn: row.resolved_on,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
    blocksApi: row.blocks_api,
  };
}

function idFromRequest(req: Request): number | null {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.use(requireAuthenticated);

router.get("/resolution-items", async (req, res): Promise<void> => {
  const allowedQuery = new Set(["owner", "category", "type", "status", "priority", "sort"]);
  if (Object.keys(req.query).some((key) => !allowedQuery.has(key))) {
    res.status(400).json({ error: "Unknown query parameter" });
    return;
  }
  const filters: string[] = [];
  const params: unknown[] = [];
  for (const field of ["owner", "category", "type", "status", "priority"] as const) {
    const value = req.query[field];
    if (value !== undefined) {
      if (typeof value !== "string" || value.length > 200) {
        res.status(400).json({ error: `Invalid ${field}` });
        return;
      }
      if (field === "type" && !TYPES.has(value)) {
        res.status(400).json({ error: "Invalid type" });
        return;
      }
      if (field === "category" && !CATEGORIES.has(value)) {
        res.status(400).json({ error: "Invalid category" });
        return;
      }
      if (field === "status" && !STATUSES.has(value)) {
        res.status(400).json({ error: "Invalid status" });
        return;
      }
      if (field === "priority" && !PRIORITIES.has(value)) {
        res.status(400).json({ error: "Invalid priority" });
        return;
      }
      params.push(value);
      filters.push(`${field} = $${params.length}`);
    }
  }
  if (req.query.sort !== undefined && !["value", "days", "priority"].includes(String(req.query.sort))) {
    res.status(400).json({ error: "sort must be value, days, or priority" });
    return;
  }
  const sort = req.query.sort === "value"
    ? "value_at_stake DESC NULLS LAST, raised_on ASC"
    : req.query.sort === "priority"
      ? "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, raised_on ASC"
      : "raised_on ASC";
  try {
    const result = await pool.query(
      `SELECT * FROM resolution_item ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY ${sort}, id ASC`,
      params,
    );
    const items = result.rows.map(itemJson);
    if (sort === "raised_on ASC") items.sort((a, b) => Number(b.daysOpen ?? 0) - Number(a.daysOpen ?? 0));
    const relationships = await pool.query(
      `SELECT source_code AS "sourceCode", target_code AS "targetCode", relation, created_at AS "createdAt"
         FROM resolution_item_relationship
        ORDER BY source_code, target_code, relation`,
    );
    res.json({ items, relationships: relationships.rows });
  } catch (err) {
    req.log.error({ err }, "resolution items read failed");
    res.status(500).json({ error: "Unable to load resolution items" });
  }
});

router.post("/resolution-items", requireAdmin, async (req, res): Promise<void> => {
  let item: ItemInput;
  try {
    item = validateResolutionItem(req.body);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid resolution item" });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO resolution_item
       (code, type, title, category, fiscal_year, month, scope_product, scope_measure,
         reason, evidence, value_at_stake, raised_on, raised_by, owner, priority, status, blocks_api)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [item.code, item.type, item.title, item.category, item.fiscalYear, item.month, item.scopeProduct,
        item.scopeMeasure, item.reason, item.evidence, item.valueAtStake, item.raisedOn, item.raisedBy,
         item.owner, item.priority, item.status, item.blocksApi],
    );
    await writeAudit(client, "resolution_item_added", req, req.authUser?.id ?? null, null, { id: result.rows[0].id, code: item.code });
    await client.query("COMMIT");
    res.status(201).json({ item: itemJson(result.rows[0]) });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (err?.code === "23505") {
      res.status(409).json({ error: "A resolution item with that code already exists" });
      return;
    }
    if (err?.code === "23514") {
      res.status(400).json({ error: "Resolution item violates a register rule" });
      return;
    }
    req.log.error({ err }, "resolution item add failed");
    res.status(500).json({ error: "Unable to add resolution item" });
  } finally {
    client.release();
  }
});

router.patch("/resolution-items/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = idFromRequest(req);
  if (!id) {
    res.status(400).json({ error: "Invalid resolution item id" });
    return;
  }
  let changes: Record<string, unknown>;
  try {
    changes = validateEdit(req.body);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid resolution item update" });
    return;
  }
  const fields = Object.keys(changes);
  const sets = fields.map((field, index) => `${({
    fiscalYear: "fiscal_year", scopeProduct: "scope_product", scopeMeasure: "scope_measure",
    valueAtStake: "value_at_stake", raisedOn: "raised_on", raisedBy: "raised_by", blocksApi: "blocks_api",
  } as Record<string, string>)[field] ?? field} = $${index + 2}`);
  // A HOLD/PENDING check is evaluated after the update, so an edit cannot
  // accidentally turn a PENDING item into an API block or remove HOLD scope.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const previous = await client.query(
      `SELECT * FROM resolution_item WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!previous.rows[0]) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Resolution item not found" });
      return;
    }
    if (isResolutionItemClosed(previous.rows[0].status)) {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: "Resolution item is already closed",
        item: itemJson(previous.rows[0]),
      });
      return;
    }
    const result = await client.query(
      `UPDATE resolution_item SET ${sets.join(", ")}, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, ...fields.map((field) => changes[field])],
    );
    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Resolution item not found" });
      return;
    }
    await writeAudit(client, "resolution_item_edited", req, req.authUser?.id ?? null, null, {
      id,
      fields,
      before: auditSnapshot(previous.rows[0]),
      after: auditSnapshot(result.rows[0]),
    });
    await client.query("COMMIT");
    res.json({ item: itemJson(result.rows[0]) });
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (err?.code === "23514") {
      res.status(400).json({ error: "Resolution item violates a register rule" });
      return;
    }
    req.log.error({ err }, "resolution item edit failed");
    res.status(500).json({ error: "Unable to edit resolution item" });
  } finally {
    client.release();
  }
});

router.post("/resolution-items/:id/resolve", requireAdmin, async (req, res): Promise<void> => {
  const id = idFromRequest(req);
  if (!id) {
    res.status(400).json({ error: "Invalid resolution item id" });
    return;
  }
  if (!objectWithOnlyKeys(req.body, RESOLVE_KEYS)) {
    res.status(400).json({ error: "Unknown or invalid fields" });
    return;
  }
  let status: string;
  let resolutionNote: string;
  try {
    status = textValue(req.body.status, "status", true, 20)!;
    if (!["resolved", "answered", "accepted-as-is"].includes(status)) throw new Error("Invalid resolution status");
    resolutionNote = textValue(req.body.resolutionNote, "resolutionNote", true, MAX_TEXT)!;
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Invalid resolution" });
    return;
  }
  const resolvedBy = req.authUser?.displayName || req.authUser?.email || "administrator";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const previous = await client.query(
      `SELECT * FROM resolution_item WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!previous.rows[0]) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Resolution item not found" });
      return;
    }
    if (isResolutionItemClosed(previous.rows[0].status)) {
      await client.query("ROLLBACK");
      res.status(409).json({
        error: "Resolution item is already closed",
        item: itemJson(previous.rows[0]),
      });
      return;
    }
    const result = await client.query(
      `UPDATE resolution_item
       SET status = $2, resolved_on = CURRENT_DATE, resolved_by = $3,
           resolution_note = $4, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, status, resolvedBy, resolutionNote],
    );
    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Resolution item not found" });
      return;
    }
    await writeAudit(client, "resolution_item_resolved", req, req.authUser?.id ?? null, null, {
      id,
      status,
      resolvedBy,
      before: auditSnapshot(previous.rows[0]),
      after: auditSnapshot(result.rows[0]),
    });
    await client.query("COMMIT");
    res.json({ item: itemJson(result.rows[0]) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    req.log.error({ err }, "resolution item resolve failed");
    res.status(500).json({ error: "Unable to resolve resolution item" });
  } finally {
    client.release();
  }
});

export default router;