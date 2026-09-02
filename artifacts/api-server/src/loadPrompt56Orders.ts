/**
 * Prompt 56 order-booking backfill.  Default mode is read-only.  `--write` is
 * intentionally the only way to change the database.
 */
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import unzipper from "unzipper";
import { pool, runMigrations } from "@workspace/db";
import { readTabRowsChunked, type SheetCellValue } from "./lib/registers/sheetsApi.js";
import { assertSegmentWiseDateSignature } from "./lib/mgmt/names.js";
import { isPrompt56AugustDate, literalProductOrderDatetime, parseLegacyV1Rows, type LegacyOrderLine } from "./lib/secondaryOrders/legacyV1Parser.js";

const SHEET_ID = "1aNQ2TczEMHcSeB26yKoKayiq1CWc4dXdTQORrgxdl80";
const TAB = "Data Sheet";
const PRODUCT_PREFIX = "Product-Wise-Secondary-Order-Report_";
const APR_JUN_DROP = new Set(["SANTOSH KUMAR KV","Ravindera","AJOY BORAH","SASIKUMAR A","OP KALRA","Ilesh Vyash","SUMIT PAREEK","Test","HARDEEP KHINDA","AMIT HARIDASJI BELONKAR","SANDEEP DADHEECH","L.SELVAGANAPATHY","MANOKARAN","KANISH KHANNA","KAPIL THAKUR","SUKANTA SEN","RAVI KANT MAHATO"]);
const JUL_DROP = new Set(["AJOY BORAH","ASHUTOSH KUAMR","O.P. KALRA","SUMIT PAREEK","SASIKUMAR A","AMIT HARIDASJI BELONKAR","ILESH VYAS","HARDEEP KHINDA","SANDEEP DADHEECH","L.SELVAGANAPATHY","MANOKARAN","KANISH KHANNA","KAPIL THAKUR","RAVI KANT MAHATO"]);
const EXPECTED = {
  // The Sheet API exposes 379,441 physical rows; two are non-line rows, so
  // 379,439 lines are parsed and retained as separate lineage measures.
  segment: { rows: 379439, physicalRows: 379441, orders: 52515, value: 2310913869 },
  Apr: { rows: 21613, orders: 3156, value: 131087397 },
  May: { rows: 31266, orders: 4493, value: 210078126 },
  Jun: { rows: 36300, orders: 5462, value: 249037679 },
  Jul: { rows: 34147, orders: 4840, value: 223436806 },
  AprJul: { rows: 123326, orders: 17951, value: 813640008 },
  Aug: { rows: 8602, orders: 1361, value: 56403177 },
};
type P56Line = LegacyOrderLine & { era: "legacy_crm" | "product_wise_crm"; kind: "segment_wise" | "pscode3" | "product_wise"; completeness: "complete" | "partial"; sourceFile: string; sourceId: string; sourceSha256: string; sourceBytes: number; status: string | null; cpCode: string | null; occurrence: number; hash: string };
const num = (v: unknown) => { const s = String(v ?? "").replace(/[₹,\s]/g, ""); return s ? (Number.isFinite(Number(s)) ? Number(s) : null) : null; };
const txt = (v: unknown) => String(v ?? "").trim();
const fy = (d: Date) => `${d.getUTCFullYear() - (d.getUTCMonth() < 3 ? 1 : 0)}-${String((d.getUTCFullYear() - (d.getUTCMonth() < 3 ? 1 : 0) + 1) % 100).padStart(2, "0")}`;
const summary = (rows: P56Line[]) => ({ rows: rows.length, orders: new Set(rows.map(r => r.orderId)).size, value: rows.reduce((a, r) => a + (r.basicOrderValue ?? 0), 0) });
function control(name: string, actual: ReturnType<typeof summary>, expected: { rows: number; orders: number; value: number }) {
  const bad = actual.rows !== expected.rows || actual.orders !== expected.orders || Math.round(actual.value) !== expected.value;
  return { name, expected, actual, pass: !bad };
}
function enrich(lines: LegacyOrderLine[], kind: P56Line["kind"], sourceFile: string, sourceId: string, completeness: P56Line["completeness"], sourceSha256: string, sourceBytes: number): P56Line[] {
  const occurrence = new Map<string, number>();
  return lines.map((r) => {
    const k = `${r.orderId}\0${r.productCode}`; const n = (occurrence.get(k) ?? 0) + 1; occurrence.set(k, n);
    return { ...r, era: "legacy_crm", kind, completeness, sourceFile, sourceId, sourceSha256, sourceBytes, status: null, cpCode: null, occurrence: n, hash: createHash("sha256").update(JSON.stringify(r)).digest("hex") };
  });
}
async function sheetLines() {
  const rows: SheetCellValue[][] = [];
  await readTabRowsChunked(SHEET_ID, TAB, (batch) => rows.push(...batch));
  const parsed = parseLegacyV1Rows(rows, { kind: "column" });
  assertSegmentWiseDateSignature("2025-26", parsed.signature);
  const raw = JSON.stringify(rows);
  const out = enrich(parsed.lines, "segment_wise", `google-sheet:${SHEET_ID}/${TAB}`, SHEET_ID, "complete", createHash("sha256").update(raw).digest("hex"), Buffer.byteLength(raw));
  // Sheets reports physical rows; the parser excludes the header plus the one
  // non-line row. Keep both measurements in the report rather than conflating them.
  return { rowsRead: rows.length, lines: out };
}
async function xlsxRows(buffer: Buffer): Promise<SheetCellValue[][]> {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as never);
  const ws = wb.worksheets[0]; if (!ws) throw new Error("archive workbook has no worksheet");
  const rows: SheetCellValue[][] = [];
  ws.eachRow({ includeEmpty: true }, row => rows.push((row.values as unknown[]).slice(1) as SheetCellValue[]));
  return rows;
}
function member(filename: string) { return filename.replace(/^PSCode_3_New_Report /, "").replace(/\.xlsx$/i, "").trim(); }
async function archiveLines(zipPath: string, drop: Set<string>) {
  if (!existsSync(zipPath)) throw new Error(`PSCode archive not found: ${zipPath}`);
  const zip = await unzipper.Open.file(zipPath); const lines: P56Line[] = [];
  for (const entry of zip.files.filter(f => /PSCode_3_New_Report .*\.xlsx$/i.test(f.path))) {
    const name = basename(entry.path); if (drop.has(member(name))) continue;
    const content = await entry.buffer();
    const parsed = parseLegacyV1Rows(await xlsxRows(content), { kind: "filename", teamMember: member(name) });
    lines.push(...enrich(parsed.lines, "pscode3", name, `archive:${basename(zipPath)}:${name}`, "complete", createHash("sha256").update(content).digest("hex"), content.byteLength));
  }
  // Occurrence is source-wide, not file-wide.
  const seen = new Map<string, number>(); for (const r of lines) { const k = `${r.orderId}\0${r.productCode}`; r.occurrence = (seen.get(k) ?? 0) + 1; seen.set(k, r.occurrence); }
  return lines;
}
async function productLines(file: string): Promise<P56Line[]> {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file); const ws = wb.worksheets[0]; if (!ws) throw new Error("Product-Wise workbook has no worksheet");
  const productBytes = readFileSync(file);
  const sourceSha256 = createHash("sha256").update(productBytes).digest("hex");
  const lines: P56Line[] = []; const occurrence = new Map<string, number>();
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const c = (i: number) => row.getCell(i).value; const date = literalProductOrderDatetime(c(1));
    const orderId = txt(c(2)), productCode = txt(c(14)), dealerId = txt(c(5));
    if (!date || !orderId || !productCode || !dealerId) return;
    if (!isPrompt56AugustDate(date)) {
      throw new Error(`Product-Wise row ${rowNumber} is outside the literal 01-19 Aug 2026 IST boundary`);
    }
    const key = `${orderId}\0${productCode}`, occ = (occurrence.get(key) ?? 0) + 1; occurrence.set(key, occ);
    const basicOrderValue = num(c(21));
    lines.push({ orderId, productCode, orderDatetime: date, fiscalYear: fy(date), salesUserName: txt(c(3)) || null, customerName: txt(c(4)) || null, dealerId, cpName: txt(c(7)) || null, categoryName: txt(c(13)) || null, qty: num(c(17)), basicOrderValue, sourceRowNumber: rowNumber, era: "product_wise_crm", kind: "product_wise", completeness: "partial", sourceFile: basename(file), sourceId: basename(file), sourceSha256, sourceBytes: productBytes.byteLength, status: txt(c(22)) || null, cpCode: txt(c(8)) || null, occurrence: occ, hash: createHash("sha256").update(JSON.stringify(row.values)).digest("hex") });
  });
  return lines;
}
async function protectedCounts() {
  const q = await pool.query<{ sku: string; register: string; sale: string }>(`SELECT (SELECT count(*) FROM secondary_sku_line)::text sku,(SELECT count(*) FROM secondary_register_line)::text register,(SELECT count(*) FROM sale_line_all)::text sale`);
  return q.rows[0];
}
async function protectedCountsInTransaction(client: { query: (...args: any[]) => Promise<any> }) {
  const q = await client.query(`SELECT (SELECT count(*) FROM secondary_sku_line)::text sku,(SELECT count(*) FROM secondary_register_line)::text register,(SELECT count(*) FROM sale_line_all)::text sale`);
  return q.rows[0] as { sku: string; register: string; sale: string };
}
function intersections(a: P56Line[], b: P56Line[]) {
  const order = new Set(a.map(x => x.orderId)), pair = new Set(a.map(x => `${x.orderId}\0${x.productCode}`));
  return { orders: new Set(b.filter(x => order.has(x.orderId)).map(x => x.orderId)).size, orderProducts: new Set(b.filter(x => pair.has(`${x.orderId}\0${x.productCode}`)).map(x => `${x.orderId}\0${x.productCode}`)).size };
}
async function skuReconcile(rows: P56Line[]) {
  const result: Record<string, { incoming: number; sku: number; difference: number }> = {};
  for (const month of ["Apr","May","Jun","Jul"]) {
    const incoming = rows.filter(r => r.orderDatetime.getUTCMonth() === ["Apr","May","Jun","Jul"].indexOf(month) + 3).reduce((n, r) => n + (r.basicOrderValue ?? 0), 0);
    const db = await pool.query<{ value: string | null }>(`SELECT sum(net_amount)::text value FROM secondary_sku_line WHERE fy='2026-27' AND month_label=$1`, [`${month}-26`]);
    const sku = Number(db.rows[0]?.value ?? 0); result[month] = { incoming, sku, difference: Math.round(incoming - sku) };
  } return result;
}
async function write(lines: P56Line[]) {
  const client = await pool.connect(); try {
    await client.query("BEGIN");
    const before = await protectedCountsInTransaction(client);
    await client.query(`DELETE FROM secondary_order_line WHERE (source_kind='segment_wise' AND fiscal_year='2025-26') OR (source_kind='pscode3' AND fiscal_year='2026-27') OR (source_kind='product_wise' AND fiscal_year='2026-27')`);
    for (const r of lines) await client.query(`INSERT INTO secondary_order_line (source_era,source_kind,fiscal_year,period_completeness,source_id,order_id,order_datetime,order_status,sales_user_name,customer_name,dealer_id,cp_name,cp_code,category_name,product_code,occurrence,source_row_number,content_hash,qty,basic_order_value,source_file) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`, [r.era,r.kind,r.fiscalYear,r.completeness,r.sourceId,r.orderId,r.orderDatetime,r.status,r.salesUserName,r.customerName,r.dealerId,r.cpName,r.cpCode,r.categoryName,r.productCode,r.occurrence,r.sourceRowNumber,r.hash,r.qty,r.basicOrderValue,r.sourceFile]);
    for (const source of new Map(lines.map(r => [r.sourceId, r])).values()) await client.query(`INSERT INTO secondary_order_upload (source_file,source_id,entry_point,source_sha256,source_bytes,verification,comparison,assessment,material_reasons,analytics_status) VALUES ($1,$2,'load-prompt56-orders',$3,$4,'{}','{}','PROMPT56_LOADED',ARRAY[]::text[],'ISOLATED_PENDING_RELIABILITY')`, [source.sourceFile,source.sourceId,source.sourceSha256,source.sourceBytes]);
    const after = await protectedCountsInTransaction(client);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`protected-table count changed inside Prompt 56 transaction: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    }
    await client.query("COMMIT");
    return { before, after };
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
async function main() {
  if (process.argv.includes("--write")) await runMigrations();
  const root = resolve(process.cwd(), "../../attached_assets");
  const aprZip = process.env.PROMPT56_APR_JUN_ZIP ?? resolve(root, "PSCODE_3_NEW_REPORT_1785584202460.zip");
  const julZip = process.env.PROMPT56_JUL_ZIP ?? resolve(root, "PSCode_3_NEW_REPORTS_JULY2026-20260805T074609Z-1-001_1785917168364.zip");
  const product = process.env.SOL_XLSX ?? resolve(root, "Product-Wise-Secondary-Order-Report_29_6569_19-Aug-2026_1787135138176.xlsx");
  const before = await protectedCounts(); const segment = await sheetLines(); const aprJun = await archiveLines(aprZip, APR_JUN_DROP); const jul = await archiveLines(julZip, JUL_DROP); const aug = await productLines(product);
  const months = Object.fromEntries(["Apr","May","Jun","Jul"].map(m => [m, control(m, summary([...aprJun, ...jul].filter(x => x.orderDatetime.getUTCMonth() === ["Apr","May","Jun","Jul"].indexOf(m) + 3)), EXPECTED[m as "Apr"])]));
  const b3 = intersections(segment.lines, [...aprJun, ...jul]); const reconciliation = await skuReconcile([...aprJun, ...jul]);
  const controls = [control("FY2025-26 Segment Wise", summary(segment.lines), EXPECTED.segment), ...Object.values(months), control("Apr-Jul PSCode 3", summary([...aprJun, ...jul]), EXPECTED.AprJul), control("Aug 1-19 Product-Wise", summary(aug), EXPECTED.Aug)];
  const physicalRowsPass = segment.rowsRead === EXPECTED.segment.physicalRows;
  const pass = physicalRowsPass && controls.every(c => c.pass) && b3.orders === 0 && b3.orderProducts === 0 && Object.values(reconciliation).every(x => x.difference === 0);
  const lineage = [...new Map([...segment.lines, ...aprJun, ...jul, ...aug].map(r => [r.sourceId, {
    sourceId: r.sourceId, sourceFile: r.sourceFile, sourceKind: r.kind,
    sha256: r.sourceSha256, bytes: r.sourceBytes, entryPoint: "load-prompt56-orders",
  }])).values()];
  const report: any = { entryPoint: "load-prompt56-orders", dryRun: !process.argv.includes("--write"), sources: { segment: { sourceId: SHEET_ID, physicalRows: segment.rowsRead, expectedPhysicalRows: EXPECTED.segment.physicalRows, physicalRowsPass, parsedLines: segment.lines.length, expectedParsedLines: EXPECTED.segment.rows }, aprJunZip: basename(aprZip), julZip: basename(julZip), product: basename(product) }, lineage, controls, b3, reconciliation, protectedCounts: { before }, augustCanary: { expectedFailure: true, reason: "8,602 rows is intentionally below the existing 19,417 full-month SKU floor; no guard was changed." }, pass };
  if (!pass) { console.log(JSON.stringify(report, null, 2)); throw new Error("Prompt 56 controls failed; refusing to write"); }
  if (process.argv.includes("--write")) {
    const transactionalCounts = await write([...segment.lines, ...aprJun, ...jul, ...aug]);
    report.protectedCounts = { before, transactional: transactionalCounts };
  }
  console.log(JSON.stringify(report, null, 2)); await pool.end();
}
main().catch(async e => { console.error(e); await pool.end(); process.exit(1); });