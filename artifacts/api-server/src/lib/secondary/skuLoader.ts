/**
 * Secondary SKU register loader — Phase K1.
 *
 * Reads the closed-year secondary registers at item-code (Cat. No.) granularity
 * and inserts rows into secondary_sku_line. The existing secondary_register_line
 * loader stores at brand/segment level; this loader stores at SKU level.
 *
 * Supported FYs: 2024-25, 2025-26 (15-column standard layout).
 * FY2023-24 has a different 14-column layout; it is guarded by a column-count
 * check and skipped if Cat. No. cannot be located.
 *
 * Column detection is header-name based (not positional) for resilience.
 * Month is derived from the Date column via the existing toMonthLabel helper.
 *
 * NET = Sub Total column. Order Total is never used.
 */

import crypto from "node:crypto";
import { sql as sqlRaw } from "drizzle-orm";
import { assertSkuWipeGuard } from "../sku/skuWipeGuard.js";
import { db, secondarySkuLines, type InsertSecSkuLine } from "@workspace/db";
import { listSheetTabs, readTabRowsChunked, type SheetCellValue } from "../registers/sheetsApi.js";
import { toMonthLabel } from "./normalize.js";
import { canonGroupFromMap } from "../sku/catalogue.js";
import { clearRetailerRegistry } from "../mgmt/retailerRegistry.js";
import { logger } from "../logger.js";

// ── Column header aliases ────────────────────────────────────────────────────

const COL_ALIASES: Record<string, string[]> = {
  date:        ["DATE", "MONTH", "M0NTH"],
  // Genuine retailer identity column. Older layouts (FY2021-22/22-23) title it
  // just "ID"; newer layouts (FY2024-25+) title it "RETAILER ID". Never SR.NO —
  // that is a row serial, not an identity (it polluted retailer_id historically).
  retailerId:  ["RETAILER ID", "RET#", "RET #", "RET NO", "RET. NO", "RET ID", "ID"],
  retailer:    ["RETAILER", "RETAILERS", "RETAILER NAME"],
  orderId:     ["ORDER ID", "ORDER NO"],
  segment:     ["SEGMENT", "CATEGORY", "CAT", "BRAND", "GROUP", "PRODUCTGROUP"],
  itemCode:    ["CAT.NO", "CAT. NO.", "CATNO", "CAT NO", "CAT.NO.", "CAT NO.", "ITEM CODE"],
  qty:         ["QTY", "QUANTITY"],
  mrp:         ["MRP"],
  grossAmount: ["ORDER VALUE"],
  distributor: ["DISTRIBUTOR", "DIST.", "DIST NAME", "DISTRIBUTOR NAME"],
  discount:    ["DISCOUNT"],
  netAmount:   ["SUB TOTAL", "SUBTOTAL", "SUB-TOTAL", "NET AMOUNT"],
  head:        ["TEAM MEMBER", "TEAM MEMBER NAME", "SALESPERSON", "PERSON NAME", "TM NAME"],
};

type ColMap = Record<keyof typeof COL_ALIASES, number>;

function detectColumns(headerRow: SheetCellValue[]): ColMap | null {
  const normalized = headerRow.map((c) =>
    String(c ?? "").trim().toUpperCase().replace(/\s+/g, " "),
  );
  const find = (keys: string[]): number =>
    normalized.findIndex((h) => keys.some((k) => h === k || h.startsWith(k)));

  const map: ColMap = {} as ColMap;
  for (const [field, aliases] of Object.entries(COL_ALIASES)) {
    if (field === "retailer") {
      // Exact match only — "RETAILER ID" startsWith "RETAILER" and must NOT
      // bind the retailer NAME column to the identity column.
      map.retailer = normalized.findIndex((h) => aliases.includes(h));
      continue;
    }
    if (field === "retailerId") {
      // "ID" must be an exact header match (startsWith would be too loose),
      // and the retailerId column must never be the SR.NO serial column.
      map.retailerId = normalized.findIndex(
        (h) => h === "ID" || h === "RETAILER ID" || h.startsWith("RET#") || h.startsWith("RET #") || h === "RET NO" || h === "RET. NO" || h === "RET ID",
      );
      continue;
    }
    map[field as keyof ColMap] = find(aliases);
  }

  // itemCode must be found — otherwise this tab is not item-code level data.
  if (map.itemCode < 0) return null;
  return map;
}

// ── Normalisation helpers ────────────────────────────────────────────────────

function cellStr(v: SheetCellValue): string {
  return String(v ?? "").trim();
}

function cellNum(v: SheetCellValue): number | null {
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return isFinite(n) ? n : null;
}

