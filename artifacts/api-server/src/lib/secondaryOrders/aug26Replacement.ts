/**
 * Guarded one-time replacement for the incomplete Aug-26 Product-Wise export.
 * There is deliberately no scheduler or generic-loader entry point.
 */
import ExcelJS from "exceljs";
import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { canonGroupFromMap } from "../sku/catalogue.js";
import { normSecKey } from "../mgmt/names.js";
import { parseOrderDatetime } from "./loader.js";

export const AUG26_SOURCE_FILE = "Aug_month_order_booking_1788880718670.xlsx";
export const AUG26_SOURCE_SHA256 = "cd3df6cc6cf0ff264b9e2611e357df893f67c71c35e66b53823f5df125a98c51";
export const AUG26_REASON = "superseded-by-full-month-export";
export const PRAYAG_CONFIRMATION =
  "Prayag confirmed the six lines were deliberately changed or removed at source, not omitted by an export filter.";
export const AUG26_HEADERS = [
  "Date", "Order ID", "Sales User Name", "Employee ID", "Reporting Manager",
  "Customer Name", "Dealer ID", "Dealer Mobile", "Channel Partner Name", "CP Code",
  "State", "District", "City", "Pincode", "Category Name", "Product Code",
  "GST Type", "GST (%)", "GST Amount", "Qty", "Discount (%)", "Discount Amount",
  "Dealer Order Value", "Basic Order Value", "Order Status",
] as const;

const AUG_START = "2026-07-31T18:30:00Z";
const SEP_START = "2026-08-31T18:30:00Z";
const PREVIEW_MINUTES = 30;

export type Aug26Line = {
  orderId: string;
  productCode: string;
  orderDatetime: Date;
  orderStatus: string | null;
  salesUserName: string | null;
  employeeId: string | null;
  reportingManager: string | null;
  customerName: string | null;
  dealerId: string;
  dealerMobile: string | null;
  cpName: string | null;
  cpCode: string;
  state: string | null;
  district: string | null;
  city: string | null;
  pincode: string | null;
  categoryName: string | null;
  gstType: string | null;
  gstPct: number | null;
  gstAmount: number | null;
  qty: number;
  discountPct: number | null;
  discountAmount: number | null;
  dealerOrderValue: number;
  basicOrderValue: number;
  occurrence: number;
  sourceRowNumber: number;
};
export type RemovedLine = {
  orderId: string;
  productCode: string;
  basicOrderValue: number;
  qty: number;
};
export type RemovalConfirmation = RemovedLine & { confirmed: true };
export type Aug26Controls = {
  rows: number;
  orders: number;
  retailers: number;
  cps: number;
  products: number;
  qty: number;
  basic: number;
  dealer: number;
  approved: number;
  pending: number;
  dateMin: string;
  dateMax: string;
  lowOrders: number;
  lowMin: number;
  lowMax: number;
  highOrders: number;
  highMin: number;
  highMax: number;
};
export const EXPECTED_CONTROLS: Aug26Controls = {
  rows: 28185, orders: 4000, retailers: 2832, cps: 169, products: 2380,
  qty: 1119016, basic: 195788289, dealer: 230650998.74,
  approved: 28185, pending: 0, dateMin: "2026-08-01", dateMax: "2026-08-31",
  lowOrders: 2444, lowMin: 9, lowMax: 2484,
  highOrders: 1556, highMin: 160217, highMax: 161781,
};
export const EXPECTED_REMOVED_LINES: RemovedLine[] = [
  { orderId: "SORD-1099", productCode: "PD-46-H-N", qty: 1, basicOrderValue: 4980 },
  { orderId: "SORD-260", productCode: "124", qty: 1, basicOrderValue: 280 },
  { orderId: "SORD-260", productCode: "124", qty: 20, basicOrderValue: 5606 },
  { orderId: "SORD-260", productCode: "129", qty: 10, basicOrderValue: 2901 },
  { orderId: "SORD-782", productCode: "120-S", qty: 20, basicOrderValue: 1476 },
  { orderId: "SORD-782", productCode: "189", qty: 20, basicOrderValue: 3863 },
];

