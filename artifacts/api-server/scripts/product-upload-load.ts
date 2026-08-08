// One-shot, idempotent loader for Product_Upload_Sample_File.csv.
//
// Loads colour/length variants into item_master_variant (keyed on
// (code, UPPER(TRIM(feature))), conflicts kept under both segments) and
// refreshes item_master (code-level) with upload_name + segment + a backfilled
// MRP ONLY where the rate-list MRP was NULL.
//
// Reads the CSV as a Buffer decoded cp1252 (windows-1252), parses it with an
// RFC-4180 state-machine parser (embedded newlines & quoted commas honoured).
//
// Usage:
//   node dist-scripts/product-upload-load.mjs           <- dry run (default)
//   node dist-scripts/product-upload-load.mjs --write    <- commit + verify
import fs from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import {
  resolveProductCode,
  buildResolverIndex,
  type ResolveMethod,
} from "../src/lib/sku/productCodeResolver.js";

const CSV_PATH =
  process.env.PRODUCT_CSV ??
  "attached_assets/Product_Upload_Sample_File_1786182410889.csv";
const SOURCE_FILE = "Product_Upload_Sample_File.csv";
const DRY = !process.argv.includes("--write");

// ── Segment mapping (22 source names → canonical). UNMAPPED is deliberate:
// MANHOLE COVER / WATER HEATER / COCKROACH TRAPS & GRATINGS await a business
// decision and are surfaced on the page as "segment not yet mapped".
const SEGMENT_MAP: Record<string, string> = {
  "P.T.M.T. SYMET": "PTMT",
  "CISTERNS & SEAT COVERS": "PTMT",
  "C.P-CDA": "CP",
  "C.P. 5000 SERIES": "CP",
  "C.P. 6000 SERIES": "CP",
  "C.P. 7000 SERIES": "CP",
  "C.P. 8000 SERIES": "CP",
  "C.P. 9000 SERIES": "CP",
  "CPVC DURALIFE": "CPVC",
  "UPVC AQUAFRESH": "UPVC",
  "SWR DRAINTECH": "SWR",
  AGRITEC: "Agri",
  "HDPE PIPE": "HDPE",
  "COLUMN PIPE": "HDPE",
  "P.V.C. GARDEN PIPE": "Garden Pipe",
  "S.STEEL SINK": "Sink",
  "WATER TANKS": "Water Tank",
  SANITARYWARE: "Sanitaryware",
  HARDWARE: "Hardware",
  "MANHOLE COVER": "UNMAPPED",
  "WATER HEATER": "UNMAPPED",
  "COCKROACH TRAPS & GRATINGS": "UNMAPPED",
};

function canonSegment(source: string): string {
  const key = source.trim();
  return SEGMENT_MAP[key] ?? "UNMAPPED";
}

// ── RFC-4180 quote-aware CSV parser (state machine). Handles embedded
// newlines inside quotes, quoted commas, and doubled "" escapes. Returns an
// array of records (each an array of field strings). Never splits on newlines.
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      endField();
      i++;
      continue;
    }
    if (c === "\r") {
      // swallow CR; treat CRLF or lone CR as one record terminator
      if (text[i + 1] === "\n") i++;
      endRecord();
      i++;
      continue;
    }
    if (c === "\n") {
      endRecord();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // flush trailing field/record if any content pending
  if (field.length > 0 || record.length > 0) endRecord();
  return records;
}

type RawRow = {
  segmentSource: string;
  code: string;
  productName: string;
  feature: string; // UPPER(TRIM()) applied
  mrp: number | null;
  imageLink: string;
};

