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
// head_alias.json retired — alias map now comes from person_registry DB table.
import { headAliasLookup as _registryAliasLookup } from "../personRegistry.js";
import { logger } from "../logger.js";
import { createHash } from "node:crypto";
import {
  readTabRowsChunked,
  readTabSample,
  readTabFormulaSample,
  listSheetTabs,
  getGoogleAccessToken,
  type SheetCellValue,
} from "../registers/sheetsApi.js";
import { normHead, fiscalMonthIndex } from "./names.js";
import { mgmtSources } from "./roster.js";
import {
  classifyStateHeadPackFile,
  configuredStateHeadPackPolicy,
  manifestConflictFileIds,
  manifestBlockers,
  createStateHeadPackPeriodIntegrity,
  recordStateHeadPackPeriodRow,
  stateHeadPackPeriodIntegrityBlockers,
  type StateHeadPackPeriodIntegrity,
  type StateHeadPackManifestEntry,
} from "./stateHeadPack.js";

// Canonical bucket for register STATE HEAD values that are channels, not
// people (PROJECT / GOVT / GEM / JJM / OTHER and blanks in channel files).
// Their sale stays in the company total on its own summary line and is never
// attributed to a team member.
export const NON_TERRITORY_HEAD = "Non-territory (Project/Govt/GeM/JJM)";
// Canonical bucket for STATE HEAD values that are neither in the alias map
// nor institutional. Never silently dropped: bucketed here and listed on the
// Missing Data tab as "unmapped state head: <value>".
export const UNMAPPED_HEAD = "Unmapped (review)";

const INSTITUTIONAL_KEYS = new Set(["project", "govt", "gem", "jjm", "other"]);

// normHead(register spelling) -> canonical roster display name. Canonical
// names map to themselves so already-correct spellings pass through.
// _registryAliasLookup stores UPPERCASE keys; normHead returns lowercase.
// This helper bridges the two normalizations.
function aliasLookupByNormHead(key: string): string | undefined {
  for (const [rk, rv] of _registryAliasLookup) {
    if (normHead(rk) === key) return rv;
  }
  return undefined;
}
const headAliasByKey = {
  get: aliasLookupByNormHead,
  has: (key: string) => aliasLookupByNormHead(key) !== undefined,
};

// Resolve a raw register STATE HEAD value. Blank values are decided by the
// caller (they inherit the file's dominant head when one exists).
function resolveRegisterHead(
  raw: string,
): { display: string; kind: HeadKind } | null {
  const key = normHead(raw);
  if (!key) return null;
  if (INSTITUTIONAL_KEYS.has(key)) {
    return { display: NON_TERRITORY_HEAD, kind: "nonTerritory" };
  }
  const canonical = headAliasByKey.get(key);
  if (canonical) return { display: canonical, kind: "head" };
  return { display: raw, kind: "unmapped" };
}

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

// "head" = a canonical team-member state head (alias-mapped). "nonTerritory"
// = the institutional channel bucket. "unmapped" = a STATE HEAD value the
// alias map does not know; kept per raw value so the Missing Data tab can
// list it, and bucketed under UNMAPPED_HEAD on the report.
export type HeadKind = "head" | "nonTerritory" | "unmapped";

export type HeadRegisterAgg = {
  // normHead of the canonical display (kind "head"), or a fixed bucket key.
  headKey: string;
  // Canonical roster display name, NON_TERRITORY_HEAD, or the raw unmapped
  // register value.
  headDisplay: string;
  kind: HeadKind;
  fileId: string;
  fileName: string;
  registerTab: string;
  rowsRead: number;
  byFy: Map<string, FyRegisterAgg>;
  /** FY-labelled raw total before transaction-date filtering. */
  headlineByFy: Map<string, { amount: number }>;
};

export type RegisterLoadStatus = {
  fileId: string;
  fileName: string;
  status: "ok" | "error" | "excluded" | "skipped";
  httpStatus?: number;
  detail: string;
  rowsRead?: number;
};

export type StateHeadRegisters = {
  byHead: Map<string, HeadRegisterAgg>;
  statuses: RegisterLoadStatus[];
  /** Read-only folder manifest used by the release reconciliation check. */
  manifest: StateHeadPackManifestEntry[];
  /** Human-readable warnings for excluded temporary/duplicate files. */
  packWarnings: string[];
  /** Mixed/non-head feeders that prevent a reconciled head pack. */
  packBlockers: string[];
  folderError: string | null;
  loadedAt: number;
};

const TTL_MS = 15 * 60_000;
const cacheByFolder = new Map<string, StateHeadRegisters>();
const inFlightByFolder = new Map<string, Promise<StateHeadRegisters>>();

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