export type Aug26Preview = {
  sourceFile: string;
  sourceSha256: string;
  sourceBytes: number;
  controls: Aug26Controls;
  incomingFingerprint: string;
  existingFingerprint: string;
  previewHash: string;
  oldRows: number;
  removedLines: RemovedLine[];
  protectedFingerprints: Record<string, string>;
  collisions: number;
};

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount: number | null;
  }>;
};

function plainCellValue(value: unknown): string | number | Date | null {
  if (value == null) return null;
  if (value instanceof Date || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if ("result" in object) return plainCellValue(object.result);
    if ("text" in object) return plainCellValue(object.text);
    if (Array.isArray(object.richText)) {
      return object.richText.map((part) => String((part as { text?: unknown }).text ?? "")).join("");
    }
  }
  return null;
}
const text = (value: unknown): string | null => {
  const plain = plainCellValue(value);
  if (plain == null) return null;
  const result = String(plain).trim();
  return result === "" ? null : result;
};
const numberValue = (value: unknown): number | null => {
  const plain = plainCellValue(value);
  if (plain == null || plain === "") return null;
  const result = Number(String(plain).replace(/,/g, "").replace(/%$/, "").trim());
  return Number.isFinite(result) ? result : null;
};

export function buildAug26HeaderIndex(headers: Array<string | null>): Map<string, number> {
  if (headers.length !== AUG26_HEADERS.length || new Set(headers).size !== AUG26_HEADERS.length) {
    throw new Error(`Expected exactly ${AUG26_HEADERS.length} unique columns.`);
  }
  const index = new Map(headers.map((header, position) => [String(header), position + 1]));
  for (const header of AUG26_HEADERS) {
    if (!index.has(header)) throw new Error(`Missing required header: ${header}`);
  }
  return index;
}

function indiaDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

export function summarizeAug26Lines(lines: Aug26Line[]): Aug26Controls {
  const distinct = (selector: (line: Aug26Line) => unknown) => new Set(lines.map(selector)).size;
  const sum = (selector: (line: Aug26Line) => number) => lines.reduce((total, line) => total + selector(line), 0);
  const orderNumbers = [...new Set(lines.map((line) => {
    const match = /^SORD-(\d+)$/.exec(line.orderId);
    if (!match) throw new Error(`Invalid order ID ${line.orderId}.`);
    return Number(match[1]);
  }))];
  const low = orderNumbers.filter((value) => value >= 9 && value <= 2484);
  const high = orderNumbers.filter((value) => value >= 160217 && value <= 161781);
  if (low.length + high.length !== orderNumbers.length) throw new Error("Unexpected SORD order-number block.");
  const dates = lines.map((line) => indiaDate(line.orderDatetime)).sort();
  return {
    rows: lines.length,
    orders: orderNumbers.length,
    retailers: distinct((line) => line.dealerId),
    cps: distinct((line) => line.cpCode),
    products: distinct((line) => line.productCode),
    qty: sum((line) => line.qty),
    basic: sum((line) => line.basicOrderValue),
    dealer: Math.round(sum((line) => line.dealerOrderValue) * 100) / 100,
    approved: lines.filter((line) => line.orderStatus === "APPROVED").length,
    pending: lines.filter((line) => line.orderStatus === "PENDING").length,
    dateMin: dates[0] ?? "",
    dateMax: dates.at(-1) ?? "",
    lowOrders: low.length,
    lowMin: Math.min(...low),
    lowMax: Math.max(...low),
    highOrders: high.length,
    highMin: Math.min(...high),
    highMax: Math.max(...high),
  };
}

export function assertExpectedControls(actual: Aug26Controls): void {
  const mismatches = Object.entries(EXPECTED_CONTROLS)
    .filter(([key, expected]) => actual[key as keyof Aug26Controls] !== expected)
    .map(([key, expected]) => `${key}: expected ${expected}, got ${actual[key as keyof Aug26Controls]}`);
  if (mismatches.length > 0) throw new Error(`Aug-26 workbook controls failed: ${mismatches.join("; ")}`);
}

