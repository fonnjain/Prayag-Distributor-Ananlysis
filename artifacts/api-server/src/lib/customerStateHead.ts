/**
 * customerStateHead.ts
 *
 * Derives customer_master.state_head from three sources, in preference order:
 *   1. Exact company-name join to sale_line head_canon  (confidence='sale_line')
 *   2. Distributor → TM → head chain via distributorTmMap + person_registry  (confidence='chain')
 *   3. State-level fallback when the state is served by exactly one head  (confidence='state_lookup')
 *
 * Rows that cannot be resolved are left NULL with head_confidence='Guessed'.
 *
 * Entry points:
 *   runFullBackfill(pool)   – admin route: all three passes over all rows
 *   deriveForIds(pool, ids) – import-time: chain + state-lookup for newly inserted rows
 *   logCoverage(pool)       – startup: one-line summary log
 */

import { pool as defaultPool } from "@workspace/db";
type Pool = typeof defaultPool;
// Accepts both Pool and PoolClient (both expose the same query() signature).
type Queryable = Pick<Pool, "query">;
import { normParty } from "./mgmt/names.js";
import { loadDistributorTmMap, getDistributorTmMapIfReady, type DistributorTmMap } from "./mgmt/distributorTmMap.js";
import { logger } from "./logger.js";

// ── State normalisation ──────────────────────────────────────────────────────
//
// customer_master.state stores raw upload values ("East U.P", "Delhi NCR", etc.)
// sale_line.state_canon uses a different vocabulary ("EAST U.P", "DELHI", etc.)
// This map converts upload values (uppercased) to the sale_line / state_hierarchy vocabulary.

const CUSTOMER_STATE_OVERRIDES: Record<string, string> = {
  "DELHI NCR":     "DELHI",
  "DELHI A":       "DELHI",
  "DELHI (NCR)":   "DELHI",
  "UTTARAKHAND":   "UTTRAKHAND",    // sale_line spelling variant
  "J&K":           "JAMMU AND KASHMIR",
  "JAMMU":         "JAMMU AND KASHMIR",
  "KASHMIR":       "JAMMU AND KASHMIR",
  "HP":            "HIMACHAL PRADESH",
  "AP":            "ANDHRA PRADESH",
  "TAMILNADU":     "TAMIL NADU",
  "TAMILNADU (S)": "TAMIL NADU",
  "KARNATAKA (B)": "KARNATAKA",
  "RAJASTHAN (N)": "RAJASTHAN",
  "MAHARASHTRA 2": "MAHARASHTRA",
  "CHATTISGARH":   "CHHATTISGARH",
  // sale_line UP split variants → keep distinct (do NOT collapse to UTTAR PRADESH)
  "UP ( A )":      "EAST U.P",
  "UP (AS)":       "EAST U.P",
  "UP (S)":        "WEST U.P",
};

/**
 * Normalise a raw customer_master.state value to the vocabulary used in
 * sale_line.state_canon and state_hierarchy.state_canon.
 * Returns null for blank input.
 */
export function normaliseCustomerState(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  return CUSTOMER_STATE_OVERRIDES[upper] ?? upper;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Single-head state map: normalised state_canon → head_canon (only for states with 1 head). */
async function buildSingleHeadStateMap(pool: Queryable): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ state_canon: string; head_canon: string; cnt: string }>(`
    SELECT state_canon,
           MAX(head_canon) AS head_canon,
           COUNT(DISTINCT head_canon) AS cnt
    FROM sale_line_all
    WHERE version_status = 'current'
      AND state_canon IS NOT NULL
      AND head_canon  IS NOT NULL
    GROUP BY state_canon
    HAVING COUNT(DISTINCT head_canon) = 1
  `);
  const m = new Map<string, string>();
  for (const r of rows) {
    m.set(r.state_canon, r.head_canon);
  }
  return m;
}

/**
 * Head territory map: head_canon → Set of state_canon values covered in sale_line.
 * Used as a guard: if the chain resolves a head but that head has no sales in the
 * customer's state, the assignment is likely wrong → leave unresolved.
 */
async function buildHeadTerritoryMap(pool: Queryable): Promise<Map<string, Set<string>>> {
  const { rows } = await pool.query<{ head_canon: string; state_canon: string }>(`
    SELECT DISTINCT head_canon, state_canon
    FROM sale_line_all
    WHERE version_status = 'current'
      AND head_canon  IS NOT NULL
      AND state_canon IS NOT NULL
  `);
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    let s = m.get(r.head_canon);
    if (!s) { s = new Set(); m.set(r.head_canon, s); }
    s.add(r.state_canon);
  }
  return m;
}