/**
 * Simple key normalisation: lowercase + collapse whitespace.
 *
 * Exported so tests can verify the JS function matches the SQL expression used
 * in the state_canon backfill:
 *   REGEXP_REPLACE(LOWER(TRIM(x)), '\s+', ' ', 'g')
 *
 * Both produce the same result — this equivalence is what makes the join correct.
 */
export function headNormKey(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}
/** Alias kept for internal callers — do not export separately to avoid confusion. */
const normKey = headNormKey;

/**
 * Normalise a genuine retailer identity value: "ret# 12345" → "RET#12345".
 * Returns null for anything that is not a RET# value (e.g. a bare row serial),
 * so a mis-detected serial column can never pollute retailer_id again.
 */
export function normaliseRetId(raw: string): string | null {
  const v = raw.toUpperCase().replace(/\s+/g, "");
  const m = v.match(/^RET#?(\d+)$/);
  return m ? `RET#${m[1]}` : null;
}

// ── Line UID ─────────────────────────────────────────────────────────────────

function makeLineUid(
  fy: string,
  monthLabel: string,
  headRaw: string,
  retailer: string,
  distributor: string,
  itemCode: string,
  grossAmount: string,
  occurrence: number,
): string {
  const key = [fy, monthLabel, headRaw, retailer, distributor, itemCode, grossAmount, occurrence]
    .join("|");
  return crypto.createHash("sha1").update(key).digest("hex");
}

// ── Per-tab parse ────────────────────────────────────────────────────────────

type ParseResult = {
  rows: InsertSecSkuLine[];
  skipped: number;
  noItemCode: number;
  noMonth: number;
  rowsWithRetId: number;
};

export function parseTab(
  tabTitle: string,
  rawRows: SheetCellValue[][],
  fy: string,
  sheetId: string,
): ParseResult {
  const result: ParseResult = { rows: [], skipped: 0, noItemCode: 0, noMonth: 0, rowsWithRetId: 0 };

  // Find the header row (first row where we can detect itemCode column).
  let cols: ColMap | null = null;
  let dataStart = 0;
  for (let i = 0; i < Math.min(10, rawRows.length); i++) {
    const detected = detectColumns(rawRows[i]);
    if (detected) {
      cols = detected;
      dataStart = i + 1;
      break;
    }
  }
  if (!cols) return result; // Tab has no recognisable item-code header.

  // Occurrence counter: counts rows sharing the same natural key.
  const occurrenceMap = new Map<string, number>();

  // Merged-cell carry-forward. RET#, Date, Order ID, Segment, Retailer and
  // Distributor are MERGED cells in these registers: the Sheets API returns a
  // value only on the first row of each merge block and null on the rest.
  // Without carry-forward, RET# coverage reads ~15% instead of ~100%.
  const carry: {
    date: SheetCellValue;
    retailer: string;
    retailerId: string | null;
    distributor: string;
    segmentRaw: string;
    headRaw: string;
  } = { date: null, retailer: "", retailerId: null, distributor: "", segmentRaw: "", headRaw: "" };

  for (let i = dataStart; i < rawRows.length; i++) {
    const cells = rawRows[i];
    if (!cells || cells.every((c) => c == null || String(c).trim() === "")) continue;

    const itemCode = cellStr(cells[cols.itemCode] ?? null);
    if (!itemCode) { result.noItemCode++; continue; }

    // Retailer name drives the carry group: a non-blank name starts a new
    // merge block, so the carried RET# from the previous block must never
    // leak into a new block whose own RET# cell is blank.
    const retailerRaw = cols.retailer >= 0 ? cellStr(cells[cols.retailer] ?? null) : "";
    const retIdRaw    = cols.retailerId >= 0 ? cellStr(cells[cols.retailerId] ?? null) : "";
    if (retailerRaw) {
      carry.retailer = retailerRaw;
      carry.retailerId = retIdRaw ? normaliseRetId(retIdRaw) : null;
    } else if (retIdRaw) {
      carry.retailerId = normaliseRetId(retIdRaw);
    }

    const rawDate = cols.date >= 0 ? cells[cols.date] : null;
    if (rawDate != null && String(rawDate).trim() !== "") carry.date = rawDate;
    const distRaw = cols.distributor >= 0 ? cellStr(cells[cols.distributor] ?? null) : "";
    if (distRaw) carry.distributor = distRaw;
    const segRaw = cols.segment >= 0 ? cellStr(cells[cols.segment] ?? null) : "";
    if (segRaw) carry.segmentRaw = segRaw;
    const headRawCell = cols.head >= 0 ? cellStr(cells[cols.head] ?? null) : "";
    if (headRawCell) carry.headRaw = headRawCell;

    const monthLabel = toMonthLabel(carry.date ?? null, fy);
    if (!monthLabel) { result.noMonth++; continue; }

    const retailer   = carry.retailer;
    const retailerId = carry.retailerId;
    const distributor= carry.distributor;
    const headRaw    = carry.headRaw;
    const segmentRaw = carry.segmentRaw || null;
    const qty        = cols.qty >= 0 ? cellNum(cells[cols.qty] ?? null) : null;
    const mrp        = cols.mrp >= 0 ? cellNum(cells[cols.mrp] ?? null) : null;
    const grossAmt   = cols.grossAmount >= 0 ? cellNum(cells[cols.grossAmount] ?? null) : null;
    const discountPct= cols.discount >= 0 ? cellNum(cells[cols.discount] ?? null) : null;
    const netAmt     = cols.netAmount >= 0 ? cellNum(cells[cols.netAmount] ?? null) : null;

    // Skip rows with no value at all.
    if (grossAmt == null && netAmt == null) { result.skipped++; continue; }

    const segmentCanon = segmentRaw ? (canonGroupFromMap(segmentRaw) ?? null) : null;
    const headCanon = headRaw ? normKey(headRaw) : null;

    const grossStr = grossAmt != null ? String(grossAmt) : "";
    const natKey = `${fy}|${monthLabel}|${headRaw}|${retailer}|${distributor}|${itemCode}|${grossStr}`;
    const occurrence = (occurrenceMap.get(natKey) ?? 0) + 1;
    occurrenceMap.set(natKey, occurrence);

    const lineUid = makeLineUid(fy, monthLabel, headRaw, retailer, distributor, itemCode, grossStr, occurrence);

    result.rows.push({
      lineUid,
      fy,
      monthLabel,
      headRaw: headRaw || null,
      headCanon,
      stateRaw: null,
      // stateCanon populated by post-load UPDATE (backfillSkuStateCanon) from person_registry
      stateCanon: null,
      retailer: retailer || null,
      retailerId: retailerId || null,
      distributor: distributor || null,
      itemCode,
      segmentRaw: segmentRaw || null,
      segmentCanon,
      qty: qty != null ? String(qty) : null,
      mrp: mrp != null ? String(mrp) : null,
      netAmount: netAmt != null ? String(netAmt) : null,
      grossAmount: grossAmt != null ? String(grossAmt) : null,
      discountPct: discountPct != null ? String(discountPct) : null,
      source: `sheets_sku_backfill:${sheetId}`,
    });
    if (retailerId) result.rowsWithRetId++;
  }

  return result;
}

// ── Insert batch ─────────────────────────────────────────────────────────────

const INSERT_BATCH = 500;

async function insertBatch(rows: InsertSecSkuLine[], dryRun: boolean): Promise<number> {
  if (dryRun || rows.length === 0) return rows.length;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    const result = await db
      .insert(secondarySkuLines)
      .values(batch)
      .onConflictDoNothing()
      .returning({ lineUid: secondarySkuLines.lineUid });
    inserted += result.length;
  }
  return inserted;
}

