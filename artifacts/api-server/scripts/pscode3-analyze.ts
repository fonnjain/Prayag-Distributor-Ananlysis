// Phase 1 — analysis only, no DB writes.
// Parses the 181-file FY2026-27 secondary register drop (PSCode_3 per-salesperson
// xlsx files), applies the documented rules, and reports:
//   - per-month lines / gross / NET / effective discount vs expected anchors
//   - identity check: Sub Total = Order Value × (1 − Discount/100)
//   - Prasun Chatterjee control (₹18,34,504)
//   - the duplicate-total pairs with line counts + first 3 Order IDs
import ExcelJS from "exceljs";
import { readdirSync } from "node:fs";
import path from "node:path";

const DIR = "/tmp/pscode3/PSCODE 3 NEW REPORT";

interface Line {
  member: string;
  dateSerial: number | null;
  monthLabel: string | null;
  retailerId: string;
  retailer: string;
  orderId: string;
  segment: string;
  catNo: string;
  qty: number | null;
  mrp: number | null;
  orderValue: number | null;
  distributor: string;
  discountPct: number | null;
  subTotal: number | null;
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "object" && v instanceof Date) return v.toISOString();
  if (typeof v === "object" && "result" in (v as any)) return String((v as any).result ?? "");
  return String(v).trim();
};

function monthLabelFromDate(v: unknown): { serial: number | null; label: string | null } {
  let d: Date | null = null;
  if (v instanceof Date) d = v;
  else if (typeof v === "number" && v > 20000) d = new Date((v - 25569) * 86400000);
  else if (typeof v === "string") {
    const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(v.trim());
    if (m) d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    else { const p = new Date(v); if (!isNaN(p.getTime())) d = p; }
  }
  if (!d || isNaN(d.getTime())) return { serial: null, label: null };
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return { serial: Math.round(d.getTime() / 86400000 + 25569), label: `${MON[d.getUTCMonth()]}-${String(d.getUTCFullYear() % 100).padStart(2, "0")}` };
}

async function parseFile(fp: string, member: string): Promise<{ lines: Line[]; totalRowM: number | null; issues: string[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(fp);
  const ws = wb.worksheets[0];
  const lines: Line[] = [];
  const issues: string[] = [];
  let totalRowM: number | null = null;
  let carryOrderId = "", carrySegment = "";
  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= 2) return; // header band
    const c = (i: number) => (row.getCell(i).value as unknown);
    const a = str(c(1));
    if (a.toUpperCase().startsWith("TOTAL")) {
      totalRowM = num(c(13));
      return;
    }
    const orderValue = num(c(10));
    const subTotal = num(c(13));
    const retailer = str(c(4));
    if (orderValue == null && subTotal == null && !retailer) return; // blank
    const oid = str(c(5));
    const seg = str(c(6));
    if (oid) carryOrderId = oid;
    if (seg) carrySegment = seg;
    const { serial, label } = monthLabelFromDate(c(2));
    lines.push({
      member,
      dateSerial: serial,
      monthLabel: label,
      retailerId: str(c(3)),
      retailer,
      orderId: carryOrderId,
      segment: carrySegment,
      catNo: str(c(7)),
      qty: num(c(8)),
      mrp: num(c(9)),
      orderValue,
      distributor: str(c(11)),
      discountPct: num(c(12)),
      subTotal,
    });
  });
  return { lines, totalRowM, issues };
}

const files = readdirSync(DIR).filter((f) => f.startsWith("PSCode_3_New_Report ") && f.endsWith(".xlsx"));
console.log("PSCode_3 files:", files.length);

const perFile: { member: string; file: string; lines: Line[]; net: number; totalRowM: number | null }[] = [];
let identityFail = 0, identityChecked = 0, badDates = 0;
const byMonth = new Map<string, { lines: number; gross: number; net: number; orders: Set<string>; retailers: Set<string>; codes: Set<string>; dists: Set<string> }>();

