// Dues fetcher — PARTY O/S & PAYMENT 26-27
//
// Spreadsheet: 1oHFpXqVDPRF3Vi3WV9MdNcxkHNjgytLPxXUQgM6o1ok
// Condition: "Payments of All Bills must be cleared within the due dates."
// A distributor with any overdue amount > 0 earns NOTHING on any scheme.
// Show "BLOCKED — clear dues first" instead of a nudge.
//
// Column detection: we look for a column named "Party" or "Customer" (the
// distributor name) and a numeric "O/S" or "Overdue" column. If the sheet
// structure changes, update PARTY_COL_KEYWORDS / OS_COL_KEYWORDS below.
import { getGoogleAccessToken } from "../registers/sheetsApi.js";
import { logger } from "../logger.js";

const DUES_SPREADSHEET_ID = "1oHFpXqVDPRF3Vi3WV9MdNcxkHNjgytLPxXUQgM6o1ok";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

const PARTY_COL_KEYWORDS = ["party", "customer", "distributor", "name"];
const OS_COL_KEYWORDS = ["o/s", "overdue", "outstanding", "balance", "pending"];

type DuesResult = {
  blocked: Set<string>;
  available: boolean;
  fetchedAt: string;
  error?: string;
};

// In-memory cache — refreshed at most once per hour
let cache: DuesResult | null = null;
let cacheTs = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getBlockedCustomers(): Promise<DuesResult> {
  if (cache && Date.now() - cacheTs < CACHE_TTL_MS) return cache;

  try {
    const token = await getGoogleAccessToken();

    // Fetch the first sheet values (range A:Z, up to 10k rows)
    const url = `${SHEETS_BASE}/${DUES_SPREADSHEET_ID}/values/A1:Z10000?valueRenderOption=UNFORMATTED_VALUE`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Sheets API ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data = (await res.json()) as { values?: (string | number | null)[][] };
    const rows = data.values ?? [];

    if (!rows.length) {
      throw new Error("Empty dues sheet — no rows returned");
    }

    // Detect header row (first row that has at least 3 cells)
    let headerRowIdx = -1;
    let partyColIdx = -1;
    let osColIdx = -1;

    for (let r = 0; r < Math.min(10, rows.length); r++) {
      const row = rows[r];
      let pIdx = -1;
      let oIdx = -1;
      for (let c = 0; c < row.length; c++) {
        const cell = String(row[c] ?? "").toLowerCase().trim();
        if (pIdx === -1 && PARTY_COL_KEYWORDS.some((k) => cell.includes(k))) {
          pIdx = c;
        }
        if (oIdx === -1 && OS_COL_KEYWORDS.some((k) => cell.includes(k))) {
          oIdx = c;
        }
      }
      if (pIdx !== -1 && oIdx !== -1) {
        headerRowIdx = r;
        partyColIdx = pIdx;
        osColIdx = oIdx;
        break;
      }
    }

    if (headerRowIdx === -1 || partyColIdx === -1 || osColIdx === -1) {
      logger.warn(
        { partyColIdx, osColIdx },
        "dues: could not detect party/O&S columns — dues check disabled",
      );
      const result: DuesResult = {
        blocked: new Set(),
        available: false,
        fetchedAt: new Date().toISOString(),
        error: "Column detection failed — check PARTY O/S sheet structure",
      };
      cache = result;
      cacheTs = Date.now();
      return result;
    }

    const blocked = new Set<string>();

    for (let r = headerRowIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      const party = String(row[partyColIdx] ?? "").trim().toUpperCase();
      const osRaw = row[osColIdx];
      const os = typeof osRaw === "number" ? osRaw : parseFloat(String(osRaw ?? "0"));

      if (party && !isNaN(os) && os > 0) {
        blocked.add(party);
      }
    }

    logger.info({ count: blocked.size }, "dues: loaded blocked customers");

    const result: DuesResult = {
      blocked,
      available: true,
      fetchedAt: new Date().toISOString(),
    };
    cache = result;
    cacheTs = Date.now();
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, "dues: fetch failed — dues check disabled");
    const result: DuesResult = {
      blocked: new Set(),
      available: false,
      fetchedAt: new Date().toISOString(),
      error: msg,
    };
    // Cache the failure for 5 minutes so we don't spam the API on every request
    cache = result;
    cacheTs = Date.now() - CACHE_TTL_MS + 5 * 60 * 1000;
    return result;
  }
}