// ── Public API ───────────────────────────────────────────────────────────────

export type SkuLoadResult = {
  fy: string;
  sheetId: string;
  tabs: number;
  tabsWithItemCodes: number;
  rowsParsed: number;
  rowsInserted: number;
  noItemCode: number;
  noMonth: number;
  skipped: number;
  rowsWithRetId: number;
  dryRun: boolean;
};

/**
 * Load item-code level secondary register data from a Google Sheet.
 *
 * dryRun=true (default): parses and validates but writes nothing.
 * dryRun=false: inserts into secondary_sku_line (ON CONFLICT DO NOTHING).
 */
// ── Replace-mode sanity gate (pure, unit-tested) ──────────────────────────────
//
// Guards the destructive delete in replace mode. A successfully *read* but
// unparseable/empty/truncated workbook must never replace existing rows.

export const REPLACE_MIN_ROWS = 1_000;
export const REPLACE_MIN_RETID_COVERAGE = 0.9;
export const REPLACE_MIN_EXISTING_RATIO = 0.5;

export const WIPE_GUARD_RATIO = 0.60; // 60% floor: incoming >= 60% of prior like-month
export function checkReplaceSanity(input: {
  rowsParsed: number;
  rowsWithRetId: number;
  tabsWithItemCodes: number;
  existingRows: number;
}): { ok: true } | { ok: false; reason: string } {
  const { rowsParsed, rowsWithRetId, tabsWithItemCodes, existingRows } = input;
  if (tabsWithItemCodes < 1) {
    return { ok: false, reason: "no data tab with item codes was found in the workbook" };
  }
  if (rowsParsed < REPLACE_MIN_ROWS) {
    return {
      ok: false,
      reason: `only ${rowsParsed} rows parsed (< ${REPLACE_MIN_ROWS} minimum) — workbook looks empty or malformed`,
    };
  }
  const coverage = rowsWithRetId / rowsParsed;
  if (coverage < REPLACE_MIN_RETID_COVERAGE) {
    return {
      ok: false,
      reason: `RET# coverage ${(coverage * 100).toFixed(1)}% is below ${REPLACE_MIN_RETID_COVERAGE * 100}% — carry-forward or column detection likely broke`,
    };
  }
  if (existingRows > 0 && rowsParsed < existingRows * REPLACE_MIN_EXISTING_RATIO) {
    return {
      ok: false,
      reason: `parsed ${rowsParsed} rows but ${existingRows} rows already exist (< ${REPLACE_MIN_EXISTING_RATIO * 100}% of existing) — refusing a suspiciously small replacement`,
    };
  }
  return { ok: true };
}