function removedKey(line: RemovedLine): string {
  return [line.orderId, line.productCode, line.qty, line.basicOrderValue].join("\u001f");
}
function sortedRemoved(lines: RemovedLine[]): string[] {
  return lines.map(removedKey).sort();
}
export function assertRemovalConfirmations(
  removedLines: RemovedLine[],
  confirmations: RemovalConfirmation[],
): void {
  const expected = sortedRemoved(EXPECTED_REMOVED_LINES);
  if (JSON.stringify(sortedRemoved(removedLines)) !== JSON.stringify(expected)) {
    throw new Error("The removed-line evidence is not the six lines confirmed by Prayag.");
  }
  if (
    confirmations.length !== EXPECTED_REMOVED_LINES.length ||
    confirmations.some((confirmation) => confirmation.confirmed !== true) ||
    JSON.stringify(sortedRemoved(confirmations)) !== JSON.stringify(expected)
  ) {
    throw new Error("All six removed lines require exact explicit confirmation.");
  }
}

function canonical(lines: Aug26Line[]): string {
  const records = lines.map((line) => ({
    ...line,
    orderDatetime: line.orderDatetime.toISOString(),
  }));
  return createHash("sha256").update(records.map((record) => JSON.stringify(record)).sort().join("\n")).digest("hex");
}

function stableRecord(value: Record<string, string>): string {
  return JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

export function protectedFingerprintsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  return stableRecord(left) === stableRecord(right);
}

export async function resolveFingerprintEntries(
  entries: Array<readonly [string, Promise<string>]>,
): Promise<Record<string, string>> {
  const resolved = await Promise.all(entries.map(async ([name, pending]) => {
    const fingerprintValue = await pending;
    if (typeof fingerprintValue !== "string") throw new Error(`Invalid fingerprint for ${name}.`);
    return [name, fingerprintValue] as const;
  }));
  return Object.fromEntries(resolved);
}

export async function parseAug26Replacement(bytes: Buffer): Promise<{
  lines: Aug26Line[];
  sourceSha256: string;
  sourceBytes: number;
  controls: Aug26Controls;
}> {
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  if (sourceSha256 !== AUG26_SOURCE_SHA256) {
    throw new Error("Workbook SHA-256 is not the approved Aug-26 full-month export.");
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as never);
  if (workbook.worksheets.length !== 1) throw new Error("Expected exactly one worksheet.");
  const sheet = workbook.worksheets[0];
  const headers = (sheet.getRow(1).values as unknown[]).slice(1).map(text);
  const index = buildAug26HeaderIndex(headers);
  const cell = (row: ExcelJS.Row, name: typeof AUG26_HEADERS[number]) => row.getCell(index.get(name)!).value;
  const lines: Aug26Line[] = [];
  const occurrences = new Map<string, number>();
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const orderId = text(cell(row, "Order ID"));
    const productCode = text(cell(row, "Product Code"));
    const orderDatetime = parseOrderDatetime(cell(row, "Date"));
    const qty = numberValue(cell(row, "Qty"));
    const basicOrderValue = numberValue(cell(row, "Basic Order Value"));
    const dealerOrderValue = numberValue(cell(row, "Dealer Order Value"));
    const dealerId = text(cell(row, "Dealer ID"));
    const cpCode = text(cell(row, "CP Code"));
    if (!orderId || !productCode || !orderDatetime || qty == null || basicOrderValue == null ||
      dealerOrderValue == null || !dealerId || !cpCode) {
      throw new Error(`Invalid required value at source row ${rowNumber}.`);
    }
    const pair = `${orderId}\0${productCode}`;
    const occurrence = (occurrences.get(pair) ?? 0) + 1;
    occurrences.set(pair, occurrence);
    lines.push({
      orderId, productCode, orderDatetime, qty, basicOrderValue, dealerOrderValue,
      dealerId, cpCode, occurrence, sourceRowNumber: rowNumber,
      orderStatus: text(cell(row, "Order Status")),
      salesUserName: text(cell(row, "Sales User Name")),
      employeeId: text(cell(row, "Employee ID")),
      reportingManager: text(cell(row, "Reporting Manager")),
      customerName: text(cell(row, "Customer Name")),
      dealerMobile: text(cell(row, "Dealer Mobile")),
      cpName: text(cell(row, "Channel Partner Name")),
      state: text(cell(row, "State")),
      district: text(cell(row, "District")),
      city: text(cell(row, "City")),
      pincode: text(cell(row, "Pincode")),
      categoryName: text(cell(row, "Category Name")),
      gstType: text(cell(row, "GST Type")),
      gstPct: numberValue(cell(row, "GST (%)")),
      gstAmount: numberValue(cell(row, "GST Amount")),
      discountPct: numberValue(cell(row, "Discount (%)")),
      discountAmount: numberValue(cell(row, "Discount Amount")),
    });
  });
  const controls = summarizeAug26Lines(lines);
  assertExpectedControls(controls);
  return { lines, sourceSha256, sourceBytes: bytes.length, controls };
}

