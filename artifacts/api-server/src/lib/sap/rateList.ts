// Rate-list lookups for the SAP pipeline, read from the live "rate list"
// Google Sheet. Two tabs:
//   Sheet1 — item master: item code -> item type -> product GROUP, plus MRP.
//   Sheet2 — customer master: customer name -> STATE HEAD / STATE / channel.
//
// Both maps are cached with a TTL, and concurrent builds are de-duplicated so a
// burst of uploads triggers a single Sheets read (see the sheets-loader
// concurrency rule). Cost/MRP columns are NEVER used as a cost input; MRP is
// read only for reference and cross-checks.
import { readAllTabRows, type SheetCellValue } from "../registers/sheetsApi.js";
import { canonGroup, type UnmappedReport } from "../registers/normalize.js";
import { normParty, normName } from "../mgmt/names.js";
import { sapConfig } from "./config.js";

export type RateItem = {
  code: string;
  itemName: string | null;
  itemType: string | null;
  group: string | null;
  category: string | null; // FG / SFG
  mrp: number | null;
};

export type CustomerInfo = {
  name: string;
  head: string | null;
  state: string | null;
  channel: string | null;
};

export type RateListMaps = {
  items: Map<string, RateItem>; // key: normalized item code
  customers: Map<string, CustomerInfo>; // key: normParty(name)
};

const TTL_MS = 30 * 60_000;
let cache: { maps: RateListMaps; builtAtMs: number } | null = null;
let inflight: Promise<RateListMaps> | null = null;

export function normCode(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase();
}

function norm(v: SheetCellValue): string {
  return String(v ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function text(v: SheetCellValue): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: SheetCellValue): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

// Finds the header row (within the first 20 rows) whose normalized cells
// include every required token, and returns the column index of each requested
// header. Returns null when no such row exists.
function locateHeader(
  rows: SheetCellValue[][],
  required: string[],
  wanted: Record<string, string[]>,
): { rowIndex: number; cols: Record<string, number> } | null {
  const limit = Math.min(rows.length, 20);
  for (let r = 0; r < limit; r++) {
    const cells = rows[r].map(norm);
    const set = new Set(cells);
    if (!required.every((t) => set.has(t))) continue;
    const cols: Record<string, number> = {};
    for (const [key, aliases] of Object.entries(wanted)) {
      cols[key] = -1;
      for (const alias of aliases) {
        const idx = cells.indexOf(alias);
        if (idx >= 0) {
          cols[key] = idx;
          break;
        }
      }
    }
    return { rowIndex: r, cols };
  }
  return null;
}

function buildItemMap(rows: SheetCellValue[][]): Map<string, RateItem> {
  const header = locateHeader(
    rows,
    ["ITEMCODE", "ITEMTYPE"],
    {
      code: ["ITEMCODE"],
      name: ["ITEMNAME"],
      itemGroup: ["ITEMGROUP"],
      itemType: ["ITEMTYPE"],
      category: ["ITEMCATEGORY", "CATEGORY"],
      mrp: ["MRP"],
    },
  );
  const map = new Map<string, RateItem>();
  if (!header) return map;
  const { cols } = header;
  const throwaway: UnmappedReport = {
    unmapped_groups: {},
    unmapped_heads: {},
    unmapped_states: {},
  };
  for (let r = header.rowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    const code = normCode(cols.code >= 0 ? row[cols.code] : null);
    if (!code) continue;
    const itemType = cols.itemType >= 0 ? text(row[cols.itemType]) : null;
    const category = cols.category >= 0 ? text(row[cols.category]) : null;
    const mrp = cols.mrp >= 0 ? num(row[cols.mrp]) : null;
    const item: RateItem = {
      code,
      itemName: cols.name >= 0 ? text(row[cols.name]) : null,
      itemType,
      group: canonGroup(itemType, throwaway),
      category,
      mrp,
    };
    const existing = map.get(code);
    if (!existing) {
      map.set(code, item);
      continue;
    }
    // Prefer the FG (finished-good) row over SFG (semi-finished) noise, and a
    // priced row over a zero/blank one.
    const prefer =
      (isFg(item.category) && !isFg(existing.category)) ||
      (item.category === existing.category &&
        (item.mrp ?? 0) > 0 &&
        !((existing.mrp ?? 0) > 0));
    if (prefer) map.set(code, item);
  }
  return map;
}

function isFg(category: string | null): boolean {
  return (category ?? "").toUpperCase().startsWith("FG");
}

function buildCustomerMap(rows: SheetCellValue[][]): Map<string, CustomerInfo> {
  const header = locateHeader(
    rows,
    ["NAME", "STATEHEAD"],
    {
      name: ["NAME", "PARTYNAME", "CUSTOMER", "CUSTOMERNAME"],
      state: ["STATE"],
      head: ["STATEHEAD", "HEAD"],
      channel: ["GROUP", "CHANNEL", "PAYMENTTR"],
    },
  );
  const map = new Map<string, CustomerInfo>();
  if (!header) return map;
  const { cols } = header;
  for (let r = header.rowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    const name = cols.name >= 0 ? text(row[cols.name]) : null;
    if (!name) continue;
    const key = normParty(name);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, {
        name,
        head: cols.head >= 0 ? text(row[cols.head]) : null,
        state: cols.state >= 0 ? text(row[cols.state]) : null,
        channel: cols.channel >= 0 ? text(row[cols.channel]) : null,
      });
    }
  }
  return map;
}

async function build(): Promise<RateListMaps> {
  const { spreadsheetId, itemTab, customerTab } = sapConfig.rateList;
  const [itemRows, customerRows] = await Promise.all([
    readAllTabRows(spreadsheetId, itemTab),
    readAllTabRows(spreadsheetId, customerTab),
  ]);
  return {
    items: buildItemMap(itemRows),
    customers: buildCustomerMap(customerRows),
  };
}

export async function getRateListMaps(forceRefresh = false): Promise<RateListMaps> {
  if (!forceRefresh && cache && Date.now() - cache.builtAtMs < TTL_MS) {
    return cache.maps;
  }
  if (!forceRefresh && inflight) return inflight;
  const p = build()
    .then((maps) => {
      cache = { maps, builtAtMs: Date.now() };
      return maps;
    })
    .finally(() => {
      if (inflight === p) inflight = null;
    });
  inflight = p;
  return p;
}

// Customer match keyed on the same normalization used for the register bridge,
// so "(CITY)" suffixes and casing differences never cause a false miss.
export function matchCustomer(
  customerRaw: string | null,
  maps: RateListMaps,
): CustomerInfo | null {
  if (!customerRaw) return null;
  const key = normParty(customerRaw);
  if (key && maps.customers.has(key)) return maps.customers.get(key)!;
  // Fall back to normName (strips parens but keeps m/s handling looser) for the
  // rare rows whose punctuation defeats normParty.
  const alt = normName(customerRaw);
  for (const [k, info] of maps.customers) {
    if (k === alt) return info;
  }
  return null;
}
