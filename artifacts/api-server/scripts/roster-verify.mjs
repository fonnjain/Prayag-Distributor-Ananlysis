// One-shot, idempotent verification loader for hr_roster.csv (Sales_User_List).
// Reads the authoritative config/hr_roster.csv (UTF-8, transcoded from cp1252),
// parses it with a real RFC-4180 state-machine parser, applies the compound
// identity key normSecKey(Name)+":"+normSecKey(Reporting Manager), and prints
// all five verification outputs the spec demands.
//
// Run: node artifacts/api-server/scripts/roster-verify.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = join(__dir, "../config/hr_roster.csv");

// normSecKey — must match src/lib/mgmt/names.ts (KEEPS parentheticals).
function normSecKey(raw) {
  return String(raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// RFC-4180 state-machine parser: handles quoted fields, escaped quotes ("")
// and embedded newlines inside quotes. Returns an array of rows (arrays).
function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let i = 0;
  let inQuotes = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  // flush trailing field/row if any content
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Employee-code plausibility: valid = numeric AND <= 4 digits.
function isPlausibleEmpCode(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return false;
  if (!/^[0-9]+$/.test(s)) return false;   // must be pure numeric (rules out +, spaces)
  return s.length <= 4;
}

const text = readFileSync(CSV_PATH, "utf8");
const rows = parseCsv(text);
const header = rows[0].map((h) => h.trim().toLowerCase());
const col = (name) => header.findIndex((h) => h === name.toLowerCase());

const cName = col("name");
const cMgr = col("reporting manager");
const cStatus = col("status");
const cEmp = col("employee code");
const cHq = col("headquarter");
const cWState = col("working state");
const cSeg = col("assigned segment");
const cCtc = col("ctc");
const cDesig = col("designation");
const cOrder = col("order type");
const cState = col("state");
const cCity = col("city");

const dataRows = rows.slice(1).filter((r) => (r[cName] ?? "").trim() !== "");

// Build records with compound key. Detect same-name collisions and keep BOTH.
const records = dataRows.map((r) => {
  const name = (r[cName] ?? "").trim();
  const mgr = (r[cMgr] ?? "").trim();
  const statusRaw = (r[cStatus] ?? "").trim();
  return {
    name,
    mgr,
    status: statusRaw,
    active: statusRaw.toLowerCase() === "active",
    empCode: (r[cEmp] ?? "").trim(),
    hq: (r[cHq] ?? "").trim(),
    workingState: (r[cWState] ?? "").trim(),
    segment: (r[cSeg] ?? "").trim(),
    ctc: (r[cCtc] ?? "").trim(),
    designation: (r[cDesig] ?? "").trim(),
    orderType: (r[cOrder] ?? "").trim(),
    state: (r[cState] ?? "").trim(),
    city: (r[cCity] ?? "").trim(),
    key: normSecKey(name) + ":" + normSecKey(mgr),
    nameKey: normSecKey(name),
  };
});

const active = records.filter((r) => r.active);
const deactive = records.filter((r) => r.status.toLowerCase() === "deactive");

console.log("========================================================");
console.log("VERIFICATION 1 — Parse counts");
console.log("========================================================");
console.log("Columns:", header.length);
console.log("Rows parsed (data rows):", records.length);
console.log("Active:", active.length);
console.log("Deactive:", deactive.length);
console.log("Other status:", records.length - active.length - deactive.length);

console.log("\n========================================================");
console.log("VERIFICATION 3 — The Ashutosh case (compound key)");
console.log("========================================================");
const ashutosh = records.filter((r) => r.nameKey.startsWith("ashutoshkumar"));
for (const a of ashutosh) {
  console.log(`  name="${a.name}" mgr="${a.mgr}" emp=${a.empCode} status=${a.status}`);
  console.log(`    key="${a.key}"`);
}
const ashutoshKeys = new Set(ashutosh.map((a) => a.key));
console.log(`  distinct compound keys among Ashutosh rows: ${ashutoshKeys.size} (expect 2)`);

console.log("\n========================================================");
console.log("VERIFICATION 4 — Active members with bad employee code");
console.log("========================================================");
const badCode = active.filter((r) => !isPlausibleEmpCode(r.empCode));
console.log("Count flagged (expect 62):", badCode.length);
console.log("First 10 by name:");
badCode
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name))
  .slice(0, 10)
  .forEach((r, i) => console.log(`  ${i + 1}. ${r.name}  [code=${r.empCode}]`));