/** Query person_registry once and return norm_key → state_head mapping. */
async function buildPersonStateHeadMap(pool: Queryable): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ norm_key: string; state_head: string | null }>(`
    SELECT norm_key, state_head
    FROM person_registry
    WHERE state_head IS NOT NULL AND is_person = true
  `);
  const m = new Map<string, string>();
  for (const r of rows) {
    if (r.state_head) m.set(r.norm_key, r.state_head);
  }
  return m;
}

// ── Pass 1: sale_line name match ──────────────────────────────────────────────

/**
 * For each customer whose UPPER(TRIM(company)) matches exactly one head_canon
 * across all sale_line rows, write state_head and head_confidence='sale_line'.
 * Skips customers already having a state_head.
 * Returns the number of rows updated.
 */
async function passSaleLine(pool: Queryable, idFilter?: string[]): Promise<number> {
  // Build a map: UPPER(TRIM(customer)) → head_canon (only unambiguous ones).
  const { rows: slRows } = await pool.query<{ cust: string; head_canon: string }>(`
    SELECT UPPER(TRIM(customer)) AS cust,
           MAX(head_canon)       AS head_canon
    FROM sale_line_all
    WHERE version_status = 'current'
      AND head_canon IS NOT NULL
      AND customer   IS NOT NULL
    GROUP BY UPPER(TRIM(customer))
    HAVING COUNT(DISTINCT head_canon) = 1
  `);
  if (!slRows.length) return 0;

  const headByName = new Map<string, string>();
  for (const r of slRows) headByName.set(r.cust, r.head_canon);

  // Fetch customers with null state_head.
  const whereId = idFilter?.length
    ? `AND id = ANY($1::text[])`
    : "";
  const params: unknown[] = idFilter?.length ? [idFilter] : [];
  const { rows: cmRows } = await pool.query<{ id: string; company: string }>(
    `SELECT id, company FROM customer_master WHERE state_head IS NULL ${whereId}`,
    params,
  );

  const updates: Array<{ id: string; head: string }> = [];
  for (const cm of cmRows) {
    const key = (cm.company ?? "").trim().toUpperCase();
    const head = headByName.get(key);
    if (head) updates.push({ id: cm.id, head });
  }
  if (!updates.length) return 0;

  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const batch = updates.slice(i, i + CHUNK);
    const ids   = batch.map((u) => u.id);
    const heads = batch.map((u) => u.head);
    await pool.query(
      `UPDATE customer_master
          SET state_head      = v.head,
              head_confidence = 'sale_line'
         FROM (SELECT UNNEST($1::text[]) AS id, UNNEST($2::text[]) AS head) AS v
        WHERE customer_master.id = v.id
          AND customer_master.state_head IS NULL`,
      [ids, heads],
    );
    total += batch.length;
  }
  return total;
}

// ── Pass 2: distributor → TM → head chain ────────────────────────────────────

/**
 * Resolves state_head via distributorTmMap + person_registry for Distributor,
 * Direct Dealer, and Retailer customers whose state_head is still NULL.
 * Applies a territory guard to reject plausible mis-maps.
 * Returns the number of rows updated.
 *
 * @param prebuiltDistMap  Optional already-built map to avoid a redundant Drive call.
 *   When omitted the function falls back to loadDistributorTmMap() (blocking build).
 */
