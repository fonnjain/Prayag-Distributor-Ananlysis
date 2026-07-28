// Google Sheets API client with chunked value reads.
//
// Replaces the old Drive `files.export` path entirely: export fails for
// spreadsheets over ~10 MB, and the sale registers are far past that. Instead
// we call `spreadsheets.values.get` in 50k-row A1 chunks, which works for any
// sheet size.
//
// Auth: the connector proxy does not expose the Sheets API surface (only
// Drive), so we fetch the google-drive connection's OAuth access token from
// the Replit connectors endpoint and call sheets.googleapis.com directly.
// Tokens expire, so the token is re-fetched when close to expiry.
//
// Dates: we request UNFORMATTED_VALUE + SERIAL_NUMBER so date cells arrive as
// Excel serial numbers — the exact representation the xlsx backfill path
// normalizes, keeping line_uid stable across sources. (The spec suggested
// FORMATTED_STRING; SERIAL_NUMBER is deliberate — formatted strings depend on
// the spreadsheet locale and would produce different uids.)

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
export const SHEETS_CHUNK_ROWS = 50_000;

type TokenCache = { accessToken: string; expiresAtMs: number };
let tokenCache: TokenCache | null = null;

export async function getGoogleAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAtMs - 60_000) {
    return tokenCache.accessToken;
  }
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!hostname) {
    throw new Error("REPLIT_CONNECTORS_HOSTNAME is not set");
  }
  const xReplitToken = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL
      ? `depl ${process.env.WEB_REPL_RENEWAL}`
      : null;
  if (!xReplitToken) {
    throw new Error(
      "No Replit identity token available to fetch the Google connection",
    );
  }
  // connector_names filter param is not recognised by this connectors version —
  // fetch all connections and pick the google-drive one by connector_name field.
  const url = `https://${hostname}/api/v2/connection?include_secrets=true`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Replit-Token": xReplitToken },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch google-drive connection (${res.status})`);
  }
  const data = (await res.json()) as {
    items?: Array<{
      connector_name?: string;
      settings?: {
        access_token?: string;
        expires_at?: string;
        oauth?: { credentials?: { access_token?: string; expires_at?: string } };
      };
    }>;
  };
  const item = (data.items ?? []).find(
    (c) => c.connector_name === "google-drive",
  );
  const settings = item?.settings;
  const accessToken =
    settings?.access_token ?? settings?.oauth?.credentials?.access_token;
  if (!accessToken) {
    throw new Error("google-drive connection has no access token");
  }
  const expiresAt =
    settings?.expires_at ?? settings?.oauth?.credentials?.expires_at;
  tokenCache = {
    accessToken,
    expiresAtMs: expiresAt
      ? new Date(expiresAt).getTime()
      : Date.now() + 5 * 60_000,
  };
  return accessToken;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503]);
const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sheetsGet(path: string): Promise<unknown> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const token = await getGoogleAccessToken();
    const res = await fetch(`${SHEETS_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return res.json();
    const body = await res.text().catch(() => "");
    lastError = new Error(
      `Sheets API request failed (${res.status}): ${body.slice(0, 300)}`,
    );
    if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) {
      throw lastError;
    }
    // 429 is a per-minute read quota; back off long enough for it to reset.
    await sleep(attempt * 15_000);
  }
  throw lastError ?? new Error("Sheets API request failed");
}

// A1 sheet titles with spaces/quotes must be quoted.
function quoteTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

export type SheetTab = { title: string; rowCount: number };

export async function listSheetTabs(spreadsheetId: string): Promise<SheetTab[]> {
  const data = (await sheetsGet(
    `/${spreadsheetId}?fields=sheets.properties(title,gridProperties(rowCount))`,
  )) as {
    sheets?: Array<{
      properties?: { title?: string; gridProperties?: { rowCount?: number } };
    }>;
  };
  return (data.sheets ?? []).map((s) => ({
    title: s.properties?.title ?? "",
    rowCount: s.properties?.gridProperties?.rowCount ?? 0,
  }));
}

export type SheetCellValue = string | number | boolean | null;

// Reads every populated row of one tab in 50k-row chunks. Values arrive
// UNFORMATTED with dates as Excel serial numbers. The Sheets API omits
// trailing empty cells and rows; rows are returned as-is (0-indexed arrays).
export async function readTabRowsChunked(
  spreadsheetId: string,
  title: string,
  onChunk: (rows: SheetCellValue[][], startRowNumber: number) => void,
): Promise<{ rowsRead: number }> {
  let start = 1;
  let rowsRead = 0;
  for (;;) {
    const end = start + SHEETS_CHUNK_ROWS - 1;
    const range = `${quoteTitle(title)}!${start}:${end}`;
    const data = (await sheetsGet(
      `/${spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
    )) as { values?: SheetCellValue[][] };
    const rows = data.values ?? [];
    if (rows.length > 0) {
      onChunk(rows, start);
      rowsRead += rows.length;
    }
    // The API trims trailing empty rows, so a short chunk means we're done.
    if (rows.length < SHEETS_CHUNK_ROWS) break;
    start = end + 1;
  }
  return { rowsRead };
}

