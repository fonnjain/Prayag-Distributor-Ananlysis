// State-Head dispatched-sale register reader (the Sale side of the
// management report).
//
// Source: the "State Heads" Drive folder — one workbook per head per FY,
// titled "<Head> <FY>" (e.g. "Anant Singh JI 2026-27"). Each workbook is the
// company sale register filtered to that head and holds TWO fiscal years;
// rows are filtered on the FY column, never the file title.
//
// The register tab has NO header row in some workbooks and sits among pivot
// tabs, so it is detected by content: a tab where sampled rows carry a date
// serial in column B, a numeric Amount in column H, and an "FY-YYYY-YY"
// label in column N/O. Columns (fixed order, verified against the live
// files): Invoice, Date, Customer(party), Code, Month, Qty, Rate, Amount,
// Group, Station, State, State Head, Type, FY, FY.
//
// Reads go through chunked values.get only — never files.export. Every
// workbook load records a status so the report and the options endpoint can
// surface the real failure (403 not shared / 404 wrong id / no register tab)
// instead of a silent blank.
import { logger } from "../logger.js";
import {
  readTabRowsChunked,
  listSheetTabs,
  getGoogleAccessToken,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import { normName, fiscalMonthIndex } from "./names.js";
import { mgmtSources } from "./roster.js";

export type PartyAgg = {
  amount: number;
  // Fiscal months Apr(0)..Mar(11).
  monthAmount: number[];
  invoiceIds: Set<string>;
  monthInvoiceIds: Array<Set<string>>;
};

export type FyRegisterAgg = {
  fy: string;
  amount: number;
  rows: number;
  invoiceIds: Set<string>;
  // Customer(party) -> per-party aggregate, so a Party -> Team Member bridge
  // can split Sale down to member grain (incl. monthly) without a re-read.
  parties: Map<string, PartyAgg>;
  // Fiscal months Apr(0)..Mar(11).
  monthAmount: number[];
  // Raw Group label -> amount (for INDEX-map reconciliation).
  groupAmount: Map<string, number>;
};

export type HeadRegisterAgg = {
  // normName of the dominant State Head column value in the file.
  headKey: string;
  // The State Head column value as written in the register.
  headDisplay: string;
  fileId: string;
  fileName: string;
  registerTab: string;
  rowsRead: number;
  byFy: Map<string, FyRegisterAgg>;
};

export type RegisterLoadStatus = {
  fileId: string;
  fileName: string;
  status: "ok" | "error";
  httpStatus?: number;
  detail: string;
  rowsRead?: number;
};

export type StateHeadRegisters = {
  byHead: Map<string, HeadRegisterAgg>;
  statuses: RegisterLoadStatus[];
  folderError: string | null;
  loadedAt: number;
};

const TTL_MS = 15 * 60_000;
let cache: StateHeadRegisters | null = null;
let inFlight: Promise<StateHeadRegisters> | null = null;

type FolderFile = { id: string; name: string };

async function listFolderWorkbooks(folderId: string): Promise<FolderFile[]> {
  const token = await getGoogleAccessToken();
  const q = encodeURIComponent(
    `'${folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.spreadsheet'`,
  );
  const files: FolderFile[] = [];
  let pageToken = "";
  do {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name)&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Drive folder listing failed (${res.status}): ${body.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as {
      nextPageToken?: string;
      files?: FolderFile[];
    };
    files.push(...(data.files ?? []));
    pageToken = data.nextPageToken ?? "";
  } while (pageToken);
  return files;
}

// "FY-2025-26" / "FY 2025-26" / "2025-26" -> "2025-26"; null when the cell is
// not an FY label (also rejects pivot debris like "#REF! ...").
function parseFyLabel(v: SheetCellValue): string | null {
  const m = /(\d{4})\s*-\s*(\d{2})\s*$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const start = Number(m[1]);
  if (start < 2000 || start > 2100) return null;
  if ((start + 1) % 100 !== Number(m[2])) return null;
  return `${m[1]}-${m[2]}`;
}

function isDateSerial(v: SheetCellValue): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 20_000 && v < 80_000;
}

// A row "looks like" a register line when Date(B) is a serial, Amount(H) is
// numeric, and the FY column (N, falling back to O) carries an FY label.
function looksLikeRegisterRow(r: SheetCellValue[]): boolean {
  if (!isDateSerial(r[1])) return false;
  if (typeof r[7] !== "number" || !Number.isFinite(r[7])) return false;
  return parseFyLabel(r[13]) != null || parseFyLabel(r[14]) != null;
}

// Detect the register tab by content. Samples the first rows of each tab
// (largest first — the register is a big flat tab) and picks the first whose
// sample carries at least two register-shaped rows.
async function detectRegisterTab(
  spreadsheetId: string,
): Promise<string | null> {
  const tabs = await listSheetTabs(spreadsheetId);
  const ordered = [...tabs].sort((a, b) => b.rowCount - a.rowCount);
  const token = await getGoogleAccessToken();
  for (const tab of ordered) {
    if (tab.rowCount < 2) continue;
    const range = encodeURIComponent(`'${tab.title}'!A1:O8`);
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) continue;
    const data = (await res.json()) as { values?: SheetCellValue[][] };
    const rows = data.values ?? [];
    let hits = 0;
    for (const r of rows) if (looksLikeRegisterRow(r)) hits++;
    if (hits >= 2) return tab.title;
  }
  return null;
}

