// Shared persistence layer for register ingestion (xlsx backfill and live
// Sheets sync). Idempotency comes from ON CONFLICT (line_uid) DO NOTHING —
// the existing row always wins, so a Sheets row is never overwritten by a
// backfill row.
import { inArray, sql } from "drizzle-orm";
import {
  db,
  saleLines,
  itemMaster,
  ingestRuns,
  type InsertSaleLine,
  type InsertIngestRun,
} from "@workspace/db";
import expectedCounts from "../../../config/expected_counts.json";
import type { UnmappedReport } from "./normalize.js";

export const BATCH_SIZE = 1000;

// Expected row counts per FY (spec section A). The prior-year block repeats
// across files with identical counts, so the per-FY expectation is unique.
export const EXPECTED_FY_COUNTS: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  for (const perFile of Object.values(
    expectedCounts.registers as Record<string, Record<string, number>>,
  )) {
    for (const [fyRaw, count] of Object.entries(perFile)) {
      out[fyRaw.replace(/^FY-/, "")] = count;
    }
  }
  return out;
})();

export const EXPECTED_TOTAL_LINES = expectedCounts.total_distinct_sale_lines;

// Deduplicate a batch before insert.
// When a row has serial_no set: key = (fy, month_label, serial_no). Serial
// numbers restart at 1 for each monthly tab, so month_label is required to
// scope uniqueness correctly. Two lines with the same (fy, month_label,
// serial_no) are the same physical dispatch line (true double-read); we keep
// the first occurrence.
// When serial_no is absent (historical FYs without column A): no in-memory
// dedup — trust the occurrence-counter in line_uid to distinguish legitimate
// variant lines. The DB ON CONFLICT (line_uid) DO NOTHING handles residual
// hash collisions.
function dedupeBySerialNo(lines: InsertSaleLine[]): InsertSaleLine[] {
  const seen = new Map<string, InsertSaleLine>();
  const out: InsertSaleLine[] = [];
  for (const line of lines) {
    if (line.serialNo != null && line.monthLabel != null) {
      const key = `${line.fy ?? ""}|${line.monthLabel}|${line.serialNo}`;
      if (!seen.has(key)) {
        seen.set(key, line);
        out.push(line);
      }
    } else {
      out.push(line);
    }
  }
  return out;
}

export async function insertSaleLineBatches(
  lines: InsertSaleLine[],
): Promise<{ inserted: number }> {
  // Dedupe within the incoming set before hitting the DB.
  const deduped = dedupeBySerialNo(lines);
  let inserted = 0;
  for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
    const batch = deduped.slice(i, i + BATCH_SIZE);
    const rows = await db
      .insert(saleLines)
      .values(batch)
      .onConflictDoNothing({ target: saleLines.lineUid })
      .returning({ lineUid: saleLines.lineUid });
    inserted += rows.length;
  }
  return { inserted };
}

// Counts how many of the given line_uids already exist (dry-run support).
export async function countExistingLineUids(uids: string[]): Promise<number> {
  let existing = 0;
  for (let i = 0; i < uids.length; i += BATCH_SIZE) {
    const batch = uids.slice(i, i + BATCH_SIZE);
    const rows = await db
      .select({ lineUid: saleLines.lineUid })
      .from(saleLines)
      .where(inArray(saleLines.lineUid, batch));
    existing += rows.length;
  }
  return existing;
}

export type IngestAssertion = {
  name: string;
  passed: boolean;
  detail: string;
};

export function assertFyCounts(
  fyCounts: Record<string, number>,
): IngestAssertion[] {
  const assertions: IngestAssertion[] = [];
  for (const [fy, count] of Object.entries(fyCounts)) {
    const expected = EXPECTED_FY_COUNTS[fy];
    if (expected == null) {
      assertions.push({
        name: `row_count_${fy}`,
        passed: false,
        detail: `no expected count on record for FY ${fy} (got ${count})`,
      });
    } else {
      assertions.push({
        name: `row_count_${fy}`,
        passed: count === expected,
        detail: `expected ${expected}, got ${count}`,
      });
    }
  }
  return assertions;
}

export function assertUnmappedEmpty(
  unmapped: UnmappedReport,
): IngestAssertion[] {
  return [
    {
      name: "unmapped_groups_empty",
      passed: Object.keys(unmapped.unmapped_groups).length === 0,
      detail: JSON.stringify(unmapped.unmapped_groups),
    },
    {
      name: "unmapped_heads_empty",
      passed: Object.keys(unmapped.unmapped_heads).length === 0,
      detail: JSON.stringify(unmapped.unmapped_heads),
    },
    {
      name: "unmapped_states_empty",
      passed: Object.keys(unmapped.unmapped_states).length === 0,
      detail: JSON.stringify(unmapped.unmapped_states),
    },
  ];
}

// Spec Task 8 assertion 1: sum(amount) grouped by group/head/state must each
// equal the grand total within one rupee. Catches NaN amounts and rows whose
// canon value was dropped during normalization (raw present, canon null).
// Genuinely blank source cells (raw empty too) are an upstream data-entry gap:
// they go into an explicit "(blank)" bucket — mirroring SQL NULL-group
// semantics — so sums stay consistent, and are reported in the detail.
const BLANK_BUCKET = "(blank)";

