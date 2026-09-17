import { pool } from "@workspace/db";
import {
  JUL26_PSCODE3,
  JUL26_PSCODE3_APPROVED_ARCHIVE_SHA256,
} from "./pscode3Jul26.js";

export const JUL26_RETROSPECTIVE_PROVENANCE = {
  sourceFile:
    "PSCode_3_NEW_REPORTS_JULY2026-20260805T074609Z-1-001_1785917168364.zip",
  archiveSha256: JUL26_PSCODE3_APPROVED_ARCHIVE_SHA256,
  originalLoadDate: "2026-08-24",
  // The source evidence currently establishes the date, not the exact time.
  // Keep commit disabled until review supplies the exact original timestamp.
  approvedOriginalLoadedAt: null as string | null,
  retrospectiveRecordDate: "2026-09-17",
  expected: {
    filesFound: 163,
    filesDropped: 14,
    filesLoading: 149,
    rawRows: 36_805,
    rawNet: 239_311_764,
    rows: 34_147,
    net: 223_436_806,
    gross: 442_326_730.1,
    discountPct: 49.48602677720013,
    footerRows: 149,
    skippedNoValue: 0,
    noItemCode: 0,
    noMonth: 0,
    wrongMonth: 0,
    months: ["Jul-26"],
    ashutoshMainRows: 368,
    ashutoshRudrapurRows: 98,
  },
} as const;

export type JulyRetrospectiveInput = {
  originalLoadedAt: string;
  recordedBy: string;
  sourceNote: string;
};

export type JulyTotals = { rows: number; net: number };

export function assertJulyRetrospectiveInput(
  input: JulyRetrospectiveInput,
  requireApprovedTimestamp = false,
): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      input.originalLoadedAt,
    )
  ) {
    throw new Error("original_loaded_at must be a strict ISO timestamp");
  }
  const parsed = new Date(input.originalLoadedAt);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !==
      JUL26_RETROSPECTIVE_PROVENANCE.originalLoadDate
  ) {
    throw new Error(
      "original_loaded_at must be an ISO timestamp on 24 August 2026",
    );
  }
  if (requireApprovedTimestamp) {
    const approved =
      JUL26_RETROSPECTIVE_PROVENANCE.approvedOriginalLoadedAt;
    if (!approved) {
      throw new Error(
        "July metadata repair commit is disabled until review pins the exact original 24 August load timestamp",
      );
    }
    if (input.originalLoadedAt !== approved) {
      throw new Error(
        "original_loaded_at does not match the reviewed original load timestamp",
      );
    }
  }
  if (!input.recordedBy.trim() || input.recordedBy.length > 200) {
    throw new Error("recorded_by is required and must be at most 200 characters");
  }
  if (!input.sourceNote.trim() || input.sourceNote.length > 2_000) {
    throw new Error("source_note is required and must be at most 2,000 characters");
  }
}

export function assertJulyTotals(
  sku: JulyTotals,
  mirror: JulyTotals,
): void {
  const expected = JUL26_RETROSPECTIVE_PROVENANCE.expected;
  if (
    sku.rows !== expected.rows ||
    sku.net !== expected.net ||
    mirror.rows !== expected.rows ||
    mirror.net !== expected.net
  ) {
    throw new Error(
      `July metadata repair refused: existing SKU=${sku.rows}/${sku.net}, ` +
        `mirror=${mirror.rows}/${mirror.net}; expected both ` +
        `${expected.rows}/${expected.net}`,
    );
  }
}