async function fingerprint(client: Queryable, sql: string, args: unknown[] = []): Promise<string> {
  const result = await client.query(
    `SELECT COALESCE(md5(string_agg(md5(to_jsonb(x)::text), '' ORDER BY md5(to_jsonb(x)::text))), '') AS fingerprint
     FROM (${sql}) x`,
    args,
  );
  return String(result.rows[0]?.fingerprint ?? "");
}

async function protectedSet(client: Queryable): Promise<Record<string, string>> {
  return resolveFingerprintEntries([
    ["secondary_order_fy25_26", fingerprint(client, "SELECT * FROM secondary_order_line WHERE fiscal_year = '2025-26'")],
    ["secondary_order_apr_jul_26_27", fingerprint(client,
      "SELECT * FROM secondary_order_line WHERE fiscal_year = '2026-27' AND order_datetime >= $1::timestamptz AND order_datetime < $2::timestamptz",
      ["2026-03-31T18:30:00Z", AUG_START])],
    ["secondary_sku_line", fingerprint(client, "SELECT * FROM secondary_sku_line")],
    ["secondary_register_line", fingerprint(client, "SELECT * FROM secondary_register_line")],
    ["sale_line_all", fingerprint(client, "SELECT * FROM sale_line_all")],
  ]);
}

async function findCollisions(client: Queryable, lines: Aug26Line[]): Promise<Array<Record<string, unknown>>> {
  const pairs = [...new Set(lines.map((line) => `${line.orderId}\u001f${line.productCode}`))];
  const orderIds = [...new Set(lines.map((line) => line.orderId))];
  const collisions: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < pairs.length; offset += 2000) {
    const result = await client.query(
      `SELECT order_id, product_code, fiscal_year, order_datetime
       FROM secondary_order_line
       WHERE (order_id || chr(31) || product_code) = ANY($1::text[])
         AND NOT (fiscal_year = '2026-27' AND order_datetime >= $2::timestamptz AND order_datetime < $3::timestamptz)
       LIMIT 20`,
      [pairs.slice(offset, offset + 2000), AUG_START, SEP_START],
    );
    collisions.push(...result.rows);
  }
  for (let offset = 0; offset < orderIds.length; offset += 2000) {
    const result = await client.query(
      `SELECT DISTINCT order_id, fiscal_year, order_datetime
       FROM secondary_order_line
       WHERE order_id = ANY($1::text[])
         AND NOT (fiscal_year = '2026-27' AND order_datetime >= $2::timestamptz AND order_datetime < $3::timestamptz)
       LIMIT 20`,
      [orderIds.slice(offset, offset + 2000), AUG_START, SEP_START],
    );
    collisions.push(...result.rows);
  }
  return collisions;
}