export async function loadSecSkuFromSheets(
  fy: string,
  sheetId: string,
  dryRun = true,
  opts: {
    replace?: boolean;
    /** Skip the wipe guard. Must be set explicitly — never default, never env var. */
    skipGuard?: boolean;
    /** Human-readable label for who set skipGuard (required when skipGuard=true). */
    skipGuardLabel?: string;
  } = {},
): Promise<SkuLoadResult> {
  const replace = opts.replace === true && !dryRun;
  logger.info({ fy, sheetId, dryRun, replace }, "skuLoader: starting");

  const tabs = await listSheetTabs(sheetId);
  logger.info({ fy, sheetId, tabCount: tabs.length }, "skuLoader: tabs discovered");

  let tabsWithItemCodes = 0;
  let totalParsed = 0;
  let totalInserted = 0;
  let totalNoItemCode = 0;
  let totalNoMonth = 0;
  let totalSkipped = 0;
  let totalWithRetId = 0;
  // replace mode: buffer every parsed row so the delete+insert happens in one
  // transaction only after ALL Sheets reads succeeded — a mid-read quota
  // failure must never leave the FY half-loaded.
  const bufferedRows: InsertSecSkuLine[] = [];

  for (const tab of tabs) {
    // Skip obviously non-data tabs by title.
    const title = tab.title.trim().toUpperCase();
    if (
      title.includes("INDEX") ||
      title.includes("SUMMARY") ||
      title.includes("COVER") ||
      title.includes("INSTRUCTIONS")
    ) {
      logger.debug({ fy, tab: tab.title }, "skuLoader: skipping non-data tab by title");
      continue;
    }

    logger.info({ fy, tab: tab.title }, "skuLoader: reading tab");

    const rawRows: SheetCellValue[][] = [];
    await readTabRowsChunked(sheetId, tab.title, (chunk) => {
      rawRows.push(...chunk);
    });

    if (rawRows.length < 2) continue;

    const parseResult = parseTab(tab.title, rawRows, fy, sheetId);

    if (parseResult.rows.length === 0 && parseResult.noItemCode > 0) {
      logger.info(
        { fy, tab: tab.title, noItemCode: parseResult.noItemCode },
        "skuLoader: tab has no item-code column — skipping",
      );
      continue;
    }

    tabsWithItemCodes++;
    totalNoItemCode += parseResult.noItemCode;
    totalNoMonth += parseResult.noMonth;
    totalSkipped += parseResult.skipped;
    totalParsed += parseResult.rows.length;
    totalWithRetId += parseResult.rowsWithRetId;

    let inserted: number;
    if (replace) {
      // push(...rows) overflows the call stack on 300k-row tabs — loop instead.
      for (const r of parseResult.rows) bufferedRows.push(r);
      inserted = parseResult.rows.length; // written after all tabs parse
    } else {
      inserted = await insertBatch(parseResult.rows, dryRun);
    }
    totalInserted += inserted;

    logger.info(
      {
        fy,
        tab: tab.title,
        parsed: parseResult.rows.length,
        inserted,
        dryRun,
      },
      "skuLoader: tab processed",
    );
  }

  if (replace) {
    // Fail-closed sanity gate: atomicity alone would happily replace an FY
    // with a bad-but-complete parse. Refuse to delete anything unless the
    // parsed set looks like a genuine full workbook.
    const existingRes = await db.execute<{ n: string }>(
      sqlRaw`SELECT COUNT(*)::text AS n FROM secondary_sku_line WHERE fy = ${fy} AND source LIKE 'sheets_sku_backfill:%'`,
    );
    const existingRows = parseInt(existingRes.rows[0]?.n ?? "0", 10);
    const gate = checkReplaceSanity({
      rowsParsed: totalParsed,
      rowsWithRetId: totalWithRetId,
      tabsWithItemCodes,
      existingRows,
    });
    if (!gate.ok) {
      throw new Error(`skuLoader: replace refused for FY${fy} — ${gate.reason}`);
    }
    // All tabs parsed successfully — atomic swap of the FY's sheets-sourced rows.
    totalInserted = 0;
    await db.transaction(async (tx) => {
      // ── Wipe guard: runs BEFORE the DELETE, inside this transaction ────────
      // Throws WipeGuardAbortError on ratio violation — Drizzle rolls back.
      await assertSkuWipeGuard({
        tx: tx as any,
        fy,
        incoming: bufferedRows.map((r) => ({
          monthLabel: r.monthLabel,
          distributor: r.distributor ?? null,
          head: r.headCanon ?? null,
        })),
        skipGuard: opts.skipGuard === true,
        callerLabel: opts.skipGuardLabel ?? "loadSecSkuFromSheets opts.skipGuard",
        sourceLike: "sheets_sku_backfill:%",
        // Explicit flag: this loader always maps headCanon into the head
        // dimension, so Rule 3 (per-member drop check) must always run.
        // Setting this to true means Rule 3 fires even when all parsed heads
        // happen to be null — a workbook that loses the head column is refused
        // rather than silently bypassing the member check.
        memberGuardEnabled: true,
      });
      await tx.execute(
        sqlRaw`DELETE FROM secondary_sku_line WHERE fy = ${fy} AND source LIKE 'sheets_sku_backfill:%'`,
      );
      for (let i = 0; i < bufferedRows.length; i += INSERT_BATCH) {
        const batch = bufferedRows.slice(i, i + INSERT_BATCH);
        const inserted = await tx
          .insert(secondarySkuLines)
          .values(batch)
          .onConflictDoNothing()
          .returning({ lineUid: secondarySkuLines.lineUid });
        totalInserted += inserted.length;
      }
      // ── State-canon backfill — runs INSIDE the replace transaction ──────────
      // Failure here rolls back the entire replace so the FY is never left in a
      // state where rows are inserted but state_canon is missing.  The .catch()
      // wrapper used for append-only loads is intentionally absent here.
      //
      // Join uses the same two-path strategy as backfillSkuStateCanon():
      //   Path A — exact norm_key (employee-code keys)
      //   Path B — normalised alias_secondary / canonical_name (display-name keys)
      // Collision-safe: only updates head_canons where all matching registry entries
      // agree on the same state_head (HAVING COUNT(DISTINCT) = 1).  Ambiguous names
      // are left NULL and counted in the residual warning.
      const backfillResult = await tx.execute<{ updated: string }>(sqlRaw`
        WITH registry_norm AS (
          SELECT
            norm_key,
            REGEXP_REPLACE(LOWER(TRIM(COALESCE(alias_secondary, canonical_name))), '\s+', ' ', 'g')
              AS display_key,
            state_head
          FROM person_registry
          WHERE state_head IS NOT NULL
        ),
        head_match AS (
          SELECT
            ssl.head_canon,
            MIN(rm.state_head) AS state_head
          FROM secondary_sku_line ssl
          JOIN registry_norm rm
            ON ssl.head_canon = rm.norm_key
            OR ssl.head_canon = rm.display_key
          WHERE ssl.fy = ${fy}
            AND ssl.state_canon IS NULL
            AND ssl.head_canon IS NOT NULL
          GROUP BY ssl.head_canon
          HAVING COUNT(DISTINCT rm.state_head) = 1
        ),
        done AS (
          UPDATE secondary_sku_line ssl
          SET state_canon = hm.state_head
          FROM head_match hm
          WHERE ssl.head_canon = hm.head_canon
            AND ssl.fy = ${fy}
            AND ssl.state_canon IS NULL
          RETURNING ssl.line_uid
        )
        SELECT COUNT(*)::text AS updated FROM done
      `);
      const stateCanonUpdated = parseInt(backfillResult.rows[0]?.updated ?? "0", 10);
      logger.info({ fy, stateCanonUpdated }, "skuLoader: state_canon backfill complete (in replace txn)");
    });
    logger.info({ fy, replaced: bufferedRows.length, inserted: totalInserted }, "skuLoader: replace txn committed");
  }

  const result: SkuLoadResult = {
    fy,
    sheetId,
    tabs: tabs.length,
    tabsWithItemCodes,
    rowsParsed: totalParsed,
    rowsInserted: totalInserted,
    noItemCode: totalNoItemCode,
    noMonth: totalNoMonth,
    skipped: totalSkipped,
    rowsWithRetId: totalWithRetId,
    dryRun,
  };

  logger.info(result, "skuLoader: complete");

  // After an append-only live load, backfill state_canon for newly inserted
  // rows that are still NULL.  Replace-mode loads do this inside their
  // transaction (above).  This call propagates errors — a backfill failure is
  // treated the same as an insert failure: the caller gets an exception.
  if (!dryRun && !replace) {
    await backfillSkuStateCanon(fy);
  }
  if (!dryRun && totalInserted > 0) {
    clearSecondarySkuFyCache();
    // Post-load coverage check: compare per-member sku_line totals vs register
    // totals and warn when PSCode2 appears incomplete. This is a background
    // diagnostic — the ingest is already committed. Any failure is logged at WARN
    // so it is never silently discarded; it does not block the response.
    import("./skuCoverageGuard.js")
      .then(({ checkSkuVsRegisterCoverage }) =>
        checkSkuVsRegisterCoverage(fy).catch((err: unknown) =>
          logger.warn({ fy, err }, "skuLoader: post-load coverage check query failed"),
        ),
      )
      .catch((importErr: unknown) =>
        logger.warn({ fy, importErr }, "skuLoader: failed to import skuCoverageGuard — post-load coverage check skipped"),
      );
  }
  return result;
}