type RegisterTabSchema = {
  name: "state-head-register-v2" | "state-head-register-legacy";
  dateIndexes: number[];
  amountIndex: number;
  fyIndexes: number[];
  invoiceIndex: number;
  partyIndex: number;
  groupIndex: number;
  headIndex: number;
};

type RegisterTab = RegisterTabSchema & {
  title: string;
  reportTab: string | null;
};

// The current folder contains two raw layouts. The v2 layout is the documented
// 15-column register. Historical FY2025-26 workbooks have the older Sheet1
// layout where Report 1 pivots FY from column M. Both must be audited: silently
// recognizing only one layout would turn a hard pack gate into a bypass.
const REGISTER_TAB_SCHEMAS: RegisterTabSchema[] = [
  {
    name: "state-head-register-v2",
    dateIndexes: [1, 4],
    amountIndex: 7,
    fyIndexes: [13, 14],
    invoiceIndex: 0,
    partyIndex: 2,
    groupIndex: 8,
    headIndex: 11,
  },
  {
    name: "state-head-register-legacy",
    dateIndexes: [2],
    amountIndex: 5,
    // Column M is the Report 1 pivot field; K is retained only as a fallback.
    fyIndexes: [12, 10],
    invoiceIndex: 1,
    partyIndex: 0,
    groupIndex: 6,
    headIndex: 9,
  },
];

function rowFy(r: SheetCellValue[], schema: RegisterTabSchema): string | null {
  for (const index of schema.fyIndexes) {
    const fy = parseFyLabel(r[index]);
    if (fy) return fy;
  }
  return null;
}

function rowDateSerial(
  r: SheetCellValue[],
  schema: RegisterTabSchema,
): number | null {
  for (const index of schema.dateIndexes) {
    if (isDateSerial(r[index])) return r[index] as number;
  }
  return null;
}

function rowAmount(r: SheetCellValue[], schema: RegisterTabSchema): number | null {
  const raw = r[schema.amountIndex];
  const amount = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(amount) ? amount : null;
}

function looksLikeRegisterRow(
  r: SheetCellValue[],
  schema: RegisterTabSchema,
): boolean {
  return rowDateSerial(r, schema) != null && rowAmount(r, schema) != null && rowFy(r, schema) != null;
}

// Detect the register tab by content. State Head source packs conventionally
// keep raw transactions in Sheet1, so inspect it first to avoid spending a
// quota read on every Report tab. The content test remains authoritative and
// all other tabs are still searched as a fallback.
async function detectRegisterTab(
  spreadsheetId: string,
): Promise<RegisterTab | null> {
  const tabs = await listSheetTabs(spreadsheetId);
  const tabPriority = (title: string): number => {
    const normalized = title.trim().toLowerCase();
    if (normalized === "sheet1") return 0;
    if (normalized === "data" || normalized === "data sheet") return 1;
    return 2;
  };
  const ordered = [...tabs].sort(
    (a, b) =>
      tabPriority(a.title) - tabPriority(b.title) || b.rowCount - a.rowCount,
  );
  const reportTab =
    tabs.find((tab) => tab.title.replace(/\s+/g, "").toLowerCase() === "report1")
      ?.title ?? null;
  let best: (RegisterTab & { hits: number; rowCount: number }) | null = null;
  for (const tab of ordered) {
    if (tab.rowCount < 2) continue;
    // readTabSample retries 429/5xx — a quota hiccup here used to silently
    // skip the tab and mis-report the workbook as having no register.
    const rows = await readTabSample(spreadsheetId, tab.title, "A1:O8");
    for (const schema of REGISTER_TAB_SCHEMAS) {
      let hits = 0;
      for (const r of rows) if (looksLikeRegisterRow(r, schema)) hits++;
      if (
        hits >= 2 &&
        (!best || hits > best.hits || (hits === best.hits && tab.rowCount > best.rowCount))
      ) {
        const detected: RegisterTab & { hits: number; rowCount: number } = {
          ...schema,
          title: tab.title,
          reportTab,
          hits,
          rowCount: tab.rowCount,
        };
        // A content-confirmed Sheet1 is the established raw-data convention
        // for both supported layouts. Returning here avoids sampling dozens of
        // report tabs and exhausting the per-minute Sheets read quota.
        if (tabPriority(tab.title) === 0) return detected;
        best = detected;
      }
    }
  }
  return best;
}

function currentExcelDateSerial(): number {
  const now = new Date();
  const utcDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return Math.floor((utcDay - Date.UTC(1899, 11, 30)) / 86_400_000);
}