function googleStatus(err: unknown): number | undefined {
  const m = /\((\d{3})\)/.exec(err instanceof Error ? err.message : String(err));
  return m ? Number(m[1]) : undefined;
}

function failureDetail(file: FolderFile, err: unknown): RegisterLoadStatus {
  const httpStatus = googleStatus(err);
  const raw = err instanceof Error ? err.message : String(err);
  let detail: string;
  if (httpStatus === 403) {
    detail =
      `Google returned 403 (not shared) reading State-Head register "${file.name}" ` +
      `(file id ${file.id}). Share it with the connected Google account, then refresh.`;
  } else if (httpStatus === 404) {
    detail =
      `Google returned 404 (file not found) for State-Head register "${file.name}" ` +
      `(file id ${file.id}). The id looks wrong or the file was deleted.`;
  } else {
    detail = `Reading State-Head register "${file.name}" (${file.id}) failed: ${raw.slice(0, 300)}`;
  }
  return { fileId: file.id, fileName: file.name, status: "error", httpStatus, detail };
}

async function loadOneWorkbook(
  file: FolderFile,
): Promise<{ agg: HeadRegisterAgg | null; status: RegisterLoadStatus }> {
  let registerTab: string | null;
  try {
    registerTab = await detectRegisterTab(file.id);
  } catch (err) {
    return { agg: null, status: failureDetail(file, err) };
  }
  if (!registerTab) {
    return {
      agg: null,
      status: {
        fileId: file.id,
        fileName: file.name,
        status: "error",
        detail:
          `No register tab detected in "${file.name}" (${file.id}); expected a tab whose rows ` +
          `carry a date serial, a numeric Amount and an FY-YYYY-YY label in the fixed register columns.`,
      },
    };
  }
  const byFy = new Map<string, FyRegisterAgg>();
  const headCounts = new Map<string, { display: string; n: number }>();
  let rowsRead = 0;
  let skippedNonRegister = 0;
  try {
    ({ rowsRead } = await readTabRowsChunked(file.id, registerTab, (rows) => {
      for (const r of rows) {
        if (r == null) continue;
        const fy = parseFyLabel(r[13]) ?? parseFyLabel(r[14]);
        const amount = typeof r[7] === "number" ? r[7] : Number(r[7]);
        if (fy == null || !Number.isFinite(amount)) {
          skippedNonRegister++;
          continue;
        }
        let agg = byFy.get(fy);
        if (!agg) {
          agg = {
            fy,
            amount: 0,
            rows: 0,
            invoiceIds: new Set<string>(),
            parties: new Map<string, PartyAgg>(),
            monthAmount: new Array(12).fill(0) as number[],
            groupAmount: new Map<string, number>(),
          };
          byFy.set(fy, agg);
        }
        agg.amount += amount;
        agg.rows++;
        const invoice = String(r[0] ?? "").trim();
        if (invoice) agg.invoiceIds.add(invoice);
        const dateSerial = isDateSerial(r[1])
          ? (r[1] as number)
          : isDateSerial(r[4])
            ? (r[4] as number)
            : null;
        const mIdx =
          dateSerial != null ? fiscalMonthIndex(Math.round(dateSerial), fy) : null;
        if (mIdx != null) agg.monthAmount[mIdx] += amount;
        const party = String(r[2] ?? "").trim().toUpperCase();
        if (party) {
          let pa = agg.parties.get(party);
          if (!pa) {
            pa = {
              amount: 0,
              monthAmount: new Array(12).fill(0) as number[],
              invoiceIds: new Set<string>(),
              monthInvoiceIds: Array.from({ length: 12 }, () => new Set<string>()),
            };
            agg.parties.set(party, pa);
          }
          pa.amount += amount;
          if (invoice) pa.invoiceIds.add(invoice);
          if (mIdx != null) {
            pa.monthAmount[mIdx] += amount;
            if (invoice) pa.monthInvoiceIds[mIdx].add(invoice);
          }
        }
        const group = String(r[8] ?? "").trim();
        if (group) {
          agg.groupAmount.set(group, (agg.groupAmount.get(group) ?? 0) + amount);
        }
        const head = String(r[11] ?? "").trim();
        if (head) {
          const key = normName(head);
          const hc = headCounts.get(key);
          if (hc) hc.n++;
          else headCounts.set(key, { display: head, n: 1 });
        }
      }
    }));
  } catch (err) {
    return { agg: null, status: failureDetail(file, err) };
  }
  let headKey = "";
  let headDisplay = file.name.replace(/\s*\d{4}-\d{2}\s*$/, "").trim();
  let best = 0;
  for (const [key, hc] of headCounts) {
    if (hc.n > best) {
      best = hc.n;
      headKey = key;
      headDisplay = hc.display;
    }
  }
  if (!headKey) headKey = normName(headDisplay);
  const agg: HeadRegisterAgg = {
    headKey,
    headDisplay,
    fileId: file.id,
    fileName: file.name,
    registerTab,
    rowsRead,
    byFy,
  };
  const fySummary = [...byFy.values()]
    .map((f) => `${f.fy}: ${Math.round(f.amount)} across ${f.rows} rows`)
    .join("; ");
  logger.info(
    {
      fileName: file.name,
      fileId: file.id,
      registerTab,
      rowsRead,
      skippedNonRegister,
      head: headDisplay,
      fySummary,
    },
    "state-head register read via chunked values.get",
  );
  return {
    agg,
    status: {
      fileId: file.id,
      fileName: file.name,
      status: "ok",
      detail: `Read ${rowsRead} rows from tab "${registerTab}" (${fySummary}).`,
      rowsRead,
    },
  };
}

