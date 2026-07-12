// Loads payment-collection data from the PARTY O/S & PAYMENT workbooks.
//
// Each workbook tracks party-level outstanding balances and payments.  Rows
// with Type == "Pymt" (case-insensitive, trimmed) are payment/collection
// entries.  We aggregate the payment amount per state head, normalised via the
// same head_alias map used by the register pipeline.
//
// Returns Map<normHeadKey, number> — total collection amount for each head.

import { readAllTabRows } from "../registers/sheetsApi.js";
import { normHead, normName } from "./names.js";
import { mgmtSources } from "./roster.js";
import headAliasJson from "../../../config/head_alias.json";

// Build the alias map once at module load (same as stateHeadRegisters.ts).
const headAliasByKey: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [raw, canonical] of Object.entries(
    headAliasJson as Record<string, string>,
  )) {
    m.set(normHead(raw), normName(canonical));
  }
  return m;
})();

function resolveHeadKey(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  const key = normHead(String(raw));
  if (!key) return null;
  return headAliasByKey.get(key) ?? key;
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const s = String(v).replace(/[,\s]/g, "");
  const n = Number(s);
  return Number.isFinite(n) && n !== 0 ? n : v === 0 || s === "0" ? 0 : null;
}

function toStr(v: unknown): string {
  return v == null ? "" : String(v).trim().toLowerCase();
}

// Returns a collection-amount map for a given FY by reading the PARTY O/S &
// PAYMENT sheet.  Falls back gracefully to an empty map if the sheet ID is
// not configured for that FY.
export async function loadCollectionForFy(
  fy: string,
): Promise<Map<string, number>> {
  const src = mgmtSources() as {
    party_os_payment?: { files_by_year: Record<string, string> };
  };
  const sheetId = src.party_os_payment?.files_by_year?.[fy];
  if (!sheetId) return new Map();

  // The sheet may have multiple tabs; read the first/default tab.
  const rows = await readAllTabRows(sheetId, "Sheet1").catch(async () => {
    // Some workbooks name the first tab differently — fall back to no-tab-arg
    // readAllTabRows requires a tab name; try common alternatives.
    return readAllTabRows(sheetId, "Party O/S & Payment").catch(async () => {
      return readAllTabRows(sheetId, "Data").catch(() => [] as unknown[][]);
    });
  });

  if (rows.length < 2) return new Map();

  // Detect column indices from the header row.
  const rawHeader = rows[0] ?? [];
  const header = rawHeader.map((v) => toStr(v));

  const fc = (needle: string): number =>
    header.findIndex((h) => h.includes(needle));

  const iType       = fc("type");
  const iAmount     = fc("amount") >= 0 ? fc("amount") : fc("amt");
  const iStateHead  =
    fc("state head") >= 0 ? fc("state head") :
    fc("s.head") >= 0    ? fc("s.head") :
    fc("head");

  if (iType < 0 || iAmount < 0) return new Map();

  const result = new Map<string, number>();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const type = toStr(r[iType]);
    if (!type.includes("pymt") && !type.includes("payment")) continue;

    const amt = toNum(r[iAmount]);
    if (amt == null || amt <= 0) continue;

    const headKey = iStateHead >= 0 ? resolveHeadKey(r[iStateHead]) : null;
    if (!headKey) continue;

    result.set(headKey, (result.get(headKey) ?? 0) + amt);
  }

  return result;
}