async function totals(client: any, table: string, source?: string) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS rows,
            COALESCE(SUM(net_amount::numeric), 0)::numeric::text AS net
       FROM ${table}
      WHERE fy = $1 AND month_label = $2 ${source ? "AND source = $3" : ""}`,
    source
      ? [JUL26_PSCODE3.fy, JUL26_PSCODE3.month, source]
      : [JUL26_PSCODE3.fy, JUL26_PSCODE3.month],
  );
  return {
    rows: Number(result.rows[0]?.rows ?? 0),
    net: Number(result.rows[0]?.net ?? 0),
  };
}

async function provenanceCount(client: any): Promise<number> {
  const result = await client.query(
    `SELECT COUNT(*)::int AS rows
       FROM secondary_sku_load_provenance
      WHERE fy = $1 AND month_label = $2`,
    [JUL26_PSCODE3.fy, JUL26_PSCODE3.month],
  );
  return Number(result.rows[0]?.rows ?? 0);
}

export async function previewJulyRetrospectiveProvenance() {
  const [sku, mirror, existingProvenance] = await Promise.all([
    totals(pool, "secondary_sku_line"),
    totals(
      pool,
      "secondary_register_line",
      JUL26_PSCODE3.brandSource,
    ),
    provenanceCount(pool),
  ]);
  assertJulyTotals(sku, mirror);
  if (existingProvenance !== 0) {
    throw new Error(
      "July metadata repair refused: a provenance record already exists",
    );
  }
  return {
    metadataOnly: true,
    sku,
    mirror,
    existingProvenance,
    source: JUL26_RETROSPECTIVE_PROVENANCE,
    writesPlanned: ["one secondary_sku_load_provenance row"],
    tablesNeverWritten: ["secondary_sku_line", "secondary_register_line"],
  };
}

export async function commitJulyRetrospectiveProvenance(
  input: JulyRetrospectiveInput,
) {
  assertJulyRetrospectiveInput(input, true);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "pscode3-jul26-load",
    ]);
    // SHARE blocks concurrent INSERT/UPDATE/DELETE while allowing the aggregate
    // verification reads. SHARE ROW EXCLUSIVE serialises provenance writers
    // while still allowing this transaction's single INSERT.
    await client.query("LOCK TABLE secondary_sku_line IN SHARE MODE");
    await client.query(
      "LOCK TABLE secondary_register_line IN SHARE MODE",
    );
    await client.query(
      "LOCK TABLE secondary_sku_load_provenance IN SHARE ROW EXCLUSIVE MODE",
    );

    const beforeSku = await totals(client, "secondary_sku_line");
    const beforeMirror = await totals(
      client,
      "secondary_register_line",
      JUL26_PSCODE3.brandSource,
    );
    assertJulyTotals(beforeSku, beforeMirror);
    if ((await provenanceCount(client)) !== 0) {
      throw new Error(
        "July metadata repair refused: a provenance record already exists",
      );
    }

    const recordedAt = new Date();
    if (
      recordedAt.toISOString().slice(0, 10) !==
      JUL26_RETROSPECTIVE_PROVENANCE.retrospectiveRecordDate
    ) {
      throw new Error(
        "July metadata repair was approved as a 17 September retrospective record; use the actual execution date in a newly reviewed repair",
      );
    }
    const controls = {
      retrospective: true,
      originalLoadDate:
        JUL26_RETROSPECTIVE_PROVENANCE.originalLoadDate,
      provenanceRecordedAt: recordedAt.toISOString(),
      metadataOnly: true,
      sourceControls: JUL26_RETROSPECTIVE_PROVENANCE.expected,
      before: { sku: beforeSku, mirror: beforeMirror },
      dataTablesWritten: [],
    };
    const note =
      `RETROSPECTIVE PROVENANCE recorded ${recordedAt
        .toISOString()
        .slice(0, 10)} for the original 24 August 2026 load; this record was ` +
      `not written at load time. ${input.sourceNote.trim()}`;

    await client.query(
      `INSERT INTO secondary_sku_load_provenance
        (fy, month_label, source_note, uploaded_by, uploaded_at,
         archive_sha256, row_count, net_amount, source, controls,
         verified_at, source_file)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
      [
        JUL26_PSCODE3.fy,
        JUL26_PSCODE3.month,
        note,
        `retrospective-record:${input.recordedBy.trim()}`,
        new Date(input.originalLoadedAt),
        JUL26_RETROSPECTIVE_PROVENANCE.archiveSha256,
        JUL26_RETROSPECTIVE_PROVENANCE.expected.rows,
        JUL26_RETROSPECTIVE_PROVENANCE.expected.net,
        JUL26_PSCODE3.skuSource,
        JSON.stringify(controls),
        recordedAt,
        JUL26_RETROSPECTIVE_PROVENANCE.sourceFile,
      ],
    );

    const afterSku = await totals(client, "secondary_sku_line");
    const afterMirror = await totals(
      client,
      "secondary_register_line",
      JUL26_PSCODE3.brandSource,
    );
    assertJulyTotals(afterSku, afterMirror);
    if (
      beforeSku.rows !== afterSku.rows ||
      beforeSku.net !== afterSku.net ||
      beforeMirror.rows !== afterMirror.rows ||
      beforeMirror.net !== afterMirror.net
    ) {
      throw new Error(
        "July metadata repair refused: data totals changed during the transaction",
      );
    }
    await client.query("COMMIT");
    return {
      metadataOnly: true,
      retrospective: true,
      originalLoadedAt: new Date(input.originalLoadedAt).toISOString(),
      provenanceRecordedAt: recordedAt.toISOString(),
      before: { sku: beforeSku, mirror: beforeMirror },
      after: { sku: afterSku, mirror: afterMirror },
      sourceFile: JUL26_RETROSPECTIVE_PROVENANCE.sourceFile,
      archiveSha256: JUL26_RETROSPECTIVE_PROVENANCE.archiveSha256,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}