async function passChain(
  pool: Queryable,
  idFilter?: string[],
  prebuiltDistMap?: DistributorTmMap,
): Promise<number> {
  const [distMap, personStateHead, headTerritory] = await Promise.all([
    prebuiltDistMap ? Promise.resolve(prebuiltDistMap) : loadDistributorTmMap(),
    buildPersonStateHeadMap(pool),
    buildHeadTerritoryMap(pool),
  ]);

  if (distMap.error) {
    logger.warn({ err: distMap.error }, "[customerStateHead] distributorTmMap failed; skipping chain pass");
    return 0;
  }

  const whereId = idFilter?.length ? `AND cm.id = ANY($1::text[])` : "";
  const params: unknown[] = idFilter?.length ? [idFilter] : [];

  // -- Distributors + Direct Dealers --
  const { rows: ddRows } = await pool.query<{ id: string; company: string; state: string | null }>(
    `SELECT id, company, state
       FROM customer_master cm
      WHERE state_head IS NULL
        AND type IN ('Distributor','Direct Dealer')
        ${whereId}`,
    params,
  );

  // -- Retailers via resolved_dist_id --
  const { rows: retRows } = await pool.query<{
    retailer_id: string; state: string | null; dist_norm_key: string;
  }>(
    `SELECT cm.id AS retailer_id, cm.state, di.norm_key AS dist_norm_key
       FROM customer_master cm
       JOIN retailer_distributor rd ON rd.retailer_id = cm.id AND rd.resolved_dist_id IS NOT NULL
       JOIN distributor_identity  di ON di.dist_id = rd.resolved_dist_id
      WHERE cm.state_head IS NULL
        AND cm.type = 'Retailer'
        ${whereId.replace("cm.id", "cm.id")}`,
    params,
  );

  const updates: Array<{ id: string; head: string }> = [];

  /** Try to resolve a distributor norm_key → state_head, with territory guard. */
  const resolve = (distNormKey: string, rawState: string | null): string | null => {
    const entry = distMap.byPartyKey.get(distNormKey);
    if (!entry) return null;
    const stateHead = personStateHead.get(entry.memberNormKey);
    if (!stateHead) return null;
    // Territory guard: if normalised customer state exists in sale_line AND the
    // resolved head has no sales there, don't trust this assignment.
    if (rawState) {
      const normState = normaliseCustomerState(rawState);
      if (normState) {
        const headStates = headTerritory.get(stateHead);
        if (headStates && !headStates.has(normState)) {
          // Head has sale_line data but not in this state → likely a mis-map.
          return null;
        }
      }
    }
    return stateHead;
  };

  for (const row of ddRows) {
    const key = normParty(row.company);
    if (!key) continue;
    const head = resolve(key, row.state);
    if (head) updates.push({ id: row.id, head });
  }

  // For retailers, use the first resolved distributor that succeeds.
  const seenRetailer = new Map<string, string>();
  for (const row of retRows) {
    if (seenRetailer.has(row.retailer_id)) continue;
    const head = resolve(row.dist_norm_key, row.state);
    if (head) seenRetailer.set(row.retailer_id, head);
  }
  for (const [id, head] of seenRetailer) {
    updates.push({ id, head });
  }

  if (!updates.length) return 0;

  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const batch = updates.slice(i, i + CHUNK);
    const ids   = batch.map((u) => u.id);
    const heads = batch.map((u) => u.head);
    await pool.query(
      `UPDATE customer_master
          SET state_head      = v.head,
              head_confidence = 'chain'
         FROM (SELECT UNNEST($1::text[]) AS id, UNNEST($2::text[]) AS head) AS v
        WHERE customer_master.id = v.id
          AND customer_master.state_head IS NULL`,
      [ids, heads],
    );
    total += batch.length;
  }
  return total;
}

// ── Pass 3: state-level fallback ──────────────────────────────────────────────

/**
 * For remaining NULL-state_head rows whose normalised state maps to a single-head
 * state in sale_line, writes the head with head_confidence='state_lookup'.
 * Skips multi-head states (e.g. West U.P, East U.P, Karnataka).
 * Returns the number of rows updated.
 */
async function passStateLookup(pool: Queryable, idFilter?: string[]): Promise<number> {
  const singleHeadMap = await buildSingleHeadStateMap(pool);
  if (!singleHeadMap.size) return 0;

  const whereId = idFilter?.length ? `AND id = ANY($1::text[])` : "";
  const params: unknown[] = idFilter?.length ? [idFilter] : [];

  const { rows: cmRows } = await pool.query<{ id: string; state: string | null }>(
    `SELECT id, state FROM customer_master WHERE state_head IS NULL ${whereId}`,
    params,
  );

  const updates: Array<{ id: string; head: string }> = [];
  for (const cm of cmRows) {
    const normState = normaliseCustomerState(cm.state);
    if (!normState) continue;
    const head = singleHeadMap.get(normState);
    if (head) updates.push({ id: cm.id, head });
  }
  if (!updates.length) return 0;

  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const batch = updates.slice(i, i + CHUNK);
    const ids   = batch.map((u) => u.id);
    const heads = batch.map((u) => u.head);
    await pool.query(
      `UPDATE customer_master
          SET state_head      = v.head,
              head_confidence = 'state_lookup'
         FROM (SELECT UNNEST($1::text[]) AS id, UNNEST($2::text[]) AS head) AS v
        WHERE customer_master.id = v.id
          AND customer_master.state_head IS NULL`,
      [ids, heads],
    );
    total += batch.length;
  }
  return total;
}