// ── State-canon backfill ──────────────────────────────────────────────────────

/**
 * Propagate state_head from the person table into person_registry.
 *
 * Mirrors migration 034 steps 1 & 2:
 *   Step 1 — for each non-state-head person whose name matches a registry row,
 *             set person_registry.state_head to the name of their state-head
 *             (looked up via person.state_head_person_id → person.name).
 *   Step 2 — state heads themselves: ensure their own registry row has
 *             state_head = their own canonical_name.
 *
 * Unlike the migration, this is NOT idempotent in the "only touches NULL" sense:
 * it also overwrites existing values so a correction to state_head_person_id
 * propagates even when person_registry.state_head was already set (possibly to
 * the wrong value).  This is the intended behaviour for the self-service sync.
 *
 * @returns Object with step1Updated and step2Updated row counts.
 */
export async function syncPersonRegistryStateHead(): Promise<{
  step1Updated: number;
  step2Updated: number;
}> {
  // Step 1: propagate state_head from person → person_registry via name match.
  // Overwrites existing values so corrections to state_head_person_id take effect.
  const step1Res = await db.execute<{ updated: string }>(sqlRaw`
    WITH updates AS (
      UPDATE person_registry pr
      SET
        state_head = sh.name,
        updated_at = now()
      FROM person p
      JOIN person sh ON sh.person_id = p.state_head_person_id
      WHERE LOWER(TRIM(p.name)) = LOWER(TRIM(pr.canonical_name))
        AND p.state_head_person_id IS NOT NULL
      RETURNING pr.canonical_name
    )
    SELECT COUNT(*)::text AS updated FROM updates
  `);
  const step1Updated = parseInt(step1Res.rows[0]?.updated ?? "0", 10);

  // Step 2: state heads themselves — state_head = their own canonical_name.
  // Overwrites existing values (same reason as step 1).
  const step2Res = await db.execute<{ updated: string }>(sqlRaw`
    WITH updates AS (
      UPDATE person_registry pr
      SET
        state_head = pr.canonical_name,
        updated_at = now()
      WHERE pr.is_state_head = TRUE
      RETURNING pr.canonical_name
    )
    SELECT COUNT(*)::text AS updated FROM updates
  `);
  const step2Updated = parseInt(step2Res.rows[0]?.updated ?? "0", 10);

  logger.info(
    { step1Updated, step2Updated },
    "syncPersonRegistryStateHead: complete",
  );
  return { step1Updated, step2Updated };
}