async function loadUncached(): Promise<StateHeadRegisters> {
  const folderId = mgmtSources().state_head_registers.folderId;
  let files: FolderFile[];
  try {
    files = await listFolderWorkbooks(folderId);
  } catch (err) {
    const detail = `Could not list the State Heads Drive folder ${folderId}: ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ folderId, err }, "state heads folder listing failed");
    return {
      byHead: new Map(),
      statuses: [],
      folderError: detail,
      loadedAt: Date.now(),
    };
  }
  if (files.length === 0) {
    return {
      byHead: new Map(),
      statuses: [],
      folderError: `The State Heads Drive folder ${folderId} contains no spreadsheets.`,
      loadedAt: Date.now(),
    };
  }
  const results: Array<{ agg: HeadRegisterAgg | null; status: RegisterLoadStatus }> =
    new Array(files.length);
  // Modest concurrency: each workbook costs a tab listing + a handful of
  // sample reads + 1-2 chunked reads; 3 in parallel stays well under quota.
  const POOL = 3;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const i = next++;
      results[i] = await loadOneWorkbook(files[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, files.length) }, worker));
  const byHead = new Map<string, HeadRegisterAgg>();
  const statuses: RegisterLoadStatus[] = [];
  for (const r of results) {
    statuses.push(r.status);
    if (!r.agg) continue;
    const existing = byHead.get(r.agg.headKey);
    if (!existing) {
      byHead.set(r.agg.headKey, r.agg);
      continue;
    }
    // Two workbooks for the same head (different FY files): merge FY blocks.
    existing.rowsRead += r.agg.rowsRead;
    for (const [fy, fyAgg] of r.agg.byFy) {
      const cur = existing.byFy.get(fy);
      if (!cur) {
        existing.byFy.set(fy, fyAgg);
        continue;
      }
      cur.amount += fyAgg.amount;
      cur.rows += fyAgg.rows;
      for (const id of fyAgg.invoiceIds) cur.invoiceIds.add(id);
      for (const [p, pa] of fyAgg.parties) {
        const curPa = cur.parties.get(p);
        if (!curPa) {
          cur.parties.set(p, pa);
          continue;
        }
        curPa.amount += pa.amount;
        for (const id of pa.invoiceIds) curPa.invoiceIds.add(id);
        for (let i = 0; i < 12; i++) {
          curPa.monthAmount[i] += pa.monthAmount[i];
          for (const id of pa.monthInvoiceIds[i]) curPa.monthInvoiceIds[i].add(id);
        }
      }
      for (let i = 0; i < 12; i++) cur.monthAmount[i] += fyAgg.monthAmount[i];
      for (const [g, a] of fyAgg.groupAmount) {
        cur.groupAmount.set(g, (cur.groupAmount.get(g) ?? 0) + a);
      }
    }
  }
  const failed = statuses.filter((s) => s.status === "error");
  logger.info(
    {
      workbooks: files.length,
      heads: byHead.size,
      failed: failed.length,
    },
    "state-head register load complete",
  );
  for (const f of failed) {
    logger.error(
      { fileId: f.fileId, fileName: f.fileName, httpStatus: f.httpStatus },
      f.detail,
    );
  }
  return { byHead, statuses, folderError: null, loadedAt: Date.now() };
}

export async function loadStateHeadRegisters(): Promise<StateHeadRegisters> {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) return cache;
  if (inFlight) return inFlight;
  inFlight = loadUncached()
    .then((r) => {
      cache = r;
      return r;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function invalidateStateHeadRegisterCache(): void {
  cache = null;
}

// Last successful load, if any — used by the options endpoint to surface a
// precise status without triggering a full multi-workbook read.
export function getCachedStateHeadRegisters(): StateHeadRegisters | null {
  return cache;
}

// Cheap connectivity check: counts the register workbooks in the State Heads
// folder without reading any of them.
export async function countStateHeadWorkbooks(): Promise<number> {
  const folderId = mgmtSources().state_head_registers.folderId;
  return (await listFolderWorkbooks(folderId)).length;
}
