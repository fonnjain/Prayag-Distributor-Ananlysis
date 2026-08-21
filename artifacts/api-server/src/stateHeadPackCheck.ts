/**
 * Read-only State Head master-pack release check.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run statehead-pack-check
 *   pnpm --filter @workspace/api-server run statehead-pack-check -- --fy 2025-26 --json
 *
 * The Drive folder is read through loadStateHeadRegisters. No source workbook
 * or database row is modified. A non-zero exit means the pack must not be
 * presented as reconciled.
 */
import { pool } from "@workspace/db";
import {
  loadStateHeadRegisters,
  type StateHeadRegisters,
} from "./lib/mgmt/stateHeadRegisters.js";
import { resolveHeadKey } from "./lib/mgmt/names.js";
import {
  fiscalYearsForStateHeadAudit,
  hasMaterialPackTotalDiscrepancy,
  sumEligibleStateHeadSaleRows,
  missingMaterialSourceHeads,
  stateHeadSourceLoadBlockers,
  stateHeadPackRequestedFyBlockers,
  type StateHeadSaleSourceRow,
} from "./lib/mgmt/stateHeadPack.js";
import { loadPersonRegistry } from "./lib/personRegistry.js";

type DbHeadRow = { head: string | null; net: string };

type HeadDiscrepancy = {
  head: string;
  packNet: number;
  saleLineNet: number;
  delta: number;
  deltaPct: number;
};

type FyAudit = {
  fy: string;
  packTotal: number;
  saleLineCurrentNet: number;
  mappedSaleLineCurrentNet: number;
  delta: number;
  deltaPct: number;
  mappedHeadDiscrepancies: HeadDiscrepancy[];
  missingMaterialHeads: Array<{
    head: string;
    saleLineNet: number;
    sharePct: number;
  }>;
};

type AuditReport = {
  generatedAt: string;
  readOnly: true;
  reconciliationReady: boolean;
  warnings: string[];
  blockers: string[];
  exclusions: StateHeadRegisters["manifest"];
  files: StateHeadRegisters["manifest"];
  fiscalYears: FyAudit[];
  sourcePatterns: Array<{
    rawTab: string;
    rawSchema: string;
    reportFormulaSource: string | null;
    files: string[];
  }>;
  sandeepSourceComparison: {
    file: string;
    sameAsDominantPattern: boolean | null;
    detail: string;
  } | null;
};

