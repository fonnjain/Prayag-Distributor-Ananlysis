/**
 * Read-only identity audit for State Head workbook folders.
 *
 * It answers whether the historical FY folder and the current folder contain
 * duplicate FY transactions or complementary parts of the same fiscal year.
 * The identity is invoice number + normalized party. Workbook titles and FY
 * labels are reported as evidence, but raw transaction dates define the FY.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run statehead-pack-cross-folder-check
 *   pnpm --filter @workspace/api-server run statehead-pack-cross-folder-check -- --json
 */
import { pool } from "@workspace/db";
import { getGoogleAccessToken, readTabRowsChunked } from "./lib/registers/sheetsApi.js";
import { fiscalMonthIndex, normParty, resolveHeadKey } from "./lib/mgmt/names.js";
import { mgmtSources } from "./lib/mgmt/roster.js";

type SheetCellValue = string | number | boolean | null;
type FolderFile = { id: string; name: string };
type SourceFolder = "historical" | "current";

type PairAggregate = {
  amount: number;
  rows: number;
  files: Set<string>;
};

type FileTotals = {
  fileId: string;
  fileName: string;
  fy2025_26: number;
  fy2025_26Rows: number;
  fy2026_27: number;
  fy2026_27Rows: number;
  fy2026_27FutureTotal: number;
  fy2026_27FutureRows: number;
};

type FolderAudit = {
  folder: SourceFolder;
  files: FileTotals[];
  fy2025_26Total: number;
  fy2025_26Rows: number;
  fy2025_26MissingIdentityTotal: number;
  fy2025_26MissingIdentityRows: number;
  fy2025_26Pairs: Map<string, PairAggregate>;
  fy2025_26ByHead: Map<string, number>;
  fy2026_27Total: number;
  fy2026_27Rows: number;
  fy2026_27FutureTotal: number;
  fy2026_27FutureRows: number;
};

type Schema = {
  dateIndexes: number[];
  invoiceIndex: number;
  partyIndex: number;
  amountIndex: number;
  headIndex: number;
};

const CURRENT_SCHEMA: Schema = {
  dateIndexes: [1, 4],
  invoiceIndex: 0,
  partyIndex: 2,
  amountIndex: 7,
  headIndex: 11,
};

const HISTORICAL_SCHEMA: Schema = {
  dateIndexes: [2],
  invoiceIndex: 1,
  partyIndex: 0,
  amountIndex: 5,
  headIndex: 9,
};

function isDateSerial(value: SheetCellValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 20_000 && value < 80_000;
}

function rowDateSerial(row: SheetCellValue[], schema: Schema): number | null {
  for (const index of schema.dateIndexes) {
    if (isDateSerial(row[index])) return row[index];
  }
  return null;
}

