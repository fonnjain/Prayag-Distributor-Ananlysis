// Schema migration runner.
//
// Migrations are stored inline as an ordered array. On every server start the
// runner ensures the schema_migrations tracking table exists, then applies any
// migration whose id is not yet recorded — in order, inside individual
// transactions.
//
// IDEMPOTENCY CONTRACT
//   • Each SQL block must be safe to skip when the id is already present.
//   • On a fresh DB (post drizzle-kit push): the Drizzle schema already creates
//     sale_line_all, so the ALTER TABLE IF EXISTS is a no-op and the views are
//     created fresh.
//   • On the existing DB: ALTER TABLE renames sale_line → sale_line_all, then
//     creates both views.
//   • After a drizzle-kit push --force (all tables recreated): schema_migrations
//     is dropped with them; the runner re-applies the migration, the ALTER TABLE
//     IF EXISTS is a no-op (Drizzle already created sale_line_all), views are
//     recreated.

import { pool } from "./index.js";

interface Migration {
  id: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: "002_ingest_run_rows_per_month",
    sql: `
      ALTER TABLE ingest_run ADD COLUMN IF NOT EXISTS rows_per_month jsonb;
    `,
  },
  {
    id: "001_sale_line_rename",
    sql: `
      -- Rename raw table so naive queries no longer reach superseded rows.
      --
      -- Guard: only rename when 'sale_line' exists AND is a plain table (relkind='r').
      -- This covers three cases:
      --   1. Fresh DB after drizzle-kit push: Drizzle already created sale_line_all,
      --      so sale_line (as a table) does not exist → no-op on the ALTER.
      --   2. Existing DB, migration not yet applied: sale_line is a table → rename runs.
      --   3. Migration was applied manually (our case today): sale_line is now a VIEW
      --      and sale_line_all already exists → no-op on the ALTER, views get OR REPLACE'd.
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'sale_line'
            AND c.relkind = 'r'
            AND n.nspname = 'public'
        ) THEN
          ALTER TABLE sale_line RENAME TO sale_line_all;
        END IF;
      END;
      $$;

      -- 'sale_line' view: current-only.  A naive SELECT * FROM sale_line is safe.
      CREATE OR REPLACE VIEW sale_line AS
        SELECT * FROM sale_line_all WHERE version_status = 'current';

      -- Backward-compat alias used by many existing analytics queries.
      CREATE OR REPLACE VIEW sale_line_current AS
        SELECT * FROM sale_line_all WHERE version_status = 'current';
    `,
  },
  {
    id: "003_register_month_state",
    sql: `
      CREATE TABLE IF NOT EXISTS register_month_state (
        fy                TEXT        NOT NULL,
        month_label       TEXT        NOT NULL,
        last_good_rows    INTEGER,
        last_good_amount  NUMERIC,
        last_replaced_at  TIMESTAMPTZ,
        frozen_at         TIMESTAMPTZ,
        frozen_rows       INTEGER,
        frozen_amount     NUMERIC,
        PRIMARY KEY (fy, month_label)
      );
    `,
  },
  {
    id: "004_mgmt_data_snapshot",
    sql: `
      -- Cold-start fast path for GET /api/mgmt/data: last successful payload
      -- per (fy, month_from, month_to). Guarantees the table exists in
      -- production where drizzle-kit push is not run.
      CREATE TABLE IF NOT EXISTS mgmt_data_snapshot (
        id         SERIAL PRIMARY KEY,
        fy         TEXT        NOT NULL,
        month_from INTEGER     NOT NULL,
        month_to   INTEGER     NOT NULL,
        payload    JSONB       NOT NULL,
        saved_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS mgmt_data_snap_key_idx
        ON mgmt_data_snapshot (fy, month_from, month_to);
    `,
  },
  {
    id: "005_route_payload_snapshot",
    sql: `
      -- Generic cold-start fast path for heavy read-only routes (e.g.
      -- /api/company-reports, /api/warnings): last successful payload per
      -- snapshot key. Guarantees the table exists in production where
      -- drizzle-kit push is not run.
      CREATE TABLE IF NOT EXISTS route_payload_snapshot (
        key      TEXT        PRIMARY KEY,
        payload  JSONB       NOT NULL,
        saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: "007_member_targets",
    sql: `
      -- Writable home for member-level targets (the Target Master Google
      -- Sheet is read-only and effectively abandoned). One row per
      -- (fy, team_member); only explicit user saves write here.
      CREATE TABLE IF NOT EXISTS member_targets (
        id          SERIAL      PRIMARY KEY,
        fy          TEXT        NOT NULL,
        team_member TEXT        NOT NULL,
        state_head  TEXT        NOT NULL DEFAULT '',
        level       TEXT        NOT NULL DEFAULT 'TM',
        annual      JSONB       NOT NULL,
        monthly     JSONB       NOT NULL,
        source      TEXT        NOT NULL DEFAULT 'user',
        updated_by  TEXT        NOT NULL DEFAULT '',
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT member_targets_uq UNIQUE (fy, team_member)
      );
    `,
  },
  {
    id: "011_register_tab_audit",
    sql: `
      -- Ledger of workbook tabs seen by register syncs that the loaders do NOT
      -- read as sales/order data: scratch tabs (Sheet11), early future-month
      -- tabs (a 'Sep' tab appearing in August), lookup/summary tabs. Each row
      -- records why the tab was excluded and when it was first noticed, so a
      -- new tab is reported instead of silently read or silently dropped.
      DROP TABLE IF EXISTS register_tab_audit;
      CREATE TABLE register_tab_audit (
        sheet_id      text NOT NULL,
        tab_name      text NOT NULL,
        fy            text NOT NULL,
        register      text NOT NULL,
        status        text NOT NULL,
        reason        text,
        grid_rows     integer,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (sheet_id, tab_name, fy, register)
      );
    `,
  },
  {
    id: "008_backfill_state_head_2425_2526",
    sql: `
      -- FY2024-25 and FY2025-26 registers (Schema B, 11 columns) carry no
      -- STATE / STATE HEAD columns, so every sale_line row for those years was
      -- ingested with state_canon and head_canon NULL. Company Reports (and any
      -- state/head-grouped analytics) therefore showed Rs 0.00 for the prior
      -- year. Backfill both attributes per customer from the years that DO
      -- carry them: FY2026-27 first (most recent attribution), then FY2023-24.
      -- Amounts, row counts and identity keys are untouched — the frozen-FY
      -- row/amount anchors still hold. Rows whose customer never appears in a
      -- state-bearing year stay NULL (grouped as 'Unmapped' — honest residual).
      WITH src AS (
        SELECT lower(trim(customer)) AS cust,
               max(state_canon) FILTER (WHERE fy = '2026-27') AS st27,
               max(head_canon)  FILTER (WHERE fy = '2026-27') AS hd27,
               max(state_canon) FILTER (WHERE fy = '2023-24') AS st24,
               max(head_canon)  FILTER (WHERE fy = '2023-24') AS hd24
        FROM sale_line_all
        WHERE version_status = 'current'
          AND fy IN ('2026-27', '2023-24')
          AND (state_canon IS NOT NULL OR head_canon IS NOT NULL)
        GROUP BY 1
      )
      UPDATE sale_line_all t
      SET state_canon = COALESCE(t.state_canon, src.st27, src.st24),
          head_canon  = COALESCE(t.head_canon,  src.hd27, src.hd24)
      FROM src
      WHERE t.fy IN ('2024-25', '2025-26')
        AND lower(trim(t.customer)) = src.cust
        AND (t.state_canon IS NULL OR t.head_canon IS NULL);
    `,
  },
  {
    id: "006_drop_mgmt_data_snapshot",
    sql: `
      -- GET /api/mgmt/data now uses the generic route_payload_snapshot layer
      -- (key mgmt-data|<fy>|<from>|<to>); the bespoke table is obsolete.
      -- Copy existing snapshots into the shared table first so the first
      -- request after rollout still gets the instant cold-start path instead
      -- of blocking on a ~20s live Sheets build. Existing shared keys win
      -- (they can only be fresher — written by the new code).
      -- Guarded: on a fresh DB the old table never existed (its Drizzle schema
      -- is gone), so the copy is skipped entirely.
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'mgmt_data_snapshot'
            AND c.relkind = 'r'
            AND n.nspname = 'public'
        ) THEN
          INSERT INTO route_payload_snapshot (key, payload, saved_at)
            SELECT 'mgmt-data|' || fy || '|' || month_from || '|' || month_to,
                   payload, saved_at
            FROM mgmt_data_snapshot
            ON CONFLICT (key) DO NOTHING;
        END IF;
      END;
      $$;
      DROP TABLE IF EXISTS mgmt_data_snapshot;
    `,
  },
  {
    id: "009_engine_targets",
    sql: `
      -- Engine-Generated Targets (T1): stores user-edited parameters and
      -- per-row overrides for the target engine. Engine proposals are always
      -- recomputed live; ONLY explicit user edits are persisted here, so
      -- regeneration can never overwrite them. engine_value keeps the
      -- proposal that was current when the user edited, for display.
      CREATE TABLE IF NOT EXISTS engine_targets (
        id           SERIAL      PRIMARY KEY,
        fy           TEXT        NOT NULL,
        row_key      TEXT        NOT NULL,
        value        JSONB       NOT NULL,
        engine_value JSONB,
        source       TEXT        NOT NULL DEFAULT 'user',
        updated_by   TEXT        NOT NULL DEFAULT '',
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT engine_targets_uq UNIQUE (fy, row_key)
      );
    `,
  },
  {
    id: "010_backfill_secondary_sku_segment_canon",
    sql: `
      -- Backfill secondary_sku_line.segment_canon for rows ingested before
      -- config/group_map.json learned the PSCode_3 / register brand vocabulary
      -- ("P.T.M.T. SYMET", "CPVC DURALIFE", "C.P. 5000 SERIES", ...).
      -- Keep this VALUES list consistent with config/group_map.json.
      -- Idempotent: only touches rows whose segment_canon is still NULL.
      UPDATE secondary_sku_line s SET segment_canon = m.canon
      FROM (VALUES
        ('P.T.M.T. SYMET',             'PTMT / Faucets'),
        ('VIGNETTE',                   'PTMT / Faucets'),
        ('CPVC DURALIFE',              'CPVC'),
        ('UPVC AQUAFRESH',             'UPVC'),
        ('SWR DRAINTECH',              'SWR'),
        ('C.P-CDA',                    'CP (Chrome-Plated)'),
        ('C.P. 5000 SERIES',           'CP (Chrome-Plated)'),
        ('C.P. 6000 SERIES',           'CP (Chrome-Plated)'),
        ('C.P. 7000 SERIES',           'CP (Chrome-Plated)'),
        ('C.P. 8000 SERIES',           'CP (Chrome-Plated)'),
        ('C.P. 9000 SERIES',           'CP (Chrome-Plated)'),
        ('P.V.C. GARDEN PIPE',         'Garden Pipe'),
        ('CISTERNS & SEAT COVERS',     'CISTERN'),
        ('S.STEEL SINK',               'Sink'),
        ('AGRITEC',                    'AGRI'),
        ('AGRI AGRITEC',               'AGRI'),
        ('WATER TANKS',                'WATER TANK'),
        ('COLUMN PIPE',                'COLUMN'),
        ('WATER HEATER',               'Sanitaryware'),
        ('COCKROACH TRAPS & GRATINGS', 'Connection / Waste'),
        ('MANHOLE COVER',              'Connection / Waste')
      ) AS m(raw, canon)
      WHERE s.segment_canon IS NULL AND s.segment_raw = m.raw;
    `,
  },
  {
    id: "012_distributor_identity",
    sql: `
      -- Persisted distributor identity registry. DIST# is the only merge key;
      -- rows without one are identified by name + state + district.
      CREATE TABLE IF NOT EXISTS distributor_identity (
        id          SERIAL      PRIMARY KEY,
        dist_id     TEXT,
        name        TEXT        NOT NULL,
        norm_key    TEXT        NOT NULL,
        state       TEXT,
        district    TEXT,
        source      TEXT        NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT distributor_identity_uk UNIQUE (dist_id)
      );
      CREATE INDEX IF NOT EXISTS distributor_identity_norm_key_idx
        ON distributor_identity (norm_key);
    `,
  },
  {
    id: "013_distributor_identity_alias",
    sql: `
      -- Alternate spellings observed in other sources (member sheets / Party TM
      -- Map bridge, registers), each mapped to its authoritative DIST#. This is
      -- what lets a transaction spelled differently resolve to the same identity.
      CREATE TABLE IF NOT EXISTS distributor_identity_alias (
        id          SERIAL      PRIMARY KEY,
        dist_id     TEXT        NOT NULL,
        alias       TEXT        NOT NULL,
        norm_key    TEXT        NOT NULL,
        source      TEXT        NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT distributor_identity_alias_uk UNIQUE (dist_id, norm_key)
      );
      CREATE INDEX IF NOT EXISTS distributor_identity_alias_norm_key_idx
        ON distributor_identity_alias (norm_key);
    `,
  },
  {
    id: "014_product_upload_variants",
    sql: `
      -- Product_Upload_Sample_File.csv load (Aug 2026).
      -- item_master stays keyed on code (existing joins depend on that);
      -- colour/length variants with per-variant MRP live in item_master_variant,
      -- a child table of the same master (NOT a parallel catalogue).
      ALTER TABLE item_master ADD COLUMN IF NOT EXISTS segment_source TEXT;
      ALTER TABLE item_master ADD COLUMN IF NOT EXISTS segment_canon  TEXT;
      ALTER TABLE item_master ADD COLUMN IF NOT EXISTS upload_name    TEXT;
      ALTER TABLE item_master ADD COLUMN IF NOT EXISTS mrp_source     TEXT;

      CREATE TABLE IF NOT EXISTS item_master_variant (
        id             SERIAL      PRIMARY KEY,
        code           TEXT        NOT NULL,
        feature_name   TEXT        NOT NULL DEFAULT '',
        product_name   TEXT,
        segment_source TEXT,
        segment_canon  TEXT,
        mrp            NUMERIC,
        mrp_conflict   BOOLEAN     NOT NULL DEFAULT FALSE,
        image_link     TEXT,
        source_file    TEXT,
        loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        -- conflicts (e.g. TTS-01/02/03 listed under two segments with
        -- different MRP) keep BOTH rows, so uniqueness includes segment_source
        CONSTRAINT item_master_variant_uk UNIQUE (code, feature_name, segment_source)
      );
      CREATE INDEX IF NOT EXISTS imv_code_idx ON item_master_variant (code);
    `,
  },
  {
    id: "015_customer_upload_junctions",
    sql: `
      -- Distributer/Retailer_Upload_Sample_File.csv load (Aug 2026).
      -- customer_master gains upload-sourced attributes; multi-value
      -- Assign User / Assign Distributor Name become junction tables.
      ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS gst              TEXT;
      ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS pincode          TEXT;
      ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS area             TEXT;
      ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS email            TEXT;
      ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS address          TEXT;
      ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS lead_status      TEXT;
      ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS status_source    TEXT;
      ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS entity_type      TEXT;
      ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS assigned_segment TEXT;
      ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS created_date     TEXT;
      ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS created_by       TEXT;
      ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS source_file      TEXT;
      ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS review_group     INTEGER;

      CREATE TABLE IF NOT EXISTS retailer_user (
        id            SERIAL  PRIMARY KEY,
        retailer_id   TEXT    NOT NULL,
        user_name     TEXT    NOT NULL,
        user_norm_key TEXT    NOT NULL,
        resolved      BOOLEAN NOT NULL DEFAULT FALSE,
        position      INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT retailer_user_uk UNIQUE (retailer_id, user_norm_key)
      );
      CREATE INDEX IF NOT EXISTS ru_user_idx ON retailer_user (user_norm_key);

      CREATE TABLE IF NOT EXISTS retailer_distributor (
        id               SERIAL  PRIMARY KEY,
        retailer_id      TEXT    NOT NULL,
        distributor_name TEXT    NOT NULL,
        dist_norm_key    TEXT    NOT NULL,
        resolved_dist_id TEXT,
        resolved         BOOLEAN NOT NULL DEFAULT FALSE,
        position         INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT retailer_distributor_uk UNIQUE (retailer_id, dist_norm_key)
      );
      CREATE INDEX IF NOT EXISTS rd_dist_idx ON retailer_distributor (dist_norm_key);
    `,
  },
  {
    id: "016_customer_master_type_nullable",
    sql: `
      -- The distributor upload's Customer Type drives customer_master.type
      -- (Distributors -> Distributor, Direct Dealers -> Direct Dealer). Rows
      -- with any other / blank Customer Type must NOT be defaulted to
      -- Distributor — they carry type NULL until adjudicated.
      ALTER TABLE customer_master ALTER COLUMN type DROP NOT NULL;
    `,
  },
  {
    id: "018_ai_report_job",
    sql: `
      -- Job-tracking table for async AI report generation (growth + statehead).
      -- Status transitions: queued → running → complete | failed.
      -- Completed payloads are stored in route_payload_snapshot (key "ai-job|{job_id}").
      CREATE TABLE IF NOT EXISTS ai_report_job (
        job_id       TEXT        PRIMARY KEY,
        cache_key    TEXT        NOT NULL,
        status       TEXT        NOT NULL DEFAULT 'queued',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ,
        error        TEXT
      );
      CREATE INDEX IF NOT EXISTS ai_report_job_cache_key_idx
        ON ai_report_job (cache_key);
      CREATE INDEX IF NOT EXISTS ai_report_job_created_at_idx
        ON ai_report_job (created_at);
    `,
  },
  {
    id: "017_scheme_schema_rebuild",
    sql: `
      -- Replace the old generic scheme_def / scheme_slab tables with the new
      -- five-table model that matches the actual Q2 FY2026-27 workbook structure.
      --
      -- Drop order: scheme_slab (FK child) first, then scheme_def (parent).
      -- The new scheme_slab table also reuses the name, so we must drop before
      -- creating. Both DROPs are guarded so the migration is safe on a fresh DB.
      DROP TABLE IF EXISTS scheme_slab;
      DROP TABLE IF EXISTS scheme_def;

      -- ── territory_group ──────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS territory_group (
        group_raw   TEXT        PRIMARY KEY,
        label       TEXT        NOT NULL,
        states      TEXT[]      NOT NULL
      );

      -- ── scheme ───────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS scheme (
        scheme_id             TEXT        PRIMARY KEY,
        name                  TEXT        NOT NULL,
        audience              TEXT[]      NOT NULL,
        settlement            TEXT        NOT NULL,
        qualification_basis   TEXT        NOT NULL,
        territory_group       TEXT        REFERENCES territory_group (group_raw),
        product_scope         TEXT,
        period_from           DATE        NOT NULL,
        period_to             DATE,
        period_note           TEXT,
        audience_source_term  TEXT,
        funding_note          TEXT
      );

      -- ── scheme_slab ───────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS scheme_slab (
        id              SERIAL      PRIMARY KEY,
        scheme_id       TEXT        NOT NULL REFERENCES scheme (scheme_id) ON DELETE CASCADE,
        slab_order      INTEGER     NOT NULL,
        threshold_from  NUMERIC     NOT NULL,
        threshold_to    NUMERIC,
        unit            TEXT        NOT NULL,
        rate            NUMERIC,
        alt_reward      TEXT,
        free_goods      TEXT,
        reward_status   TEXT        NOT NULL DEFAULT 'ok',
        raw_text        TEXT
      );
      CREATE INDEX IF NOT EXISTS scheme_slab_scheme_order_idx
        ON scheme_slab (scheme_id, slab_order);

      -- ── scheme_item_group ─────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS scheme_item_group (
        id          SERIAL  PRIMARY KEY,
        item_group  TEXT    NOT NULL,
        scheme_id   TEXT    NOT NULL REFERENCES scheme (scheme_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS scheme_item_group_item_idx
        ON scheme_item_group (item_group);

      -- ── special_pricing ───────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS special_pricing (
        id              SERIAL  PRIMARY KEY,
        customer_name   TEXT    NOT NULL,
        effective_from  DATE    NOT NULL,
        effective_to    DATE,
        note            TEXT,
        rate_rows       JSONB   NOT NULL
      );
    `,
  },
];

export async function runMigrations(): Promise<void> {
  // Bootstrap the tracking table (CREATE TABLE IF NOT EXISTS is always safe).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT        PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  for (const migration of MIGRATIONS) {
    const { rowCount } = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE id = $1",
      [migration.id],
    );
    if (rowCount && rowCount > 0) continue; // already applied

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [
        migration.id,
      ]);
      await client.query("COMMIT");
      console.log(`[migrations] Applied: ${migration.id}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(
        `Migration ${migration.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      client.release();
    }
  }
}
