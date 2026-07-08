// One-time (idempotent) xlsx backfill job for the invoice-line sale registers
// and the rate-list item master.
//
// Usage:
//   npm run backfill -- --file <path/to/register.xlsx> [--fy 2026-27] [--dry-run]
//   npm run backfill -- --item-master <path/to/rate_list.xlsx> [--dry-run]
//
// Runs against whatever DATABASE_URL points at (dev or production).
// Re-running inserts nothing: line_uid is deterministic and the insert is
// ON CONFLICT DO NOTHING.
import { pool, type InsertSaleLine } from "@workspace/db";
import { logger } from "./lib/logger.js";
import {
  OccurrenceCounter,
  emptyUnmapped,
  parseRegisterRow,
  toSaleLine,
} from "./lib/registers/normalize.js";
import { streamRegisterFile, streamRateList } from "./lib/registers/xlsxStream.js";
import {
  assertFyCounts,
  assertNoNegativeAmounts,
  assertSumConsistency,
  assertUnmappedEmpty,
  countExistingLineUids,
  insertSaleLineBatches,
  recordIngestRun,
  upsertItemMaster,
  type IngestAssertion,
} from "./lib/registers/ingest.js";

type Args = {
  file?: string;
  itemMaster?: string;
  fy?: string;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--":
        break;
      case "--file":
        args.file = argv[++i];
        break;
      case "--item-master":
        args.itemMaster = argv[++i];
        break;
      case "--fy":
        args.fy = argv[++i];
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.file && !args.itemMaster) {
    throw new Error(
      "Usage: npm run backfill -- --file <register.xlsx> [--fy 2026-27] [--dry-run] | --item-master <rate_list.xlsx>",
    );
  }
  return args;
}

async function backfillRegister(args: Args): Promise<boolean> {
  const filePath = args.file!;
  const startedAt = new Date();
  const unmapped = emptyUnmapped();
  const occurrence = new OccurrenceCounter();
  const fyCounts: Record<string, number> = {};
  const lines: InsertSaleLine[] = [];
  let rowsRead = 0;
  let invalidRows = 0;
  const invalidSamples: string[] = [];

  logger.info({ filePath, fy: args.fy ?? "all", dryRun: args.dryRun }, "backfill: streaming register");

  await streamRegisterFile(filePath, (values, columns) => {
    const result = parseRegisterRow(values, columns);
    if (result.kind === "empty") return;
    if (result.kind === "invalid") {
      invalidRows++;
      if (invalidSamples.length < 5) invalidSamples.push(result.reason);
      return;
    }
    if (args.fy && result.row.fy !== args.fy) return;
    rowsRead++;
    fyCounts[result.row.fy] = (fyCounts[result.row.fy] ?? 0) + 1;
    lines.push(toSaleLine(result.row, occurrence, unmapped, "xlsx_backfill"));
  });

  const assertions: IngestAssertion[] = [
    ...assertFyCounts(fyCounts),
    ...assertUnmappedEmpty(unmapped),
    ...assertSumConsistency(lines),
    ...assertNoNegativeAmounts(lines),
    {
      name: "no_invalid_rows",
      passed: invalidRows === 0,
      detail: invalidRows === 0 ? "none" : `${invalidRows} invalid rows: ${invalidSamples.join("; ")}`,
    },
  ];
  const failed = assertions.filter((a) => !a.passed);
  for (const a of assertions) {
    logger.info({ assertion: a.name, passed: a.passed, detail: a.detail }, "backfill: assertion");
  }

  if (failed.length > 0) {
    logger.error({ failed }, "backfill: assertions FAILED — nothing was written");
    await recordIngestRun({
      startedAt,
      source: "xlsx_backfill",
      fy: args.fy ?? Object.keys(fyCounts).sort().join(","),
      rowsRead,
      rowsInserted: 0,
      rowsSkipped: rowsRead,
      unmapped,
      assertions,
      status: "fail",
    });
    return false;
  }

  if (args.dryRun) {
    const existing = await countExistingLineUids(lines.map((l) => l.lineUid));
    const wouldInsert = lines.length - existing;
    logger.info(
      { rowsRead, fyCounts, alreadyPresent: existing, wouldInsert },
      "backfill: dry run — no changes made",
    );
    return true;
  }

  const { inserted } = await insertSaleLineBatches(lines);
  const skipped = lines.length - inserted;
  await recordIngestRun({
    startedAt,
    source: "xlsx_backfill",
    fy: args.fy ?? Object.keys(fyCounts).sort().join(","),
    rowsRead,
    rowsInserted: inserted,
    rowsSkipped: skipped,
    unmapped,
    assertions,
    status: "ok",
  });
  logger.info({ rowsRead, fyCounts, inserted, skipped }, "backfill: complete");
  return true;
}

async function backfillItemMaster(args: Args): Promise<boolean> {
  const filePath = args.itemMaster!;
  const startedAt = new Date();
  const items: Parameters<typeof upsertItemMaster>[0] = [];

  logger.info({ filePath, dryRun: args.dryRun }, "backfill: streaming rate list");
  const { rowsScanned } = await streamRateList(filePath, (item) => {
    items.push(item);
  });

  const distinct = new Set(items.map((i) => i.code)).size;
  if (args.dryRun) {
    logger.info({ rowsScanned, distinctCodes: distinct }, "backfill: dry run — no changes made");
    return true;
  }

  const { upserted } = await upsertItemMaster(items);
  await recordIngestRun({
    startedAt,
    source: "xlsx_backfill_item_master",
    fy: null,
    rowsRead: rowsScanned,
    rowsInserted: upserted,
    rowsSkipped: rowsScanned - upserted,
    unmapped: null,
    assertions: [],
    status: "ok",
  });
  logger.info({ rowsScanned, distinctCodes: distinct, upserted }, "backfill: item master complete");
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let ok = true;
  if (args.file) ok = (await backfillRegister(args)) && ok;
  if (args.itemMaster) ok = (await backfillItemMaster(args)) && ok;
  await pool.end();
  if (!ok) process.exit(1);
}

main().catch((err) => {
  logger.error({ err }, "backfill: fatal error");
  process.exit(1);
});