for (const f of files) {
  const member = f.replace(/^PSCode_3_New_Report /, "").replace(/\.xlsx$/, "").trim();
  const { lines, totalRowM } = await parseFile(path.join(DIR, f), member);
  let net = 0;
  for (const l of lines) {
    net += l.subTotal ?? 0;
    if (l.orderValue != null && l.discountPct != null && l.subTotal != null) {
      identityChecked++;
      const expect = l.orderValue * (1 - l.discountPct / 100);
      if (Math.abs(expect - l.subTotal) > 1) identityFail++;
    }
    if (!l.monthLabel) badDates++;
    const key = l.monthLabel ?? "??";
    let m = byMonth.get(key);
    if (!m) { m = { lines: 0, gross: 0, net: 0, orders: new Set(), retailers: new Set(), codes: new Set(), dists: new Set() }; byMonth.set(key, m); }
    m.lines++; m.gross += l.orderValue ?? 0; m.net += l.subTotal ?? 0;
    if (l.orderId) m.orders.add(l.orderId);
    if (l.retailerId || l.retailer) m.retailers.add(l.retailerId || l.retailer);
    if (l.catNo) m.codes.add(l.catNo);
    if (l.distributor) m.dists.add(l.distributor);
  }
  perFile.push({ member, file: f, lines, net, totalRowM });
}

const cr = (n: number) => (n / 1e7).toFixed(4);
console.log("\n── Per-month totals (Total: rows excluded) ──");
for (const [m, v] of [...byMonth.entries()].sort()) {
  const disc = v.gross > 0 ? ((1 - v.net / v.gross) * 100).toFixed(1) : "—";
  console.log(`${m}: lines=${v.lines} orders=${v.orders.size} retailers=${v.retailers.size} codes=${v.codes.size} dists=${v.dists.size} gross=${cr(v.gross)}Cr NET=${cr(v.net)}Cr disc=${disc}%`);
}
const allLines = perFile.reduce((s, p) => s + p.lines.length, 0);
const allNet = perFile.reduce((s, p) => s + p.net, 0);
const allGross = perFile.reduce((s, p) => s + p.lines.reduce((x, l) => x + (l.orderValue ?? 0), 0), 0);
console.log(`ALL: lines=${allLines} NET=${cr(allNet)}Cr disc=${((1 - allNet / allGross) * 100).toFixed(1)}%`);
console.log(`identity Sub Total = OV×(1−d%): checked=${identityChecked} fails(>₹1)=${identityFail}; undated lines=${badDates}`);

const prasun = perFile.find((p) => p.member.toUpperCase().includes("PRASUN"));
if (prasun) {
  console.log(`\nPrasun control: NET=₹${prasun.net.toFixed(2)} (expected 1834504); lines=${prasun.lines.length}`);
  const byDist = new Map<string, number>();
  for (const l of prasun.lines) byDist.set(l.distributor, (byDist.get(l.distributor) ?? 0) + (l.subTotal ?? 0));
  console.log("  by distributor:", [...byDist.entries()].map(([d, v]) => `${d}=₹${v.toFixed(0)}`).join(", "));
}

// Footer disagreement count
const footerDiff = perFile.filter((p) => p.totalRowM != null && Math.abs(p.totalRowM - p.net) > 1).length;
const noFooter = perFile.filter((p) => p.totalRowM == null).length;
console.log(`\nfooter Total: differs >₹1 in ${footerDiff} files; missing footer in ${noFooter} files`);

// Duplicate-total pairs
console.log("\n── Duplicate-total groups (identical NET to the rupee) ──");
const byTotal = new Map<string, typeof perFile>();
for (const p of perFile) {
  const k = p.net.toFixed(0);
  const arr = byTotal.get(k) ?? [];
  arr.push(p);
  byTotal.set(k, arr);
}
let dupGroups = 0;
for (const [total, group] of [...byTotal.entries()].sort((a, b) => +b[0] - +a[0])) {
  if (group.length < 2 || +total === 0) continue;
  dupGroups++;
  console.log(`₹${(+total / 1e5).toFixed(2)} L:`);
  for (const p of group) {
    const oids = [...new Set(p.lines.map((l) => l.orderId))].slice(0, 3);
    console.log(`   ${p.member}  lines=${p.lines.length}  first3OrderIDs=[${oids.join(", ")}]`);
  }
  // classify
  const oidSets = group.map((p) => new Set(p.lines.map((l) => l.orderId)));
  const inter = [...oidSets[0]].filter((x) => oidSets.every((s) => s.has(x)));
  console.log(`   → shared Order IDs: ${inter.length} of ${oidSets[0].size} → ${inter.length === oidSets[0].size && oidSets.every((s) => s.size === oidSets[0].size) ? "DUPLICATE EXPORT (load one)" : inter.length === 0 ? "different people (load both)" : "PARTIAL overlap — inspect"}`);
}
console.log(`dup groups: ${dupGroups}`);
// zero-total / empty files
const empty = perFile.filter((p) => p.lines.length === 0 || p.net === 0);
if (empty.length) console.log("\nzero/empty files:", empty.map((p) => `${p.member}(${p.lines.length})`).join(", "));
process.exit(0);
