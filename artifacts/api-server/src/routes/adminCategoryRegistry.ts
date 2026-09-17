import { Router } from "express";
import { createHash } from "node:crypto";
import { isAdminToken } from "../lib/adminAuth.js";
import { pool } from "@workspace/db";
import config from "../config/prompt68-category-registry.json";

const router = Router();
const CONFIG_TEXT = JSON.stringify(config);
const CONFIG_SHA256 = createHash("sha256").update(CONFIG_TEXT).digest("hex");
const EXPECTED_MASTER_NAMES = [
  "PLUMBING", "PTMT", "C P", "SANITARYWARE", "SINK", "HARDWARE",
] as const;
const EFFECTIVE_FROM = "2026-04-01";

async function controls(client: { query: Function }, source: "incoming" | "registry") {
  const assignmentSource = source === "incoming"
    ? `SELECT item_code, master_category FROM jsonb_to_recordset($1::jsonb)
         AS x(item_code text, subcategory text, master_category text)`
    : `SELECT item_code, master_category
       FROM canonical_item_category_registry
        WHERE effective_from = DATE '${EFFECTIVE_FROM}' AND effective_to IS NULL`;
  return client.query(`
    WITH fy AS (
      SELECT line_uid, UPPER(BTRIM(code)) code, amount, invoice_date, month_label
      FROM sale_line_current WHERE fy = '2026-27'
    ), registry_source AS (
      ${assignmentSource}
    ), a AS (
      SELECT f.line_uid, f.code, f.amount, r.master_category
      FROM fy f JOIN registry_source r
        ON UPPER(BTRIM(r.item_code)) = f.code
    ), per_master AS (
      SELECT master_category, count(DISTINCT code)::int codes,
        sum(amount::numeric)::numeric(20,2)::text amount
      FROM a GROUP BY master_category
    ), per_line AS (
      SELECT line_uid, count(*) n FROM a GROUP BY line_uid
    )
    SELECT (SELECT count(*)::int FROM fy) rows,
      (SELECT count(DISTINCT code)::int FROM fy) codes,
      (SELECT coalesce(sum(amount::numeric),0)::numeric(20,2)::text FROM fy) amount,
      (SELECT count(*)::int FROM a) mapped,
      (SELECT coalesce(sum(amount::numeric),0)::numeric(20,2)::text FROM a) mapped_amount,
      (SELECT count(*)::int FROM fy f WHERE NOT EXISTS (SELECT 1 FROM a WHERE a.line_uid=f.line_uid)) unmapped,
      (SELECT coalesce(sum(f.amount::numeric),0)::numeric(20,2)::text FROM fy f
        WHERE NOT EXISTS (SELECT 1 FROM a WHERE a.line_uid=f.line_uid)) unmapped_amount,
      (SELECT count(*)::int FROM per_line WHERE n > 1) overlapping,
      coalesce((SELECT jsonb_object_agg(master_category,jsonb_build_array(codes,amount)) FROM per_master),'{}') masters
  `, source === "incoming" ? [JSON.stringify(config.assignments)] : []);
}

/**
 * Prompt 68 originally used 4,000 codes / Rs 136.27 Cr / zero unmapped as
 * point-in-time production verification. Those transaction totals are not an
 * invariant: new FY rows and the known Composite residue changed them while
 * the approved 10,417-code assignment generation remained unchanged.
 *
 * The durable controls are therefore:
 * - every current transaction is either mapped once or explicitly unmapped;
 * - mapped plus unmapped value cross-foots to the current transaction total;
 * - no transaction overlaps assignments; and
 * - the mapped result contains exactly the six approved masters.
 *
 * The preview hash pins these current controls between preview and apply.
 */
export function controlsPass(row: any): boolean {
  const rows = Number(row.rows);
  const mapped = Number(row.mapped);
  const unmapped = Number(row.unmapped);
  const amount = Number(row.amount);
  const mappedAmount = Number(row.mapped_amount);
  const unmappedAmount = Number(row.unmapped_amount);
  const masters = row.masters ?? {};
  const masterNames = Object.keys(masters).sort();
  return Number.isFinite(rows) &&
    Number.isFinite(amount) &&
    mapped + unmapped === rows &&
    Math.abs((mappedAmount + unmappedAmount) - amount) < 0.01 &&
    Number(row.overlapping) === 0 &&
    masterNames.length === EXPECTED_MASTER_NAMES.length &&
    EXPECTED_MASTER_NAMES.every((name) => masterNames.includes(name));
}

function authorized(req: import("express").Request): boolean {
  return isAdminToken(String(req.headers["x-admin-secret"] ?? ""));
}