// Plausibility breakdown for reference (mirrors spec measurement).
let longNum = 0, roundPlaceholder = 0, plusChars = 0, mobile = 0;
for (const r of active) {
  const s = r.empCode;
  if (isPlausibleEmpCode(s)) continue;
  if (s.includes("+")) { plusChars++; continue; }
  if (/^[0-9]{10}$/.test(s)) { mobile++; continue; }
  if (/^[0-9]+$/.test(s) && /0{4,}$/.test(s)) { roundPlaceholder++; continue; }
  if (/^[0-9]+$/.test(s)) { longNum++; continue; }
}
console.log(`  breakdown → longNumeric=${longNum} roundPlaceholder=${roundPlaceholder} plus=${plusChars} mobile10=${mobile}`);

console.log("\n========================================================");
console.log("VERIFICATION 5 — Reporting Managers not resolving to a row");
console.log("========================================================");
// A reporting manager resolves if some OTHER row's Name matches (normSecKey,
// parenthetical-tolerant: also match the base name without parenthetical).
const nameKeys = new Set(records.map((r) => r.nameKey));
const nameKeysBase = new Set(records.map((r) => normSecKey(r.name.replace(/\([^)]*\)/g, ""))));
const unresolved = [];
const seenMgr = new Set();
for (const r of records) {
  if (!r.mgr) continue;
  const mk = normSecKey(r.mgr);
  if (nameKeys.has(mk) || nameKeysBase.has(mk)) continue;
  if (seenMgr.has(mk)) continue;
  seenMgr.add(mk);
  unresolved.push(r.mgr);
}
console.log("Distinct Reporting Managers not resolving to another row:", unresolved.length);
unresolved.sort((a, b) => a.localeCompare(b)).forEach((m, i) => console.log(`  ${i + 1}. ${m}`));

console.log("\n========================================================");
console.log("ROSTER HEALTH PANEL numbers (active members)");
console.log("========================================================");
const pct = (n) => ((n / active.length) * 100).toFixed(1) + "%";
console.log("Designation populated:", pct(active.filter((r) => r.designation).length));
console.log("Reporting Manager populated:", pct(active.filter((r) => r.mgr).length));
console.log("CTC populated:", pct(active.filter((r) => r.ctc && r.ctc !== "0").length));
console.log("Headquarter populated:", pct(active.filter((r) => r.hq).length));
console.log("Working State populated:", pct(active.filter((r) => r.workingState).length));
console.log("Assigned Segment populated:", pct(active.filter((r) => r.segment).length));
const orderCounts = {};
for (const r of active) orderCounts[r.orderType || "(blank)"] = (orderCounts[r.orderType || "(blank)"] ?? 0) + 1;
console.log("Order Type breakdown:", JSON.stringify(orderCounts));

console.log("\n========================================================");
console.log("AMBIGUOUS DUPLICATE NAMES (resolve only by manager)");
console.log("========================================================");
const nameCount = new Map();
for (const r of records) nameCount.set(r.nameKey, (nameCount.get(r.nameKey) ?? 0) + 1);
const ambiguous = [...nameCount.entries()].filter(([, c]) => c > 1);
console.log("Distinct ambiguous name keys:", ambiguous.length);
ambiguous
  .map(([k]) => records.find((r) => r.nameKey === k)?.name)
  .sort((a, b) => a.localeCompare(b))
  .forEach((n, i) => console.log(`  ${i + 1}. ${n}`));

console.log("\n========================================================");
console.log("SHARED PLACEHOLDER / DUPLICATE checks");
console.log("========================================================");
const share = active.filter((r) => r.empCode === "5900000000000");
console.log(`Emp code 5900000000000 held by ${share.length} active people:`);
share.forEach((r) => console.log(`   ${r.name} (${r.city}, reporting to ${r.mgr})`));
const bala = records.filter((r) => r.empCode === "940");
console.log(`Emp code 940 held by ${bala.length} people:`);
bala.forEach((r) => console.log(`   ${r.name} (${r.city}, ${r.status}, mgr ${r.mgr})`));
