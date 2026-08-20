import { randomUUID, createHash } from "node:crypto";
import { pool } from "@workspace/db";
import {
  fetchAuthoritativeProducts,
  type AuthoritativeProduct,
} from "./authorityClient.js";
import { clearSkuCaches } from "../sku/catalogue.js";
import { clearK4Cache } from "../sku/skuK4.js";

export const SOURCE_DIVISION_MAP: Record<string, string> = {
  "Pipes & Fittings": "Pipe & Fitting",
  "PTMT & Plastic Fittings": "PTMT",
  "CP Fittings / Faucets": "CP",
  Hardware: "Hardware",
  "Ceramic Sanitaryware": "Sanitaryware",
  "CP (QUAA / FERN)": "QUAA & FERN",
  "QUAA & FERN": "QUAA & FERN",
};

export function mapAuthoritativeDivisions(divisionRaw: string): Array<{
  sourceDivision: string;
  appSegment: string | null;
}> {
  return [...new Set(divisionRaw.split("|").map((part) => part.trim()).filter(Boolean))]
    .map((sourceDivision) => ({
      sourceDivision,
      appSegment: SOURCE_DIVISION_MAP[sourceDivision] ?? null,
    }));
}

function assertValidSnapshot(rows: AuthoritativeProduct[], expectedTotal: number): void {
  if (rows.length !== expectedTotal || rows.length === 0) {
    throw new Error(`MRP source row count mismatch: expected ${expectedTotal}, got ${rows.length}`);
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.itemCode)) throw new Error(`Duplicate authoritative MRP code: ${row.itemCode}`);
    seen.add(row.itemCode);
    if (row.mrp != null && row.mrp < 0) throw new Error(`Negative authoritative MRP: ${row.itemCode}`);
  }
}

let refreshInFlight = false;

export type AuthoritativeSyncReport = {
  generationId: string;
  rowsSynced: number;
  sourceTotal: number;
  provenanceComplete: boolean;
  missingBatchId: number;
  missingReviewStatus: number;
  rowsByDivision: Array<{ divisionRaw: string; count: number }>;
  multiDivisionExamples: Array<{ itemCode: string; divisionRaw: string; mrp: number | null }>;
  overlap: { both: number; legacyOnly: number; sourceOnly: number };
  newlyResolvableRegister: { count: number; fy2627Net: number };
  protectedTables: Record<string, number>;
  syncedAt: string;
};