function numberValue(value: SheetCellValue | undefined): number | null {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function inFy(serial: number | null, fy: string): boolean {
  return serial != null && fiscalMonthIndex(Math.round(serial), fy) != null;
}

function currentExcelDateSerial(): number {
  const now = new Date();
  return Math.floor(
    (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      Date.UTC(1899, 11, 30)) /
      86_400_000,
  );
}

async function listFolderWorkbooks(folderId: string): Promise<FolderFile[]> {
  const token = await getGoogleAccessToken();
  const q = encodeURIComponent(
    `'${folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.spreadsheet'`,
  );
  const files: FolderFile[] = [];
  let pageToken = "";
  do {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name)&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      throw new Error(`Drive folder listing failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
    }
    const body = (await response.json()) as {
      nextPageToken?: string;
      files?: FolderFile[];
    };
    files.push(...(body.files ?? []));
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

function emptyAudit(folder: SourceFolder): FolderAudit {
  return {
    folder,
    files: [],
    fy2025_26Total: 0,
    fy2025_26Rows: 0,
    fy2025_26MissingIdentityTotal: 0,
    fy2025_26MissingIdentityRows: 0,
    fy2025_26Pairs: new Map(),
    fy2025_26ByHead: new Map(),
    fy2026_27Total: 0,
    fy2026_27Rows: 0,
    fy2026_27FutureTotal: 0,
    fy2026_27FutureRows: 0,
  };
}

function addPair(
  pairs: Map<string, PairAggregate>,
  key: string,
  amount: number,
  fileName: string,
): void {
  const current = pairs.get(key) ?? { amount: 0, rows: 0, files: new Set<string>() };
  current.amount += amount;
  current.rows++;
  current.files.add(fileName);
  pairs.set(key, current);
}

async function auditFolder(
  folder: SourceFolder,
  folderId: string,
  schema: Schema,
): Promise<FolderAudit> {
  const audit = emptyAudit(folder);
  const files = await listFolderWorkbooks(folderId);
  const asOf = currentExcelDateSerial();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const file = files[next++];
      const totals: FileTotals = {
        fileId: file.id,
        fileName: file.name,
        fy2025_26: 0,
        fy2025_26Rows: 0,
        fy2026_27: 0,
        fy2026_27Rows: 0,
        fy2026_27FutureTotal: 0,
        fy2026_27FutureRows: 0,
      };
      const fy2025Rows: Array<{ row: SheetCellValue[]; amount: number }> = [];
      await readTabRowsChunked(file.id, "Sheet1", (rows) => {
        for (const raw of rows) {
          if (!raw) continue;
          const row = raw as SheetCellValue[];
          const amount = numberValue(row[schema.amountIndex]);
          const dateSerial = rowDateSerial(row, schema);
          if (amount == null || dateSerial == null) continue;
          if (inFy(dateSerial, "2025-26")) {
            totals.fy2025_26 += amount;
            totals.fy2025_26Rows++;
            fy2025Rows.push({ row, amount });
          }
          if (inFy(dateSerial, "2026-27")) {
            totals.fy2026_27 += amount;
            totals.fy2026_27Rows++;
            if (dateSerial > asOf) {
              totals.fy2026_27FutureTotal += amount;
              totals.fy2026_27FutureRows++;
            }
          }
        }
      });

      // Blank State Head cells inherit the file's dominant raw head, matching
      // the production State Head register loader.
      const headCounts = new Map<string, number>();
      for (const { row } of fy2025Rows) {
        const rawHead = String(row[schema.headIndex] ?? "").trim();
        if (rawHead) headCounts.set(rawHead, (headCounts.get(rawHead) ?? 0) + 1);
      }
      const dominantHead = [...headCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      for (const { row, amount } of fy2025Rows) {
        const rawHead = String(row[schema.headIndex] ?? "").trim() || dominantHead;
        const headKey = resolveHeadKey(rawHead || "[blank]");
        audit.fy2025_26ByHead.set(
          headKey,
          (audit.fy2025_26ByHead.get(headKey) ?? 0) + amount,
        );
        const invoice = String(row[schema.invoiceIndex] ?? "").trim();
        const party = normParty(row[schema.partyIndex]);
        if (!invoice || !party) {
          audit.fy2025_26MissingIdentityTotal += amount;
          audit.fy2025_26MissingIdentityRows++;
          continue;
        }
        addPair(audit.fy2025_26Pairs, `${invoice}\u0000${party}`, amount, file.name);
      }
      audit.files.push(totals);
      audit.fy2025_26Total += totals.fy2025_26;
      audit.fy2025_26Rows += totals.fy2025_26Rows;
      audit.fy2026_27Total += totals.fy2026_27;
      audit.fy2026_27Rows += totals.fy2026_27Rows;
      audit.fy2026_27FutureTotal += totals.fy2026_27FutureTotal;
      audit.fy2026_27FutureRows += totals.fy2026_27FutureRows;
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, files.length) }, worker));
  audit.files.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return audit;
}

async function registerByHead(fy: string): Promise<Map<string, number>> {
  const result = await pool.query<{ head: string | null; net: string }>(
    `SELECT head_canon AS head, COALESCE(SUM(amount), 0)::text AS net
       FROM sale_line_current
      WHERE version_status = 'current' AND fy = $1
      GROUP BY 1`,
    [fy],
  );
  return new Map(
    result.rows.map((row) => [resolveHeadKey(row.head ?? "[blank]"), Number(row.net)]),
  );
}

function cr(amount: number): number {
  return amount / 10_000_000;
}

function overlapReport(historical: FolderAudit, current: FolderAudit) {
  let historicalOnlyTotal = 0;
  let currentOnlyTotal = 0;
  let sharedEqualTotal = 0;
  let sharedConflictHistoricalTotal = 0;
  let sharedConflictCurrentTotal = 0;
  let sharedEqualPairs = 0;
  let sharedConflictingPairs = 0;
  let historicalOnlyPairs = 0;
  let currentOnlyPairs = 0;
  const conflictSamples: Array<{
    invoice: string;
    partyKey: string;
    historicalAmount: number;
    currentAmount: number;
  }> = [];

  for (const [key, historicalPair] of historical.fy2025_26Pairs) {
    const currentPair = current.fy2025_26Pairs.get(key);
    if (!currentPair) {
      historicalOnlyTotal += historicalPair.amount;
      historicalOnlyPairs++;
      continue;
    }
    if (Math.abs(historicalPair.amount - currentPair.amount) < 0.005) {
      sharedEqualTotal += currentPair.amount;
      sharedEqualPairs++;
    } else {
      sharedConflictHistoricalTotal += historicalPair.amount;
      sharedConflictCurrentTotal += currentPair.amount;
      sharedConflictingPairs++;
      if (conflictSamples.length < 20) {
        const [invoice, partyKey] = key.split("\u0000");
        conflictSamples.push({
          invoice,
          partyKey,
          historicalAmount: historicalPair.amount,
          currentAmount: currentPair.amount,
        });
      }
    }
  }
  for (const [key, currentPair] of current.fy2025_26Pairs) {
    if (historical.fy2025_26Pairs.has(key)) continue;
    currentOnlyTotal += currentPair.amount;
    currentOnlyPairs++;
  }
  return {
    historicalOnlyPairs,
    historicalOnlyTotal,
    currentOnlyPairs,
    currentOnlyTotal,
    sharedEqualPairs,
    sharedEqualTotal,
    sharedConflictingPairs,
    sharedConflictHistoricalTotal,
    sharedConflictCurrentTotal,
    conflictSamples,
    // Only safe when no pair has conflicting amounts and every row has a
    // usable identity. Otherwise the audit intentionally refuses a clean sum.
    safelyDeduplicatedTotal:
      sharedConflictingPairs === 0 &&
      historical.fy2025_26MissingIdentityRows === 0 &&
      current.fy2025_26MissingIdentityRows === 0
        ? historicalOnlyTotal + currentOnlyTotal + sharedEqualTotal
        : null,
  };
}

function plainAudit(audit: FolderAudit) {
  return {
    files: audit.files.length,
    fy2025_26: {
      total: audit.fy2025_26Total,
      rows: audit.fy2025_26Rows,
      pairs: audit.fy2025_26Pairs.size,
      missingIdentityTotal: audit.fy2025_26MissingIdentityTotal,
      missingIdentityRows: audit.fy2025_26MissingIdentityRows,
    },
    fy2026_27: {
      total: audit.fy2026_27Total,
      rows: audit.fy2026_27Rows,
      futureTotal: audit.fy2026_27FutureTotal,
      futureRows: audit.fy2026_27FutureRows,
    },
  };
}

async function main(): Promise<void> {
  const sources = mgmtSources().state_head_registers;
  const historicalFolderId = sources.folders_by_year?.["2025-26"];
  if (!historicalFolderId) throw new Error("No FY2025-26 State Head folder is configured.");
  const [historical, current, register] = await Promise.all([
    auditFolder("historical", historicalFolderId, HISTORICAL_SCHEMA),
    auditFolder("current", sources.folderId, CURRENT_SCHEMA),
    registerByHead("2025-26"),
  ]);
  const overlap = overlapReport(historical, current);
  const currentHeadComparison = [...current.fy2025_26ByHead.entries()]
    .map(([headKey, packAmount]) => ({
      headKey,
      currentFolderAmount: packAmount,
      registerAmount: register.get(headKey) ?? 0,
      delta: packAmount - (register.get(headKey) ?? 0),
    }))
    .sort((a, b) => a.headKey.localeCompare(b.headKey));
  const namedCurrentFiles = current.files.filter((file) =>
    /sandeep|narendra|anuj/i.test(file.fileName),
  );
  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    identity: "invoice number + normalized party (case/punctuation/city suffix insensitive)",
    historical: plainAudit(historical),
    current: plainAudit(current),
    overlap,
    currentHeadComparison,
    namedCurrentFiles,
  };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log("State Head cross-folder identity audit (read-only)");
  console.log(
    `Historical FY2025-26: ₹${cr(historical.fy2025_26Total).toFixed(4)} Cr; ` +
      `${historical.fy2025_26Rows} rows; ${historical.fy2025_26Pairs.size} invoice-party identities.`,
  );
  console.log(
    `Current folder FY2025-26: ₹${cr(current.fy2025_26Total).toFixed(4)} Cr; ` +
      `${current.fy2025_26Rows} rows; ${current.fy2025_26Pairs.size} invoice-party identities.`,
  );
  console.log(
    `Overlap: ${overlap.sharedEqualPairs} exact identities (₹${cr(overlap.sharedEqualTotal).toFixed(4)} Cr), ` +
      `${overlap.historicalOnlyPairs} historical-only, ${overlap.currentOnlyPairs} current-only, ` +
      `${overlap.sharedConflictingPairs} amount conflicts.`,
  );
  console.log(
    `Safe cross-folder deduplicated FY2025-26 total: ` +
      `${overlap.safelyDeduplicatedTotal == null ? "BLOCKED (identity gaps or conflicts)" : `₹${cr(overlap.safelyDeduplicatedTotal).toFixed(4)} Cr`}.`,
  );
  console.log(
    `Current FY2026-27: ₹${cr(current.fy2026_27Total).toFixed(4)} Cr; ` +
      `${current.fy2026_27FutureRows} future-dated rows (₹${cr(current.fy2026_27FutureTotal).toFixed(4)} Cr).`,
  );
  console.log("\nFY2025-26 current-folder by head vs register:");
  for (const row of currentHeadComparison) {
    console.log(
      `  ${row.headKey}: pack ₹${cr(row.currentFolderAmount).toFixed(4)} Cr; ` +
        `register ₹${cr(row.registerAmount).toFixed(4)} Cr; delta ₹${cr(row.delta).toFixed(4)} Cr`,
    );
  }
  console.log("\nNamed current FY2026-27 files:");
  for (const file of namedCurrentFiles) {
    console.log(`  ${file.fileName}: ₹${cr(file.fy2026_27).toFixed(4)} Cr`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });