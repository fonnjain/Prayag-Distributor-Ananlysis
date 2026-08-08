// One-shot idempotent loader for Distributer_Upload_Sample_File.csv and
// Retailer_Upload_Sample_file.csv into the EXISTING customer_master table plus
// the retailer_user / retailer_distributor junction tables.
//
// ONE loader, type parameter ("distributor" | "retailer") for both files.
//
// Run (bundled with esbuild, then node):
//   node --enable-source-maps <bundled>.mjs
//
// Encoding is cp1252, NOT UTF-8. CSV is parsed with a real RFC-4180 quote-aware
// state machine that handles embedded newlines and quoted commas. The
// multi-value "Assign User" / "Assign Distributor Name" cells are split with a
// second quote-aware comma splitter.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "@workspace/db";
import { normSecKey } from "../mgmt/names.js";
import { normDistKey } from "../mgmt/distributorDeepDive.js";

// ── paths ────────────────────────────────────────────────────────────────────
// The workspace/deployment cwd varies (repo root in production, artifact dir in
// dev CLI runs), so probe both. Uploaded files carry changing timestamp
// suffixes — always resolve the LATEST file matching the stable prefix.
import { readdirSync, existsSync } from "node:fs";
function attachedDir(): string {
  for (const cand of [
    path.resolve(process.cwd(), "attached_assets"),
    path.resolve(process.cwd(), "../../attached_assets"),
  ]) {
    if (existsSync(cand)) return cand;
  }
  throw new Error("attached_assets directory not found from cwd " + process.cwd());
}
export function latestAttached(prefix: string): string {
  const dir = attachedDir();
  const matches = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".csv")).sort();
  if (matches.length === 0) throw new Error(`no file matching ${prefix}*.csv in ${dir}`);
  return path.join(dir, matches[matches.length - 1]);
}
function rosterPath(): string {
  for (const cand of [
    path.resolve(process.cwd(), "config/hr_roster.csv"),
    path.resolve(process.cwd(), "artifacts/api-server/config/hr_roster.csv"),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return latestAttached("Sales_User_List_");
}

// Structural expectations. Parsing must produce EXACTLY these — anything else
// (e.g. 3,390 / 79,547 from newline-splitting) means the parser is broken and
// we must abort before deleting anything.
const DIST_EXPECT = {
  columns: 32,
  rows: 3316,
  required: ["Id", "Company Name", "Customer Type", "Status", "State Name", "District"],
};
const RET_EXPECT = {
  columns: 44,
  rows: 76678,
  required: ["Id", "Company Name", "Status", "Lead Status", "State Name", "District", "Assign User", "Assign Distributor Name"],
};

// ── cp1252 decode ──────────────────────────────────────────────────────────────
function decodeCp1252(buf: Buffer): string {
  return new TextDecoder("windows-1252").decode(buf);
}

// ── RFC-4180 quote-aware CSV parser (handles embedded newlines) ────────────────
// Returns, for each field, BOTH the unquoted value and the RAW field text
// (with surrounding/embedded quotes preserved). The raw text is what a
// quote-aware multi-value splitter must run against: the "Assign Distributor
// Name" cell embeds individually-quoted values whose commas are part of the
// name, e.g. "Chhinamastike Sanitation Pvt. Ltd. ( Previously Balajee Ent.,
// Deoghar)". If we split the already-unquoted value we fragment that name.
interface CsvRow { values: string[]; raw: string[]; }
function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let field = "";
  let rawField = "";
  let values: string[] = [];
  let raws: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const pushField = () => { values.push(field); raws.push(rawField); field = ""; rawField = ""; };
  const pushRow = () => { pushField(); rows.push({ values, raw: raws }); values = []; raws = []; };
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; rawField += '""'; i += 2; continue; }
        inQuotes = false; rawField += '"'; i++; continue;
      }
      field += c; rawField += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; rawField += '"'; i++; continue; }
    if (c === ",") { pushField(); i++; continue; }
    if (c === "\r") { if (text[i + 1] === "\n") i++; pushRow(); i++; continue; }
    if (c === "\n") { pushRow(); i++; continue; }
    field += c; rawField += c; i++;
  }
  if (field !== "" || rawField !== "" || values.length > 0) pushRow();
  return rows;
}

