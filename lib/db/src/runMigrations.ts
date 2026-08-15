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

      -- ── scheme_reward_slab ───────────────────────────────────────────────
      -- Named differently from the legacy scheme_slab on purpose: the publish
      -- diff must see DROP old + CREATE new, never an in-place ALTER of a
      -- same-named table with an incompatible shape.
      CREATE TABLE IF NOT EXISTS scheme_reward_slab (
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
      CREATE INDEX IF NOT EXISTS scheme_reward_slab_scheme_order_idx
        ON scheme_reward_slab (scheme_id, slab_order);

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
  {
    id: "020_sale_line_channel",
    sql: `
      -- Add the rate-list channel column to sale_line_all.
      -- Retail | Govt | Project | JJM | Gem | Export | Unmapped | NULL (no match).
      -- NULL means the customer was not found in the rate-list customer master —
      -- never defaulted to 'Retail'.  Backfill runs in-app via the admin route.
      ALTER TABLE sale_line_all
        ADD COLUMN IF NOT EXISTS channel TEXT;

      CREATE INDEX IF NOT EXISTS sale_line_fy_channel_idx
        ON sale_line_all (fy, channel);

      -- Refresh both views so they pick up the new column.  PostgreSQL caches
      -- column definitions at CREATE VIEW time; ALTER TABLE on the base table
      -- requires CREATE OR REPLACE on every dependent view in dependency order.
      CREATE OR REPLACE VIEW sale_line AS
        SELECT * FROM sale_line_all WHERE version_status = 'current';
      CREATE OR REPLACE VIEW sale_line_current AS
        SELECT * FROM sale_line WHERE version_status = 'current';
    `,
  },
  {
    id: "021_person_registry",
    sql: `
      -- Single source of truth for the person/head identity model.
      -- Replaces head_alias.json + normalize.json territory_heads as pipeline sources.
      -- norm_key is the unique identity: plausible employee codes (≤4 digits) or
      -- normSecKey(name):normSecKey(manager) for implausible codes.
      CREATE TABLE IF NOT EXISTS person_registry (
        id               SERIAL      PRIMARY KEY,
        employee_code    TEXT,
        code_plausible   BOOLEAN     NOT NULL DEFAULT FALSE,
        norm_key         TEXT        NOT NULL UNIQUE,
        canonical_name   TEXT        NOT NULL,
        alias_primary    TEXT[],
        alias_secondary  TEXT,
        alias_sheet      TEXT,
        reporting_manager TEXT,
        state_head       TEXT,
        is_state_head    BOOLEAN     NOT NULL DEFAULT FALSE,
        is_person        BOOLEAN     NOT NULL DEFAULT TRUE,
        hr_status        TEXT,
        flag_notes       TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS pr_canonical_name_idx ON person_registry (canonical_name);
      CREATE INDEX IF NOT EXISTS pr_is_state_head_idx  ON person_registry (is_state_head);
      CREATE INDEX IF NOT EXISTS pr_is_person_idx      ON person_registry (is_person);
      CREATE INDEX IF NOT EXISTS pr_employee_code_idx  ON person_registry (employee_code);
    `,
  },
  {
    id: "022_mrp_tables",
    sql: `
      -- MRP master — effective-dated, append-only.
      -- mrp_master: one row per normalised item code (join key to sale_line.code).
      -- mrp_history: effective-dated price rows; effective_to = NULL means current.
      -- The OLD MRP / NEW MRP pair from each workbook produces two history rows
      -- (old with effective_to = w.e.f. date; new with effective_from = w.e.f.).
      CREATE TABLE IF NOT EXISTS mrp_master (
        item_code    TEXT    PRIMARY KEY,
        item_name    TEXT,
        segment      TEXT    NOT NULL,
        series       TEXT,
        packing      TEXT
      );

      CREATE TABLE IF NOT EXISTS mrp_history (
        id             SERIAL  PRIMARY KEY,
        item_code      TEXT    NOT NULL REFERENCES mrp_master(item_code) ON DELETE CASCADE,
        mrp            NUMERIC NOT NULL,
        effective_from DATE    NOT NULL,
        effective_to   DATE,
        source_file    TEXT    NOT NULL,
        is_current     BOOLEAN NOT NULL DEFAULT TRUE
      );

      CREATE INDEX IF NOT EXISTS mrp_history_item_idx
        ON mrp_history (item_code);
      CREATE INDEX IF NOT EXISTS mrp_history_current_idx
        ON mrp_history (item_code, is_current)
        WHERE is_current = TRUE;
    `,
  },
  {
    id: "023_mrp_composite_key",
    sql: `
      -- Upgrade mrp_master PK from (item_code) to (item_code, segment).
      --
      -- Motivation: codes such as CNS-15 appear in both the PTMT and CP
      -- catalogues as genuinely different products with independent price
      -- histories. Keying on item_code alone caused two problems:
      --   1. Only the first-seen segment's master row was stored (the other
      --      was silently dropped).
      --   2. mrp_history accumulated multiple is_current=TRUE rows for the
      --      same item_code from different workbooks.
      -- The composite key gives each (item_code, segment) pair its own master
      -- row and its own clean history. is_ambiguous_code flags the codes that
      -- appear in more than one segment so the UI and resolver can warn rather
      -- than guess.
      --
      -- Drop in FK-dependency order (history first, then master).
      DROP TABLE IF EXISTS mrp_history;
      DROP TABLE IF EXISTS mrp_master;

      -- mrp_master: composite PK (item_code, segment).
      CREATE TABLE mrp_master (
        item_code         TEXT    NOT NULL,
        item_name         TEXT,
        segment           TEXT    NOT NULL,
        series            TEXT,
        packing           TEXT,
        is_ambiguous_code BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (item_code, segment)
      );

      -- mrp_history: FK references composite PK; segment stored for efficient
      -- per-(code, segment) queries without joining back to mrp_master.
      CREATE TABLE mrp_history (
        id             SERIAL  PRIMARY KEY,
        item_code      TEXT    NOT NULL,
        segment        TEXT    NOT NULL,
        mrp            NUMERIC NOT NULL,
        effective_from DATE    NOT NULL,
        effective_to   DATE,
        source_file    TEXT    NOT NULL,
        is_current     BOOLEAN NOT NULL DEFAULT TRUE,
        FOREIGN KEY (item_code, segment)
          REFERENCES mrp_master (item_code, segment)
          ON DELETE CASCADE
      );

      CREATE INDEX mrp_history_item_seg_idx
        ON mrp_history (item_code, segment);
      CREATE INDEX mrp_history_current_idx
        ON mrp_history (item_code, segment, is_current)
        WHERE is_current = TRUE;
    `,
  },
  {
    id: "019_rename_scheme_slab_to_reward_slab",
    sql: `
      -- Dev DBs that ran the original 017 have the NEW-shape table under the
      -- legacy name scheme_slab. Rename it (preserving seeded slab data) so
      -- dev and prod converge on scheme_reward_slab. Idempotent: no-op when
      -- the rename already happened or 017 created the new name directly.
      DO $do$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = 'scheme_slab')
           AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = 'scheme_reward_slab') THEN
          ALTER TABLE scheme_slab RENAME TO scheme_reward_slab;
          ALTER INDEX IF EXISTS scheme_slab_scheme_order_idx
            RENAME TO scheme_reward_slab_scheme_order_idx;
        END IF;
      END
      $do$;
    `,
  },
  {
    id: "024_margin_fact",
    sql: `
      CREATE TABLE IF NOT EXISTS margin_fact (
        id            SERIAL       PRIMARY KEY,
        fy            TEXT         NOT NULL,
        month_label   TEXT         NOT NULL,
        segment       TEXT         NOT NULL,
        item_code     TEXT         NOT NULL,
        tab_name      TEXT,
        qty           NUMERIC,
        weight        NUMERIC,
        mrp           NUMERIC,
        -- Fraction, not percentage. 0.5353 means realised sale is 46.47% of MRP.
        -- Label every derived figure "gross margin" / "gross contribution", never "profit".
        -- bom_cost is factory cost only; no freight, overhead or SG&A is included.
        discount_frac NUMERIC,
        avg_sale      NUMERIC,
        bom_cost      NUMERIC,
        sale_value    NUMERIC,
        bom_value     NUMERIC,
        source_file   TEXT         NOT NULL,
        loaded_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_margin_fact_fy_month_code ON margin_fact (fy, month_label, item_code);
      CREATE INDEX IF NOT EXISTS idx_margin_fact_fy_segment    ON margin_fact (fy, segment);
    `,
  },
  {
    id: "025_state_hierarchy",
    sql: `
      -- Every distinct state_canon value maps to one parent.
      -- Splits (DELHI A, DELHI NCR, UP ( A ) …) share a parent; non-splits map to themselves.
      -- picker_visible=false keeps non-geographic channel codes out of the UI while
      -- preserving them in the table so verification arithmetic stays exact.
      CREATE TABLE IF NOT EXISTS state_hierarchy (
        state_canon    TEXT    PRIMARY KEY,
        state_parent   TEXT    NOT NULL,
        is_split       BOOLEAN NOT NULL DEFAULT false,
        picker_visible BOOLEAN NOT NULL DEFAULT true,
        display_order  INTEGER NOT NULL DEFAULT 999
      );

      INSERT INTO state_hierarchy
        (state_canon, state_parent, is_split, picker_visible, display_order)
      VALUES
        -- ── Delhi splits ────────────────────────────────────────────────────
        ('DELHI A',                         'Delhi',                         true,  true,   10),
        ('DELHI NCR',                       'Delhi',                         true,  true,   11),
        -- ── North: HP, J&K, Chandigarh ──────────────────────────────────────
        ('HIMACHAL PRADESH',                'HIMACHAL PRADESH',              false, true,   12),
        ('CHANDIGARH',                      'CHANDIGARH',                    false, true,   14),
        ('JAMMU',                           'Jammu and Kashmir',             true,  true,   15),
        ('KASHMIR',                         'Jammu and Kashmir',             true,  true,   16),
        -- ── Uttar Pradesh splits ─────────────────────────────────────────────
        ('UTTAR PRADESH',                   'Uttar Pradesh',                 true,  true,   20),
        ('UP ( A )',                         'Uttar Pradesh',                 true,  true,   21),
        ('UP (AS)',                          'Uttar Pradesh',                 true,  true,   22),
        -- ── Uttarakhand ──────────────────────────────────────────────────────
        ('UTTARAKHAND',                     'UTTARAKHAND',                   false, true,   25),
        -- ── Haryana, Rajasthan splits, Punjab ────────────────────────────────
        ('HARYANA',                         'HARYANA',                       false, true,   30),
        ('RAJASTHAN',                       'Rajasthan',                     true,  true,   32),
        ('RAJASTHAN (N)',                    'Rajasthan',                     true,  true,   33),
        ('PUNJAB',                          'PUNJAB',                        false, true,   35),
        -- ── East ─────────────────────────────────────────────────────────────
        ('ASSAM',                           'ASSAM',                         false, true,   40),
        ('WEST BENGAL',                     'WEST BENGAL',                   false, true,   43),
        ('BIHAR',                           'BIHAR',                         false, true,   45),
        ('JHARKHAND',                       'JHARKHAND',                     false, true,   47),
        ('ODISHA',                          'ODISHA',                        false, true,   50),
        -- ── South ────────────────────────────────────────────────────────────
        ('AP',                              'Andhra Pradesh',                true,  true,   55),
        ('TELANGANA',                       'TELANGANA',                     false, true,   56),
        ('KERALA',                          'KERALA',                        false, true,   57),
        ('GOA',                             'GOA',                           false, true,   58),
        ('KARNATAKA',                       'Karnataka',                     true,  true,   60),
        ('KARNATAKA (B)',                   'Karnataka',                     true,  true,   61),
        ('TAMIL NADU',                      'Tamil Nadu',                    true,  true,   65),
        ('TAMILNADU (S)',                    'Tamil Nadu',                    true,  true,   66),
        -- ── West ─────────────────────────────────────────────────────────────
        ('MAHARASHTRA',                     'MAHARASHTRA',                   false, true,   72),
        ('GUJARAT',                         'GUJARAT',                       false, true,   75),
        ('MADHYA PRADESH',                  'MADHYA PRADESH',                false, true,   78),
        ('CHHATTISGARH',                    'CHHATTISGARH',                  false, true,   80),
        -- ── Remote geographic ─────────────────────────────────────────────────
        ('ANDAMAN',                         'ANDAMAN',                       false, true,  100),
        ('NEPAL',                           'NEPAL',                         false, true,  110),
        -- ── Non-geographic channel codes (in hierarchy for arithmetic, not in picker) ──
        ('GEM',                             'GEM',                           false, false, 900),
        ('JJM',                             'JJM',                           false, false, 901),
        ('Non-territory / Project / Govt',  'Non-territory / Project / Govt',false, false, 902),
        ('HITESH',                          'HITESH',                        false, false, 903)
      ON CONFLICT (state_canon) DO UPDATE SET
        state_parent   = EXCLUDED.state_parent,
        is_split       = EXCLUDED.is_split,
        picker_visible = EXCLUDED.picker_visible,
        display_order  = EXCLUDED.display_order;
    `,
  },
  {
    id: "026_market_survey",
    sql: `
      -- Stores retailer visit price surveys recorded by Prayag salespeople.
      -- customer_id references customer_master(id) (TEXT PK like "RET#92823").
      -- net_price is always the canonical stored value; mrp + discount_pct are
      -- stored when entry_mode = 'mrp_discount' so the working is preserved.
      -- Editing is allowed for 24 hours after created_at (enforced in the API).
      CREATE TABLE IF NOT EXISTS market_survey (
        id                SERIAL       PRIMARY KEY,
        surveyed_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
        recorded_by       TEXT         NOT NULL,
        is_existing_buyer BOOLEAN      NOT NULL,
        customer_id       TEXT         REFERENCES customer_master(id),
        prospect_name     TEXT,
        state             TEXT,
        district          TEXT,
        segment           TEXT         NOT NULL,
        prayag_item_code  TEXT,
        competitor_brand  TEXT         NOT NULL,
        competitor_product TEXT,
        net_price         NUMERIC(12,2) NOT NULL,
        mrp               NUMERIC(12,2),
        discount_pct      NUMERIC(8,4),
        entry_mode        TEXT         NOT NULL
          CHECK (entry_mode IN ('net_direct','mrp_discount')),
        unit              TEXT         NOT NULL DEFAULT 'piece',
        pack_size         TEXT,
        reasons           TEXT[]       NOT NULL DEFAULT '{}',
        monthly_volume    NUMERIC(12,2),
        note              TEXT,
        created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_ms_seg_brand   ON market_survey (segment, competitor_brand);
      CREATE INDEX IF NOT EXISTS idx_ms_item_code   ON market_survey (prayag_item_code)
        WHERE prayag_item_code IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_ms_state       ON market_survey (state);
      CREATE INDEX IF NOT EXISTS idx_ms_recorded_by ON market_survey (recorded_by);
      CREATE INDEX IF NOT EXISTS idx_ms_created_at  ON market_survey (created_at DESC);
    `,
  },
  {
    id: "028_market_survey_prospect",
    sql: `
      -- Pending new distributor / retailer records submitted via the Market Survey page.
      -- These are NOT written to customer_master directly — they sit here for approval.
      -- When approved, approved_customer_id is set to the new customer_master.id.
      -- market_survey.pending_prospect_id links a survey to its pending prospect so
      -- the survey is not blocked waiting for approval.
      CREATE TABLE IF NOT EXISTS market_survey_prospect (
        id                   SERIAL       PRIMARY KEY,
        name                 TEXT         NOT NULL,
        contact              TEXT         NOT NULL,
        contact_person       TEXT,
        address              TEXT,
        district             TEXT         NOT NULL,
        state                TEXT         NOT NULL,
        area                 TEXT,
        pincode              TEXT,
        gst                  TEXT,
        type                 TEXT         NOT NULL CHECK (type IN ('Distributor','Retailer')),
        for_distributor_id   TEXT         REFERENCES customer_master(id),
        source               TEXT         NOT NULL DEFAULT 'market_survey',
        submitted_by         TEXT         NOT NULL,
        submitted_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
        status               TEXT         NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','approved','rejected')),
        approved_customer_id TEXT         REFERENCES customer_master(id),
        approved_at          TIMESTAMPTZ,
        note                 TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_msp_status       ON market_survey_prospect (status);
      CREATE INDEX IF NOT EXISTS idx_msp_type         ON market_survey_prospect (type);
      CREATE INDEX IF NOT EXISTS idx_msp_submitted_by ON market_survey_prospect (submitted_by);
      CREATE INDEX IF NOT EXISTS idx_msp_submitted_at ON market_survey_prospect (submitted_at DESC);

      -- Link a survey row to the pending prospect it was recorded against.
      ALTER TABLE market_survey
        ADD COLUMN IF NOT EXISTS pending_prospect_id INTEGER
          REFERENCES market_survey_prospect(id);
    `,
  },
  {
    id: "027_competitor_price",
    sql: `
      -- Local snapshot of competitor pricing from the Prayag Competition Analysis app.
      -- Fetched daily; never written to from the client bundle.
      -- prayag_item_code is NULL at import and set manually via the mapping UI.
      -- net_price_derived = mrp × (1 − discount_pct_assumed / 100); label as "derived".
      CREATE TABLE IF NOT EXISTS competitor_price (
        id                   SERIAL        PRIMARY KEY,
        competitor_brand     TEXT          NOT NULL,
        competitor_code      TEXT          NOT NULL,  -- their row id (as string)
        competitor_name      TEXT,
        category             TEXT          NOT NULL,
        mrp                  NUMERIC(12,2),
        net_price_derived    NUMERIC(12,2),
        discount_pct_assumed NUMERIC(5,2)  DEFAULT 40,
        source_fetched_at    TIMESTAMPTZ   NOT NULL,
        prayag_item_code     TEXT,
        mapped_by            TEXT,
        mapped_at            TIMESTAMPTZ,
        created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        UNIQUE (competitor_brand, competitor_code)
      );
      CREATE INDEX IF NOT EXISTS idx_cp_prayag_code ON competitor_price (prayag_item_code)
        WHERE prayag_item_code IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_cp_brand_cat   ON competitor_price (competitor_brand, category);
    `,
  },
  {
    id: "029_market_survey_batched_lines",
    sql: `
      -- survey_id groups all lines from one multi-item submission.
      -- survey_type is the explicit tab choice (never inferred from field population).
      -- Existing rows get survey_type='unclassified' and a unique survey_id each.
      ALTER TABLE market_survey
        ADD COLUMN IF NOT EXISTS survey_id   UUID,
        ADD COLUMN IF NOT EXISTS survey_type TEXT
          CHECK (survey_type IN ('existing_sku','new_sku','new_customer','unclassified'));

      UPDATE market_survey
        SET survey_id   = gen_random_uuid(),
            survey_type = 'unclassified'
        WHERE survey_id IS NULL;

      ALTER TABLE market_survey
        ALTER COLUMN survey_id   SET NOT NULL,
        ALTER COLUMN survey_type SET NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_ms_survey_id   ON market_survey (survey_id);
      CREATE INDEX IF NOT EXISTS idx_ms_survey_type ON market_survey (survey_type);
    `,
  },
  {
    id: "030_master_org_schema",
    sql: `
      -- ── designation ──────────────────────────────────────────────────────────
      -- Controlled vocabulary. Rank 1 = most senior. Never free-text on a person.
      CREATE TABLE IF NOT EXISTS designation (
        designation_id  SERIAL PRIMARY KEY,
        name            TEXT NOT NULL UNIQUE,
        rank            INTEGER NOT NULL,
        is_system       BOOLEAN NOT NULL DEFAULT false,
        created_by      TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- ── person ───────────────────────────────────────────────────────────────
      -- Editable master for salespeople. person_id is the identity key — NOT
      -- employee_code (62 of 179 have implausible codes).
      CREATE TABLE IF NOT EXISTS person (
        person_id              SERIAL PRIMARY KEY,
        name                   TEXT NOT NULL,
        employee_code          TEXT,           -- informational only; nullable
        designation_id         INTEGER REFERENCES designation(designation_id),
        reports_to_person_id   INTEGER REFERENCES person(person_id),
        state_head_person_id   INTEGER REFERENCES person(person_id),
        is_state_head          BOOLEAN NOT NULL DEFAULT false,
        is_active              BOOLEAN NOT NULL DEFAULT true,
        headquarter            TEXT,
        order_type             TEXT,
        source                 TEXT NOT NULL DEFAULT 'app_created'
          CHECK (source IN ('hr_sheet','app_created')),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_person_name          ON person (name);
      CREATE INDEX IF NOT EXISTS idx_person_reports_to    ON person (reports_to_person_id);
      CREATE INDEX IF NOT EXISTS idx_person_state_head    ON person (state_head_person_id);

      -- ── territory ────────────────────────────────────────────────────────────
      -- States and splits. East U.P and West U.P stay separate; both point at
      -- Uttar Pradesh as parent. Reuses the same vocabulary as state_hierarchy.
      CREATE TABLE IF NOT EXISTS territory (
        territory_id        SERIAL PRIMARY KEY,
        name                TEXT NOT NULL UNIQUE,
        parent_territory_id INTEGER REFERENCES territory(territory_id),
        is_split            BOOLEAN NOT NULL DEFAULT false
      );
      CREATE INDEX IF NOT EXISTS idx_territory_parent ON territory (parent_territory_id);

      -- ── person_territory ─────────────────────────────────────────────────────
      -- Many-to-many: a person holds several states; a state has several people.
      CREATE TABLE IF NOT EXISTS person_territory (
        person_id       INTEGER NOT NULL REFERENCES person(person_id),
        territory_id    INTEGER NOT NULL REFERENCES territory(territory_id),
        effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
        effective_to    DATE,
        PRIMARY KEY (person_id, territory_id, effective_from)
      );

      -- ── customer ─────────────────────────────────────────────────────────────
      -- Editable master for all customer entities (DIST#, RET#, etc.).
      -- The existing customer_master table is NOT replaced — it continues to
      -- serve as the operational read-only source. This table is the new truth.
      CREATE TABLE IF NOT EXISTS customer (
        customer_id   TEXT PRIMARY KEY,     -- preserves DIST#/RET# identifiers
        name          TEXT NOT NULL,
        type          TEXT NOT NULL CHECK (type IN
          ('distributor','direct_dealer','retailer','sub_dealer',
           'project','govt','other')),
        territory_id  INTEGER REFERENCES territory(territory_id),
        status        TEXT,
        source        TEXT NOT NULL DEFAULT 'import'
          CHECK (source IN ('import','app_created','customer_master')),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_customer_type      ON customer (type);
      CREATE INDEX IF NOT EXISTS idx_customer_territory ON customer (territory_id);

      -- ── customer_assignment ──────────────────────────────────────────────────
      -- Effective-dated assignment of a customer to a salesperson and state head.
      -- Reports always read the assignment IN FORCE during the period being
      -- reported, not today's. Reassigning a customer must never change history.
      CREATE TABLE IF NOT EXISTS customer_assignment (
        id                    SERIAL PRIMARY KEY,
        customer_id           TEXT NOT NULL REFERENCES customer(customer_id),
        person_id             INTEGER REFERENCES person(person_id),
        state_head_person_id  INTEGER REFERENCES person(person_id),
        confidence            TEXT NOT NULL CHECK (confidence IN
          ('confirmed','assign_user_chain','state_lookup','guessed')),
        effective_from        DATE NOT NULL DEFAULT CURRENT_DATE,
        effective_to          DATE,
        set_by                TEXT,
        set_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ca_customer    ON customer_assignment (customer_id);
      CREATE INDEX IF NOT EXISTS idx_ca_person      ON customer_assignment (person_id);
      CREATE INDEX IF NOT EXISTS idx_ca_state_head  ON customer_assignment (state_head_person_id);
      CREATE INDEX IF NOT EXISTS idx_ca_effective   ON customer_assignment (customer_id, effective_from, effective_to);

      -- ── customer_link ────────────────────────────────────────────────────────
      -- Retailer → distributor. Many-to-many: over a third of active retailers
      -- link to more than one distributor. Do NOT collapse to one.
      CREATE TABLE IF NOT EXISTS customer_link (
        id             SERIAL PRIMARY KEY,
        retailer_id    TEXT NOT NULL REFERENCES customer(customer_id),
        distributor_id TEXT NOT NULL REFERENCES customer(customer_id),
        link_order     INTEGER NOT NULL DEFAULT 1,
        effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
        effective_to   DATE,
        UNIQUE (retailer_id, distributor_id, effective_from)
      );
      CREATE INDEX IF NOT EXISTS idx_cl_retailer     ON customer_link (retailer_id);
      CREATE INDEX IF NOT EXISTS idx_cl_distributor  ON customer_link (distributor_id);

      -- ── change_log ───────────────────────────────────────────────────────────
      -- Every edit, without exception.
      CREATE TABLE IF NOT EXISTS change_log (
        id           BIGSERIAL PRIMARY KEY,
        entity_type  TEXT NOT NULL,
        entity_id    TEXT NOT NULL,
        field        TEXT NOT NULL,
        old_value    TEXT,
        new_value    TEXT,
        changed_by   TEXT,
        changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reason       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_cl_entity ON change_log (entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_cl_when   ON change_log (changed_at);
    `,
  },
  {
    id: "031_seed_unresolved_links",
    sql: `
      -- Retailer→distributor links from the seed that could not be matched to a
      -- customer row because the distributor name in the link tab differed from
      -- every name in the Customers tab.  14 names, 372 affected links.
      -- Phase 3 UI surfaces these so operators can map or confirm gone.
      CREATE TABLE IF NOT EXISTS seed_unresolved_link (
        id           SERIAL PRIMARY KEY,
        raw_name     TEXT NOT NULL UNIQUE,   -- exact string from the seed xlsx
        link_count   INTEGER NOT NULL,       -- number of retailer links that were dropped
        notes        TEXT,                  -- operator notes
        resolution   TEXT CHECK (resolution IN ('mapped', 'confirmed_gone', NULL)),
        mapped_to_id TEXT REFERENCES customer(customer_id),
        resolved_by  TEXT,
        resolved_at  TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Populate the 14 names discovered during seed import (2026-08-15).
      -- Row counts: 372 links from unmatched distributor names + 64 from missing
      -- retailer rows = 436 total skipped (as reported in Phase 1 verification).
      INSERT INTO seed_unresolved_link (raw_name, link_count, notes) VALUES
        ('Prayag Sale Corporation Ne',                                       109, 'Cell value appears truncated in xlsx'),
        ('Chhinamastike Sanitation Pvt. Ltd. ( Previously Balajee Ent.',     87,  'Name split across rows in xlsx — likely same company as "Deoghar)" row'),
        ('Deoghar)',                                                          87,  'Continuation of "Chhinamastike Sanitation..." row above'),
        ('M/S Manoj Hardware And Paint Store',                               36,  NULL),
        ('Simis Enterprises ( Non Active)',                                  11,  'Marked non-active in source'),
        ('Ms Vashnavi Enterprise',                                            8,  NULL),
        ('M/S Mansaa Associates',                                             8,  NULL),
        ('Ms Heaven Trading Hub',                                             5,  NULL),
        ('Prabhusurat (Non Active)',                                          5,  'Marked non-active in source'),
        ('M Plastico(Non Active)',                                            5,  'Marked non-active in source'),
        ('Num Traders(Not Active)',                                           5,  'Marked not-active in source'),
        ('Ms Aum Sai Enterprises',                                            3,  NULL),
        ('Krishna Sanitary',                                                  2,  NULL),
        ('Nawander Company (Non Active)',                                     1,  'Marked non-active in source')
      ON CONFLICT (raw_name) DO NOTHING;
    `,
  },
  {
    id: "032_recover_split_name_links",
    sql: `
      -- 032: Merge the Chhinamastike split-name rows in seed_unresolved_link,
      -- mark both resolved names and Prayag Sale Corporation NE as mapped,
      -- and recover the 174+109 customer_link rows that were dropped at seed time.

      -- Merge: update first half-row to the full company name (idempotent)
      UPDATE seed_unresolved_link
      SET raw_name     = 'Chhinamastike Sanitation Pvt. Ltd. ( Previously Balajee Ent., Deoghar)',
          link_count   = 174,
          notes        = 'Comma in company name caused naive xlsx split; two halves covered 174 distinct retailer links to DIST#9236',
          resolution   = 'mapped',
          mapped_to_id = 'DIST#9236',
          resolved_by  = 'system',
          resolved_at  = NOW()
      WHERE raw_name IN (
        'Chhinamastike Sanitation Pvt. Ltd. ( Previously Balajee Ent.',
        'Chhinamastike Sanitation Pvt. Ltd. ( Previously Balajee Ent., Deoghar)'
      );

      -- Delete the dangling second-half row (idempotent)
      DELETE FROM seed_unresolved_link WHERE raw_name = 'Deoghar)';

      -- Mark Prayag Sale resolved (truncated name → DIST#39381)
      UPDATE seed_unresolved_link
      SET notes        = 'Truncated at 25 chars in xlsx; full name is Prayag Sale Corporation NE',
          resolution   = 'mapped',
          mapped_to_id = 'DIST#39381',
          resolved_by  = 'system',
          resolved_at  = NOW()
      WHERE raw_name = 'Prayag Sale Corporation Ne';

      -- Recover 174 Chhinamastike links (idempotent via ON CONFLICT)
      INSERT INTO customer_link (retailer_id, distributor_id, link_order)
      VALUES ('RET#89709','DIST#9236',1),('RET#89709','DIST#9236',2),('RET#89461','DIST#9236',1),('RET#89461','DIST#9236',2),('RET#89118','DIST#9236',1),('RET#89118','DIST#9236',2),('RET#87843','DIST#9236',1),('RET#87843','DIST#9236',2),('RET#87583','DIST#9236',1),('RET#87583','DIST#9236',2),('RET#87412','DIST#9236',1),('RET#87412','DIST#9236',2),('RET#83681','DIST#9236',1),('RET#83681','DIST#9236',2),('RET#81878','DIST#9236',1),('RET#81878','DIST#9236',2),('RET#80815','DIST#9236',1),('RET#80815','DIST#9236',2),('RET#79086','DIST#9236',1),('RET#79086','DIST#9236',2),('RET#79083','DIST#9236',1),('RET#79083','DIST#9236',2),('RET#73411','DIST#9236',1),('RET#73411','DIST#9236',2),('RET#73161','DIST#9236',1),('RET#73161','DIST#9236',2),('RET#72971','DIST#9236',1),('RET#72971','DIST#9236',2),('RET#72530','DIST#9236',1),('RET#72530','DIST#9236',2),('RET#68963','DIST#9236',1),('RET#68963','DIST#9236',2),('RET#68397','DIST#9236',1),('RET#68397','DIST#9236',2),('RET#68131','DIST#9236',1),('RET#68131','DIST#9236',2),('RET#66491','DIST#9236',1),('RET#66491','DIST#9236',2),('RET#62856','DIST#9236',1),('RET#62856','DIST#9236',2),('RET#59454','DIST#9236',1),('RET#59454','DIST#9236',2),('RET#59431','DIST#9236',1),('RET#59431','DIST#9236',2),('RET#58393','DIST#9236',1),('RET#58393','DIST#9236',2),('RET#58057','DIST#9236',1),('RET#58057','DIST#9236',2),('RET#57105','DIST#9236',1),('RET#57105','DIST#9236',2),('RET#57087','DIST#9236',1),('RET#57087','DIST#9236',2),('RET#56851','DIST#9236',1),('RET#56851','DIST#9236',2),('RET#56800','DIST#9236',1),('RET#56800','DIST#9236',2),('RET#56653','DIST#9236',1),('RET#56653','DIST#9236',2),('RET#54550','DIST#9236',1),('RET#54550','DIST#9236',2),('RET#54539','DIST#9236',1),('RET#54539','DIST#9236',2),('RET#52568','DIST#9236',1),('RET#52568','DIST#9236',2),('RET#52551','DIST#9236',1),('RET#52551','DIST#9236',2),('RET#49466','DIST#9236',1),('RET#49466','DIST#9236',2),('RET#48759','DIST#9236',1),('RET#48759','DIST#9236',2),('RET#46473','DIST#9236',1),('RET#46473','DIST#9236',2),('RET#43876','DIST#9236',1),('RET#43876','DIST#9236',2),('RET#42873','DIST#9236',1),('RET#42873','DIST#9236',2),('RET#41826','DIST#9236',1),('RET#41826','DIST#9236',2),('RET#41334','DIST#9236',1),('RET#41334','DIST#9236',2),('RET#38396','DIST#9236',1),('RET#38396','DIST#9236',2),('RET#38322','DIST#9236',1),('RET#38322','DIST#9236',2),('RET#33084','DIST#9236',1),('RET#33084','DIST#9236',2),('RET#32052','DIST#9236',1),('RET#32052','DIST#9236',2),('RET#30372','DIST#9236',1),('RET#30372','DIST#9236',2),('RET#30319','DIST#9236',1),('RET#30319','DIST#9236',2),('RET#30072','DIST#9236',1),('RET#30072','DIST#9236',2),('RET#29973','DIST#9236',1),('RET#29973','DIST#9236',2),('RET#29401','DIST#9236',1),('RET#29401','DIST#9236',2),('RET#28266','DIST#9236',1),('RET#28266','DIST#9236',2),('RET#27894','DIST#9236',1),('RET#27894','DIST#9236',2),('RET#27789','DIST#9236',1),('RET#27789','DIST#9236',2),('RET#25309','DIST#9236',1),('RET#25309','DIST#9236',2),('RET#24265','DIST#9236',1),('RET#24265','DIST#9236',2),('RET#24263','DIST#9236',1),('RET#24263','DIST#9236',2),('RET#23023','DIST#9236',1),('RET#23023','DIST#9236',2),('RET#22879','DIST#9236',2),('RET#22879','DIST#9236',3),('RET#20763','DIST#9236',2),('RET#20763','DIST#9236',3),('RET#20719','DIST#9236',1),('RET#20719','DIST#9236',2),('RET#20719','DIST#9236',3),('RET#20719','DIST#9236',4),('RET#20442','DIST#9236',1),('RET#20442','DIST#9236',2),('RET#19803','DIST#9236',2),('RET#19803','DIST#9236',3),('RET#19604','DIST#9236',1),('RET#19604','DIST#9236',2),('RET#19402','DIST#9236',2),('RET#19402','DIST#9236',3),('RET#19399','DIST#9236',2),('RET#19399','DIST#9236',3),('RET#19396','DIST#9236',2),('RET#19396','DIST#9236',3),('RET#19353','DIST#9236',2),('RET#19353','DIST#9236',3),('RET#19022','DIST#9236',1),('RET#19022','DIST#9236',2),('RET#18666','DIST#9236',1),('RET#18666','DIST#9236',2),('RET#15442','DIST#9236',1),('RET#15442','DIST#9236',2),('RET#15443','DIST#9236',1),('RET#15443','DIST#9236',2),('RET#15444','DIST#9236',1),('RET#15444','DIST#9236',2),('RET#15447','DIST#9236',1),('RET#15447','DIST#9236',2),('RET#15460','DIST#9236',1),('RET#15460','DIST#9236',2),('RET#15461','DIST#9236',1),('RET#15461','DIST#9236',2),('RET#15462','DIST#9236',1),('RET#15462','DIST#9236',2),('RET#15466','DIST#9236',1),('RET#15466','DIST#9236',2),('RET#15467','DIST#9236',1),('RET#15467','DIST#9236',2),('RET#15468','DIST#9236',1),('RET#15468','DIST#9236',2),('RET#10618','DIST#9236',2),('RET#10618','DIST#9236',3),('RET#10155','DIST#9236',1),('RET#10155','DIST#9236',2),('RET#10144','DIST#9236',2),('RET#10144','DIST#9236',3),('RET#10142','DIST#9236',1),('RET#10142','DIST#9236',2),('RET#10135','DIST#9236',2),('RET#10135','DIST#9236',3),('RET#10138','DIST#9236',2),('RET#10138','DIST#9236',3),('RET#10027','DIST#9236',2),('RET#10027','DIST#9236',3),('RET#9870','DIST#9236',2),('RET#9870','DIST#9236',3)
      ON CONFLICT (retailer_id, distributor_id, effective_from) DO NOTHING;

      -- Recover 109 Prayag Sale Corporation NE links (idempotent via ON CONFLICT)
      INSERT INTO customer_link (retailer_id, distributor_id, link_order)
      VALUES ('RET#89729','DIST#39381',1),('RET#89642','DIST#39381',1),('RET#89351','DIST#39381',2),('RET#88533','DIST#39381',2),('RET#88128','DIST#39381',1),('RET#87939','DIST#39381',2),('RET#86466','DIST#39381',2),('RET#85681','DIST#39381',2),('RET#85493','DIST#39381',2),('RET#85460','DIST#39381',1),('RET#84808','DIST#39381',1),('RET#84405','DIST#39381',1),('RET#84032','DIST#39381',1),('RET#80767','DIST#39381',1),('RET#80160','DIST#39381',1),('RET#79186','DIST#39381',1),('RET#78415','DIST#39381',2),('RET#78209','DIST#39381',2),('RET#78083','DIST#39381',2),('RET#77943','DIST#39381',1),('RET#77904','DIST#39381',1),('RET#77821','DIST#39381',1),('RET#73580','DIST#39381',3),('RET#72644','DIST#39381',2),('RET#72163','DIST#39381',1),('RET#69347','DIST#39381',1),('RET#68915','DIST#39381',1),('RET#68904','DIST#39381',2),('RET#68455','DIST#39381',1),('RET#67896','DIST#39381',1),('RET#67640','DIST#39381',2),('RET#64157','DIST#39381',1),('RET#63322','DIST#39381',1),('RET#63305','DIST#39381',1),('RET#63228','DIST#39381',1),('RET#62931','DIST#39381',1),('RET#62489','DIST#39381',1),('RET#61938','DIST#39381',1),('RET#61595','DIST#39381',1),('RET#61287','DIST#39381',1),('RET#61142','DIST#39381',1),('RET#61031','DIST#39381',1),('RET#60523','DIST#39381',1),('RET#60144','DIST#39381',2),('RET#59386','DIST#39381',1),('RET#59115','DIST#39381',1),('RET#59019','DIST#39381',1),('RET#58625','DIST#39381',1),('RET#54071','DIST#39381',2),('RET#53081','DIST#39381',1),('RET#49238','DIST#39381',1),('RET#48681','DIST#39381',1),('RET#48474','DIST#39381',1),('RET#43771','DIST#39381',2),('RET#43366','DIST#39381',3),('RET#41783','DIST#39381',2),('RET#39377','DIST#39381',1),('RET#38748','DIST#39381',2),('RET#37430','DIST#39381',2),('RET#36597','DIST#39381',2),('RET#30912','DIST#39381',2),('RET#34634','DIST#39381',2),('RET#34633','DIST#39381',2),('RET#33639','DIST#39381',2),('RET#33638','DIST#39381',3),('RET#31884','DIST#39381',2),('RET#31664','DIST#39381',2),('RET#31070','DIST#39381',1),('RET#31047','DIST#39381',1),('RET#30966','DIST#39381',1),('RET#30916','DIST#39381',2),('RET#30908','DIST#39381',1),('RET#30896','DIST#39381',1),('RET#30795','DIST#39381',1),('RET#30793','DIST#39381',1),('RET#27697','DIST#39381',1),('RET#25527','DIST#39381',1),('RET#24335','DIST#39381',1),('RET#24006','DIST#39381',1),('RET#23752','DIST#39381',1),('RET#23173','DIST#39381',1),('RET#23018','DIST#39381',1),('RET#22852','DIST#39381',1),('RET#22163','DIST#39381',2),('RET#22119','DIST#39381',2),('RET#20218','DIST#39381',1),('RET#20165','DIST#39381',1),('RET#20035','DIST#39381',2),('RET#19561','DIST#39381',1),('RET#19391','DIST#39381',3),('RET#18393','DIST#39381',2),('RET#15280','DIST#39381',1),('RET#15083','DIST#39381',1),('RET#15087','DIST#39381',1),('RET#14668','DIST#39381',1),('RET#14281','DIST#39381',1),('RET#13675','DIST#39381',2),('RET#13555','DIST#39381',2),('RET#13379','DIST#39381',1),('RET#13376','DIST#39381',2),('RET#13389','DIST#39381',1),('RET#13169','DIST#39381',1),('RET#12591','DIST#39381',1),('RET#12316','DIST#39381',1),('RET#11917','DIST#39381',1),('RET#11502','DIST#39381',1),('RET#10522','DIST#39381',1),('RET#10503','DIST#39381',1),('RET#10470','DIST#39381',1)
      ON CONFLICT (retailer_id, distributor_id, effective_from) DO NOTHING;
`,
  },

  // ── 033: customer_review_queue ─────────────────────────────────────────────
  {
    id: "033_customer_review_queue",
    sql: `
      CREATE TABLE IF NOT EXISTS customer_review_queue (
        id                    SERIAL PRIMARY KEY,
        name                  TEXT NOT NULL,
        type                  TEXT NOT NULL DEFAULT 'retailer'
                                CHECK (type IN ('retailer','distributor','direct_dealer',
                                                'sub_dealer','project','govt','other')),
        proposed_territory_id INT  REFERENCES territory(territory_id),
        proposed_person_id    INT  REFERENCES person(person_id),
        notes                 TEXT,
        submitted_by          TEXT NOT NULL DEFAULT 'unknown',
        submitted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        review_status         TEXT NOT NULL DEFAULT 'pending'
                                CHECK (review_status IN ('pending','approved','rejected')),
        reviewed_by           TEXT,
        reviewed_at           TIMESTAMPTZ,
        approved_customer_id  TEXT            -- set on approval (no FK; NEW# ids are generated)
      );
    `,
  },
  // ── 035: alert + alert_action tables ──────────────────────────────────────
  {
    id: "035_alert_tables",
    sql: `
      -- Persistence layer for the Red Alert detection engine.
      -- alert: one row per (fy, code, entityKey, analysisWindow) fingerprint.
      -- alert_action: audit trail of acknowledge actions.

      CREATE TABLE IF NOT EXISTS alert (
        id              SERIAL      PRIMARY KEY,
        fingerprint     TEXT        NOT NULL UNIQUE,
        fy              TEXT        NOT NULL,
        code            TEXT        NOT NULL,
        entity          TEXT        NOT NULL,
        entity_key      TEXT        NOT NULL,
        entity_type     TEXT        NOT NULL,
        period_label    TEXT        NOT NULL,
        status          TEXT        NOT NULL DEFAULT 'open'
          CHECK (status IN ('open','acknowledged','cleared')),
        periods_open    INTEGER     NOT NULL DEFAULT 1,
        rupees_at_stake NUMERIC     NOT NULL DEFAULT 0,
        detail          JSONB       NOT NULL DEFAULT '{}',
        guards_passed   JSONB       NOT NULL DEFAULT '[]',
        suppressed_by   INTEGER     REFERENCES alert(id),
        linked_alert_id INTEGER     REFERENCES alert(id),
        clear_reason    TEXT,
        first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS alert_fy_status_idx  ON alert (fy, status);
      CREATE INDEX IF NOT EXISTS alert_code_idx       ON alert (code);
      CREATE INDEX IF NOT EXISTS alert_entity_key_idx ON alert (entity_key);
      CREATE INDEX IF NOT EXISTS alert_linked_idx     ON alert (linked_alert_id)
        WHERE linked_alert_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS alert_action (
        id         SERIAL      PRIMARY KEY,
        alert_id   INTEGER     NOT NULL REFERENCES alert(id) ON DELETE CASCADE,
        action     TEXT        NOT NULL,
        by_person  TEXT        NOT NULL DEFAULT '',
        at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        note       TEXT
      );
      CREATE INDEX IF NOT EXISTS alert_action_alert_id_idx ON alert_action (alert_id);
      CREATE INDEX IF NOT EXISTS alert_action_at_idx       ON alert_action (at DESC);
    `,
  },
  {
    id: "034_populate_person_registry_state_head",
    sql: `
      -- Populate person_registry.state_head from the Phase 1 person table.
      --
      -- The person table (migration 030) stores state_head_person_id as a FK to
      -- the person who is the state head for each territory member.  person_registry
      -- was built from the HR roster which only knows the direct reporting manager,
      -- not necessarily the state head — so many rows have state_head = NULL.
      -- 549k secondary_sku_line rows resolve a head but cannot roll up to a territory
      -- because the corresponding person_registry.state_head is NULL.
      --
      -- Step 1: Propagate state_head from person → person_registry via name match.
      -- Idempotent: only touches rows where state_head IS NULL.
      UPDATE person_registry pr
      SET
        state_head = sh.name,
        updated_at = now()
      FROM person p
      JOIN person sh ON sh.person_id = p.state_head_person_id
      WHERE LOWER(TRIM(p.name)) = LOWER(TRIM(pr.canonical_name))
        AND p.state_head_person_id IS NOT NULL
        AND pr.state_head IS NULL;

      -- Step 2: State heads themselves — ensure their own state_head field is set
      -- to their canonical name (they are their own territory head).
      UPDATE person_registry pr
      SET
        state_head = pr.canonical_name,
        updated_at = now()
      WHERE pr.is_state_head = TRUE
        AND pr.state_head IS NULL;

      -- Step 3: Backfill secondary_sku_line.state_canon from person_registry.
      --
      -- head_canon is produced by skuLoader's headNormKey():
      --   headNormKey(x) = x.toLowerCase().replace(/\s+/g, " ").trim()
      -- In SQL: REGEXP_REPLACE(LOWER(TRIM(x)), '\s+', ' ', 'g')
      --
      -- Join strategy (two paths, priority-ordered):
      --   Path A — exact norm_key match: works for employee-code norm_keys.
      --   Path B — normalised display name: alias_secondary holds the secondary-register
      --            display spelling (the TEAM MEMBER column value); canonical_name is the
      --            fallback when alias_secondary is absent.
      --
      -- Only unambiguous matches: a head_canon must resolve to exactly one state_head
      -- across all registry entries (both paths). HAVING COUNT(DISTINCT) = 1 rejects
      -- any head_canon where two or more registry rows disagree — those names are left
      -- NULL and reported in the residual warning.  MIN() is deterministic when the
      -- distinct count is 1 (all values are identical).
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
          MIN(rm.state_head) AS state_head   -- safe: MIN when COUNT(DISTINCT) = 1
        FROM secondary_sku_line ssl
        JOIN registry_norm rm
          ON ssl.head_canon = rm.norm_key          -- Path A: exact registry key
          OR ssl.head_canon = rm.display_key       -- Path B: normalised display/alias name
        WHERE ssl.state_canon IS NULL
          AND ssl.head_canon IS NOT NULL
        GROUP BY ssl.head_canon
        HAVING COUNT(DISTINCT rm.state_head) = 1   -- reject ambiguous head names
      )
      UPDATE secondary_sku_line ssl
      SET state_canon = hm.state_head
      FROM head_match hm
      WHERE ssl.head_canon = hm.head_canon
        AND ssl.state_canon IS NULL;
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

interface Migration {
  id: string;
  sql: string;
}