function numberValue(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function percentDelta(packNet: number, sourceNet: number): number {
  return Math.abs(packNet - sourceNet) / Math.max(Math.abs(sourceNet), 1);
}

async function saleLineTotals(fy: string): Promise<{
  total: number;
  byHead: Map<string, number>;
  displayByHead: Map<string, string>;
}> {
  const result = await pool.query<DbHeadRow>(
    `SELECT head_canon AS head,
            COALESCE(SUM(amount), 0)::text AS net
       FROM sale_line_current
      WHERE version_status = 'current' AND fy = $1
      GROUP BY 1
      ORDER BY 1`,
    [fy],
  );
  const rows: StateHeadSaleSourceRow[] = result.rows.map((row) => ({
    head: row.head,
    net: numberValue(row.net),
  }));
  return sumEligibleStateHeadSaleRows(rows);
}

function packHeadTotals(
  registers: StateHeadRegisters,
  fy: string,
): { total: number; byHead: Map<string, number> } {
  const byHead = new Map<string, number>();
  for (const file of registers.manifest) {
    if (!file.included) continue;
    for (const [head, amounts] of Object.entries(file.includedByHeadByFy)) {
      const amount = numberValue(amounts[fy]);
      const key = resolveHeadKey(head);
      byHead.set(key, (byHead.get(key) ?? 0) + amount);
    }
  }
  return {
    total: [...byHead.values()].reduce((sum, value) => sum + value, 0),
    byHead,
  };
}

async function buildReport(
  registers: StateHeadRegisters,
  requestedFy: string | null,
): Promise<AuditReport> {
  const fiscalYears = fiscalYearsForStateHeadAudit(
    registers.manifest,
    requestedFy,
  );
  if (fiscalYears.length === 0) fiscalYears.push("2025-26");

  const fyAudits: FyAudit[] = [];
  for (const fy of fiscalYears) {
    const [pack, source] = await Promise.all([
      Promise.resolve(packHeadTotals(registers, fy)),
      saleLineTotals(fy),
    ]);
    const mappedSourceTotal = [...pack.byHead.keys()].reduce(
      (sum, head) => sum + (source.byHead.get(head) ?? 0),
      0,
    );
    const mappedHeadDiscrepancies: HeadDiscrepancy[] = [];
    for (const [head, packNet] of pack.byHead) {
      const saleLineNet = source.byHead.get(head) ?? 0;
      const delta = packNet - saleLineNet;
      const deltaPct = percentDelta(packNet, saleLineNet);
      if (deltaPct > 0.01) {
        mappedHeadDiscrepancies.push({
          head,
          packNet,
          saleLineNet,
          delta,
          deltaPct,
        });
      }
    }
    const missingMaterialHeads = missingMaterialSourceHeads(
      pack.byHead,
      source.byHead,
      source.total,
    ).map((missing) => ({
      head: source.displayByHead.get(missing.head) ?? missing.head,
      saleLineNet: missing.net,
      sharePct: missing.sharePct,
    }));
    const delta = pack.total - source.total;
    fyAudits.push({
      fy,
      packTotal: pack.total,
      saleLineCurrentNet: source.total,
      mappedSaleLineCurrentNet: mappedSourceTotal,
      delta,
      deltaPct: percentDelta(pack.total, source.total),
      mappedHeadDiscrepancies,
      missingMaterialHeads,
    });
  }

  const readErrors = registers.statuses
    .filter((status) => status.status === "error")
    .map((status) => `${status.fileName} (${status.fileId}): ${status.detail}`);
  const sourceLoadBlockers = stateHeadSourceLoadBlockers(
    registers.folderError,
    registers.manifest,
  );
  const requestedFyBlockers = stateHeadPackRequestedFyBlockers(
    registers.manifest,
    requestedFy,
  );
  const discrepancyBlockers = fyAudits.flatMap((audit) => {
    const totalBlocker =
      hasMaterialPackTotalDiscrepancy(
        audit.packTotal,
        audit.saleLineCurrentNet,
      )
        ? [
            `${audit.fy} total: deduplicated pack ₹${audit.packTotal.toFixed(2)} vs ` +
              `sale_line_current ₹${audit.saleLineCurrentNet.toFixed(2)} ` +
              `(${(audit.deltaPct * 100).toFixed(2)}% discrepancy)`,
          ]
        : [];
    const missingBlockers = audit.missingMaterialHeads.map(
      (missing) =>
        `${audit.fy} missing material head ${missing.head}: ` +
        `sale_line_current ₹${missing.saleLineNet.toFixed(2)} ` +
        `(${(missing.sharePct * 100).toFixed(2)}% of FY net)`,
    );
    return [
      ...totalBlocker,
      ...missingBlockers,
      ...audit.mappedHeadDiscrepancies.map(
      (d) =>
        `${audit.fy} ${d.head}: pack ₹${d.packNet.toFixed(2)} vs ` +
        `sale_line_current ₹${d.saleLineNet.toFixed(2)} ` +
        `(${(d.deltaPct * 100).toFixed(2)}% discrepancy)`,
      ),
    ];
  });
  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    reconciliationReady:
      sourceLoadBlockers.length === 0 &&
      requestedFyBlockers.length === 0 &&
      registers.packBlockers.length === 0 &&
      readErrors.length === 0 &&
      discrepancyBlockers.length === 0,
    warnings: [...registers.packWarnings, ...readErrors],
    blockers: [
      ...sourceLoadBlockers,
      ...requestedFyBlockers,
      ...registers.packBlockers,
      ...discrepancyBlockers,
    ],
    exclusions: registers.manifest.filter(
      (entry) => entry.classification === "excluded",
    ),
    files: registers.manifest,
    fiscalYears: fyAudits,
    ...sourcePatternReport(registers.manifest),
  };
}

function sourcePatternReport(files: StateHeadRegisters["manifest"]): Pick<
  AuditReport,
  "sourcePatterns" | "sandeepSourceComparison"
> {
  const patternByKey = new Map<
    string,
    {
      rawTab: string;
      rawSchema: string;
      reportFormulaSource: string | null;
      files: string[];
    }
  >();
  for (const file of files) {
    const rawTab = file.rawTab ?? "unknown";
    const rawSchema = file.rawSchema ?? "unknown";
    const reportFormulaSource = file.reportFormulaSource ?? null;
    const key = `${rawTab}\u0000${rawSchema}\u0000${reportFormulaSource ?? ""}`;
    const group = patternByKey.get(key) ?? {
      rawTab,
      rawSchema,
      reportFormulaSource,
      files: [],
    };
    group.files.push(file.fileName);
    patternByKey.set(key, group);
  }
  const sourcePatterns = [...patternByKey.values()].sort(
    (a, b) => b.files.length - a.files.length,
  );
  const sandeep = files.find((file) =>
    file.fileName.toLowerCase().includes("sandeep"),
  );
  if (!sandeep || sourcePatterns.length === 0) {
    return { sourcePatterns, sandeepSourceComparison: null };
  }
  const dominant = sourcePatterns[0];
  const same =
    (sandeep.rawTab ?? "unknown") === dominant.rawTab &&
    (sandeep.rawSchema ?? "unknown") === dominant.rawSchema &&
    (sandeep.reportFormulaSource ?? null) === dominant.reportFormulaSource;
  return {
    sourcePatterns,
    sandeepSourceComparison: {
      file: sandeep.fileName,
      sameAsDominantPattern: same,
      detail: same
        ? "Sandeep uses the same raw tab/schema and Report 1 source expression as the dominant file pattern."
        : "Sandeep uses a different raw tab/schema or Report 1 source expression from the dominant file pattern.",
    },
  };
}