// ── Cascade-states filter ─────────────────────────────────────────────────────

export interface StateHierarchyRow {
  canon: string;
  parent: string;
  isSplit: boolean;
}

/**
 * Given the raw state strings stored in customer_master for a particular state
 * head, and the full ordered state_hierarchy list (allRows), returns the
 * filtered subset that head serves — including parent-aggregate rows whenever
 * any of their children are matched.
 *
 * Returns null in two cases (caller should fall back to allRows):
 *   1. rawStates is empty  → backfill has not yet run for this head.
 *   2. Filtering yields 0  → vocabulary mismatch (no overlap with hierarchy).
 *
 * This function is intentionally pure so it can be unit-tested without a DB.
 */
export function buildCascadeStates(
  rawStates: string[],
  allRows: StateHierarchyRow[],
): StateHierarchyRow[] | null {
  if (!rawStates.length) return null;

  // Normalise each raw customer_master.state value to the vocabulary used in
  // state_hierarchy.state_canon.
  const normSet = new Set<string>();
  for (const s of rawStates) {
    const n = normaliseCustomerState(s);
    if (n) normSet.add(n);
  }

  // Collect parents of any matched leaf so the parent-aggregate row is included.
  const parentSet = new Set<string>();
  for (const row of allRows) {
    if (normSet.has(row.canon)) parentSet.add(row.parent);
  }

  // A row is kept if:
  //   • it is itself a matched leaf (normSet.has(canon))
  //   • it is a leaf whose parent is a matched canon (split states)
  //   • it is a parent-aggregate row for matched children
  const filtered = allRows.filter(
    (r) => normSet.has(r.canon) || normSet.has(r.parent) || parentSet.has(r.canon),
  );

  return filtered.length ? filtered : null;
}

// ── Picker alias resolution ───────────────────────────────────────────────────

/**
 * The state-head picker sends person_registry.canonical_name (the HR name,
 * e.g. "Pawan Kumar Sharma"), but customer_master.state_head stores the
 * sale-line display canonical — COALESCE(alias_secondary, canonical_name)
 * (e.g. "Pawan Sharma").  Resolve the picker value to the stored form so
 * the cascade-states filter matches actual DB values.
 *
 * Falls back to the raw picker value when no registry row is found, so the
 * endpoint degrades gracefully (will return no rows → fallback to all states).
 */