function reportFormulaSource(rows: SheetCellValue[][]): string | null {
  for (const row of rows) {
    for (const cell of row) {
      if (typeof cell !== "string" || !cell.startsWith("=")) continue;
      const query = /QUERY\(\s*([^,]+)/i.exec(cell);
      if (query) return `QUERY(${query[1].replace(/\$/g, "")})`;
      const source = /(?:'[^']+'|[A-Za-z0-9_ ]+)!A\d+:[A-Z]+\d+/i.exec(cell);
      if (source) return source[0].replace(/\$/g, "");
    }
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

// Merge a source per-FY aggregate map into a target (used when several raw
// head spellings collapse to one canonical head, and when several workbooks
// carry the same head).
function mergeFyMaps(
  target: Map<string, FyRegisterAgg>,
  src: Map<string, FyRegisterAgg>,
): void {
  for (const [fy, fyAgg] of src) {
    const cur = target.get(fy);
    if (!cur) {
      target.set(fy, fyAgg);
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

async function loadOneWorkbook(
  file: FolderFile,
): Promise<{
  aggs: HeadRegisterAgg[];
  status: RegisterLoadStatus;
  manifest: StateHeadPackManifestEntry;
}> {
  // Read excluded workbooks for their Report 1 evidence, but never pass their
  // aggregates into byHead. This keeps the audit report useful (it can show
  // the duplicate ₹11.2800 Cr) without allowing it into released totals.
  let registerTab: RegisterTab | null;
  try {
    registerTab = await detectRegisterTab(file.id);
  } catch (err) {
    return {
      aggs: [],
      status: failureDetail(file, err),
      manifest: classifyStateHeadPackFile({
        fileId: file.id,
        fileName: file.name,
        evidence: [],
      }),
    };
  }
  if (!registerTab) {
    const manifest = classifyStateHeadPackFile({
      fileId: file.id,
      fileName: file.name,
      evidence: [],
    });
    return {
      aggs: [],
      status: {
        fileId: file.id,
        fileName: file.name,
        status: "error",
        detail:
          `No register tab detected in "${file.name}" (${file.id}); expected a tab whose rows ` +
            `carry a date serial, a numeric Amount and an FY-YYYY-YY label in a supported raw layout.`,
      },
      manifest,
    };
  }
  // First pass: aggregate per raw STATE HEAD value ("" for blank cells).
  // Grouping is per ROW, never per file — one workbook can carry several
  // heads plus institutional channel rows.
  type RawGroup = {
    /** Only date-valid raw rows are eligible for reconciliation. */
    byFy: Map<string, FyRegisterAgg>;
    /** The workbook's FY-labelled total (kept for audit compatibility). */
    headlineByFy: Map<string, { amount: number }>;
    rows: number;
  };
  const rawGroups = new Map<string, RawGroup>();
  const periodIntegrityByFy: Record<string, StateHeadPackPeriodIntegrity> = {};
  const rawDataHash = createHash("sha256");
  const asOfSerial = currentExcelDateSerial();
  let formulaSource: string | null = null;
  const reportTab = registerTab.reportTab ?? "Report 1";
  try {
    formulaSource = reportFormulaSource(
      await readTabFormulaSample(
        file.id,
        reportTab,
        "A1:Z8",
      ),
    );
  } catch (err) {
    logger.warn(
      { fileId: file.id, fileName: file.name, err },
      "could not read State Head Report 1 formula signature",
    );
  }
  let rowsRead = 0;
  let skippedNonRegister = 0;
  try {
    ({ rowsRead } = await readTabRowsChunked(file.id, registerTab.title, (rows) => {
      for (const r of rows) {
        if (r == null) continue;
        const fy = rowFy(r, registerTab);
        const amount = rowAmount(r, registerTab);
        if (fy == null || amount == null) {
          skippedNonRegister++;
          continue;
        }
        rawDataHash.update(JSON.stringify(r));
        rawDataHash.update("\n");
        const period = (periodIntegrityByFy[fy] ??=
          createStateHeadPackPeriodIntegrity());
        recordStateHeadPackPeriodRow(
          period,
          fy,
          { amount, dateSerial: rowDateSerial(r, registerTab) },
          asOfSerial,
        );
        const rawHead = String(r[registerTab.headIndex] ?? "").trim();
        let grp = rawGroups.get(rawHead);
        if (!grp) {
          grp = {
            byFy: new Map<string, FyRegisterAgg>(),
            headlineByFy: new Map<string, { amount: number }>(),
            rows: 0,
          };
          rawGroups.set(rawHead, grp);
        }
        grp.rows++;
        const headline = grp.headlineByFy.get(fy) ?? { amount: 0 };
        headline.amount += amount;
        grp.headlineByFy.set(fy, headline);
        // FY labels select this workbook's two comparison populations. The
        // date year is known to be wrong on legacy rows, so dates are audit
        // evidence rather than an inclusion gate.
        let agg = grp.byFy.get(fy);
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
          grp.byFy.set(fy, agg);
        }
        agg.amount += amount;
        agg.rows++;
        const invoice = String(r[registerTab.invoiceIndex] ?? "").trim();
        if (invoice) agg.invoiceIds.add(invoice);
        const dateSerial = rowDateSerial(r, registerTab);
        const mIdx =
          dateSerial != null ? fiscalMonthIndex(Math.round(dateSerial), fy) : null;
        if (mIdx != null) agg.monthAmount[mIdx] += amount;
        const party = String(r[registerTab.partyIndex] ?? "").trim().toUpperCase();
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
        const group = String(r[registerTab.groupIndex] ?? "").trim();
        if (group) {
          agg.groupAmount.set(group, (agg.groupAmount.get(group) ?? 0) + amount);
        }
      }
    }));
  } catch (err) {
    return {
      aggs: [],
      status: failureDetail(file, err),
      manifest: classifyStateHeadPackFile({
        fileId: file.id,
        fileName: file.name,
        evidence: [],
      }),
    };
  }
  // Second pass: resolve raw values to canonical heads / buckets. Blank
  // values inherit the file's dominant canonical head when one exists (a
  // head's own workbook often leaves the column empty on some rows); a file
  // with no head values at all is an institutional channel file.
  let dominantHead: string | null = null;
  let dominantRows = 0;
  for (const [raw, grp] of rawGroups) {
    if (!raw) continue;
    const res = resolveRegisterHead(raw);
    if (res && res.kind === "head" && grp.rows > dominantRows) {
      dominantHead = res.display;
      dominantRows = grp.rows;
    }
  }
  const byDisplay = new Map<string, HeadRegisterAgg>();
  const fold = (display: string, kind: HeadKind, grp: RawGroup): void => {
    const headKey =
      kind === "head"
        ? normHead(display)
        : kind === "nonTerritory"
          ? "bucket:nonterritory"
          : `unmapped:${normHead(display)}`;
    const existing = byDisplay.get(display);
    if (existing) {
      existing.rowsRead += grp.rows;
      mergeFyMaps(existing.byFy, grp.byFy);
      for (const [fy, headline] of grp.headlineByFy) {
        const current = existing.headlineByFy.get(fy) ?? { amount: 0 };
        current.amount += headline.amount;
        existing.headlineByFy.set(fy, current);
      }
      return;
    }
    byDisplay.set(display, {
      headKey,
      headDisplay: display,
      kind,
      fileId: file.id,
      fileName: file.name,
      registerTab: registerTab.title,
      rowsRead: grp.rows,
      byFy: grp.byFy,
      headlineByFy: grp.headlineByFy,
    });
  };
  for (const [raw, grp] of rawGroups) {
    if (!raw) {
      if (dominantHead) fold(dominantHead, "head", grp);
      else fold(NON_TERRITORY_HEAD, "nonTerritory", grp);
      continue;
    }
    const res = resolveRegisterHead(raw);
    if (!res) continue;
    fold(res.display, res.kind, grp);
  }
  const aggs = [...byDisplay.values()];
  const manifest = classifyStateHeadPackFile({
    fileId: file.id,
    fileName: file.name,
    evidence: aggs.map((agg) => ({
      headDisplay: agg.headDisplay,
      kind: agg.kind,
      byFy: new Map(
        [...agg.byFy].map(([fy, fyAgg]) => [fy, { amount: fyAgg.amount }]),
      ),
      headlineByFy: agg.headlineByFy,
    })),
    rawTab: registerTab.title,
    rawSchema: registerTab.name,
    reportFormulaSource: formulaSource,
    rawDataFingerprint: rawDataHash.digest("hex"),
    periodIntegrityByFy,
  });
  const headSummary = aggs
    .map((a) => {
      const fyPart = [...a.byFy.values()]
        .map((f) => `${f.fy}: ${Math.round(f.amount)}`)
        .join(", ");
      return `${a.headDisplay} [${a.kind}] (${fyPart})`;
    })
    .join("; ");
  logger.info(
    {
      fileName: file.name,
      fileId: file.id,
      registerTab: registerTab.title,
      registerSchema: registerTab.name,
      rowsRead,
      skippedNonRegister,
      heads: aggs.length,
      headSummary,
      classification: manifest.classification,
    },
    "state-head register read via chunked values.get",
  );
  return {
    // Mixed/non-head feeders stay visible in the manifest but never reach
    // the released byHead totals.
    aggs: manifest.included ? aggs : [],
    status: {
      fileId: file.id,
      fileName: file.name,
      status: manifest.included ? "ok" : "skipped",
      detail: manifest.included
        ? `Read ${rowsRead} rows from tab "${registerTab}" (${headSummary}).`
        : manifest.reason,
      rowsRead,
    },
    manifest,
  };
}

function folderIdForRequestedFy(requestedFy?: string): string {
  const source = mgmtSources().state_head_registers;
  return requestedFy ? source.folders_by_year?.[requestedFy] ?? source.folderId : source.folderId;
}

async function loadUncached(folderId: string): Promise<StateHeadRegisters> {
  let files: FolderFile[];
  try {
    files = await listFolderWorkbooks(folderId);
  } catch (err) {
    const detail = `Could not list the State Heads Drive folder ${folderId}: ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ folderId, err }, "state heads folder listing failed");
    return {
      byHead: new Map(),
      statuses: [],
      manifest: [],
      packWarnings: [],
      packBlockers: [],
      folderError: detail,
      loadedAt: Date.now(),
    };
  }
  if (files.length === 0) {
    return {
      byHead: new Map(),
      statuses: [],
      manifest: [],
      packWarnings: [],
      packBlockers: [],
      folderError: `The State Heads Drive folder ${folderId} contains no spreadsheets.`,
      loadedAt: Date.now(),
    };
  }
  const results: Array<{
    aggs: HeadRegisterAgg[];
    status: RegisterLoadStatus;
    manifest: StateHeadPackManifestEntry;
  }> =
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
  const manifest: StateHeadPackManifestEntry[] = [];
  for (const r of results) {
    statuses.push(r.status);
    manifest.push(r.manifest);
  }
  const duplicateFileIds = manifestConflictFileIds(manifest);
  for (const r of results) {
    if (duplicateFileIds.has(r.manifest.fileId)) continue;
    for (const agg of r.aggs) {
      const existing = byHead.get(agg.headKey);
      if (!existing) {
        byHead.set(agg.headKey, agg);
        continue;
      }
      // Same canonical head across workbooks (different FY files, or the
      // same head appearing in several files): merge FY blocks.
      existing.rowsRead += agg.rowsRead;
      mergeFyMaps(existing.byFy, agg.byFy);
    }
  }
  const failed = statuses.filter((s) => s.status === "error");
  const excluded = manifest.filter((m) => m.classification === "excluded");
  const blockers = [
    ...manifestBlockers(manifest),
    ...stateHeadPackPeriodIntegrityBlockers(manifest),
  ];
  logger.info(
    {
      workbooks: files.length,
      heads: byHead.size,
      failed: failed.length,
      excluded: excluded.length,
      packBlockers: blockers.length,
    },
    "state-head register load complete",
  );
  for (const f of failed) {
    logger.error(
      { fileId: f.fileId, fileName: f.fileName, httpStatus: f.httpStatus },
      f.detail,
    );
  }
  return {
    byHead,
    statuses,
    manifest,
    packWarnings: excluded.map((entry) => entry.reason),
    packBlockers: blockers,
    folderError: null,
    loadedAt: Date.now(),
  };
}

export async function loadStateHeadRegisters(
  requestedFy?: string,
): Promise<StateHeadRegisters> {
  const folderId = folderIdForRequestedFy(requestedFy);
  const cached = cacheByFolder.get(folderId);
  if (cached && Date.now() - cached.loadedAt < TTL_MS) return cached;
  const inFlight = inFlightByFolder.get(folderId);
  if (inFlight) return inFlight;
  const nextLoad = loadUncached(folderId)
    .then((r) => {
      cacheByFolder.set(folderId, r);
      return r;
    })
    .finally(() => {
      inFlightByFolder.delete(folderId);
    });
  inFlightByFolder.set(folderId, nextLoad);
  return nextLoad;
}

export function invalidateStateHeadRegisterCache(): void {
  cacheByFolder.clear();
}

// Last successful load, if any — used by the options endpoint to surface a
// precise status without triggering a full multi-workbook read.
export function getCachedStateHeadRegisters(
  requestedFy?: string,
): StateHeadRegisters | null {
  return cacheByFolder.get(folderIdForRequestedFy(requestedFy)) ?? null;
}

// Cheap connectivity check: counts the register workbooks in the State Heads
// folder without reading any of them.
export async function countStateHeadWorkbooks(requestedFy?: string): Promise<number> {
  const folderId = folderIdForRequestedFy(requestedFy);
  return (await listFolderWorkbooks(folderId)).length;
}
