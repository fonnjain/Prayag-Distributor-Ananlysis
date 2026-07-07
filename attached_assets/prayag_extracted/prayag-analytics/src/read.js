// src/read.js — turn raw sheet rows into typed records. Header-tolerant (handles the
// real quirks: "M0NTH" with a zero, "STATE HEAD A", "FY-2025-26" as a data column).
const { listTabs, readTab } = require('./drive');

const norm = (h) => String(h == null ? '' : h).toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v) => {
  if (typeof v === 'number') return v;
  const n = Number(String(v == null ? '' : v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// Field detectors, in priority order (head before state so "STATE HEAD" wins over "STATE").
const FIELD_DETECTORS = [
  ['head', (h) => h.includes('STATEHEAD')],
  ['invoice', (h) => h.includes('INVOICE')],
  ['date', (h) => h === 'DATE'],
  ['customer', (h) => h.includes('CUSTOMER')],
  ['code', (h) => h === 'CODE'],
  ['month', (h) => h === 'MONTH' || h === 'M0NTH'],
  ['qty', (h) => h === 'QTY'],
  ['rate', (h) => h.includes('SALERATE') || h === 'RATE'],
  ['amount', (h) => h === 'AMOUNT' || h.includes('AMOUNT')],
  ['group', (h) => h === 'GROUP'],
  ['station', (h) => h.includes('STATION')],
  ['state', (h) => h === 'STATE'],
  ['type', (h) => h === 'TYPE'],
  ['fy', (h) => h.startsWith('FY')],
];

const MONTHS = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };

// "01-Apr-25" -> { d: Date, fy: "2025-26", monthLabel: "Apr-25" }
function parseDate(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{2,4})$/);
  if (!m) return { d: null, fy: null, monthLabel: null };
  const mon = MONTHS[m[2].toUpperCase()];
  if (mon == null) return { d: null, fy: null, monthLabel: null };
  let year = Number(m[3]); if (year < 100) year += 2000;
  const fyStart = mon >= 3 ? year : year - 1;
  const fy = `${fyStart}-${String(fyStart + 1).slice(2)}`;
  return { d: new Date(year, mon, Number(m[1])), fy, monthLabel: `${m[2][0].toUpperCase()}${m[2].slice(1,3).toLowerCase()}-${String(year).slice(2)}` };
}

// Find the header row within the first ~20 rows: it contains CODE + QTY + AMOUNT.
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = (rows[i] || []).map(norm);
    if (cells.includes('CODE') && cells.includes('QTY') && cells.some((c) => c.includes('AMOUNT'))) {
      return i;
    }
  }
  return -1;
}

function buildColMap(headerCells) {
  const map = {};
  headerCells.forEach((cell, idx) => {
    const h = norm(cell);
    for (const [field, test] of FIELD_DETECTORS) {
      if (map[field] == null && test(h)) { map[field] = idx; break; }
    }
  });
  return map;
}

// Auto-detect the register/rate tab: the one whose used range has a valid header row.
async function pickTab(spreadsheetId, wanted) {
  if (wanted && wanted !== '__auto__') return { tab: wanted, rows: await readTab(spreadsheetId, wanted) };
  const tabs = await listTabs(spreadsheetId);
  for (const t of tabs) {
    const rows = await readTab(spreadsheetId, t);
    if (findHeader(rows) >= 0) return { tab: t, rows };
  }
  // Fall back to first tab if nothing matched (rate master has no QTY/AMOUNT header).
  const first = tabs[0];
  return { tab: first, rows: await readTab(spreadsheetId, first) };
}