// Reads a small A1-range sample of one tab (used for register-tab detection).
// Goes through sheetsGet so 429/5xx are retried instead of silently failing.
export async function readTabSample(
  spreadsheetId: string,
  title: string,
  cellRange: string,
): Promise<SheetCellValue[][]> {
  const range = `${quoteTitle(title)}!${cellRange}`;
  const data = (await sheetsGet(
    `/${spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
  )) as { values?: SheetCellValue[][] };
  return data.values ?? [];
}

export async function readAllTabRows(
  spreadsheetId: string,
  title: string,
): Promise<SheetCellValue[][]> {
  const all: SheetCellValue[][] = [];
  await readTabRowsChunked(spreadsheetId, title, (rows) => {
    all.push(...rows);
  });
  return all;
}

// ── CSV export reader ─────────────────────────────────────────────────────────
//
// Reads a single tab via the Drive CSV export endpoint instead of the Sheets
// values.get API.  The critical difference: Drive export forces a full
// recalculation of every formula in the tab before returning, including
// cross-file IMPORTRANGE references.  The values.get endpoint with
// UNFORMATTED_VALUE returns a server-side cache for IMPORTRANGE cells that can
// lag days behind the actual formula result.
//
// Use this path for tabs whose cells contain IMPORTRANGE or other cross-file
// formulas where freshness matters.  For pure-data tabs (registers, SOBR) the
// chunked path is preferred because it handles arbitrarily large sheets.
//
// CSV format notes:
//   - Google Sheets exports numbers without thousands separators in CSV.
//   - Percentage cells export as "67.76%" (the displayed string).
//   - Date cells export as a locale-formatted string (e.g. "01/04/2026").
//   - Empty trailing cells per row are omitted (same as values.get).
//   - The caller's cellNum must handle "%" strings (divide by 100).

async function getTabGid(spreadsheetId: string, title: string): Promise<number> {
  const data = (await sheetsGet(
    `/${spreadsheetId}?fields=sheets.properties(title,sheetId)`,
  )) as {
    sheets?: Array<{ properties?: { title?: string; sheetId?: number } }>;
  };
  const sheet = (data.sheets ?? []).find((s) => s.properties?.title === title);
  if (sheet?.properties?.sheetId == null) {
    throw new Error(
      `Tab "${title}" not found in spreadsheet ${spreadsheetId}`,
    );
  }
  return sheet.properties.sheetId;
}

function parseCsvToRows(text: string): SheetCellValue[][] {
  const rows: SheetCellValue[][] = [];
  const len = text.length;
  let i = 0;

  while (i <= len) {
    // End of input.
    if (i === len) break;

    const row: SheetCellValue[] = [];
    let firstField = true;

    // Parse one row — stop at unquoted \n.
    rowLoop: while (i < len) {
      if (!firstField) {
        // Expect comma separator between fields.
        if (text[i] === ",") {
          i++;
        } else if (text[i] === "\r" || text[i] === "\n") {
          break rowLoop; // end of row
        }
      }
      firstField = false;

      if (i >= len || text[i] === "\r" || text[i] === "\n") {
        // Trailing comma → one more empty field, then end of row.
        row.push(null);
        break rowLoop;
      }

      if (text[i] === '"') {
        // RFC 4180 quoted field.
        i++; // skip opening quote
        let field = "";
        while (i < len) {
          if (text[i] === '"') {
            if (i + 1 < len && text[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++; // skip closing quote
              break;
            }
          } else {
            field += text[i];
            i++;
          }
        }
        row.push(field === "" ? null : field);
      } else {
        // Unquoted field — read until comma or end-of-row.
        let start = i;
        while (i < len && text[i] !== "," && text[i] !== "\r" && text[i] !== "\n") {
          i++;
        }
        const field = text.slice(start, i);
        row.push(field === "" ? null : field);
      }
    }

    // Consume CRLF or LF line ending.
    if (i < len && text[i] === "\r") i++;
    if (i < len && text[i] === "\n") i++;

    rows.push(row);
  }

  return rows;
}

export async function readTabRowsViaExport(
  spreadsheetId: string,
  title: string,
): Promise<SheetCellValue[][]> {
  const gid = await getTabGid(spreadsheetId, title);
  const token = await getGoogleAccessToken();
  const url =
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}` +
    `/export?format=csv&gid=${gid}`;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "follow",
    });
    if (res.ok) {
      const text = await res.text();
      return parseCsvToRows(text);
    }
    const body = await res.text().catch(() => "");
    lastError = new Error(
      `CSV export failed (${res.status}): ${body.slice(0, 300)}`,
    );
    if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) {
      throw lastError;
    }
    await sleep(attempt * 15_000);
  }
  throw lastError ?? new Error("CSV export failed");
}