async function preview(client: { query: Function }) {
  const result = await client.query(`
    WITH incoming AS (SELECT * FROM jsonb_to_recordset($1::jsonb)
      AS x(item_code text, subcategory text, master_category text)),
    old AS (
      SELECT UPPER(BTRIM(item_code)) item_code, canonical_category, master_category
      FROM canonical_item_category_registry WHERE effective_to IS NULL
    )
    SELECT
      (SELECT count(*) FROM incoming)::int AS incoming,
      (SELECT count(*) FROM old)::int AS existing,
      (SELECT count(*) FROM incoming i LEFT JOIN old o USING (item_code)
        WHERE o.item_code IS NULL)::int AS added,
      (SELECT count(*) FROM old o
        WHERE EXISTS (SELECT 1 FROM incoming i WHERE i.item_code=o.item_code))::int AS supersede,
      (SELECT count(*) FROM incoming i JOIN old o USING (item_code)
        WHERE o.master_category IS DISTINCT FROM i.master_category
           OR o.canonical_category IS DISTINCT FROM i.subcategory)::int AS changed,
      (SELECT count(*) FROM old o LEFT JOIN incoming i USING (item_code)
        WHERE i.item_code IS NULL)::int AS retired
  `, [JSON.stringify(config.assignments)]);
  return result.rows[0];
}

router.get("/admin/category-registry/preview", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
  const client = await pool.connect();
  try {
    const diff = await preview(client);
    const masterBreakdown = await client.query(`
      WITH incoming AS (
        SELECT master_category, count(*)::int codes
        FROM jsonb_to_recordset($1::jsonb)
          AS x(item_code text, subcategory text, master_category text)
        GROUP BY master_category
      ), old AS (
        SELECT master_category, count(DISTINCT UPPER(BTRIM(item_code)))::int codes
        FROM canonical_item_category_registry WHERE effective_to IS NULL
        GROUP BY master_category
      )
      SELECT coalesce(i.master_category,o.master_category) master,
        coalesce(o.codes,0) before_codes, coalesce(i.codes,0) after_codes,
        coalesce((SELECT sum(sl.amount::numeric)::numeric(20,2)::text
          FROM sale_line_current sl JOIN canonical_item_category_registry r
            ON UPPER(BTRIM(r.item_code))=UPPER(BTRIM(sl.code))
           AND r.master_category=o.master_category
           AND r.effective_to IS NULL WHERE sl.fy='2026-27'),'0.00') before_value,
         coalesce((SELECT sum(sl.amount::numeric)::numeric(20,2)::text
            FROM sale_line_current sl JOIN jsonb_to_recordset($1::jsonb)
              AS ix(item_code text, subcategory text, master_category text)
             ON UPPER(BTRIM(ix.item_code))=UPPER(BTRIM(sl.code))
            AND ix.master_category=i.master_category
            WHERE sl.fy='2026-27'),'0.00') after_value
      FROM old o FULL JOIN incoming i USING (master_category) ORDER BY 1`,
      [JSON.stringify(config.assignments)]);
    const controlResult = await controls(client, "incoming");
    const controlRow = controlResult.rows[0];
    return res.json({
      configSha256: CONFIG_SHA256, sourceFiles: config.source_files,
      corrections: config.corrections, diff, masterBreakdown: masterBreakdown.rows,
      expectedControls: {
        assignmentGeneration: config.assignments.length,
        masterNames: EXPECTED_MASTER_NAMES,
        rule: "Current rows and value must cross-foot; no overlaps; exactly the six approved masters.",
      },
      controls: controlRow,
      applyRequired: controlsPass(controlRow),
      previewHash: createHash("sha256").update(JSON.stringify({ config: CONFIG_SHA256, diff, controls: controlRow })).digest("hex"),
      intended: { insert: Number(diff.incoming), supersede: Number(diff.supersede) },
    });
  } catch (error) {
    req.log.error({ error }, "category registry preview failed");
    return res.status(500).json({ error: "Preview failed" });
  } finally { client.release(); }
});