/**
 * Backfill secondary_sku_line.state_canon for rows whose head_canon resolves
 * to a person_registry entry that now has a non-null state_head.
 *
 * Called automatically after every live (non-dry-run) SKU load, and exposed
 * for direct use by the SKU route (POST /api/sku/backfill-state-canon).
 *
 * Idempotent: only touches rows where state_canon IS NULL.
 *
 * @param fy Optional — limit to a single FY; omit to cover all FYs.
 * @returns Number of rows updated.
 */
export async function backfillSkuStateCanon(fy?: string): Promise<number> {
  // head_canon is produced by normKey(headRaw):
  //   normKey(x) = x.toLowerCase().replace(/\s+/g, " ").trim()
  //
  // Join strategy (mirroring migration 034 step 3):
  //   Path A — exact norm_key match (employee-code registry keys)
  //   Path B — normalised alias_secondary / canonical_name match
  //            (REGEXP_REPLACE replicates the JS normKey() function in SQL)
  // Collision-safe: only updates unambiguous head_canons (HAVING COUNT(DISTINCT) = 1).
  // Ambiguous names (two registry entries disagree on state_head) are left NULL.
  const fyClause = fy ? sqlRaw`AND ssl.fy = ${fy}` : sqlRaw``;
  const fyUpdateClause = fy ? sqlRaw`AND ssl.fy = ${fy}` : sqlRaw``;
  const result = await db.execute<{ updated: string }>(sqlRaw`
    WITH registry_norm AS (
      SELECT
        norm_key,
        REGEXP_REPLACE(LOWER(TRIM(COALESCE(alias_secondary, canonical_name))), '\s+', ' ', 'g')
          AS display_key,
        state_head
      FROM person_registry
      WHERE state_head IS NOT NULL
    ),
    head_match AS (
      SELECT
        ssl.head_canon,
        MIN(rm.state_head) AS state_head
      FROM secondary_sku_line ssl
      JOIN registry_norm rm
        ON ssl.head_canon = rm.norm_key
        OR ssl.head_canon = rm.display_key
      WHERE ssl.state_canon IS NULL
        AND ssl.head_canon IS NOT NULL
        ${fyClause}
      GROUP BY ssl.head_canon
      HAVING COUNT(DISTINCT rm.state_head) = 1
    ),
    updated AS (
      UPDATE secondary_sku_line ssl
      SET state_canon = hm.state_head
      FROM head_match hm
      WHERE ssl.head_canon = hm.head_canon
        AND ssl.state_canon IS NULL
        ${fyUpdateClause}
      RETURNING ssl.line_uid
    )
    SELECT COUNT(*)::text AS updated FROM updated
  `);
  const count = parseInt(result.rows[0]?.updated ?? "0", 10);
  logger.info({ fy: fy ?? "all", updated: count }, "backfillSkuStateCanon: complete");
  return count;
}