// ── quote-aware comma split for multi-value cells ──────────────────────────────
// Runs against the CSV-unwrapped cell value. Values are comma-separated, but a
// single name may itself contain a comma inside a parenthetical or a quoted
// segment, e.g. "Chhinamastike Sanitation Pvt. Ltd. ( Previously Balajee Ent.,
// Deoghar)". A naive comma split fragments that name; we protect commas that
// fall inside () [] or a "..." run so the name survives as ONE value.
function splitMultiValue(cell: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;       // parenthesis / bracket nesting
  let inQuotes = false;
  for (let i = 0; i < cell.length; i++) {
    const c = cell[i];
    if (c === '"') {
      if (inQuotes && cell[i + 1] === '"') { cur += '""'; i++; continue; }
      inQuotes = !inQuotes; cur += c; continue;
    }
    if (!inQuotes && (c === "(" || c === "[")) { depth++; cur += c; continue; }
    if (!inQuotes && (c === ")" || c === "]")) { if (depth > 0) depth--; cur += c; continue; }
    if (c === "," && depth === 0 && !inQuotes) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out
    .map((v) => v.replace(/^"(.*)"$/, "$1").replace(/""/g, '"').trim())
    .filter((v) => v.length > 0);
}

const s = (v: string | undefined): string | null => {
  if (v == null) return null;
  const t = v.trim();
  return t === "" ? null : t;
};

interface HeaderIndex { [key: string]: number; }
function headerIndex(header: string[]): HeaderIndex {
  const idx: HeaderIndex = {};
  header.forEach((h, i) => { idx[h.trim()] = i; });
  return idx;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── load HR roster names (for user resolution) ─────────────────────────────────
function loadRosterNormKeys(): Set<string> {
  const srcPath = rosterPath();
  const buf = readFileSync(srcPath);
  const src = srcPath;
  const rows = parseCsv(decodeCp1252(buf));
  const header = rows[0].values;
  const idx = headerIndex(header);
  const nameCol = idx["Name"];
  const keys = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const nm = rows[r].values[nameCol];
    if (nm && nm.trim()) keys.add(normSecKey(nm.trim()));
  }
  console.log(`[roster] loaded ${keys.size} distinct user norm keys from ${path.basename(src)}`);
  return keys;
}

// Parse a file, verify its header carries every required column and that the
// column/data-row counts match expectation EXACTLY. Throws (aborting the load
// before any DB mutation) on any mismatch.
function parseAndValidate(
  label: string,
  filePath: string,
  expect: { columns: number; rows: number; required: string[] },
): { header: string[]; idx: HeaderIndex; data: CsvRow[] } {
  const rows = parseCsv(decodeCp1252(readFileSync(filePath)));
  if (rows.length === 0) throw new Error(`[${label}] file is empty: ${filePath}`);
  const header = rows[0].values;
  const idx = headerIndex(header);

  const missing = expect.required.filter((c) => !(c in idx));
  if (missing.length > 0) {
    throw new Error(`[${label}] missing required column(s): ${missing.join(", ")}`);
  }
  if (header.length !== expect.columns) {
    throw new Error(`[${label}] expected ${expect.columns} columns, got ${header.length}`);
  }

  const data = rows.slice(1)
    .filter((row) => row.values.length > 1 && (row.values[idx["Id"]] ?? "").trim() !== "");
  if (data.length !== expect.rows) {
    throw new Error(
      `[${label}] expected ${expect.rows} data rows, got ${data.length} ` +
      `(a wrong count means the CSV parser split on embedded newlines — refusing to load).`,
    );
  }
  console.log(`[${label}] validated: columns=${header.length} data rows=${data.length}`);
  return { header, idx, data };
}

export interface CustomerLoadResult { dryRun: boolean; customerMaster: number; retailerUser: number; retailerDistributor: number; }
export async function runCustomerUploadLoad(opts: { dryRun: boolean; endPool?: boolean }): Promise<CustomerLoadResult> {
  const DRY_RUN = opts.dryRun;
  const DIST_CSV = latestAttached("Distributer_Upload_Sample_File_");
  const RET_CSV = latestAttached("Retailer_Upload_Sample_file_");
  console.log(`[files] dist=${DIST_CSV} ret=${RET_CSV}`);
  console.log(`=== customer-upload-load START${DRY_RUN ? " (DRY RUN)" : ""} ===`);

  // ── PHASE 1: parse + validate BOTH files fully in memory. On ANY failure we
  // throw here — BEFORE touching the DB — so a malformed file can never leave
  // the production master empty. ──────────────────────────────────────────────
  const dist = parseAndValidate("distributor", DIST_CSV, DIST_EXPECT);
  const di = dist.idx;
  const distData = dist.data.map((row) => row.values);

  // Build distributor master registry for retailer→distributor resolution:
  // map normDistKey(companyName) → DIST# id (first wins).
  const distByNormKey = new Map<string, string>();

  interface CMRow {
    id: string; company: string; type: string; status: string;
    contact: string | null; mobile: string | null; state: string | null;
    district: string | null; city: string | null; gst: string | null;
    pincode: string | null; area: string | null; email: string | null;
    address: string | null; leadStatus: string | null; statusSource: string | null;
    entityType: string | null; assignedSegment: string | null;
    createdDate: string | null; createdBy: string | null; sourceFile: string;
  }
  const cmRows: CMRow[] = [];

  for (const r of distData) {
    const id = r[di["Id"]].trim();
    const rawStatus = s(r[di["Status"]]);
    const company = (r[di["Company Name"]] ?? "").trim() || id;
    const nk = normDistKey(company);
    if (!distByNormKey.has(nk)) distByNormKey.set(nk, id);
    cmRows.push({
      id,
      company,
      type: "Distributor",
      status: rawStatus ?? "Pending",       // raw as-is (Approved/Pending)
      statusSource: rawStatus,
      contact: s(r[di["Contact Person 1"]]),
      mobile: s(r[di["Contact Number 1"]]),
      state: s(r[di["State Name"]]),
      district: s(r[di["District"]]),
      city: s(r[di["City"]]),
      gst: s(r[di["GST"]]),
      pincode: s(r[di["Pincode"]]),
      area: s(r[di["Area"]]),
      email: s(r[di["Email Address"]]),
      address: s(r[di["Address"]]),
      leadStatus: null,
      entityType: s(r[di["Customer Type"]]),  // Distributors / Direct Dealers
      assignedSegment: s(r[di["Assigned Segment"]]),
      createdDate: s(r[di["Date Created"]]),
      createdBy: s(r[di["Created By"]]),
      sourceFile: "distributor",
    });
  }

  // ── DEDUP ADJUDICATION: 152 groups / 339 rows. Assign review_group ONLY to
  // the same-state + same-district + different-phone groups. Never merge.
  // Name grouping key = lowercase alphanumerics only (matches the spec's
  // 152-group / 339-row census exactly).
  const norm = (v: string | null) => (v ?? "").trim().toUpperCase();
  const nameGroupKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const groups = new Map<string, CMRow[]>();
  for (const row of cmRows) {
    const key = nameGroupKey(row.company);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const reviewGroupOf = new Map<string, number>(); // id -> group number
  let dupGroups = 0, dupRows = 0;
  let gDiffState = 0, gDiffDistrict = 0, gDiffGst = 0, gReview = 0;
  let reviewGroupNo = 0;
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    dupGroups++; dupRows += list.length;
    const states = new Set(list.map((x) => norm(x.state)));
    const districts = new Set(list.map((x) => norm(x.district)));
    const gsts = new Set(list.map((x) => norm(x.gst)).filter((x) => x !== ""));
    const phones = new Set(list.map((x) => norm(x.mobile)).filter((x) => x !== ""));
    if (states.size > 1) { gDiffState++; continue; }            // distinct firms
    if (districts.size > 1) { gDiffDistrict++; continue; }        // distinct firms
    if (gsts.size > 1) { gDiffGst++; continue; }                  // distinct firms
    // same state + same district + different phone → NEEDS REVIEW
    if (phones.size > 1) {
      gReview++; reviewGroupNo++;
      for (const x of list) reviewGroupOf.set(x.id, reviewGroupNo);
    }
  }
  console.log(`[dedup] groups=${dupGroups} rows=${dupRows} | diffState=${gDiffState} diffDistrict=${gDiffDistrict} diffGst=${gDiffGst} review=${gReview}`);

  // ── RETAILER FILE ──────────────────────────────────────────────────────────────
  const ret = parseAndValidate("retailer", RET_CSV, RET_EXPECT);
  const ri = ret.idx;
  const retData = ret.data;

  interface JU { retailerId: string; userName: string; userNormKey: string; position: number; resolved: boolean; }
  interface JD { retailerId: string; distributorName: string; distNormKey: string; position: number; resolved: boolean; resolvedDistId: string | null; }
  const juBatch: JU[] = [];
  const jdBatch: JD[] = [];
  const rosterKeys = loadRosterNormKeys();

  for (const row of retData) {
    const r = row.values;
    const id = r[ri["Id"]].trim();
    const rawStatus = s(r[ri["Status"]]);          // Lead / Inactive / Active
    const rawLead = s(r[ri["Lead Status"]]);        // Pending / Approved
    const company = (r[ri["Company Name"]] ?? "").trim() || id;
    cmRows.push({
      id,
      company,
      type: "Retailer",
      status: rawStatus ?? "Lead",                  // raw as-is
      statusSource: rawStatus,
      contact: s(r[ri["Contact Person 1"]]),
      mobile: s(r[ri["Contact Number 1"]]),
      state: s(r[ri["State Name"]]),
      district: s(r[ri["District"]]),
      city: s(r[ri["City"]]),
      gst: s(r[ri["GST"]]),
      pincode: s(r[ri["Pincode"]]),
      area: s(r[ri["Area"]]),
      email: s(r[ri["Email Address"]]),
      address: s(r[ri["Address"]]),
      leadStatus: rawLead,
      entityType: null,
      assignedSegment: s(r[ri["Assigned Segment"]]),
      createdDate: s(r[ri["Date Created"]]),
      createdBy: s(r[ri["Created By"]]),
      sourceFile: "retailer",
    });

    // multi-value Assign User → retailer_user (paren/quote-aware comma split)
    const userCell = s(r[ri["Assign User"]]);
    if (userCell) {
      const parts = splitMultiValue(userCell);
      const seen = new Set<string>();
      let pos = 0;
      for (const p of parts) {
        const nk = normSecKey(p);
        if (!nk || seen.has(nk)) { pos++; continue; }
        seen.add(nk);
        juBatch.push({ retailerId: id, userName: p, userNormKey: nk, position: pos, resolved: rosterKeys.has(nk) });
        pos++;
      }
    }

    // multi-value Assign Distributor Name → retailer_distributor
    const distCell = s(r[ri["Assign Distributor Name"]]);
    if (distCell) {
      const parts = splitMultiValue(distCell);
      const seen = new Set<string>();
      let pos = 0;
      for (const p of parts) {
        const nk = normDistKey(p);
        if (!nk || seen.has(nk)) { pos++; continue; }
        seen.add(nk);
        const resolvedId = distByNormKey.get(nk) ?? null;
        jdBatch.push({ retailerId: id, distributorName: p, distNormKey: nk, position: pos, resolved: resolvedId != null, resolvedDistId: resolvedId });
        pos++;
      }
    }
  }

  // ── DRY RUN GATE: everything above is pure parse + validation + in-memory
  // batch construction. On --dry-run we stop here without touching the DB. ─────
  if (DRY_RUN) {
    console.log(
      `[dry-run] would write: customer_master=${cmRows.length}, ` +
      `retailer_user=${juBatch.length}, retailer_distributor=${jdBatch.length}. ` +
      `No DB mutation performed.`,
    );
    console.log("=== customer-upload-load DONE (DRY RUN) ===");
    if (opts.endPool) await pool.end();
    return { dryRun: true, customerMaster: cmRows.length, retailerUser: juBatch.length, retailerDistributor: jdBatch.length };
  }

  // ── PHASE 2: single transaction. Snapshot human attribution, delete, then
  // re-insert with attribution re-applied. Any error rolls the whole thing back
  // so the master is never left empty or half-written. ────────────────────────
  const CM_CHUNK = 1000;
  const J_CHUNK = 1000;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Cross-instance exclusion: in-memory job gating is process-local only
    // (autoscale can run replicas). The advisory xact lock guarantees a single
    // writer per load kind across all instances and legacy CLI runs.
    await client.query("SELECT pg_advisory_xact_lock(74011001)");

    // Preserve human edits: snapshot existing attribution before the reset so a
    // re-run never clobbers hand-set state_head / head_confidence / notes.
    interface Attribution { stateHead: string | null; headConfidence: string | null; notes: string | null; }
    const attrib = new Map<string, Attribution>();
    const snap = await client.query<{ id: string; state_head: string | null; head_confidence: string | null; notes: string | null }>(
      `SELECT id, state_head, head_confidence, notes
         FROM customer_master
        WHERE state_head IS NOT NULL`,
    );
    for (const row of snap.rows) {
      attrib.set(row.id, { stateHead: row.state_head, headConfidence: row.head_confidence, notes: row.notes });
    }
    console.log(`[attribution] snapshotted ${attrib.size} rows with a non-null state_head to re-apply`);

    // Idempotent reset (inside the txn) of rows this loader owns.
    await client.query(`DELETE FROM retailer_user`);
    await client.query(`DELETE FROM retailer_distributor`);
    await client.query(`DELETE FROM customer_master`);

    // Insert customer_master, re-applying preserved attribution per id.
    let inserted = 0;
    for (const c of chunk(cmRows, CM_CHUNK)) {
      const vals: unknown[] = [];
      const tuples: string[] = [];
      let p = 1;
      for (const row of c) {
        const rg = reviewGroupOf.get(row.id) ?? null;
        const a = attrib.get(row.id);
        tuples.push(
          `($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`,
        );
        vals.push(
          row.id, row.company, row.type, row.status, row.contact, row.mobile,
          row.state, row.district, row.city, row.gst, row.pincode, row.area,
          row.email, row.address, row.leadStatus, row.statusSource, row.entityType,
          row.assignedSegment, row.createdDate, row.createdBy, row.sourceFile, rg, "customer-upload",
          // preserved attribution (null when there was no human edit)
          a?.stateHead ?? null,
          // head_confidence is NOT NULL DEFAULT 'Guessed' — never insert NULL.
          a?.headConfidence ?? "Guessed",
          a?.notes ?? null,
        );
      }
      await client.query(
        `INSERT INTO customer_master
          (id, company, type, status, contact, mobile, state, district, city,
           gst, pincode, area, email, address, lead_status, status_source,
           entity_type, assigned_segment, created_date, created_by, source_file,
           review_group, edited_by, state_head, head_confidence, notes)
         VALUES ${tuples.join(",")}
         ON CONFLICT (id) DO NOTHING`,
        vals,
      );
      inserted += c.length;
    }
    console.log(`[customer_master] inserted ${inserted} rows (attribution re-applied for ${attrib.size})`);

    // Insert junctions (dedup on (retailer_id, norm_key)).
    let juIns = 0;
    for (const c of chunk(juBatch, J_CHUNK)) {
      const vals: unknown[] = [];
      const tuples: string[] = [];
      let p = 1;
      for (const j of c) {
        tuples.push(`($${p++},$${p++},$${p++},$${p++},$${p++})`);
        vals.push(j.retailerId, j.userName, j.userNormKey, j.resolved, j.position);
      }
      await client.query(
        `INSERT INTO retailer_user (retailer_id, user_name, user_norm_key, resolved, position)
         VALUES ${tuples.join(",")}
         ON CONFLICT (retailer_id, user_norm_key) DO NOTHING`,
        vals,
      );
      juIns += c.length;
    }
    let jdIns = 0;
    for (const c of chunk(jdBatch, J_CHUNK)) {
      const vals: unknown[] = [];
      const tuples: string[] = [];
      let p = 1;
      for (const j of c) {
        tuples.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
        vals.push(j.retailerId, j.distributorName, j.distNormKey, j.resolvedDistId, j.resolved, j.position);
      }
      await client.query(
        `INSERT INTO retailer_distributor (retailer_id, distributor_name, dist_norm_key, resolved_dist_id, resolved, position)
         VALUES ${tuples.join(",")}
         ON CONFLICT (retailer_id, dist_norm_key) DO NOTHING`,
        vals,
      );
      jdIns += c.length;
    }
    console.log(`[junctions] retailer_user rows sent=${juIns}, retailer_distributor rows sent=${jdIns}`);

    await client.query("COMMIT");
    console.log("=== customer-upload-load DONE ===");
    return { dryRun: false, customerMaster: inserted, retailerUser: juIns, retailerDistributor: jdIns };
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[transaction] rolled back — master left untouched:", err);
    throw err;
  } finally {
    client.release();
    if (opts.endPool) await pool.end();
  }
}