async function sourceReconciliation(generationId: string): Promise<Omit<AuthoritativeSyncReport,
  "generationId" | "rowsSynced" | "sourceTotal" | "provenanceComplete" | "missingBatchId" |
  "missingReviewStatus" | "syncedAt">> {
  const [division, multi, overlap, coverage, protectedCounts] = await Promise.all([
    pool.query<{ division_raw: string; count: string }>(
      `SELECT division_raw, COUNT(*)::text AS count
       FROM mrp_synced WHERE generation_id = $1
       GROUP BY division_raw ORDER BY count DESC, division_raw`,
      [generationId],
    ),
    pool.query<{ item_code: string; division_raw: string; mrp: string | null }>(
      `SELECT item_code, division_raw, mrp::text
       FROM mrp_synced
       WHERE generation_id = $1 AND division_raw LIKE '%|%'
       ORDER BY item_code LIMIT 55`,
      [generationId],
    ),
    pool.query<{ both: string; legacy_only: string; source_only: string }>(
      `WITH legacy AS (SELECT DISTINCT item_code FROM mrp_master),
            source AS (SELECT item_code FROM mrp_synced WHERE generation_id = $1)
       SELECT
         (SELECT COUNT(*) FROM legacy l JOIN source s USING (item_code))::text AS both,
         (SELECT COUNT(*) FROM legacy l LEFT JOIN source s USING (item_code) WHERE s.item_code IS NULL)::text AS legacy_only,
         (SELECT COUNT(*) FROM source s LEFT JOIN legacy l USING (item_code) WHERE l.item_code IS NULL)::text AS source_only`,
      [generationId],
    ),
    pool.query<{ count: string; net: string }>(
      `SELECT COUNT(DISTINCT sl.code)::text AS count, COALESCE(SUM(sl.amount), 0)::text AS net
       FROM sale_line_current sl
       JOIN mrp_synced s ON s.item_code = sl.code AND s.generation_id = $1
       WHERE sl.fy = '2026-27'
         AND sl.code NOT IN (SELECT DISTINCT item_code FROM mrp_master)`,
      [generationId],
    ),
    pool.query<{ sale_line: string; margin_fact: string; mrp_master: string; mrp_history: string }>(
      `SELECT
        (SELECT COUNT(*) FROM sale_line)::text AS sale_line,
        (SELECT COUNT(*) FROM margin_fact)::text AS margin_fact,
        (SELECT COUNT(*) FROM mrp_master)::text AS mrp_master,
        (SELECT COUNT(*) FROM mrp_history)::text AS mrp_history`,
    ),
  ]);
  const o = overlap.rows[0];
  return {
    rowsByDivision: division.rows.map((r) => ({ divisionRaw: r.division_raw, count: Number(r.count) })),
    multiDivisionExamples: multi.rows.map((r) => ({
      itemCode: r.item_code, divisionRaw: r.division_raw, mrp: r.mrp == null ? null : Number(r.mrp),
    })),
    overlap: { both: Number(o?.both ?? 0), legacyOnly: Number(o?.legacy_only ?? 0), sourceOnly: Number(o?.source_only ?? 0) },
    newlyResolvableRegister: {
      count: Number(coverage.rows[0]?.count ?? 0),
      fy2627Net: Number(coverage.rows[0]?.net ?? 0),
    },
    protectedTables: Object.fromEntries(
      Object.entries(protectedCounts.rows[0] ?? {}).map(([key, value]) => [key, Number(value)]),
    ),
  };
}