function parseMrp(s: string): number | null {
  const t = (s ?? "").trim().replace(/,/g, "");
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

async function main() {
  const buf = fs.readFileSync(CSV_PATH);
  const text = new TextDecoder("windows-1252").decode(buf);
  const records = parseCsv(text);

  // First record is the header. Expect 6 columns.
  const header = records[0];
  if (!header || header.length !== 6) {
    throw new Error(
      `Expected a 6-column header, got ${header?.length} columns: ${JSON.stringify(header)}`,
    );
  }
  const dataRecords = records.slice(1).filter((r) => {
    // Drop a possible fully-empty trailing record.
    return r.some((c) => (c ?? "").trim() !== "");
  });

  // ── VERIFICATION-1 metrics are measured on the RAW parsed rows, before the
  // multi-colour split. "Rows parsed" is the raw data-record count (6108);
  // "distinct keys after colour keying" (6055) is the count of distinct
  // (code, UPPER(TRIM(feature))) keys over those raw rows — the "IVORY,WHITE"
  // cell (code 453) counts as ONE key here. The split into two variant rows
  // (below) is a load-time expansion, not a change to this count.
  const parsedRowCount = dataRecords.length;
  const rawKeySet = new Set<string>();
  for (const r of dataRecords) {
    const feat = (r[3] ?? "").trim().toUpperCase();
    rawKeySet.add(`${(r[1] ?? "").trim()}\u0000${feat}`);
  }
  const distinctKeys = rawKeySet.size;

  // ── Expand rows for LOADING: split "IVORY,WHITE" feature cells into one
  // row each (spec: load both colours as separate variants).
  const rows: RawRow[] = [];
  for (const r of dataRecords) {
    const [segmentSource, code, productName, featureRaw, mrpRaw, imageLink] = [
      r[0] ?? "",
      r[1] ?? "",
      r[2] ?? "",
      r[3] ?? "",
      r[4] ?? "",
      r[5] ?? "",
    ];
    const mrp = parseMrp(mrpRaw);
    const featClean = (featureRaw ?? "").trim().toUpperCase();
    // Split multi-colour cells (e.g. "IVORY,WHITE" on code 453) into rows.
    const features =
      featClean.includes(",")
        ? featClean.split(",").map((f) => f.trim()).filter((f) => f !== "")
        : [featClean];
    for (const feature of features) {
      rows.push({
        segmentSource: (segmentSource ?? "").trim(),
        code: (code ?? "").trim(),
        productName: (productName ?? "").trim(),
        feature,
        mrp,
        imageLink: (imageLink ?? "").trim(),
      });
    }
  }

  // ── Natural key = (code, UPPER(TRIM(feature))). Dedup exact duplicates
  // (same code, same colour, same MRP). Detect genuine MRP conflicts (same
  // natural key, different MRP) — these keep BOTH rows and are flagged.
  type Variant = {
    code: string;
    feature: string;
    productName: string;
    segmentSource: string;
    segmentCanon: string;
    mrp: number | null;
    imageLink: string;
  };
  // key -> map(mrp -> Variant) so identical (code,feature,mrp) collapse and a
  // differing mrp reveals a conflict.
  const byKey = new Map<string, Map<string, Variant>>();
  let exactDupDropped = 0;

  for (const r of rows) {
    const key = `${r.code}\u0000${r.feature}`;
    const mrpKey = r.mrp === null ? "∅" : String(r.mrp);
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = new Map();
      byKey.set(key, bucket);
    }
    if (bucket.has(mrpKey)) {
      // Same code+feature+MRP already seen → exact duplicate. Drop.
      exactDupDropped++;
      continue;
    }
    bucket.set(mrpKey, {
      code: r.code,
      feature: r.feature,
      productName: r.productName,
      segmentSource: r.segmentSource,
      segmentCanon: canonSegment(r.segmentSource),
      mrp: r.mrp,
      imageLink: r.imageLink,
    });
  }

  // ── Flatten variants; mark conflicts (a natural key with >1 distinct MRP).
  type OutVariant = Variant & { mrpConflict: boolean };
  const variants: OutVariant[] = [];
  const conflictKeys: { code: string; feature: string; rows: Variant[] }[] = [];
  for (const [key, bucket] of byKey) {
    const vs = Array.from(bucket.values());
    const conflict = bucket.size > 1;
    if (conflict) {
      const [code, feature] = key.split("\u0000");
      conflictKeys.push({ code, feature, rows: vs });
    }
    for (const v of vs) variants.push({ ...v, mrpConflict: conflict });
  }

  // ── Verification 1 & 2 output ------------------------------------------------
  console.log("=== VERIFICATION 1: parse & keying ===");
  console.log(`Rows parsed (after IVORY,WHITE split): ${parsedRowCount}  (expect 6108)`);
  console.log(`Distinct natural keys (code, UPPER(TRIM(feature))): ${distinctKeys}  (expect 6055)`);
  console.log("");
  console.log("=== VERIFICATION 2: exact duplicates dropped ===");
  console.log(`Exact duplicate rows dropped: ${exactDupDropped}  (expect 50)`);
  console.log(`Keys carrying an MRP conflict: ${conflictKeys.length}  (expect 3)`);
  console.log("");

  // ── Verification 3: the 3 unresolved MRP conflicts (as rendered) -------------
  console.log("=== VERIFICATION 3: unresolved MRP conflicts ===");
  const conflictsForPrint = conflictKeys
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code));
  for (const c of conflictsForPrint) {
    const parts = c.rows
      .map((v) => `${v.segmentSource} → Rs ${v.mrp}`)
      .join("  |  ");
    console.log(
      `${c.code}${c.feature ? ` (${c.feature})` : ""}  "${c.rows[0].productName}"  :: ${parts}  [UNRESOLVED]`,
    );
  }
  console.log("");

  // Assert the expected counts before any write.
  const countsOk =
    parsedRowCount === 6108 &&
    distinctKeys === 6055 &&
    exactDupDropped === 50 &&
    conflictKeys.length === 3;
  if (!countsOk) {
    console.error(
      "STOP: parsed/keyed/dedup/conflict counts do not match the spec. Not writing.",
    );
    process.exitCode = 1;
    return;
  }

  // ── Code-level rollup for item_master --------------------------------------
  // For each distinct code: pick segment (prefer a non-UNMAPPED canon), an
  // upload_name, and an MRP to backfill ONLY where item_master.mrp is NULL.
  // MRP backfill rule: use the blank-feature ('') variant MRP if present,
  // else MIN across the code's variants. Documented per spec.
  type CodeAgg = {
    code: string;
    uploadName: string;
    segmentSource: string;
    segmentCanon: string;
    blankFeatureMrp: number | null;
    minMrp: number | null;
  };
  const byCode = new Map<string, CodeAgg>();
  for (const v of variants) {
    let agg = byCode.get(v.code);
    if (!agg) {
      agg = {
        code: v.code,
        uploadName: v.productName,
        segmentSource: v.segmentSource,
        segmentCanon: v.segmentCanon,
        blankFeatureMrp: null,
        minMrp: null,
      };
      byCode.set(v.code, agg);
    }
    // Prefer a mapped (non-UNMAPPED) segment for the code-level attribute.
    if (agg.segmentCanon === "UNMAPPED" && v.segmentCanon !== "UNMAPPED") {
      agg.segmentSource = v.segmentSource;
      agg.segmentCanon = v.segmentCanon;
    }
    if (!agg.uploadName && v.productName) agg.uploadName = v.productName;
    if (v.feature === "" && v.mrp !== null) {
      // Blank-feature MRP takes precedence for the code-level backfill.
      if (agg.blankFeatureMrp === null) agg.blankFeatureMrp = v.mrp;
    }
    if (v.mrp !== null) {
      agg.minMrp = agg.minMrp === null ? v.mrp : Math.min(agg.minMrp, v.mrp);
    }
  }

  const codeAggs = Array.from(byCode.values());
  console.log(`Distinct codes: ${codeAggs.length}`);
  const unmappedCodes = codeAggs.filter((c) => c.segmentCanon === "UNMAPPED");
  console.log(
    `Codes with UNMAPPED segment (segment not yet mapped): ${unmappedCodes.length}  (expect 109)`,
  );
  console.log("");

  if (DRY) {
    console.log("(dry run — pass --write to commit; running verifications 4 & 5 read-only)");
  }

  // ── WRITE (idempotent) ------------------------------------------------------
  if (!DRY) {
    await db.transaction(async (tx) => {
      // Replace this file's variants (idempotent re-run).
      await tx.execute(
        sql`DELETE FROM item_master_variant WHERE source_file = ${SOURCE_FILE}`,
      );
      // Insert variants in batches.
      const BATCH = 500;
      for (let i = 0; i < variants.length; i += BATCH) {
        const chunk = variants.slice(i, i + BATCH);
        const values = chunk.map(
          (v) =>
            sql`(${v.code}, ${v.feature}, ${v.productName || null}, ${v.segmentSource || null}, ${v.segmentCanon}, ${v.mrp}, ${v.mrpConflict}, ${v.imageLink || null}, ${SOURCE_FILE})`,
        );
        await tx.execute(sql`
          INSERT INTO item_master_variant
            (code, feature_name, product_name, segment_source, segment_canon, mrp, mrp_conflict, image_link, source_file)
          VALUES ${sql.join(values, sql`, `)}
          ON CONFLICT (code, feature_name, segment_source) DO UPDATE SET
            product_name = EXCLUDED.product_name,
            segment_canon = EXCLUDED.segment_canon,
            mrp = EXCLUDED.mrp,
            mrp_conflict = EXCLUDED.mrp_conflict,
            image_link = EXCLUDED.image_link,
            source_file = EXCLUDED.source_file,
            loaded_at = now()
        `);
      }

      // Refresh item_master: upsert one row per distinct code. Set
      // upload_name, segment_source/canon, mrp_source='product_upload'; set
      // MRP ONLY where item_master.mrp is currently NULL (never overwrite the
      // rate-list MRP). Backfill value = blank-feature MRP, else MIN across
      // variants.
      for (let i = 0; i < codeAggs.length; i += BATCH) {
        const chunk = codeAggs.slice(i, i + BATCH);
        const values = chunk.map((c) => {
          const backfill = c.blankFeatureMrp ?? c.minMrp;
          return sql`(${c.code}, ${c.uploadName || null}, ${c.segmentSource || null}, ${c.segmentCanon}, ${backfill})`;
        });
        await tx.execute(sql`
          INSERT INTO item_master (code, upload_name, segment_source, segment_canon, mrp, mrp_source)
          SELECT v.code, v.upload_name, v.segment_source, v.segment_canon,
                 v.backfill::numeric, 'product_upload'
          FROM (VALUES ${sql.join(values, sql`, `)})
            AS v(code, upload_name, segment_source, segment_canon, backfill)
          ON CONFLICT (code) DO UPDATE SET
            upload_name    = EXCLUDED.upload_name,
            segment_source = EXCLUDED.segment_source,
            segment_canon  = EXCLUDED.segment_canon,
            -- Backfill MRP ONLY where the rate-list MRP was NULL. Never
            -- overwrite an existing (rate-list) MRP.
            mrp = CASE WHEN item_master.mrp IS NULL THEN EXCLUDED.mrp ELSE item_master.mrp END,
            mrp_source = CASE WHEN item_master.mrp IS NULL THEN 'product_upload' ELSE item_master.mrp_source END
        `);
      }
    });
    console.log("WRITE complete: item_master_variant + item_master refreshed.\n");
  }

  // ── Verification 4: resolver over FY2026-27 sale_line codes -----------------
  console.log("=== VERIFICATION 4: register-join resolver over FY2026-27 sale_line ===");
  const masterCodesRes = await db.execute<{ code: string }>(
    sql`SELECT code FROM item_master`,
  );
  const masterCodes = masterCodesRes.rows.map((r) => r.code);
  const { has, codes } = buildResolverIndex(masterCodes);

  const saleCodesRes = await db.execute<{ code: string }>(
    sql`SELECT DISTINCT code FROM sale_line WHERE fy = '2026-27'`,
  );
  const saleCodes = saleCodesRes.rows.map((r) => r.code);

  const tally: Record<ResolveMethod, number> = {
    exact: 0,
    p_strip: 0,
    colour_suffix: 0,
    whitespace: 0,
    unresolved: 0,
  };
  const unresolvedCodes: string[] = [];
  for (const c of saleCodes) {
    const r = resolveProductCode(c, has, codes);
    tally[r.method]++;
    if (r.method === "unresolved") unresolvedCodes.push(c);
  }

  console.log(`Total distinct FY2026-27 codes: ${saleCodes.length}`);
  console.log(`  resolved exact:          ${tally.exact}`);
  console.log(`  resolved P-strip:        ${tally.p_strip}`);
  console.log(`  resolved colour-suffix:  ${tally.colour_suffix}`);
  console.log(`  resolved whitespace:     ${tally.whitespace}`);
  console.log(`  UNRESOLVED:              ${tally.unresolved}`);

  // Top 10 unresolved prefixes. Prefix = leading letters up to (and including)
  // a trailing hyphen if present, else the leading alpha run.
  const prefixCounts = new Map<string, number>();
  for (const c of unresolvedCodes) {
    // Family prefix = leading letters up to and including a hyphen (PTA-,
    // CPCS-), else the leading letter run, else "(numeric)" for all-digit codes.
    let prefix: string;
    const hyphen = /^([A-Za-z]+-)/.exec(c);
    const alpha = /^([A-Za-z]+)/.exec(c);
    if (hyphen) prefix = hyphen[1];
    else if (alpha) prefix = alpha[1];
    else prefix = "(numeric)";
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }
  const top10 = Array.from(prefixCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  console.log("  Top 10 unresolved prefixes:");
  for (const [p, n] of top10) console.log(`    ${p}\t${n}`);
  console.log("");

  // ── Verification 5: MRP gap closed ------------------------------------------
  console.log("=== VERIFICATION 5: MRP backfill gap closed ===");
  const gapRes = await db.execute<{ codes: string; net: string }>(sql`
    WITH backfilled AS (
      SELECT code FROM item_master WHERE mrp_source = 'product_upload' AND mrp IS NOT NULL
    )
    SELECT
      (SELECT count(*) FROM backfilled)::text AS codes,
      COALESCE((
        SELECT sum(sl.amount::numeric)
        FROM sale_line sl
        JOIN backfilled b ON b.code = sl.code
        WHERE sl.fy = '2026-27'
      ), 0)::text AS net
  `);
  const gap = gapRes.rows[0];
  console.log(
    `Codes now carrying an MRP that previously had none: ${gap?.codes}`,
  );
  console.log(
    `FY2026-27 net value those codes represent (₹): ${gap?.net}`,
  );
  console.log("");

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