export function assertSumConsistency(
  lines: Pick<
    InsertSaleLine,
    | "amount"
    | "groupCanon"
    | "headCanon"
    | "stateCanon"
    | "groupRaw"
    | "headRaw"
    | "stateRaw"
  >[],
): IngestAssertion[] {
  let grand = 0;
  let badAmounts = 0;
  const byGroup = new Map<string, number>();
  const byHead = new Map<string, number>();
  const byState = new Map<string, number>();
  // Rows where a raw value exists but normalization produced no canon —
  // this is real bucket loss and fails the run.
  let droppedGroup = 0;
  let droppedHead = 0;
  let droppedState = 0;
  const bump = (map: Map<string, number>, key: string, amount: number) =>
    map.set(key, (map.get(key) ?? 0) + amount);
  const bucket = (
    canon: string | null | undefined,
    raw: string | null | undefined,
  ): { key: string | null; dropped: boolean } => {
    if (canon) return { key: canon, dropped: false };
    if (raw != null && raw.trim() !== "") return { key: null, dropped: true };
    return { key: BLANK_BUCKET, dropped: false };
  };
  for (const line of lines) {
    const amount = Number(line.amount);
    if (!Number.isFinite(amount)) {
      badAmounts++;
      continue;
    }
    grand += amount;
    const g = bucket(line.groupCanon, line.groupRaw);
    if (g.key) bump(byGroup, g.key, amount);
    if (g.dropped) droppedGroup++;
    const h = bucket(line.headCanon, line.headRaw);
    if (h.key) bump(byHead, h.key, amount);
    if (h.dropped) droppedHead++;
    const s = bucket(line.stateCanon, line.stateRaw);
    if (s.key) bump(byState, s.key, amount);
    if (s.dropped) droppedState++;
  }
  const total = (map: Map<string, number>) =>
    [...map.values()].reduce((a, b) => a + b, 0);
  const groupSum = total(byGroup);
  const headSum = total(byHead);
  const stateSum = total(byState);
  const within = (a: number) => Math.abs(a - grand) <= 1;
  const passed =
    badAmounts === 0 &&
    droppedGroup === 0 &&
    droppedHead === 0 &&
    droppedState === 0 &&
    within(groupSum) &&
    within(headSum) &&
    within(stateSum);
  const problems: string[] = [];
  if (badAmounts > 0) problems.push(`${badAmounts} rows with non-numeric amount`);
  if (droppedGroup > 0) problems.push(`${droppedGroup} rows lost group_canon despite raw value`);
  if (droppedHead > 0) problems.push(`${droppedHead} rows lost head_canon despite raw value`);
  if (droppedState > 0) problems.push(`${droppedState} rows lost state_canon despite raw value`);
  if (!within(groupSum)) problems.push(`by_group sum off by ${Math.round(groupSum - grand)}`);
  if (!within(headSum)) problems.push(`by_head sum off by ${Math.round(headSum - grand)}`);
  if (!within(stateSum)) problems.push(`by_state sum off by ${Math.round(stateSum - grand)}`);
  const blanks = [byGroup, byHead, byState]
    .map((m, i) => ({ dim: ["group", "head", "state"][i], amt: m.get(BLANK_BUCKET) }))
    .filter((b) => b.amt != null)
    .map((b) => `${b.dim} blank=${Math.round(b.amt as number)}`);
  return [
    {
      name: "sum_consistency",
      passed,
      detail:
        problems.length > 0
          ? problems.join("; ")
          : `grand=${Math.round(grand)}, by_group=${Math.round(groupSum)} (${byGroup.size} buckets), by_head=${Math.round(headSum)} (${byHead.size}), by_state=${Math.round(stateSum)} (${byState.size})${blanks.length > 0 ? `; source blanks: ${blanks.join(", ")}` : ""}`,
    },
  ];
}

// Spec Task 8 assertion 3: no negative amounts outside flagged returns. The
// registers carry no returns flag, so any negative amount fails the run and
// must be investigated rather than silently ingested.
export function assertNoNegativeAmounts(
  lines: Pick<InsertSaleLine, "amount" | "invoiceNo" | "code">[],
): IngestAssertion[] {
  const negatives = lines.filter((l) => Number(l.amount) < 0);
  const samples = negatives
    .slice(0, 3)
    .map((l) => `${l.invoiceNo ?? "?"}/${l.code}: ${l.amount}`);
  return [
    {
      name: "no_negative_amounts",
      passed: negatives.length === 0,
      detail:
        negatives.length === 0
          ? "none"
          : `${negatives.length} negative amounts, e.g. ${samples.join("; ")}`,
    },
  ];
}

export async function recordIngestRun(run: InsertIngestRun): Promise<void> {
  await db.insert(ingestRuns).values(run);
}

export async function upsertItemMaster(
  items: Array<{
    code: string;
    itemName: string | null;
    itemGroup: string | null;
    unit: string | null;
    mrp: number | null;
  }>,
): Promise<{ upserted: number }> {
  // Last occurrence wins within the file.
  const byCode = new Map<string, (typeof items)[number]>();
  for (const item of items) byCode.set(item.code, item);
  const rows = [...byCode.values()].map((i) => ({
    code: i.code,
    itemName: i.itemName,
    itemGroup: i.itemGroup,
    unit: i.unit,
    mrp: i.mrp == null ? null : String(i.mrp),
  }));
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await db
      .insert(itemMaster)
      .values(batch)
      .onConflictDoUpdate({
        target: itemMaster.code,
        set: {
          itemName: sql`excluded.item_name`,
          itemGroup: sql`excluded.item_group`,
          unit: sql`excluded.unit`,
          mrp: sql`excluded.mrp`,
        },
      });
    upserted += batch.length;
  }
  return { upserted };
}