export async function resolvePickerToStoredHead(
  db: Queryable,
  pickerName: string,
): Promise<string> {
  const { rows } = await db.query<{ stored_head: string }>(`
    SELECT COALESCE(alias_secondary, canonical_name) AS stored_head
    FROM person_registry
    WHERE is_state_head = true
      AND (canonical_name = $1 OR alias_secondary = $1)
    LIMIT 1
  `, [pickerName]);
  return rows[0]?.stored_head ?? pickerName;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface BackfillCounts {
  total: number;
  saleLine: number;
  chain: number;
  stateLookup: number;
  unresolved: number;
}

/**
 * Run all three passes over the entire customer_master table.
 * Caller must hold an advisory lock before calling and pass the same locked
 * queryable (client or pool) so all queries execute under that exclusion.
 *
 * @param distMap  Pre-fetched distributorTmMap.  The caller is responsible for
 *   ensuring the map is ready (no error) before passing it.  When omitted the
 *   chain pass falls back to loadDistributorTmMap() (may trigger a Drive build).
 */
export async function runFullBackfill(
  pool: Queryable,
  distMap?: DistributorTmMap,
): Promise<BackfillCounts> {
  const { rows: [{ total }] } = await pool.query<{ total: string }>(
    "SELECT COUNT(*) AS total FROM customer_master",
  );
  const totalN = Number(total);

  const slCount = await passSaleLine(pool);
  logger.info({ slCount }, "[customerStateHead] pass 1 (sale_line) done");

  const chainCount = await passChain(pool, undefined, distMap);
  if (chainCount === 0) {
    logger.warn(
      { distMapReady: !!distMap, distMapError: distMap?.error ?? null },
      "[customerStateHead] pass 2 (chain) resolved 0 rows — check distributorTmMap readiness",
    );
  } else {
    logger.info({ chainCount }, "[customerStateHead] pass 2 (chain) done");
  }

  const stateCount = await passStateLookup(pool);
  logger.info({ stateCount }, "[customerStateHead] pass 3 (state_lookup) done");

  // Count actual NULL rows post-passes (correct even when rows were already
  // populated before this invocation ran).
  const { rows: [{ unresolved_count }] } = await pool.query<{ unresolved_count: string }>(
    "SELECT COUNT(*) AS unresolved_count FROM customer_master WHERE state_head IS NULL",
  );
  const unresolved = Number(unresolved_count);
  return { total: totalN, saleLine: slCount, chain: chainCount, stateLookup: stateCount, unresolved };
}

/**
 * Run chain + state-lookup derivation for a specific set of customer IDs
 * (newly inserted rows from a bulk import). Does NOT run the sale_line pass —
 * that pass is relatively expensive and import-time sale_line matches are
 * rare; run the full backfill periodically for complete coverage.
 *
 * @param distMap  Optional pre-built distributorTmMap. When omitted the
 *   function uses getDistributorTmMapIfReady() (non-blocking). If the map
 *   is not yet warm the chain pass is skipped and a WARN is emitted so the
 *   next scheduled backfill can pick up any multi-head-state customers that
 *   could not be resolved.
 */
export async function deriveForIds(
  pool: Queryable,
  ids: string[],
  distMap?: DistributorTmMap,
): Promise<void> {
  if (!ids.length) return;
  try {
    // Resolve the map to use for the chain pass:
    // 1. Caller-supplied map (e.g. passed from the backfill route that already
    //    built it).
    // 2. In-memory cache if already warm — non-blocking, no Drive calls.
    // 3. If neither is available, skip the chain pass rather than triggering a
    //    30–60 s blocking Drive build at import time.
    const mapToUse = distMap ?? getDistributorTmMapIfReady();

    let chain = 0;
    let chainSkipReason: "map-not-ready" | "no-distributor-link" | null = null;

    if (mapToUse === null) {
      // Map not ready — skip silently except for the WARN below.
      chainSkipReason = "map-not-ready";
      logger.warn(
        { customerIds: ids, count: ids.length },
        "[customerStateHead] import-time chain pass skipped — distributorTmMap not ready; " +
          "multi-head-state customers (West U.P., Karnataka, East U.P.) will be picked up " +
          "by the next scheduled backfill",
      );
    } else {
      chain = await passChain(pool, ids, mapToUse);
      if (chain === 0) chainSkipReason = "no-distributor-link";
    }

    const state = await passStateLookup(pool, ids);

    logger.info(
      {
        ids: ids.length,
        chain,
        chainSkipReason,
        state,
      },
      "[customerStateHead] import-time derivation done",
    );
  } catch (err) {
    logger.warn({ err }, "[customerStateHead] import-time derivation failed (non-fatal)");
  }
}

/**
 * Log a one-line coverage summary. Called once at server startup after
 * migrations complete. Uses the shared pool by default.
 */
export async function logCoverage(pool?: Pool): Promise<void> {
  const db = pool ?? defaultPool;
  try {
    const { rows } = await db.query<{
      total: string; sale_line: string; chain: string; state_lookup: string;
    }>(`
      SELECT
        COUNT(*)                                                                         AS total,
        COUNT(*) FILTER (WHERE head_confidence = 'sale_line')                           AS sale_line,
        COUNT(*) FILTER (WHERE head_confidence = 'chain')                               AS chain,
        COUNT(*) FILTER (WHERE head_confidence = 'state_lookup')                        AS state_lookup
      FROM customer_master
    `);
    if (!rows.length) return;
    const r = rows[0]!;
    const totalN = Number(r.total);
    const sl = Number(r.sale_line);
    const ch = Number(r.chain);
    const st = Number(r.state_lookup);
    const pop = sl + ch + st;
    logger.info(
      `customer_master state_head coverage: ${pop}/${totalN} rows populated` +
      ` (sale_line: ${sl}, chain: ${ch}, state_lookup: ${st}, unresolved: ${totalN - pop})`,
    );
  } catch (err) {
    logger.warn({ err }, "[customerStateHead] coverage log failed");
  }
}