// Read the sale register for one FY. Returns { rows: [...typed lines], stats }.
async function readRegister(spreadsheetId, tabConfig, targetFy) {
  const { tab, rows } = await pickTab(spreadsheetId, tabConfig);
  const hi = findHeader(rows);
  if (hi < 0) throw new Error(`No register header (CODE/QTY/AMOUNT) found in ${spreadsheetId}`);
  const col = buildColMap(rows[hi]);
  const out = [];
  let read = 0, dropped = 0, offFy = 0;
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i]; if (!r || r.length === 0) continue;
    const code = r[col.code]; const amount = num(r[col.amount]);
    if ((code == null || code === '') && !amount) { continue; }
    read++;
    const { fy, monthLabel } = parseDate(r[col.date]);
    const rowFy = fy || String(r[col.fy] || '').replace(/^FY[-\s]*/i, '').trim() || null;
    if (targetFy && rowFy && rowFy !== targetFy) { offFy++; continue; }
    if (!code && !amount) { dropped++; continue; }
    out.push({
      invoice: r[col.invoice] != null ? String(r[col.invoice]) : '',
      customer: r[col.customer] != null ? String(r[col.customer]) : '',
      code: String(code == null ? '' : code).trim(),
      month: monthLabel || (r[col.month] != null ? String(r[col.month]) : ''),
      fy: rowFy,
      qty: num(r[col.qty]),
      rate: num(r[col.rate]),
      amount,
      group: String(r[col.group] == null ? '' : r[col.group]).trim(),
      station: String(r[col.station] == null ? '' : r[col.station]).trim(),
      state: String(r[col.state] == null ? '' : r[col.state]).trim(),
      head: String(r[col.head] == null ? '' : r[col.head]).trim(),
      type: String(r[col.type] == null ? '' : r[col.type]).trim(),
    });
  }
  return { tab, rows: out, stats: { read, dropped, offFy, header_row: hi } };
}

// Read + dedupe-friendly raw rows from the rate master (dedup happens in normalize.js).
async function readRateMaster(spreadsheetId, tabConfig) {
  const { rows } = await pickTab(spreadsheetId, tabConfig);
  // Header row for rate master contains "Item Code" + "Purchase Price".
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = (rows[i] || []).map(norm);
    if (cells.some((c) => c.includes('ITEMCODE')) && cells.some((c) => c.includes('PURCHASEPRICE'))) { hi = i; break; }
  }
  if (hi < 0) return [];
  const H = rows[hi].map(norm);
  const idx = (want) => H.findIndex((c) => c.includes(want));
  const cCode = idx('ITEMCODE'), cGroup = idx('ITEMGROUP'), cType = idx('ITEMTYPE'),
        cPur = idx('PURCHASEPRICE'), cMrp = idx('MRP'), cSale = idx('SALEPRICE');
  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const code = String(r[cCode] == null ? '' : r[cCode]).trim();
    if (!code) continue;
    out.push({
      code,
      group: String(r[cGroup] == null ? '' : r[cGroup]).trim(),
      type: String(r[cType] == null ? '' : r[cType]).trim(),
      purchase: num(r[cPur]),
      mrp: num(r[cMrp]),
      sale: num(r[cSale]),
    });
  }
  return out;
}

// Read the optional Cost Master (Item Code -> Finished-Good Cost).
async function readCostMaster(spreadsheetId, tabConfig, cols) {
  if (!spreadsheetId) return {};
  const { rows } = await pickTab(spreadsheetId, tabConfig);
  const wantCode = norm(cols?.code || 'Item Code');
  const wantCost = norm(cols?.cost || 'Finished-Good Cost');
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = (rows[i] || []).map(norm);
    if (cells.some((c) => c.includes(wantCode)) && cells.some((c) => c.includes(wantCost))) { hi = i; break; }
  }
  if (hi < 0) return {};
  const H = rows[hi].map(norm);
  const cCode = H.findIndex((c) => c.includes(wantCode));
  const cCost = H.findIndex((c) => c.includes(wantCost));
  const map = {};
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i]; if (!r) continue;
    const code = String(r[cCode] == null ? '' : r[cCode]).trim();
    const cost = num(r[cCost]);
    if (code && cost > 0) map[code] = cost;
  }
  return map;
}

// Read order-book monthly tabs -> [{ month, lines, amount, qty }]. Tolerant: sums any AMOUNT-like column.
async function readOrderBook(spreadsheetId, monthlyTabs) {
  const tabs = await listTabs(spreadsheetId);
  const present = monthlyTabs.filter((m) => tabs.some((t) => norm(t).startsWith(norm(m))));
  const out = [];
  for (const m of present) {
    const actual = tabs.find((t) => norm(t).startsWith(norm(m)));
    const rows = await readTab(spreadsheetId, actual);
    const hi = findHeader(rows);
    if (hi < 0) { out.push({ month: m, lines: 0, amount: 0, qty: 0 }); continue; }
    const col = buildColMap(rows[hi]);
    let amount = 0, qty = 0, lines = 0;
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i]; if (!r || r.length === 0) continue;
      const a = num(r[col.amount]); if (!a && !r[col.code]) continue;
      amount += a; qty += num(r[col.qty]); lines++;
    }
    out.push({ month: m, lines, amount, qty });
  }
  return out;
}

module.exports = { readRegister, readRateMaster, readCostMaster, readOrderBook, parseDate, norm, num };