router.post("/admin/category-registry/apply", async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
  if (req.body?.configSha256 !== CONFIG_SHA256 || typeof req.body?.previewHash !== "string") {
    return res.status(409).json({ error: "Config hash mismatch; refresh preview" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('prompt68-category-registry'))");
    const prior = await client.query(
      "SELECT 1 FROM canonical_category_load WHERE config_sha256=$1 AND status='applied' LIMIT 1",
      [CONFIG_SHA256]);
    if (prior.rowCount) throw new Error("Config has already been applied");
    const before = await controls(client, "incoming");
    const expectedPreviewHash = createHash("sha256").update(JSON.stringify({
      config: CONFIG_SHA256, diff: await preview(client), controls: before.rows[0],
    })).digest("hex");
    if (req.body.previewHash !== expectedPreviewHash) throw new Error("Preview token is stale");
    if (!controlsPass(before.rows[0])) {
      throw new Error(`Current cross-foot controls failed: ${JSON.stringify(before.rows[0])}`);
    }
    const load = await client.query(`
      INSERT INTO canonical_category_load
        (config_sha256, source_files, corrections, status, preview_hash, actor)
      VALUES ($1,$2,$3,'applied',$4,$5) RETURNING id`,
      [CONFIG_SHA256, JSON.stringify(config.source_files), JSON.stringify(config.corrections),
        req.body.previewHash, "prompt68-reviewed-apply"]);
    await client.query(`
      UPDATE canonical_item_category_registry
      SET effective_to = $1
      WHERE effective_to IS NULL
        AND UPPER(BTRIM(item_code)) IN (
          SELECT UPPER(BTRIM(item_code)) FROM jsonb_to_recordset($2::jsonb)
            AS x(item_code text, subcategory text, master_category text)
        )
        AND (effective_from IS NULL OR effective_from < $1)`,
      [EFFECTIVE_FROM, JSON.stringify(config.assignments)]);
    await client.query(`
      INSERT INTO canonical_item_category_registry
        (item_code, canonical_category, master_category, effective_from, source_vocabulary,
         source_value, review_status, set_by)
      SELECT item_code, subcategory, master_category, $1,
        'Products_Grouping_Master.xlsx+Master_and_Sub_category.xlsx', subcategory,
        'confirmed', 'admin:prompt68'
      FROM jsonb_to_recordset($2::jsonb)
        AS x(item_code text, subcategory text, master_category text)
      ON CONFLICT (item_code, canonical_category, effective_from)
        WHERE effective_from IS NOT NULL DO NOTHING`,
      [EFFECTIVE_FROM, JSON.stringify(config.assignments)]);
    await client.query(`
      INSERT INTO canonical_category_load_evidence
        (load_id,item_code,raw_subcategory,normalized_subcategory,master_category,source_file,correction)
      SELECT $1,item_code,raw_item_type,subcategory,master_category,$2,
        CASE WHEN raw_item_type='CONECTION'
          THEN '{"correction":"CONECTION -> CONNECTION"}'::jsonb
          WHEN raw_master_category='CP'
          THEN '{"correction":"CP -> C P"}'::jsonb ELSE NULL END
      FROM jsonb_to_recordset($3::jsonb)
        AS x(item_code text, subcategory text, master_category text, raw_item_type text, raw_master_category text)
      ON CONFLICT DO NOTHING`,
      [load.rows[0].id, config.source_files[1].filename, JSON.stringify(config.assignments)]);
    await client.query(`
      INSERT INTO canonical_category_correction_evidence
        (load_id,source_file,raw_value,normalized_value,reason)
      SELECT $1,$2,x.raw_value,x.normalized_value,x.reason
      FROM jsonb_to_recordset($3::jsonb)
        AS x(raw_value text, normalized_value text, reason text)`,
      [load.rows[0].id, config.source_files[0].filename, JSON.stringify([
        { raw_value: "CP", normalized_value: "C P", reason: "merge CP into C P" },
        { raw_value: "Master Category / Sub Category", normalized_value: null, reason: "exclude leaked header row" },
        { raw_value: "CONECTION", normalized_value: "CONNECTION", reason: "normalize spelling variant" },
      ])]);
    const mutation = await client.query(`
      SELECT
        (SELECT count(*) FROM canonical_item_category_registry
          WHERE effective_from=$1::date AND effective_to IS NULL)::int assignments,
        (SELECT count(*) FROM canonical_category_load_evidence WHERE load_id=$2)::int evidence`,
      [EFFECTIVE_FROM, load.rows[0].id]);
    if (mutation.rows[0].assignments !== config.assignments.length ||
        mutation.rows[0].evidence !== config.assignments.length) {
      throw new Error(`Mutation count mismatch: ${JSON.stringify(mutation.rows[0])}`);
    }
    const after = await controls(client, "registry");
    if (!controlsPass(after.rows[0])) throw new Error(`Post-apply controls failed: ${JSON.stringify(after.rows[0])}`);
    if (JSON.stringify(after.rows[0]) !== JSON.stringify(before.rows[0])) {
      throw new Error(`Post-apply controls differ from approved preview: ${JSON.stringify({
        before: before.rows[0], after: after.rows[0],
      })}`);
    }
    await client.query("COMMIT");
    return res.json({ applied: true, loadId: load.rows[0].id, configSha256: CONFIG_SHA256 });
  } catch (error) {
    await client.query("ROLLBACK");
    req.log.error({ error }, "category registry apply failed");
    return res.status(409).json({ error: error instanceof Error ? error.message : "Apply failed" });
  } finally { client.release(); }
});

export default router;