/**
 * Materialality check: count NULL state_canon rows in secondary_sku_line.
 * Irreducible structural residual is ~17k (unmapped head names).
 * Returns { nullCount, total } for use by startup guard and admin routes.
 */
export async function getSkuStateCanonResidual(): Promise<{ nullCount: number; total: number }> {
  const result = await db.execute<{ null_count: string; total: string }>(sqlRaw`
    SELECT
      COUNT(*) FILTER (WHERE state_canon IS NULL)::text AS null_count,
      COUNT(*)::text AS total
    FROM secondary_sku_line
  `);
  return {
    nullCount: parseInt(result.rows[0]?.null_count ?? "0", 10),
    total: parseInt(result.rows[0]?.total ?? "0", 10),
  };
}

/** Rows with a NULL state_canon that exceed this count trigger a startup WARN. */
export const SKU_STATE_CANON_MATERIALITY_THRESHOLD = 50_000;

// ── Sheet ID registry ─────────────────────────────────────────────────────────

/**
 * Sheet IDs for the secondary SKU registers, keyed by FY.
 * FY2026-27 is intentionally absent — register not yet loaded.
 * When that register is loaded, add its sheet ID here and re-run the backfill.
 *
 * Source: Prayag SKU Deep Dive spec, verified 29 July 2026.
 * FY2023-24: 14-column layout — supported but Cat. No. position may differ.
 * FY2024-25: 15-column standard layout (use 1sejEhXCaPXwYZ99 — not the duplicate).
 * FY2025-26: 15-column standard layout.
 */
export const SKU_SHEET_IDS: Record<string, string> = {
  "2021-22": "1RtRByRmNQorYOEeHsZuOy1GIkB7dVu7MNv9P_pg97Bs",
  "2022-23": "1wj96uhny-eBC2umGa8bP9M1j1T9YEt-DsThduzoC-2c",
  "2023-24": "1c5ZmmcKUbp9hvW0aS_HQjkjL-FJyyZ2P8Orbc0uaPbY",
  "2024-25": "1sejEhXCaPXwYZ99mP0tPGo_pA623FQaBN2JBcreIy2g",
  "2025-26": "1aNQ2TczEMHcSeB26yKoKayiq1CWc4dXdTQORrgxdl80",
};

export const SUPPORTED_SKU_FYS = Object.keys(SKU_SHEET_IDS);

// ── Data-presence check ──────────────────────────────────────────────────────
// Some FYs are loaded from sources other than Google Sheets (FY2026-27 came in
// as a one-time PSCode_3 xlsx drop, source='pscode3_xlsx'), so gates must ask
// the database — not SKU_SHEET_IDS — whether register data exists for an FY.
const fyDataCache = new Map<string, { has: boolean; at: number }>();
const fyMonthsCache = new Map<string, { months: string[]; at: number }>();
const FY_DATA_TTL_MS = 10 * 60 * 1000;

/** Drop the presence cache — call after any load/reload of secondary_sku_line. */
export function clearSecondarySkuFyCache(): void {
  fyDataCache.clear();
  fyMonthsCache.clear();
  clearRetailerRegistry();
}