async function buildPreview(bytes: Buffer, client: Queryable): Promise<Aug26Preview> {
  const parsed = await parseAug26Replacement(bytes);
  // Resolve and cross-check Employee ID + salesperson name during preview so
  // an attribution conflict can never first appear after archive/delete work.
  await resolveSalesUsers(client, parsed.lines);
  const old = await client.query(
    `SELECT * FROM secondary_order_line
     WHERE source_era = 'product_wise_crm' AND source_kind = 'product_wise'
       AND fiscal_year = '2026-27' AND order_datetime >= $1::timestamptz AND order_datetime < $2::timestamptz
     ORDER BY order_id, product_code, occurrence`,
    [AUG_START, SEP_START],
  );
  const oldRows = old.rows.length;
  const wanted = new Set(parsed.lines.map((line) => `${line.orderId}\0${line.productCode}`));
  const removedLines = old.rows
    .filter((row) => !wanted.has(`${row.order_id}\0${row.product_code}`))
    .map((row) => ({
      orderId: String(row.order_id),
      productCode: String(row.product_code),
      basicOrderValue: Number(row.basic_order_value),
      qty: Number(row.qty),
    }));
  assertRemovalConfirmations(removedLines, EXPECTED_REMOVED_LINES.map((line) => ({ ...line, confirmed: true })));
  const existingFingerprint = await fingerprint(client,
    `SELECT * FROM secondary_order_line
     WHERE source_era = 'product_wise_crm' AND source_kind = 'product_wise'
       AND fiscal_year = '2026-27' AND order_datetime >= $1::timestamptz AND order_datetime < $2::timestamptz`,
    [AUG_START, SEP_START]);
  const incomingFingerprint = canonical(parsed.lines);
  const protectedFingerprints = await protectedSet(client);
  const collisions = await findCollisions(client, parsed.lines);
  const previewHash = createHash("sha256").update(JSON.stringify({
    sourceSha256: parsed.sourceSha256,
    incomingFingerprint,
    existingFingerprint,
    oldRows,
    removedLines: sortedRemoved(removedLines),
    protectedFingerprints,
    collisionCount: collisions.length,
  })).digest("hex");
  return {
    sourceFile: AUG26_SOURCE_FILE,
    sourceSha256: parsed.sourceSha256,
    sourceBytes: parsed.sourceBytes,
    controls: parsed.controls,
    incomingFingerprint,
    existingFingerprint,
    previewHash,
    oldRows,
    removedLines,
    protectedFingerprints,
    collisions: collisions.length,
  };
}

export async function previewAug26Replacement(bytes: Buffer): Promise<Aug26Preview & {
  replacementId: string;
  expiresAt: string;
  confirmationReference: string;
}> {
  const client = await pool.connect() as unknown as Queryable & { release: () => void };
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('secondary_order_upload'))");
    await client.query("LOCK TABLE secondary_order_line IN SHARE ROW EXCLUSIVE MODE");
    const preview = await buildPreview(bytes, client);
    if (preview.oldRows !== 8602) throw new Error(`Expected 8,602 old rows, found ${preview.oldRows}.`);
    if (preview.collisions !== 0) throw new Error(`Found ${preview.collisions} prior-period order collisions.`);
    const replacementId = randomUUID();
    const expiresAt = new Date(Date.now() + PREVIEW_MINUTES * 60_000).toISOString();
    await client.query(
      `INSERT INTO secondary_order_replacement_run
       (replacement_id, source_file, source_sha256, source_bytes, preview_hash,
        source_era, source_kind, fiscal_year, period_completeness, controls,
        protected_before, protected_after, old_fingerprint, incoming_fingerprint,
        new_fingerprint, removed_lines, confirmation, reason, expires_at, status,
        entry_point, supersedes_note)
       VALUES
       ($1::uuid, $2, $3, $4, $5, 'product_wise_crm', 'product_wise', '2026-27',
        'complete', $6::jsonb, $7::jsonb, '{}'::jsonb, $8, $9, '',
        $10::jsonb, $11::jsonb, $12, $13::timestamptz, 'pending',
        'admin-raw-xlsx-preview-and-apply', 'Full-month export supersedes the 1-19 Aug 2026 partial export')`,
      [
        replacementId, preview.sourceFile, preview.sourceSha256, preview.sourceBytes,
        preview.previewHash, JSON.stringify(preview.controls),
        JSON.stringify(preview.protectedFingerprints), preview.existingFingerprint,
        preview.incomingFingerprint, JSON.stringify(preview.removedLines),
        JSON.stringify({ confirmedBy: "Prayag", confirmation: PRAYAG_CONFIRMATION }),
        AUG26_REASON, expiresAt,
      ],
    );
    await client.query("COMMIT");
    return { ...preview, replacementId, expiresAt, confirmationReference: PRAYAG_CONFIRMATION };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function resolveSalesUsers(client: Queryable, lines: Aug26Line[]): Promise<Map<string, number>> {
  const result = await client.query("SELECT person_id, name, employee_code FROM person ORDER BY person_id");
  type PersonEvidence = { personId: number; name: string; employeeCode: string | null };
  const people: PersonEvidence[] = result.rows.map((row) => ({
    personId: Number(row.person_id),
    name: String(row.name),
    employeeCode: row.employee_code == null ? null : String(row.employee_code).trim() || null,
  }));
  const byName = new Map<string, PersonEvidence[]>();
  const byCode = new Map<string, PersonEvidence[]>();
  for (const person of people) {
    const nameKey = normSecKey(person.name);
    byName.set(nameKey, [...(byName.get(nameKey) ?? []), person]);
    if (person.employeeCode) {
      byCode.set(person.employeeCode, [...(byCode.get(person.employeeCode) ?? []), person]);
    }
  }
  const resolved = new Map<string, number>();
  const identities = new Map<string, { name: string; employeeId: string | null }>();
  for (const line of lines) {
    if (!line.salesUserName) continue;
    identities.set(`${line.salesUserName}\0${line.employeeId ?? ""}`, {
      name: line.salesUserName,
      employeeId: line.employeeId,
    });
  }
  for (const identity of identities.values()) {
    const nameMatches = byName.get(normSecKey(identity.name)) ?? [];
    const codeMatches = identity.employeeId ? byCode.get(identity.employeeId) ?? [] : [];
    const intersection = nameMatches.filter((person) =>
      codeMatches.some((candidate) => candidate.personId === person.personId));
    let match: PersonEvidence | null = null;
    if (identity.employeeId && nameMatches.length === 1 && codeMatches.length > 0 && intersection.length === 0) {
      throw new Error(
        `Employee-code conflict for ${identity.name}: ${identity.employeeId} resolves to a different person.`,
      );
    }
    if (intersection.length === 1) match = intersection[0];
    else if (codeMatches.length === 0 && nameMatches.length === 1) match = nameMatches[0];
    if (match) resolved.set(`${identity.name}\0${identity.employeeId ?? ""}`, match.personId);
  }
  return resolved;
}

