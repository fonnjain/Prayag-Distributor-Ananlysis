// src/normalize.js — apply the canonical taxonomy and clean the rate master.
const groupMap = require('../config/group_map.json');
const norm = require('../config/normalize.json');

// Build reverse lookup: UPPER(register GROUP) -> canonical group.
const GROUP_LOOKUP = {};
for (const [canon, variants] of Object.entries(groupMap.canonical)) {
  for (const v of variants) GROUP_LOOKUP[v.toUpperCase().trim()] = canon;
}
const HEADS = norm.heads;
const NON_TERRITORY = new Set(norm.non_territory);
const STATE_VARIANTS = norm.state_variants || {};

function normalizeGroup(raw) {
  const key = String(raw || '').toUpperCase().trim();
  return GROUP_LOOKUP[key] || null; // null => unmapped (flagged by compute)
}

function normalizeHead(raw) {
  const key = String(raw || '').toUpperCase().trim();
  if (HEADS[key]) return { head: HEADS[key], territory: true };
  if (NON_TERRITORY.has(key)) return { head: norm.non_territory_label, territory: false };
  if (!key) return { head: norm.non_territory_label, territory: false };
  return { head: null, raw: key, territory: false }; // null => unmapped head
}

function normalizeState(raw) {
  const key = String(raw || '').toUpperCase().trim();
  if (NON_TERRITORY.has(key) || !key) return { state: norm.non_territory_label, mapped: true };
  const mapped = STATE_VARIANTS[key] || key;
  return { state: mapped.replace(/\b\w/g, (c) => c.toUpperCase()), mapped: true };
}

// Dedupe the dirty rate master to one row per Item Code.
// Rules: prefer finished goods (Item Type contains "FG"), drop zero purchase,
// take the last non-zero purchase seen for the code. Returns { byCode, coverage }.
function dedupeRateMaster(rows) {
  const byCode = {};
  for (const r of rows) {
    const fg = /FG/i.test(r.type) || r.type === '';
    const cur = byCode[r.code];
    const better =
      !cur ||
      (r.purchase > 0 && (cur.purchase === 0 || (fg && !cur.fg)));
    if (better) byCode[r.code] = { code: r.code, group: r.group, purchase: r.purchase, mrp: r.mrp, sale: r.sale, fg };
    else if (cur && r.purchase > 0) { cur.purchase = r.purchase; if (fg) cur.fg = true; } // latest non-zero wins
  }
  const codes = Object.keys(byCode);
  const withCost = codes.filter((c) => byCode[c].purchase > 0).length;
  return { byCode, coverage: codes.length ? withCost / codes.length : 0 };
}

module.exports = { normalizeGroup, normalizeHead, normalizeState, dedupeRateMaster };