function printHuman(report: AuditReport): void {
  console.log("State Head master-pack release check (read-only)");
  console.log(`Reconciled release: ${report.reconciliationReady ? "YES" : "NO"}`);
  console.log(`Files examined: ${report.files.length}`);
  for (const file of report.files) {
    const totals = Object.entries(file.report1ByFy)
      .map(([fy, amount]) => `${fy}=₹${amount.toFixed(2)}`)
      .join(", ");
    console.log(
      `  ${file.fileName} [${file.fileId}] — ${file.classification}; ` +
        `mapped=${file.mappedHeads.join(", ") || "none"}; FY-labelled raw headline: ${totals || "none"}`,
    );
    if (file.rawTab || file.rawSchema || file.reportFormulaSource) {
      console.log(
        `    raw=${file.rawTab ?? "unknown"} (${file.rawSchema ?? "unknown schema"}); ` +
          `Report 1 source=${file.reportFormulaSource ?? "not readable"}`,
      );
    }
    for (const [fy, integrity] of Object.entries(
      file.periodIntegrityByFy ?? {},
    )) {
      const contamination = integrity.contaminationDateRange
        ? `${integrity.contaminationDateRange.from} to ${integrity.contaminationDateRange.to}`
        : "none";
      const future = integrity.futureDateRange
        ? `${integrity.futureDateRange.from} to ${integrity.futureDateRange.to}`
        : "none";
      console.log(
        `    FY${fy}: headline ₹${integrity.headlineTotal.toFixed(2)}; ` +
          `in-FY ₹${integrity.inFyTotal.toFixed(2)}; ` +
          `out-of-FY ₹${integrity.outOfFyTotal.toFixed(2)} (${integrity.outOfFyRows} rows; ${contamination}); ` +
          `future ₹${integrity.futureDatedTotal.toFixed(2)} (${integrity.futureDatedRows} rows; ${future})`,
      );
      if (integrity.undatedRows > 0) {
        console.log(
          `    FY${fy}: undated ₹${integrity.undatedTotal.toFixed(2)} ` +
            `(${integrity.undatedRows} rows; blocked)`,
        );
      }
    }
    if (!file.included) console.log(`    ${file.reason}`);
  }
  for (const audit of report.fiscalYears) {
    console.log(
      `${audit.fy}: date-valid, deduplicated pack ₹${audit.packTotal.toFixed(2)} vs ` +
        `sale_line_current ₹${audit.saleLineCurrentNet.toFixed(2)}; ` +
        `delta ${(audit.deltaPct * 100).toFixed(2)}%`,
    );
    for (const discrepancy of audit.mappedHeadDiscrepancies) {
      console.log(
        `  MATERIAL HEAD DRIFT: ${discrepancy.head} — pack ₹${discrepancy.packNet.toFixed(2)} ` +
          `vs sale_line_current ₹${discrepancy.saleLineNet.toFixed(2)} ` +
          `(${(discrepancy.deltaPct * 100).toFixed(2)}%)`,
      );
    }
    for (const missing of audit.missingMaterialHeads) {
      console.log(
        `  MISSING MATERIAL HEAD: ${missing.head} — sale_line_current ₹${missing.saleLineNet.toFixed(2)} ` +
          `(${(missing.sharePct * 100).toFixed(2)}% of FY net)`,
      );
    }
  }
  console.log("\nSource template patterns:");
  for (const pattern of report.sourcePatterns) {
    console.log(
      `  ${pattern.files.length} file(s): raw=${pattern.rawTab} (${pattern.rawSchema}); ` +
        `Report 1 source=${pattern.reportFormulaSource ?? "not readable"} — ${pattern.files.join(", ")}`,
    );
  }
  if (report.sandeepSourceComparison) {
    console.log(`  ${report.sandeepSourceComparison.detail}`);
  }
  for (const warning of report.warnings) console.log(`WARNING: ${warning}`);
  for (const blocker of report.blockers) console.error(`BLOCKED: ${blocker}`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL env var required");
  }
  const args = process.argv.slice(2);
  const fyIndex = args.indexOf("--fy");
  const requestedFy = fyIndex >= 0 ? args[fyIndex + 1] ?? null : null;
  const json = args.includes("--json");
  await loadPersonRegistry();
  const report = await buildReport(
    await loadStateHeadRegisters(requestedFy ?? undefined),
    requestedFy,
  );
  if (json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  if (!report.reconciliationReady) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});