async function insertIncoming(client: Queryable, lines: Aug26Line[], sourceSha256: string): Promise<void> {
  const personIds = await resolveSalesUsers(client, lines);
  const exactSeen = new Set<string>();
  for (let offset = 0; offset < lines.length; offset += 500) {
    const records = lines.slice(offset, offset + 500).map((line) => {
      const sourceRecord = { ...line, orderDatetime: line.orderDatetime.toISOString() };
      const contentHash = createHash("sha256").update(JSON.stringify(sourceRecord)).digest("hex");
      const exactKey = JSON.stringify(sourceRecord);
      const isExactDuplicateExport = exactSeen.has(exactKey);
      exactSeen.add(exactKey);
      return {
        ...sourceRecord,
        salesUserId: line.salesUserName
          ? personIds.get(`${line.salesUserName}\0${line.employeeId ?? ""}`) ?? null
          : null,
        segmentCanon: canonGroupFromMap(line.categoryName ?? ""),
        contentHash,
        isExactDuplicateExport,
      };
    });
    await client.query(
      `INSERT INTO secondary_order_line
       (source_era, source_kind, fiscal_year, period_completeness, source_id,
        order_id, order_datetime, order_status, sales_user_name, sales_user_id,
        employee_id, reporting_manager, customer_name, dealer_id, dealer_mobile,
        cp_name, cp_code, state, district, city, pincode, category_name,
        segment_canon, product_code, gst_type, gst_pct, gst_amount, qty,
        discount_pct, discount_amount, dealer_order_value, basic_order_value,
        occurrence, source_row_number, content_hash, is_exact_duplicate_export,
        source_file)
       SELECT
        'product_wise_crm', 'product_wise', '2026-27', 'complete', $2,
        x."orderId", x."orderDatetime"::timestamptz, x."orderStatus",
        x."salesUserName", x."salesUserId", x."employeeId", x."reportingManager",
        x."customerName", x."dealerId", x."dealerMobile", x."cpName", x."cpCode",
        x.state, x.district, x.city, x.pincode, x."categoryName", x."segmentCanon",
        x."productCode", x."gstType", x."gstPct", x."gstAmount", x.qty,
        x."discountPct", x."discountAmount", x."dealerOrderValue",
        x."basicOrderValue", x.occurrence, x."sourceRowNumber", x."contentHash",
        x."isExactDuplicateExport", $3
       FROM jsonb_to_recordset($1::jsonb) AS x(
        "orderId" text, "productCode" text, "orderDatetime" text, "orderStatus" text,
        "salesUserName" text, "salesUserId" integer, "employeeId" text,
        "reportingManager" text, "customerName" text, "dealerId" text,
        "dealerMobile" text, "cpName" text, "cpCode" text, state text, district text,
        city text, pincode text, "categoryName" text, "segmentCanon" text,
        "gstType" text, "gstPct" numeric, "gstAmount" numeric, qty numeric,
        "discountPct" numeric, "discountAmount" numeric, "dealerOrderValue" numeric,
        "basicOrderValue" numeric, occurrence integer, "sourceRowNumber" integer,
        "contentHash" text, "isExactDuplicateExport" boolean
       )`,
      [JSON.stringify(records), sourceSha256, AUG26_SOURCE_FILE],
    );
  }
}

async function controlsFromDatabase(client: Queryable): Promise<Aug26Controls> {
  const result = await client.query(
    `WITH scoped AS (
       SELECT *, substring(order_id from 6)::integer AS order_number
       FROM secondary_order_line
       WHERE source_era = 'product_wise_crm' AND source_kind = 'product_wise'
         AND fiscal_year = '2026-27' AND order_datetime >= $1::timestamptz AND order_datetime < $2::timestamptz
     )
     SELECT
       count(*)::integer AS rows,
       count(DISTINCT order_id)::integer AS orders,
       count(DISTINCT dealer_id)::integer AS retailers,
       count(DISTINCT cp_code)::integer AS cps,
       count(DISTINCT product_code)::integer AS products,
       sum(qty)::text AS qty,
       sum(basic_order_value)::text AS basic,
       round(sum(dealer_order_value), 2)::text AS dealer,
       count(*) FILTER (WHERE order_status = 'APPROVED')::integer AS approved,
       count(*) FILTER (WHERE order_status = 'PENDING')::integer AS pending,
       min((order_datetime AT TIME ZONE 'Asia/Kolkata')::date)::text AS date_min,
       max((order_datetime AT TIME ZONE 'Asia/Kolkata')::date)::text AS date_max,
       count(DISTINCT order_id) FILTER (WHERE order_number BETWEEN 9 AND 2484)::integer AS low_orders,
       min(order_number) FILTER (WHERE order_number BETWEEN 9 AND 2484)::integer AS low_min,
       max(order_number) FILTER (WHERE order_number BETWEEN 9 AND 2484)::integer AS low_max,
       count(DISTINCT order_id) FILTER (WHERE order_number BETWEEN 160217 AND 161781)::integer AS high_orders,
       min(order_number) FILTER (WHERE order_number BETWEEN 160217 AND 161781)::integer AS high_min,
       max(order_number) FILTER (WHERE order_number BETWEEN 160217 AND 161781)::integer AS high_max
     FROM scoped`,
    [AUG_START, SEP_START],
  );
  const row = result.rows[0];
  return {
    rows: Number(row.rows), orders: Number(row.orders), retailers: Number(row.retailers),
    cps: Number(row.cps), products: Number(row.products), qty: Number(row.qty),
    basic: Number(row.basic), dealer: Number(row.dealer), approved: Number(row.approved),
    pending: Number(row.pending), dateMin: String(row.date_min), dateMax: String(row.date_max),
    lowOrders: Number(row.low_orders), lowMin: Number(row.low_min), lowMax: Number(row.low_max),
    highOrders: Number(row.high_orders), highMin: Number(row.high_min), highMax: Number(row.high_max),
  };
}

export async function applyAug26Replacement(
  bytes: Buffer,
  replacementId: string,
  previewHash: string,
  operatorId: string,
  confirmations: RemovalConfirmation[],
): Promise<Aug26Preview & {
  replacementId: string;
  archivedRows: number;
  writtenControls: Aug26Controls;
  newDatabaseFingerprint: string;
}> {
  const client = await pool.connect() as unknown as Queryable & { release: () => void };
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('secondary_order_upload'))");
    await client.query("LOCK TABLE secondary_order_line IN SHARE ROW EXCLUSIVE MODE");
    const pending = await client.query(
      `SELECT source_sha256, source_bytes, preview_hash, old_fingerprint,
              incoming_fingerprint, protected_before, removed_lines
       FROM secondary_order_replacement_run
       WHERE replacement_id = $1::uuid AND status = 'pending' AND expires_at > now()
       FOR UPDATE`,
      [replacementId],
    );
    if (pending.rowCount !== 1) throw new Error("Replacement preview is missing, expired, or already applied.");
    const preview = await buildPreview(bytes, client);
    const evidence = pending.rows[0];
    if (
      preview.previewHash !== previewHash ||
      evidence.preview_hash !== previewHash ||
      evidence.source_sha256 !== preview.sourceSha256 ||
      Number(evidence.source_bytes) !== preview.sourceBytes ||
      evidence.old_fingerprint !== preview.existingFingerprint ||
      evidence.incoming_fingerprint !== preview.incomingFingerprint ||
      !protectedFingerprintsEqual(
        evidence.protected_before as Record<string, string>,
        preview.protectedFingerprints,
      )
    ) {
      throw new Error("Preview is stale or does not match the exact workbook and protected baselines.");
    }
    if (preview.oldRows !== 8602) throw new Error(`Expected 8,602 old rows, found ${preview.oldRows}.`);
    if (preview.collisions !== 0) throw new Error(`Found ${preview.collisions} prior-period order collisions.`);
    assertRemovalConfirmations(preview.removedLines, confirmations);
    const parsed = await parseAug26Replacement(bytes);
    const collisions = await findCollisions(client, parsed.lines);
    if (collisions.length !== 0) throw new Error(`Collision check failed immediately before write: ${collisions.length} rows.`);

    await client.query(
      `INSERT INTO secondary_order_line_archive (replacement_id, original_id, reason, old_row)
       SELECT $1::uuid, id, $2, to_jsonb(s)
       FROM secondary_order_line s
       WHERE source_era = 'product_wise_crm' AND source_kind = 'product_wise'
         AND fiscal_year = '2026-27' AND order_datetime >= $3::timestamptz AND order_datetime < $4::timestamptz`,
      [replacementId, AUG26_REASON, AUG_START, SEP_START],
    );
    const archived = await client.query(
      "SELECT count(*)::integer AS count FROM secondary_order_line_archive WHERE replacement_id = $1::uuid",
      [replacementId],
    );
    const archivedRows = Number(archived.rows[0]?.count);
    if (archivedRows !== 8602) throw new Error(`Archive-before-delete invariant failed: archived ${archivedRows}.`);

    const deleted = await client.query(
      `DELETE FROM secondary_order_line
       WHERE source_era = 'product_wise_crm' AND source_kind = 'product_wise'
         AND fiscal_year = '2026-27' AND order_datetime >= $1::timestamptz AND order_datetime < $2::timestamptz`,
      [AUG_START, SEP_START],
    );
    if (deleted.rowCount !== 8602) throw new Error(`Expected to delete 8,602 rows, deleted ${deleted.rowCount ?? 0}.`);
    await insertIncoming(client, parsed.lines, parsed.sourceSha256);
    const writtenControls = await controlsFromDatabase(client);
    assertExpectedControls(writtenControls);
    const newDatabaseFingerprint = await fingerprint(client,
      `SELECT * FROM secondary_order_line
       WHERE source_era = 'product_wise_crm' AND source_kind = 'product_wise'
         AND fiscal_year = '2026-27' AND order_datetime >= $1::timestamptz AND order_datetime < $2::timestamptz`,
      [AUG_START, SEP_START]);
    const protectedAfter = await protectedSet(client);
    if (!protectedFingerprintsEqual(protectedAfter, preview.protectedFingerprints)) {
      throw new Error("A protected dataset changed; the replacement transaction was rolled back.");
    }
    const updated = await client.query(
      `UPDATE secondary_order_replacement_run
       SET status = 'complete', applied_at = now(), operator_id = $2,
           protected_after = $3::jsonb, new_fingerprint = $4,
           confirmation = $5::jsonb, source_timestamp = now()
       WHERE replacement_id = $1::uuid AND status = 'pending'`,
      [
        replacementId, operatorId, JSON.stringify(protectedAfter), newDatabaseFingerprint,
        JSON.stringify({
          confirmedBy: "Prayag",
          confirmation: PRAYAG_CONFIRMATION,
          removedLines: confirmations,
        }),
      ],
    );
    if (updated.rowCount !== 1) throw new Error("Replacement lineage completion failed.");
    await client.query("COMMIT");
    return { replacementId, ...preview, archivedRows, writtenControls, newDatabaseFingerprint };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}