/** True when secondary_sku_line has at least one row for the FY (10-min cache). */
export async function secondarySkuFyHasData(fy: string): Promise<boolean> {
  const hit = fyDataCache.get(fy);
  if (hit && Date.now() - hit.at < FY_DATA_TTL_MS) return hit.has;
  const res = await db.execute(
    sqlRaw`SELECT 1 FROM secondary_sku_line WHERE fy = ${fy} LIMIT 1`,
  );
  const has = res.rows.length > 0;
  fyDataCache.set(fy, { has, at: Date.now() });
  return has;
}

// Month-name → fiscal index (Apr=1 … Mar=12) for ordering.
const MONTH_IDX: Record<string, number> = {
  Apr: 1, May: 2, Jun: 3, Jul: 4, Aug: 5, Sep: 6,
  Oct: 7, Nov: 8, Dec: 9, Jan: 10, Feb: 11, Mar: 12,
};

/**
 * Returns a human-readable period string for the months loaded in
 * secondary_sku_line for the given FY, e.g. "Apr–Jul 2026" or "Apr 2026".
 * Returns null when no data exists.  Result is cached for 10 minutes.
 */
export async function getSecondarySkuFyPeriodLabel(fy: string): Promise<string | null> {
  const hit = fyMonthsCache.get(fy);
  if (hit && Date.now() - hit.at < FY_DATA_TTL_MS) {
    return hit.months.length === 0 ? null : hit.months.join("|"); // stored as joined; decoded below
  }
  const res = await db.execute<{ month_label: string }>(
    sqlRaw`SELECT DISTINCT month_label FROM secondary_sku_line WHERE fy = ${fy}`,
  );
  const months = res.rows
    .map((r) => r.month_label)
    .sort((a, b) => {
      const ai = MONTH_IDX[a.split("-")[0]] ?? 99;
      const bi = MONTH_IDX[b.split("-")[0]] ?? 99;
      return ai - bi;
    });
  fyMonthsCache.set(fy, { months, at: Date.now() });
  if (months.length === 0) return null;
  // Format: "Apr–Jul 2026" or "Apr 2026" (single month)
  // month_label format is "Mmm-YY", e.g. "Apr-26" → year = "20YY"
  const yearSuffix = months[0].split("-")[1] ?? "??";
  const calYear = `20${yearSuffix}`;
  const firstMon = months[0].split("-")[0];
  const lastMon = months[months.length - 1].split("-")[0];
  return firstMon === lastMon
    ? `${firstMon} ${calYear}`
    : `${firstMon}–${lastMon} ${calYear}`;
}

/** "2025-26" → "2024-25" */
export function priorFyLabel(fy: string): string {
  const start = parseInt(fy.slice(0, 4), 10) - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/**
 * Pure per-month ratio check. Given:
 *   incomingByMonth  — month_label → incoming row count from the new batch
 *   priorByMonth     — prior-FY like-month label → existing DB row count
 *
 * Returns ok when every month with a prior baseline is above the ratio floor.
 * Months whose prior baseline is 0 (new month, no prior history) are skipped —
 * they are not evidence of a wipe.
 *
 * The guard fires before the DELETE, so on failure no data is ever deleted.
 */
export function checkOpenFyWipeGuard(
  incomingByMonth: Map<string, number>,
  priorByMonth: Map<string, number>,
  ratio: number = WIPE_GUARD_RATIO,
): { ok: true } | { ok: false; reason: string; violations: WipeGuardViolation[] } {
  const violations: WipeGuardViolation[] = [];

  for (const [month, incoming] of incomingByMonth) {
    const priorLike = priorLikeMonthLabel(month);
    const priorRows = priorByMonth.get(priorLike) ?? 0;
    if (priorRows === 0) continue; // no baseline → skip (first load of this month)
    const floor = priorRows * ratio;
    if (incoming < floor) {
      violations.push({ month, incoming, priorLike, priorRows, floor });
    }
  }

  if (violations.length === 0) return { ok: true };

  const desc = violations
    .map(
      (v) =>
        `${v.month}: incoming=${v.incoming} < floor=${v.floor.toFixed(0)} ` +
        `(${(ratio * 100).toFixed(0)}% of prior ${v.priorLike}=${v.priorRows})`,
    )
    .join("; ");
  return { ok: false, reason: `per-month wipe guard: ${desc}`, violations };
}

export type WipeGuardViolation = {
  month: string;
  incoming: number;
  priorLike: string;
  priorRows: number;
  floor: number;
};

/** "Apr-26" → "Apr-25": the same calendar month in the prior fiscal year. */
export function priorLikeMonthLabel(label: string): string {
  const [mon, yy] = label.split("-");
  return `${mon}-${String(parseInt(yy!, 10) - 1).padStart(2, "0")}`;
}
