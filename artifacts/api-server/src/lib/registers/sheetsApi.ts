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
  const url = `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=google-drive`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Replit-Token": xReplitToken },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch google-drive connection (${res.status})`);
  }
  const data = (await res.json()) as {
    items?: Array<{
      settings?: {
        access_token?: string;
        expires_at?: string;
        oauth?: { credentials?: { access_token?: string; expires_at?: string } };
      };
    }>;
  };
  const settings = data.items?.[0]?.settings;
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

// ---------------------------------------------------------------------------
// Writes — allowlisted spreadsheets only.
//
// The whole pipeline is read-only except the Target Master sheet. Every write
// path goes through assertWritable, so a bug elsewhere can never write to a
// register, order, roster, or index sheet.
// ---------------------------------------------------------------------------

const writableSheetIds = new Set<string>();

export function registerWritableSheet(spreadsheetId: string): void {
  if (spreadsheetId) writableSheetIds.add(spreadsheetId);
}

function assertWritable(spreadsheetId: string): void {
  if (!writableSheetIds.has(spreadsheetId)) {
    throw new Error(
      `Refusing to write to spreadsheet ${spreadsheetId}: it is not registered as writable`,
    );
  }
}

async function sheetsSend(
  path: string,
  method: "POST" | "PUT",
  body: unknown,
): Promise<unknown> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const token = await getGoogleAccessToken();
    const res = await fetch(`${SHEETS_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const text = await res.text().catch(() => "");
    lastError = new Error(
      `Sheets API write failed (${res.status}): ${text.slice(0, 300)}`,
    );
    if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) {
      throw lastError;
    }
    await sleep(attempt * 15_000);
  }
  throw lastError ?? new Error("Sheets API write failed");
}

// Creates a brand-new spreadsheet owned by the connected account and returns
// its id. The caller must registerWritableSheet() before writing to it. This
// does not touch any existing sheet, so it needs no allowlist check itself.
export async function createSpreadsheet(title: string): Promise<string> {
  const data = (await sheetsSend("", "POST", {
    properties: { title },
  })) as { spreadsheetId?: string };
  if (!data.spreadsheetId) {
    throw new Error("Sheets API returned no spreadsheetId on create");
  }
  return data.spreadsheetId;
}

// Clears every value in the given A1 range (formatting is kept).
export async function clearValues(
  spreadsheetId: string,
  range: string,
): Promise<void> {
  assertWritable(spreadsheetId);
  await sheetsSend(
    `/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`,
    "POST",
    {},
  );
}

// Updates one or more explicit ranges in a single batch (RAW input).
export async function updateValuesBatch(
  spreadsheetId: string,
  data: Array<{ range: string; values: SheetCellValue[][] }>,
): Promise<void> {
  assertWritable(spreadsheetId);
  if (data.length === 0) return;
  await sheetsSend(`/${spreadsheetId}/values:batchUpdate`, "POST", {
    valueInputOption: "RAW",
    data,
  });
}

// Appends rows after the last data row of the tab (RAW input).
export async function appendValues(
  spreadsheetId: string,
  title: string,
  values: SheetCellValue[][],
): Promise<void> {
  assertWritable(spreadsheetId);
  if (values.length === 0) return;
  const range = encodeURIComponent(`${quoteTitle(title)}!A1`);
  await sheetsSend(
    `/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    "POST",
    { values },
  );
}