export async function refreshAuthoritativeMrpCache(): Promise<AuthoritativeSyncReport> {
  if (refreshInFlight) throw new Error("Authoritative MRP sync already in progress");
  refreshInFlight = true;
  try {
    const source = await fetchAuthoritativeProducts();
    assertValidSnapshot(source.rows, source.sourceTotal);
    const generationId = randomUUID();
    const missingBatchId = source.rows.filter((row) => !row.sourceBatchId).length;
    const missingReviewStatus = source.rows.filter((row) => !row.sourceReviewStatus).length;
    const provenanceComplete = missingBatchId === 0 && missingReviewStatus === 0;
    const checksum = createHash("sha256")
      .update(source.rows.map((r) => `${r.itemCode}|${r.mrp}|${r.priceInForceSince}`).sort().join("\n"))
      .digest("hex");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(640387)");
      await client.query(
        `INSERT INTO mrp_sync_generation
         (generation_id, source_fetched_at, source_row_count, checksum, provenance_complete)
         VALUES ($1, $2, $3, $4, $5)`,
        [generationId, source.fetchedAt, source.sourceTotal, checksum, provenanceComplete],
      );
      for (let start = 0; start < source.rows.length; start += 250) {
        const batch = source.rows.slice(start, start + 250);
        const values = batch.map((_, i) => {
          const p = i * 18;
          return `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5},$${p + 6},$${p + 7},$${p + 8},$${p + 9},$${p + 10},$${p + 11},$${p + 12},$${p + 13},$${p + 14},$${p + 15},$${p + 16},$${p + 17},$${p + 18})`;
        }).join(",");
        const params = batch.flatMap((r) => [
          generationId, r.itemCode, r.sourceId, r.productName, r.divisionRaw, r.seriesRange,
          r.size, r.uom, r.mrp, r.priceInForceSince, r.previousMrp,
          r.previousMrp != null && r.mrp != null && r.previousMrp !== 0
            ? ((r.mrp - r.previousMrp) / r.previousMrp) * 100 : null,
          r.status, r.colourVariants, r.sourceBatchId, r.sourceReviewStatus,
          r.sourceReviewReasons, source.fetchedAt,
        ]);
        await client.query(
          `INSERT INTO mrp_synced
           (generation_id, item_code, source_product_id, product_name, division_raw, series_range,
            size, uom, mrp, price_in_force_since, previous_mrp, change_pct, status,
            colour_variants, source_batch_id, source_review_status, source_review_reasons, synced_at)
           VALUES ${values}`,
          params,
        );
        const mappings = batch.flatMap((r) => mapAuthoritativeDivisions(r.divisionRaw)
          .map((m) => ({ itemCode: r.itemCode, ...m })));
        for (let mappingStart = 0; mappingStart < mappings.length; mappingStart += 500) {
          const mappingBatch = mappings.slice(mappingStart, mappingStart + 500);
          const mappingValues = mappingBatch.map((_, i) => {
            const p = i * 4;
            return `($${p + 1},$${p + 2},$${p + 3},$${p + 4})`;
          }).join(",");
          await client.query(
            `INSERT INTO mrp_synced_division (generation_id, item_code, source_division, app_segment)
             VALUES ${mappingValues}`,
            mappingBatch.flatMap((m) => [generationId, m.itemCode, m.sourceDivision, m.appSegment]),
          );
        }
      }
      await client.query("UPDATE mrp_sync_generation SET is_active = false WHERE is_active = true");
      await client.query("UPDATE mrp_sync_generation SET is_active = true WHERE generation_id = $1", [generationId]);
      await client.query(
        `INSERT INTO mrp_sync_status (singleton, last_success_at, last_error)
         VALUES (true, $1, NULL)
         ON CONFLICT (singleton) DO UPDATE SET last_success_at = EXCLUDED.last_success_at, last_error = NULL`,
        [source.fetchedAt],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    // Successful activation changes the authoritative current-product and
    // current-price basis. Do not let an in-memory SKU response survive the
    // atomic generation switch.
    clearSkuCaches();
    clearK4Cache();
    const reconciliation = await sourceReconciliation(generationId);
    return {
      generationId, rowsSynced: source.rows.length, sourceTotal: source.sourceTotal,
      provenanceComplete, missingBatchId, missingReviewStatus,
      ...reconciliation, syncedAt: source.fetchedAt.toISOString(),
    };
  } catch (error) {
    await pool.query(
      `INSERT INTO mrp_sync_status (singleton, last_error)
       VALUES (true, $1)
       ON CONFLICT (singleton) DO UPDATE SET last_error = EXCLUDED.last_error`,
      [error instanceof Error ? error.message : String(error)],
    ).catch(() => undefined);
    throw error;
  } finally {
    refreshInFlight = false;
  }
}

export async function authoritativeMrpStatus(): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<{
    generation_id: string | null; source_fetched_at: string | null; source_row_count: string | null;
    provenance_complete: boolean | null; last_success_at: string | null; last_error: string | null;
  }>(
    `SELECT g.generation_id::text, g.source_fetched_at::text, g.source_row_count::text,
            g.provenance_complete, s.last_success_at::text, s.last_error
       FROM mrp_sync_status s
       LEFT JOIN mrp_sync_generation g ON g.is_active = true
       WHERE s.singleton = true`,
  );
  const row = rows[0];
  return {
    activeGeneration: row?.generation_id ?? null,
    sourceFetchedAt: row?.source_fetched_at ?? null,
    sourceRowCount: row?.source_row_count == null ? 0 : Number(row.source_row_count),
    provenanceComplete: row?.provenance_complete ?? false,
    lastSuccessAt: row?.last_success_at ?? null,
    lastError: row?.last_error ?? null,
    refreshInFlight,
  };
}