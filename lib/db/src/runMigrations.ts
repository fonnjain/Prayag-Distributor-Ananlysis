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
      -- Guard: only SET mapped_to_id when the customer actually exists in this DB
      -- (production may not have this distributor if master loads haven't run yet)
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
      )
        AND EXISTS (SELECT 1 FROM customer WHERE customer_id = 'DIST#9236');

      -- Delete the dangling second-half row (idempotent)
      DELETE FROM seed_unresolved_link WHERE raw_name = 'Deoghar)';

      -- Mark Prayag Sale resolved (truncated name → DIST#39381)
      UPDATE seed_unresolved_link
      SET notes        = 'Truncated at 25 chars in xlsx; full name is Prayag Sale Corporation NE',
          resolution   = 'mapped',
          mapped_to_id = 'DIST#39381',
          resolved_by  = 'system',
          resolved_at  = NOW()
      WHERE raw_name = 'Prayag Sale Corporation Ne'
        AND EXISTS (SELECT 1 FROM customer WHERE customer_id = 'DIST#39381');

      -- Recover 174 Chhinamastike links (idempotent via SELECT-based INSERT;
      -- skipped entirely when DIST#9236 has not been loaded into customer yet)
      INSERT INTO customer_link (retailer_id, distributor_id, link_order)
      SELECT r, d, o FROM (VALUES ('RET#89709','DIST#9236',1),('RET#89709','DIST#9236',2),('RET#89461','DIST#9236',1),('RET#89461','DIST#9236',2),('RET#89118','DIST#9236',1),('RET#89118','DIST#9236',2),('RET#87843','DIST#9236',1),('RET#87843','DIST#9236',2),('RET#87583','DIST#9236',1),('RET#87583','DIST#9236',2),('RET#87412','DIST#9236',1),('RET#87412','DIST#9236',2),('RET#83681','DIST#9236',1),('RET#83681','DIST#9236',2),('RET#81878','DIST#9236',1),('RET#81878','DIST#9236',2),('RET#80815','DIST#9236',1),('RET#80815','DIST#9236',2),('RET#79086','DIST#9236',1),('RET#79086','DIST#9236',2),('RET#79083','DIST#9236',1),('RET#79083','DIST#9236',2),('RET#73411','DIST#9236',1),('RET#73411','DIST#9236',2),('RET#73161','DIST#9236',1),('RET#73161','DIST#9236',2),('RET#72971','DIST#9236',1),('RET#72971','DIST#9236',2),('RET#72530','DIST#9236',1),('RET#72530','DIST#9236',2),('RET#68963','DIST#9236',1),('RET#68963','DIST#9236',2),('RET#68397','DIST#9236',1),('RET#68397','DIST#9236',2),('RET#68131','DIST#9236',1),('RET#68131','DIST#9236',2),('RET#66491','DIST#9236',1),('RET#66491','DIST#9236',2),('RET#62856','DIST#9236',1),('RET#62856','DIST#9236',2),('RET#59454','DIST#9236',1),('RET#59454','DIST#9236',2),('RET#59431','DIST#9236',1),('RET#59431','DIST#9236',2),('RET#58393','DIST#9236',1),('RET#58393','DIST#9236',2),('RET#58057','DIST#9236',1),('RET#58057','DIST#9236',2),('RET#57105','DIST#9236',1),('RET#57105','DIST#9236',2),('RET#57087','DIST#9236',1),('RET#57087','DIST#9236',2),('RET#56851','DIST#9236',1),('RET#56851','DIST#9236',2),('RET#56800','DIST#9236',1),('RET#56800','DIST#9236',2),('RET#56653','DIST#9236',1),('RET#56653','DIST#9236',2),('RET#54550','DIST#9236',1),('RET#54550','DIST#9236',2),('RET#54539','DIST#9236',1),('RET#54539','DIST#9236',2),('RET#52568','DIST#9236',1),('RET#52568','DIST#9236',2),('RET#52551','DIST#9236',1),('RET#52551','DIST#9236',2),('RET#49466','DIST#9236',1),('RET#49466','DIST#9236',2),('RET#48759','DIST#9236',1),('RET#48759','DIST#9236',2),('RET#46473','DIST#9236',1),('RET#46473','DIST#9236',2),('RET#43876','DIST#9236',1),('RET#43876','DIST#9236',2),('RET#42873','DIST#9236',1),('RET#42873','DIST#9236',2),('RET#41826','DIST#9236',1),('RET#41826','DIST#9236',2),('RET#41334','DIST#9236',1),('RET#41334','DIST#9236',2),('RET#38396','DIST#9236',1),('RET#38396','DIST#9236',2),('RET#38322','DIST#9236',1),('RET#38322','DIST#9236',2),('RET#33084','DIST#9236',1),('RET#33084','DIST#9236',2),('RET#32052','DIST#9236',1),('RET#32052','DIST#9236',2),('RET#30372','DIST#9236',1),('RET#30372','DIST#9236',2),('RET#30319','DIST#9236',1),('RET#30319','DIST#9236',2),('RET#30072','DIST#9236',1),('RET#30072','DIST#9236',2),('RET#29973','DIST#9236',1),('RET#29973','DIST#9236',2),('RET#29401','DIST#9236',1),('RET#29401','DIST#9236',2),('RET#28266','DIST#9236',1),('RET#28266','DIST#9236',2),('RET#27894','DIST#9236',1),('RET#27894','DIST#9236',2),('RET#27789','DIST#9236',1),('RET#27789','DIST#9236',2),('RET#25309','DIST#9236',1),('RET#25309','DIST#9236',2),('RET#24265','DIST#9236',1),('RET#24265','DIST#9236',2),('RET#24263','DIST#9236',1),('RET#24263','DIST#9236',2),('RET#23023','DIST#9236',1),('RET#23023','DIST#9236',2),('RET#22879','DIST#9236',2),('RET#22879','DIST#9236',3),('RET#20763','DIST#9236',2),('RET#20763','DIST#9236',3),('RET#20719','DIST#9236',1),('RET#20719','DIST#9236',2),('RET#20719','DIST#9236',3),('RET#20719','DIST#9236',4),('RET#20442','DIST#9236',1),('RET#20442','DIST#9236',2),('RET#19803','DIST#9236',2),('RET#19803','DIST#9236',3),('RET#19604','DIST#9236',1),('RET#19604','DIST#9236',2),('RET#19402','DIST#9236',2),('RET#19402','DIST#9236',3),('RET#19399','DIST#9236',2),('RET#19399','DIST#9236',3),('RET#19396','DIST#9236',2),('RET#19396','DIST#9236',3),('RET#19353','DIST#9236',2),('RET#19353','DIST#9236',3),('RET#19022','DIST#9236',1),('RET#19022','DIST#9236',2),('RET#18666','DIST#9236',1),('RET#18666','DIST#9236',2),('RET#15442','DIST#9236',1),('RET#15442','DIST#9236',2),('RET#15443','DIST#9236',1),('RET#15443','DIST#9236',2),('RET#15444','DIST#9236',1),('RET#15444','DIST#9236',2),('RET#15447','DIST#9236',1),('RET#15447','DIST#9236',2),('RET#15460','DIST#9236',1),('RET#15460','DIST#9236',2),('RET#15461','DIST#9236',1),('RET#15461','DIST#9236',2),('RET#15462','DIST#9236',1),('RET#15462','DIST#9236',2),('RET#15466','DIST#9236',1),('RET#15466','DIST#9236',2),('RET#15467','DIST#9236',1),('RET#15467','DIST#9236',2),('RET#15468','DIST#9236',1),('RET#15468','DIST#9236',2),('RET#10618','DIST#9236',2),('RET#10618','DIST#9236',3),('RET#10155','DIST#9236',1),('RET#10155','DIST#9236',2),('RET#10144','DIST#9236',2),('RET#10144','DIST#9236',3),('RET#10142','DIST#9236',1),('RET#10142','DIST#9236',2),('RET#10135','DIST#9236',2),('RET#10135','DIST#9236',3),('RET#10138','DIST#9236',2),('RET#10138','DIST#9236',3),('RET#10027','DIST#9236',2),('RET#10027','DIST#9236',3),('RET#9870','DIST#9236',2),('RET#9870','DIST#9236',3)) AS t(r,d,o)
      WHERE EXISTS (SELECT 1 FROM customer WHERE customer_id = 'DIST#9236')
      ON CONFLICT (retailer_id, distributor_id, effective_from) DO NOTHING;

      -- Recover 109 Prayag Sale Corporation NE links (idempotent via SELECT-based INSERT;
      -- skipped entirely when DIST#39381 has not been loaded into customer yet)
      INSERT INTO customer_link (retailer_id, distributor_id, link_order)
      SELECT r, d, o FROM (VALUES ('RET#89729','DIST#39381',1),('RET#89642','DIST#39381',1),('RET#89351','DIST#39381',2),('RET#88533','DIST#39381',2),('RET#88128','DIST#39381',1),('RET#87939','DIST#39381',2),('RET#86466','DIST#39381',2),('RET#85681','DIST#39381',2),('RET#85493','DIST#39381',2),('RET#85460','DIST#39381',1),('RET#84808','DIST#39381',1),('RET#84405','DIST#39381',1),('RET#84032','DIST#39381',1),('RET#80767','DIST#39381',1),('RET#80160','DIST#39381',1),('RET#79186','DIST#39381',1),('RET#78415','DIST#39381',2),('RET#78209','DIST#39381',2),('RET#78083','DIST#39381',2),('RET#77943','DIST#39381',1),('RET#77904','DIST#39381',1),('RET#77821','DIST#39381',1),('RET#73580','DIST#39381',3),('RET#72644','DIST#39381',2),('RET#72163','DIST#39381',1),('RET#69347','DIST#39381',1),('RET#68915','DIST#39381',1),('RET#68904','DIST#39381',2),('RET#68455','DIST#39381',1),('RET#67896','DIST#39381',1),('RET#67640','DIST#39381',2),('RET#64157','DIST#39381',1),('RET#63322','DIST#39381',1),('RET#63305','DIST#39381',1),('RET#63228','DIST#39381',1),('RET#62931','DIST#39381',1),('RET#62489','DIST#39381',1),('RET#61938','DIST#39381',1),('RET#61595','DIST#39381',1),('RET#61287','DIST#39381',1),('RET#61142','DIST#39381',1),('RET#61031','DIST#39381',1),('RET#60523','DIST#39381',1),('RET#60144','DIST#39381',2),('RET#59386','DIST#39381',1),('RET#59115','DIST#39381',1),('RET#59019','DIST#39381',1),('RET#58625','DIST#39381',1),('RET#54071','DIST#39381',2),('RET#53081','DIST#39381',1),('RET#49238','DIST#39381',1),('RET#48681','DIST#39381',1),('RET#48474','DIST#39381',1),('RET#43771','DIST#39381',2),('RET#43366','DIST#39381',3),('RET#41783','DIST#39381',2),('RET#39377','DIST#39381',1),('RET#38748','DIST#39381',2),('RET#37430','DIST#39381',2),('RET#36597','DIST#39381',2),('RET#30912','DIST#39381',2),('RET#34634','DIST#39381',2),('RET#34633','DIST#39381',2),('RET#33639','DIST#39381',2),('RET#33638','DIST#39381',3),('RET#31884','DIST#39381',2),('RET#31664','DIST#39381',2),('RET#31070','DIST#39381',1),('RET#31047','DIST#39381',1),('RET#30966','DIST#39381',1),('RET#30916','DIST#39381',2),('RET#30908','DIST#39381',1),('RET#30896','DIST#39381',1),('RET#30795','DIST#39381',1),('RET#30793','DIST#39381',1),('RET#27697','DIST#39381',1),('RET#25527','DIST#39381',1),('RET#24335','DIST#39381',1),('RET#24006','DIST#39381',1),('RET#23752','DIST#39381',1),('RET#23173','DIST#39381',1),('RET#23018','DIST#39381',1),('RET#22852','DIST#39381',1),('RET#22163','DIST#39381',2),('RET#22119','DIST#39381',2),('RET#20218','DIST#39381',1),('RET#20165','DIST#39381',1),('RET#20035','DIST#39381',2),('RET#19561','DIST#39381',1),('RET#19391','DIST#39381',3),('RET#18393','DIST#39381',2),('RET#15280','DIST#39381',1),('RET#15083','DIST#39381',1),('RET#15087','DIST#39381',1),('RET#14668','DIST#39381',1),('RET#14281','DIST#39381',1),('RET#13675','DIST#39381',2),('RET#13555','DIST#39381',2),('RET#13379','DIST#39381',1),('RET#13376','DIST#39381',2),('RET#13389','DIST#39381',1),('RET#13169','DIST#39381',1),('RET#12591','DIST#39381',1),('RET#12316','DIST#39381',1),('RET#11917','DIST#39381',1),('RET#11502','DIST#39381',1),('RET#10522','DIST#39381',1),('RET#10503','DIST#39381',1),('RET#10470','DIST#39381',1)) AS t(r,d,o)
      WHERE EXISTS (SELECT 1 FROM customer WHERE customer_id = 'DIST#39381')
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
  {
    id: "036_alert_routing",
    sql: `
      -- Recipients of alert notifications.  alert_code_pattern is a glob:
      --   'A*' | 'B*' | 'C*' | 'S*' | 'B3' | '*'
      -- scope_value is the state head's canonical_name for state_head scope,
      -- NULL for 'all'.
      CREATE TABLE IF NOT EXISTS alert_recipient (
        id                   SERIAL       PRIMARY KEY,
        alert_code_pattern   TEXT         NOT NULL,
        scope_type           TEXT         NOT NULL DEFAULT 'all',
        scope_value          TEXT,
        escalation_level     INTEGER      NOT NULL DEFAULT 1,
        name                 TEXT         NOT NULL,
        channel              TEXT         NOT NULL,
        contact              TEXT,
        cadence              TEXT         NOT NULL DEFAULT 'weekly',
        is_active            BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );

      -- One row per alert-recipient delivery attempt.
      -- trigger_type: 'on_raise' | 'weekly_digest' | 'escalation'
      -- status:       'pending'  | 'sent'           | 'failed' | 'skipped'
      CREATE TABLE IF NOT EXISTS alert_delivery (
        id                SERIAL       PRIMARY KEY,
        alert_id          INTEGER      NOT NULL REFERENCES alert(id),
        recipient_id      INTEGER      NOT NULL REFERENCES alert_recipient(id),
        channel           TEXT         NOT NULL,
        escalation_level  INTEGER      NOT NULL,
        trigger_type      TEXT         NOT NULL DEFAULT 'on_raise',
        sent_at           TIMESTAMPTZ,
        delivered_at      TIMESTAMPTZ,
        opened_at         TIMESTAMPTZ,
        acknowledged_at   TIMESTAMPTZ,
        status            TEXT         NOT NULL DEFAULT 'pending',
        skip_reason       TEXT,
        message_body      TEXT,
        created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );

      -- Configurable severity per code pattern.
      -- is_severe=true → on_raise cadence fires immediately.
      -- escalation_window_days → how long before level 2 gets notified.
      CREATE TABLE IF NOT EXISTS alert_severity_config (
        id                      SERIAL       PRIMARY KEY,
        code_pattern            TEXT         NOT NULL UNIQUE,
        is_severe               BOOLEAN      NOT NULL DEFAULT FALSE,
        escalation_window_days  INTEGER      NOT NULL DEFAULT 14,
        updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );

      INSERT INTO alert_severity_config (code_pattern, is_severe, escalation_window_days)
      VALUES
        ('S*', TRUE,  7),
        ('C*', TRUE,  7),
        ('B3', TRUE,  7),
        ('A*', FALSE, 14),
        ('B*', FALSE, 14),
        ('*',  FALSE, 14)
      ON CONFLICT (code_pattern) DO NOTHING;

      CREATE INDEX IF NOT EXISTS idx_alert_delivery_alert_id
        ON alert_delivery(alert_id);
      CREATE INDEX IF NOT EXISTS idx_alert_delivery_recipient_id
        ON alert_delivery(recipient_id);
      CREATE INDEX IF NOT EXISTS idx_alert_delivery_status
        ON alert_delivery(status);
      CREATE INDEX IF NOT EXISTS idx_alert_delivery_trigger
        ON alert_delivery(trigger_type, created_at);
    `,
  },
  {
    id: "037_alert_routing_v2",
    sql: `
      -- 1. Allow recipient_id to be NULL so we can record level-skip rows
      --    (e.g. L2 skipped because no recipient is configured at that level).
      ALTER TABLE alert_delivery ALTER COLUMN recipient_id DROP NOT NULL;

      -- 2. Rename scope_type 'all' → 'all_india' for clarity.
      UPDATE alert_recipient SET scope_type = 'all_india' WHERE scope_type = 'all';

      -- 3. Escalation-config: window in days per level, with separate
      --    severe-vs-digest tracks for level 1.
      --      L1 → L2:  7 days for severe alerts, 14 days for digest alerts
      --      L2 → L3:  7 days regardless of severity
      CREATE TABLE IF NOT EXISTS alert_escalation_config (
        level                INTEGER      PRIMARY KEY CHECK (level IN (1, 2)),
        window_days_severe   INTEGER      NOT NULL DEFAULT 7,
        window_days_digest   INTEGER      NOT NULL DEFAULT 14,
        updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      INSERT INTO alert_escalation_config (level, window_days_severe, window_days_digest)
      VALUES (1, 7, 14), (2, 7, 7)
      ON CONFLICT (level) DO NOTHING;

      -- 4. Seed real Level-1 recipients (12 State Heads + Deepak J all-India).
      --    Sunil Mohanty has no HR record; seeded with NULL contact so the row
      --    exists and can be completed in the UI later.
      INSERT INTO alert_recipient
        (name, escalation_level, scope_type, scope_value,
         alert_code_pattern, channel, contact, cadence)
      VALUES
        -- State Heads (scope = their own territory)
        ('Sandeep Dadheech',      1, 'state_head', 'Sandeep Dadheech',      '*', 'whatsapp', '9331103319', 'on_raise'),
        ('Aqil Rizvi',            1, 'state_head', 'Aqil Rizvi',            '*', 'whatsapp', '9305083814', 'on_raise'),
        ('Biju C.O',              1, 'state_head', 'Biju C.O',              '*', 'whatsapp', '9633200526', 'on_raise'),
        ('Pawan Kumar Sharma',    1, 'state_head', 'Pawan Kumar Sharma',    '*', 'whatsapp', '9958040072', 'on_raise'),
        ('Sulinder Pal',          1, 'state_head', 'Sulinder Pal',          '*', 'whatsapp', '9816258614', 'on_raise'),
        ('Anant Singh',           1, 'state_head', 'Anant Singh',           '*', 'whatsapp', '7838915612', 'on_raise'),
        ('Nasir Hussain Khan',    1, 'state_head', 'Nasir Hussain Khan',    '*', 'whatsapp', '9958065454', 'on_raise'),
        ('Sunil Patel',           1, 'state_head', 'Sunil Patel',           '*', 'whatsapp', '9408709411', 'on_raise'),
        ('Lalan Kumar',           1, 'state_head', 'Lalan Kumar',           '*', 'whatsapp', '9579398634', 'on_raise'),
        ('Anuj Sharma',           1, 'state_head', 'Anuj Sharma',           '*', 'whatsapp', '8796339586', 'on_raise'),
        ('Narendra Kumar Sharma', 1, 'state_head', 'Narendra Kumar Sharma', '*', 'whatsapp', '9828146028', 'on_raise'),
        ('Sunil Mohanty',         1, 'state_head', 'Sunil Mohanty',         '*', 'whatsapp', NULL,         'on_raise'),
        -- All-India Level 1
        ('Deepak J',              1, 'all_india', NULL, '*', 'whatsapp', '9910896007', 'on_raise'),
        -- Level 3 (CEO) — Level 2 is intentionally left blank
        ('Nitin Agarwal',         3, 'all_india', NULL, '*', 'email',    'ceo@prayagindia.com', 'on_raise')
      ON CONFLICT DO NOTHING;
    `,
  },
  {
    id: "037_person_registry_state_head_source",
    sql: `
      -- Adds state_head_source to record HOW each state_head value was derived.
      -- Values: self | reports_to_chain | crm_roster | unresolved
      -- The populate-state-head-chain script fills this column via the chain walk.
      ALTER TABLE person_registry ADD COLUMN IF NOT EXISTS state_head_source TEXT;
    `,
  },
  {
    id: "038_narendra_kumar_sharma_alias",
    sql: `
      -- Adds "NARENDRA KUMAR SHARMA" as an alias for id=19 (canonical: "Narendra Sharma")
      -- so the person_registry join stops flagging this name as unresolved.
      -- The alert routing system and person table both reference the full name.
      UPDATE person_registry
        SET alias_primary = array_append(alias_primary, 'NARENDRA KUMAR SHARMA')
      WHERE id = 19
        AND NOT ('NARENDRA KUMAR SHARMA' = ANY(COALESCE(alias_primary, '{}')));
    `,
  },
  {
    // Add former_person_name_raw to customer_assignment so the seed import can
    // persist the salesperson name even when it could not be resolved to a
    // person_id. Used by Rule 0 of the suggested-assignment engine.
    id: "042_customer_assignment_former_person",
    sql: `
      ALTER TABLE customer_assignment
        ADD COLUMN IF NOT EXISTS former_person_name_raw TEXT;
    `,
  },
  {
    id: "041_alert_scheduler",
    sql: `
      -- Persistent state for the weekly digest scheduler.
      -- Stores last_digest_at so the dedup guard survives server restarts.
      CREATE TABLE IF NOT EXISTS alert_scheduler (
        id             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        last_digest_at TIMESTAMPTZ,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO alert_scheduler (id)
        VALUES (1)
        ON CONFLICT (id) DO NOTHING;
    `,
  },
  {
    id: "040_margin_load_job",
    sql: `
      -- Persistent singleton row for the GP Margin load state.
      -- Survives server restarts; the route reads/writes this row so users can
      -- see whether a previous load was killed mid-flight and why.
      CREATE TABLE IF NOT EXISTS margin_load_job (
        id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        status      TEXT NOT NULL DEFAULT 'idle',
        started_at  TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        segments    TEXT[],
        error_msg   TEXT,
        report      JSONB,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO margin_load_job (id, status)
        VALUES (1, 'idle')
        ON CONFLICT (id) DO NOTHING;
    `,
  },
  {
    // person_id FK formalises person as the authoritative master.
    // Step 1: add nullable FK column + index.
    // Step 2: populate via case-insensitive name match (covers 177 of 179 active members).
    // Step 3: populate the 2 whose registry canonical_name has a punctuation difference
    //         (K. Suresh Kumar → person 89; S. Tirumala Rao → person 106) via employee-code.
    // Step 4: set is_person=false for the 74 geographic/product-category noise rows whose
    //         canonical_name is a state, territory, or district name (e.g. ANDHRA PRADESH,
    //         East U.P). These were seeded from HR-roster rows where a geography column was
    //         parsed as a person name. Verified 0 matching rows in sale_line or
    //         secondary_sku_line before flipping. is_state_head=false for all 74.
    id: "043_person_registry_person_fk",
    sql: `
      -- Step 1: FK column + index
      ALTER TABLE person_registry
        ADD COLUMN IF NOT EXISTS person_id INTEGER REFERENCES person(person_id);
      CREATE INDEX IF NOT EXISTS pr_person_id_idx ON person_registry(person_id);

      -- Step 2: name match (handles 177 active members)
      -- normSecKey-equivalent normalisation: lowercase alphanumerics only
      -- (LOWER(REGEXP_REPLACE(x, '[^a-z0-9]', '', 'gi'))). The original
      -- space-collapse-only form missed dotted spellings like
      -- "K. Suresh Kumar" vs "K Suresh Kumar" (rescued only by the
      -- employee-code fallback in step 3 / migration 044).
      -- Employee-code conflict guard: when BOTH sides carry a code and the
      -- codes differ, the rows are different people whose names happen to
      -- collide after stripping (e.g. "Pawan Kumar." code 1229 vs
      -- "PAWAN KUMAR" code 761) — never merge them on name alone.
      UPDATE person_registry pr
      SET person_id = p.person_id
      FROM person p
      WHERE LOWER(REGEXP_REPLACE(pr.canonical_name, '[^a-z0-9]', '', 'gi'))
          = LOWER(REGEXP_REPLACE(p.name,            '[^a-z0-9]', '', 'gi'))
        AND pr.person_id IS NULL
        AND pr.is_person = true
        AND (pr.employee_code IS NULL OR TRIM(pr.employee_code) = ''
             OR p.employee_code IS NULL OR TRIM(p.employee_code) = ''
             OR TRIM(pr.employee_code) = TRIM(p.employee_code));

       -- Step 3: employee-code match for punctuation-different spellings.
       -- A code is usable only when it belongs to exactly one person.
      --   K. Suresh Kumar (reg 134) → person 89  (code 25696++21111)
      --   S. Tirumala Rao (reg 253) → person 106 (code 3418596)
       WITH unique_person_codes AS (
         SELECT TRIM(employee_code) AS employee_code, MIN(person_id) AS person_id
         FROM person
         WHERE NULLIF(TRIM(employee_code), '') IS NOT NULL
         GROUP BY TRIM(employee_code)
         HAVING COUNT(*) = 1
       )
       UPDATE person_registry pr
      SET person_id = p.person_id
       FROM unique_person_codes p
      WHERE pr.id IN (134, 253)
         AND TRIM(pr.employee_code) = p.employee_code
        AND pr.person_id IS NULL;

      -- Step 4: demote 74 geographic/product-category noise rows
      UPDATE person_registry
      SET is_person = false
      WHERE id IN (
        432,433,437,439,443,445,448,452,458,460,462,465,466,467,471,
        472,475,479,480,482,485,486,491,492,493,496,501,502,505,508,
        510,513,514,517,523,527,528,532,537,539,542,543,552,560,563,
        566,568,570,572,574,579,581,588,590,594,617,624,630,636,648,
        676,681,686,689,700,715,717,719,725,727,730,735,847,855
      );
    `,
  },
  {
    // Patch the employee-code FK population from migration 043.
    // Migration 043 restricted the employee-code match to ids IN (134, 253)
    // to cover K. Suresh Kumar and S. Tirumala Rao. Three more registry rows
    // were missed because their canonical_names differ only in case or period
    // spacing from the person row:
    //   reg 122  J. Kamal Kishore    ↔ person 105  J.Kamal Kishore    (emp 849)
    //   reg 123  J. Suresh Kumar     ↔ person  88  J.SURESH KUMAR     (emp 737)
    //   reg 136  K.V. Thamizhselvan  ↔ person  66  K.V.THAMIZHSELVAN  (emp 601)
    //
    // Also fixes J.Kamal Kishore's reports_to_person_id: his direct manager
    // (Suresh Kumar Nair) is departed and not in person, but the chain walk
    // through the registry reaches Sandeep Dadheech (person_id=2). Per the
    // Phase 1 chain-walk rule: do not leave reports_to NULL if a head is
    // reachable. K.V.THAMIZHSELVAN correctly stays NULL — Mahendra Kumar Jain
    // has no chain above in the registry.
    id: "044_person_registry_person_fk_patch",
    sql: `
       -- Broaden the employee-code match only where a code identifies exactly
       -- one person. Shared codes must remain unresolved for review.
       WITH unique_person_codes AS (
         SELECT TRIM(employee_code) AS employee_code, MIN(person_id) AS person_id
         FROM person
         WHERE NULLIF(TRIM(employee_code), '') IS NOT NULL
         GROUP BY TRIM(employee_code)
         HAVING COUNT(*) = 1
       )
       UPDATE person_registry pr
      SET person_id = p.person_id
       FROM unique_person_codes p
       WHERE TRIM(pr.employee_code) = p.employee_code
        AND pr.person_id IS NULL;

      -- Chain-walk fix: J.Kamal Kishore's direct manager (Suresh Kumar Nair)
      -- is departed; walk through to Sandeep Dadheech (person_id=2).
      UPDATE person
      SET reports_to_person_id = 2
      WHERE person_id = 105
        AND reports_to_person_id IS NULL;
    `,
  },
  {
    // Re-run the person_registry.person_id population with the corrected
    // normSecKey-equivalent normalisation (migration 043 step 2 originally
    // used space-collapse only, which missed dotted spellings like
    // "K. Suresh Kumar" vs "K Suresh Kumar"). On DBs already patched by
    // 043/044 this is a no-op for rows the employee-code fallback rescued;
    // it exists so already-seeded DBs (e.g. production) pick up any
    // punctuation-variant name matches the old normalisation missed.
    //
    // Employee-code conflict guard: when BOTH sides carry a non-blank code
    // and the codes differ, the rows are different people whose names
    // collide after stripping (verified in dev: "Pawan Kumar." code 1229 vs
    // person "PAWAN KUMAR" code 761; "Manish Gupta." code 822 vs person
    // "Manish Gupta" code 1171) — those must never merge on name alone.
    // Idempotent: only fills person_id IS NULL rows.
    id: "045_person_registry_person_fk_norm_fix",
    sql: `
      UPDATE person_registry pr
      SET person_id = p.person_id
      FROM person p
      WHERE LOWER(REGEXP_REPLACE(pr.canonical_name, '[^a-z0-9]', '', 'gi'))
          = LOWER(REGEXP_REPLACE(p.name,            '[^a-z0-9]', '', 'gi'))
        AND pr.person_id IS NULL
        AND pr.is_person = true
        AND (pr.employee_code IS NULL OR TRIM(pr.employee_code) = ''
             OR p.employee_code IS NULL OR TRIM(p.employee_code) = ''
             OR TRIM(pr.employee_code) = TRIM(p.employee_code));
    `,
  },
  {
    id: "039_alert_routing_on_raise",
    sql: `
      -- State head recipients: weekly digest only (per-territory alerts; immediate fire is noise).
      UPDATE alert_recipient SET cadence = 'weekly' WHERE scope_type = 'state_head';

      -- All-India existing '*' rows: weekly (these handle the digest for all categories).
      UPDATE alert_recipient SET cadence = 'weekly' WHERE scope_type = 'all_india';

      -- Add immediate on_raise rows for S-category and C-category alerts to all-India
      -- recipients. These are level-1 rows so notifyAlert(triggerType='on_raise') fires them.
      -- Deepak J (L1) — S* and C* immediate
      INSERT INTO alert_recipient
        (alert_code_pattern, scope_type, name, channel, contact, cadence, escalation_level)
      VALUES
        ('S*', 'all_india', 'Deepak J',      'whatsapp', '9910896007',         'on_raise', 1),
        ('C*', 'all_india', 'Deepak J',      'whatsapp', '9910896007',         'on_raise', 1),
        ('S*', 'all_india', 'Nitin Agarwal', 'email',    'ceo@prayagindia.com', 'on_raise', 1),
        ('C*', 'all_india', 'Nitin Agarwal', 'email',    'ceo@prayagindia.com', 'on_raise', 1);
    `,
  },
  {
    id: "046_person_departure",
    sql: `
      -- ── State-head departure lifecycle ──────────────────────────────────────
      -- left_date/departure_reason record WHY a head left; is_holding marks the
      -- auto-created system person that holds a departed head's customers until
      -- a replacement is appointed. holding_for_person_id links the holding
      -- person back to the departed head.
      ALTER TABLE person ADD COLUMN IF NOT EXISTS left_date DATE;
      ALTER TABLE person ADD COLUMN IF NOT EXISTS departure_reason TEXT;
      ALTER TABLE person ADD COLUMN IF NOT EXISTS departure_note TEXT;
      ALTER TABLE person ADD COLUMN IF NOT EXISTS is_holding BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE person ADD COLUMN IF NOT EXISTS holding_for_person_id INTEGER REFERENCES person(person_id);
      CREATE INDEX IF NOT EXISTS idx_person_is_holding   ON person (is_holding) WHERE is_holding;
      CREATE INDEX IF NOT EXISTS idx_person_holding_for  ON person (holding_for_person_id) WHERE holding_for_person_id IS NOT NULL;
    `,
  },
  {
    id: "047_person_holding_unique",
    sql: `
      -- At most ONE holding person per departed head — enforced in the DB so
      -- concurrent departure requests cannot create duplicates.
      CREATE UNIQUE INDEX IF NOT EXISTS uq_person_holding_for
        ON person (holding_for_person_id) WHERE is_holding;
    `,
  },
  {
    id: "048_customer_assignment_one_open",
    sql: `
      -- Invariant: at most ONE open (effective_to IS NULL) assignment per
      -- customer. Enforced in the DB so concurrent departure/resolve/reassign
      -- transactions can never leave a customer with two competing owners.
      CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_assignment_open
        ON customer_assignment (customer_id) WHERE effective_to IS NULL;
    `,
  },
  {
    id: "049_person_source_departed_import",
    sql: `
      -- Extend the source allowlist to accommodate historical departed TM
      -- records imported from former_person_name_raw in customer_assignment.
      -- These are inactive persons — historical identity only, no assignments.
      ALTER TABLE person DROP CONSTRAINT IF EXISTS person_source_check;
      ALTER TABLE person ADD CONSTRAINT person_source_check
        CHECK (source = ANY (ARRAY['hr_sheet','app_created','departed_import']));
    `,
  },
  {
    id: "050_market_survey_richer_capture",
    sql: `
      -- Richer capture fields for market survey lines.
      -- All nullable — existing rows keep NULL and render as "not recorded".
      ALTER TABLE market_survey
        ADD COLUMN IF NOT EXISTS credit_days_competitor     integer,
        ADD COLUMN IF NOT EXISTS credit_given_by            text,
        ADD COLUMN IF NOT EXISTS credit_days_prayag         integer,
        ADD COLUMN IF NOT EXISTS competitor_scheme_type     text,
        ADD COLUMN IF NOT EXISTS competitor_scheme_value    text,
        ADD COLUMN IF NOT EXISTS delivery_days_competitor   integer,
        ADD COLUMN IF NOT EXISTS delivery_days_prayag       integer,
        ADD COLUMN IF NOT EXISTS shelf_share                text,
        ADD COLUMN IF NOT EXISTS payment_terms_note         text,
        ADD COLUMN IF NOT EXISTS competitor_visit_frequency text,
        ADD COLUMN IF NOT EXISTS competitor_moq             text,
        ADD COLUMN IF NOT EXISTS buying_since               text,
        ADD COLUMN IF NOT EXISTS would_switch               text,
        ADD COLUMN IF NOT EXISTS switch_condition           text;
    `,
  },
  {
    id: "051_secondary_order_line",
    sql: `
      -- ORDER BOOKING table for the Product-Wise Secondary Order Report.
      -- NOT dispatch; never sum or compare with secondary_sku_line or sale_line.
      -- occurrence preserves multiple source lines with the same order/product;
      -- its one-based source position keeps a re-upload idempotent.
      -- basic_order_value excludes GST; dealer_order_value includes GST.
      CREATE TABLE IF NOT EXISTS secondary_order_line (
        id                  INTEGER     GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        order_id            TEXT        NOT NULL,
        order_datetime      TIMESTAMPTZ NOT NULL,
        order_status        TEXT        NOT NULL,
        sales_user_name     TEXT,
        sales_user_id       INTEGER,
        customer_name       TEXT,
        dealer_id           TEXT        NOT NULL,
        dealer_mobile       TEXT,
        cp_name             TEXT,
        cp_code             TEXT        NOT NULL,
        state               TEXT,
        district            TEXT,
        city                TEXT,
        pincode             TEXT,
        category_name       TEXT,
        segment_canon       TEXT,
        product_code        TEXT        NOT NULL,
        occurrence          INTEGER     NOT NULL,
        source_row_number   INTEGER     NOT NULL,
        content_hash        TEXT        NOT NULL,
        is_exact_duplicate_export BOOLEAN NOT NULL DEFAULT FALSE,
        gst_pct             NUMERIC,
        gst_amount          NUMERIC,
        qty                 NUMERIC,
        discount_pct        NUMERIC,
        discount_amount     NUMERIC,
        dealer_order_value  NUMERIC,
        basic_order_value   NUMERIC,
        source_file         TEXT        NOT NULL,
        loaded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT secondary_order_line_uq UNIQUE (order_id, product_code, occurrence)
      );

      CREATE INDEX IF NOT EXISTS sol_dealer_id_idx       ON secondary_order_line (dealer_id);
      CREATE INDEX IF NOT EXISTS sol_cp_code_idx         ON secondary_order_line (cp_code);
      CREATE INDEX IF NOT EXISTS sol_order_datetime_idx  ON secondary_order_line (order_datetime);
      CREATE INDEX IF NOT EXISTS sol_product_code_idx    ON secondary_order_line (product_code);
      CREATE INDEX IF NOT EXISTS sol_order_status_idx    ON secondary_order_line (order_status);
      CREATE INDEX IF NOT EXISTS sol_state_idx           ON secondary_order_line (state);
    `,
  },
  {
    // Upgrade an early development install which used an over-strict pair key.
    id: "052_secondary_order_line_occurrence_identity",
    sql: `
      ALTER TABLE secondary_order_line
        ADD COLUMN IF NOT EXISTS occurrence INTEGER,
        ADD COLUMN IF NOT EXISTS source_row_number INTEGER,
        ADD COLUMN IF NOT EXISTS content_hash TEXT,
        ADD COLUMN IF NOT EXISTS is_exact_duplicate_export BOOLEAN NOT NULL DEFAULT FALSE;

      WITH numbered AS (
        SELECT id,
          ROW_NUMBER() OVER (PARTITION BY order_id, product_code ORDER BY id) AS occurrence
        FROM secondary_order_line
      )
      UPDATE secondary_order_line sol
      SET occurrence = numbered.occurrence,
          source_row_number = COALESCE(sol.source_row_number, numbered.occurrence),
          content_hash = COALESCE(
            sol.content_hash,
            md5(CONCAT_WS('|', sol.order_id, sol.product_code, sol.order_datetime,
              sol.order_status, sol.qty, sol.discount_pct, sol.basic_order_value,
              sol.dealer_order_value))
          )
      FROM numbered
      WHERE sol.id = numbered.id;

      ALTER TABLE secondary_order_line
        ALTER COLUMN occurrence SET NOT NULL,
        ALTER COLUMN source_row_number SET NOT NULL,
        ALTER COLUMN content_hash SET NOT NULL;

      ALTER TABLE secondary_order_line DROP CONSTRAINT IF EXISTS secondary_order_line_uq;
      ALTER TABLE secondary_order_line
        ADD CONSTRAINT secondary_order_line_uq UNIQUE (order_id, product_code, occurrence);
    `,
  },
  {
    id: "053_secondary_order_upload_verification",
    sql: `
      -- Stable-ID order uploads stay isolated until multiple reports prove
      -- their cross-upload identity resolution and line keys are reliable.
      CREATE TABLE IF NOT EXISTS secondary_order_upload (
        id               INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        source_file      TEXT        NOT NULL,
        source_sha256    TEXT        NOT NULL,
        source_bytes     BIGINT      NOT NULL,
        loaded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        verification     JSONB       NOT NULL,
        comparison       JSONB       NOT NULL,
        assessment       TEXT        NOT NULL,
        material_reasons TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
        analytics_status TEXT        NOT NULL DEFAULT 'ISOLATED_PENDING_RELIABILITY'
      );
      CREATE INDEX IF NOT EXISTS sou_loaded_at_idx ON secondary_order_upload (loaded_at DESC);
      CREATE INDEX IF NOT EXISTS sou_source_sha_idx ON secondary_order_upload (source_sha256);
    `,
  },
  {
    // Prompt 56: retain two CRM eras without making the old Product-Wise
    // identity collide with legacy SORDs.  Every statement is replay-safe.
    id: "087_secondary_order_line_prompt56_eras",
    sql: `
      ALTER TABLE secondary_order_line
        ADD COLUMN IF NOT EXISTS source_era TEXT,
        ADD COLUMN IF NOT EXISTS source_kind TEXT,
        ADD COLUMN IF NOT EXISTS fiscal_year TEXT,
        ADD COLUMN IF NOT EXISTS period_completeness TEXT,
        ADD COLUMN IF NOT EXISTS source_id TEXT;

      -- All pre-Prompt-56 rows came from the Product-Wise report.  Use their
      -- literal stored timestamp solely to derive the fiscal-year label.
      UPDATE secondary_order_line
      SET source_era = COALESCE(source_era, 'product_wise_crm'),
          source_kind = COALESCE(source_kind, 'product_wise'),
          fiscal_year = COALESCE(
            fiscal_year,
            CASE WHEN EXTRACT(MONTH FROM order_datetime AT TIME ZONE 'Asia/Kolkata') >= 4
              THEN EXTRACT(YEAR FROM order_datetime AT TIME ZONE 'Asia/Kolkata')::text
                   || '-' || RIGHT((EXTRACT(YEAR FROM order_datetime AT TIME ZONE 'Asia/Kolkata') + 1)::text, 2)
              ELSE (EXTRACT(YEAR FROM order_datetime AT TIME ZONE 'Asia/Kolkata') - 1)::text
                   || '-' || RIGHT(EXTRACT(YEAR FROM order_datetime AT TIME ZONE 'Asia/Kolkata')::text, 2)
            END
          ),
          period_completeness = COALESCE(period_completeness, 'partial');

      ALTER TABLE secondary_order_line
        ALTER COLUMN source_era SET NOT NULL,
        ALTER COLUMN source_kind SET NOT NULL,
        ALTER COLUMN fiscal_year SET NOT NULL,
        ALTER COLUMN period_completeness SET NOT NULL,
        ALTER COLUMN order_status DROP NOT NULL,
        ALTER COLUMN cp_code DROP NOT NULL;

      ALTER TABLE secondary_order_line DROP CONSTRAINT IF EXISTS secondary_order_line_uq;
      ALTER TABLE secondary_order_line
        ADD CONSTRAINT secondary_order_line_uq
        UNIQUE (source_era, order_id, product_code, occurrence);
      CREATE INDEX IF NOT EXISTS sol_fiscal_year_idx ON secondary_order_line (fiscal_year);
      CREATE INDEX IF NOT EXISTS sol_source_kind_idx ON secondary_order_line (source_kind);

      ALTER TABLE secondary_order_upload
        ADD COLUMN IF NOT EXISTS source_id TEXT,
        ADD COLUMN IF NOT EXISTS entry_point TEXT;
    `,
  },
  {
    id: "054_application_auth",
    sql: `
      -- Application accounts are separate from HR identities. Passwords are
      -- scrypt hashes; session tokens and login identifiers are stored as hashes.
      CREATE TABLE IF NOT EXISTS auth_users (
        id                SERIAL PRIMARY KEY,
        email             TEXT NOT NULL UNIQUE,
        email_normalized  TEXT NOT NULL UNIQUE,
        display_name      TEXT NOT NULL,
        password_hash     TEXT NOT NULL,
        role              TEXT NOT NULL DEFAULT 'normal'
                          CHECK (role IN ('admin', 'normal')),
        is_active         BOOLEAN NOT NULL DEFAULT TRUE,
        locked_until      TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        deactivated_at    TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS auth_users_email_normalized_idx
        ON auth_users (email_normalized);
      CREATE INDEX IF NOT EXISTS auth_users_active_role_idx
        ON auth_users (is_active, role);
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'auth_users_role_check'
        ) THEN
          ALTER TABLE auth_users
            ADD CONSTRAINT auth_users_role_check CHECK (role IN ('admin', 'normal'));
        END IF;
      END;
      $$;

      CREATE TABLE IF NOT EXISTS auth_sessions (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES auth_users(id),
        token_hash    TEXT NOT NULL UNIQUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at    TIMESTAMPTZ NOT NULL,
        last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        revoked_at    TIMESTAMPTZ,
        ip_hash       TEXT,
        user_agent    TEXT
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id);
      CREATE INDEX IF NOT EXISTS auth_sessions_active_idx
        ON auth_sessions (expires_at, revoked_at);

      CREATE TABLE IF NOT EXISTS auth_audit (
        id              SERIAL PRIMARY KEY,
        actor_user_id   INTEGER REFERENCES auth_users(id),
        target_user_id  INTEGER REFERENCES auth_users(id),
        event           TEXT NOT NULL,
        metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
        ip_hash         TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS auth_audit_target_idx
        ON auth_audit (target_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS auth_audit_actor_idx
        ON auth_audit (actor_user_id, created_at DESC);

      -- A short-lived DB throttle protects unknown addresses as well as real
      -- accounts, without retaining a readable email or IP address.
      CREATE TABLE IF NOT EXISTS auth_login_throttle (
        key_hash       TEXT PRIMARY KEY,
        failure_count  INTEGER NOT NULL DEFAULT 0,
        window_started TIMESTAMPTZ NOT NULL DEFAULT now(),
        locked_until   TIMESTAMPTZ
      );
    `,
  },
  {
    id: "055_canonical_state_coverage",
    sql: `
      -- Organisation coverage is deliberately separate from the legacy
      -- territory table.  territory remains a customer-compatibility lookup;
      -- it must never again be used to decide who covers a sales geography.

      -- The nine geography values that appear in the approved master data but
      -- have no register rows must still be assignable coverage leaves.
      INSERT INTO state_hierarchy
        (state_canon, state_parent, is_split, picker_visible, display_order)
      VALUES
        ('ARUNACHAL PRADESH',       'ARUNACHAL PRADESH',       false, true, 41),
        ('DADRA AND NAGAR HAVELI',  'DADRA AND NAGAR HAVELI',  false, true, 59),
        ('MANIPUR',                 'MANIPUR',                 false, true, 44),
        ('MEGHALAYA',               'MEGHALAYA',               false, true, 44),
        ('MIZORAM',                 'MIZORAM',                 false, true, 44),
        ('NAGALAND',                'NAGALAND',                false, true, 44),
        ('PONDICHERRY',             'PONDICHERRY',             false, true, 57),
        ('SIKKIM',                  'SIKKIM',                  false, true, 44),
        ('TRIPURA',                 'TRIPURA',                 false, true, 44)
      ON CONFLICT (state_canon) DO UPDATE
        SET state_parent = EXCLUDED.state_parent,
            is_split = EXCLUDED.is_split,
            picker_visible = EXCLUDED.picker_visible;

      -- A system-only coverage holder makes the known no-head register bucket
      -- explicit.  It is not an employee and must never appear as an assignment
      -- target or ordinary person in the organisation UI.
      ALTER TABLE person
        ADD COLUMN IF NOT EXISTS is_system_coverage BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE person DROP CONSTRAINT IF EXISTS person_source_check;
      ALTER TABLE person
        ADD CONSTRAINT person_source_check
        CHECK (source IN ('hr_sheet','app_created','departed_import','system_coverage'));
      CREATE UNIQUE INDEX IF NOT EXISTS uq_person_system_coverage_name
        ON person (name) WHERE is_system_coverage;

      INSERT INTO person
        (name, is_state_head, is_active, is_system_coverage, source)
      SELECT 'Unassigned coverage', false, false, true, 'system_coverage'
      WHERE NOT EXISTS (
        SELECT 1 FROM person
        WHERE is_system_coverage = true AND name = 'Unassigned coverage'
      );

      -- Immutable evidence of the retired model.  No live route reads either
      -- archive table; they exist solely for reconciliation and audit export.
      CREATE TABLE IF NOT EXISTS person_territory_archive (
        person_id          INTEGER NOT NULL,
        territory_id       INTEGER NOT NULL,
        effective_from     DATE NOT NULL,
        effective_to       DATE,
        archived_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        archive_reason     TEXT NOT NULL DEFAULT 'canonical_state_coverage'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_person_territory_archive_source
        ON person_territory_archive (person_id, territory_id, effective_from);

      CREATE TABLE IF NOT EXISTS person_state_coverage (
        coverage_id            BIGSERIAL PRIMARY KEY,
        person_id              INTEGER NOT NULL REFERENCES person(person_id),
        state_canon            TEXT NOT NULL REFERENCES state_hierarchy(state_canon),
        state_head_person_id   INTEGER NOT NULL REFERENCES person(person_id),
        effective_from         DATE NOT NULL,
        effective_to           DATE,
        source                 TEXT NOT NULL DEFAULT 'migration'
                               CHECK (source IN ('migration','seed_import','master_import','manual')),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (effective_to IS NULL OR effective_to >= effective_from),
        UNIQUE (person_id, state_canon, state_head_person_id, effective_from)
      );
      CREATE INDEX IF NOT EXISTS psc_person_idx ON person_state_coverage (person_id, effective_from);
      CREATE INDEX IF NOT EXISTS psc_head_leaf_idx
        ON person_state_coverage (state_head_person_id, state_canon, effective_from);

      CREATE TABLE IF NOT EXISTS person_state_coverage_mapping (
        mapping_id             BIGSERIAL PRIMARY KEY,
        legacy_person_id       INTEGER NOT NULL,
        state_head_person_id   INTEGER NOT NULL REFERENCES person(person_id),
        legacy_territory_id    INTEGER NOT NULL,
        legacy_territory       TEXT NOT NULL,
        state_canon            TEXT NOT NULL REFERENCES state_hierarchy(state_canon),
        effective_from         DATE NOT NULL,
        effective_to           DATE,
        mapping_rule           TEXT NOT NULL,
        coverage_id            BIGINT REFERENCES person_state_coverage(coverage_id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (legacy_person_id, legacy_territory_id, state_canon, effective_from)
      );

      -- Snapshot sales before touching the expression of coverage.  sale_line is
      -- never updated in this migration; retaining both snapshots makes that a
      -- repeatable assertion rather than an assumption.
      CREATE TABLE IF NOT EXISTS canonical_coverage_sales_snapshot (
        snapshot_stage         TEXT NOT NULL CHECK (snapshot_stage IN ('before','after')),
        fy                     TEXT NOT NULL,
        -- NULL is represented as the explicit register exception key so it can
        -- participate in the primary-key comparison.
        head_canon             TEXT NOT NULL,
        net_amount             NUMERIC NOT NULL,
        captured_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (snapshot_stage, fy, head_canon)
      );
      INSERT INTO canonical_coverage_sales_snapshot (snapshot_stage, fy, head_canon, net_amount)
      SELECT 'before', '2025-26', COALESCE(head_canon, '__UNASSIGNED__'), SUM(amount)
      FROM sale_line
      WHERE fy = '2025-26'
      GROUP BY COALESCE(head_canon, '__UNASSIGNED__')
      ON CONFLICT (snapshot_stage, fy, head_canon) DO NOTHING;

      INSERT INTO person_territory_archive (person_id, territory_id, effective_from, effective_to)
      SELECT person_id, territory_id, effective_from, effective_to
      FROM person_territory
      ON CONFLICT (person_id, territory_id, effective_from) DO NOTHING;

      -- The approved crosswalk is intentionally declarative.  Parent coverage
      -- is expanded only where the register hierarchy explicitly supplies the
      -- two Jammu/Kashmir leaves under the same responsible head.
      CREATE TEMP TABLE canonical_coverage_work (
        person_id INTEGER NOT NULL,
        state_head_person_id INTEGER NOT NULL,
        territory_id INTEGER NOT NULL,
        legacy_territory TEXT NOT NULL,
        state_canon TEXT NOT NULL,
        effective_from DATE NOT NULL,
        effective_to DATE,
        mapping_rule TEXT NOT NULL
      ) ON COMMIT DROP;

      INSERT INTO canonical_coverage_work
        (person_id, state_head_person_id, territory_id, legacy_territory,
         state_canon, effective_from, effective_to, mapping_rule)
      SELECT
        pt.person_id,
        COALESCE(p.state_head_person_id, sentinel.person_id),
        pt.territory_id,
        t.name,
        x.state_canon,
        pt.effective_from,
        pt.effective_to,
        x.mapping_rule
      FROM person_territory pt
      JOIN territory t ON t.territory_id = pt.territory_id
      JOIN person p ON p.person_id = pt.person_id
      CROSS JOIN LATERAL (
        SELECT v.state_canon, v.mapping_rule
        FROM (VALUES
          ('JAMMU AND KASHMIR', 'JAMMU', 'approved parent expansion: Jammu leaf'),
          ('JAMMU AND KASHMIR', 'KASHMIR', 'approved parent expansion: Kashmir leaf'),
          ('ANDHRA PRADESH', 'AP', 'approved register alias: Andhra Pradesh → AP'),
          ('CHATTISGARH', 'CHHATTISGARH', 'canonical spelling: CHATTISGARH → CHHATTISGARH'),
          ('DELHI', 'DELHI A', 'approved Delhi register-leaf mapping'),
          ('Delhi NCR', 'DELHI NCR', 'case-normalised register leaf'),
          ('East U.P', 'UTTAR PRADESH', 'approved East U.P state-head split')
        ) AS v(legacy_territory, state_canon, mapping_rule)
        WHERE v.legacy_territory = t.name
        UNION ALL
        SELECT
          CASE state_head.name
            WHEN 'Anant Singh' THEN 'UP ( A )'
            WHEN 'Anuj Sharma' THEN 'UP (AS)'
          END,
          'approved West U.P state-head split'
        FROM person state_head
        WHERE t.name = 'West U.P'
          AND state_head.person_id = COALESCE(p.state_head_person_id, p.person_id)
          AND state_head.name IN ('Anant Singh', 'Anuj Sharma')
        UNION ALL
        SELECT t.name, 'exact canonical leaf'
        WHERE t.name NOT IN (
          'JAMMU AND KASHMIR', 'ANDHRA PRADESH', 'CHATTISGARH',
          'DELHI', 'Delhi NCR', 'East U.P', 'West U.P'
        )
      ) x
      CROSS JOIN LATERAL (
        SELECT person_id
        FROM person
        WHERE is_system_coverage = true AND name = 'Unassigned coverage'
        ORDER BY person_id
        LIMIT 1
      ) sentinel
      WHERE EXISTS (
          SELECT 1 FROM state_hierarchy sh
          WHERE sh.state_canon = x.state_canon AND sh.picker_visible = true
        );

      -- Do not silently coerce a legacy value that does not have an approved
      -- mapping.  The entire migration rolls back with the unmapped names.
      DO $$
      DECLARE unmapped TEXT;
      BEGIN
        SELECT string_agg(DISTINCT t.name, ', ' ORDER BY t.name) INTO unmapped
        FROM person_territory pt
        JOIN territory t ON t.territory_id = pt.territory_id
        WHERE NOT EXISTS (
          SELECT 1 FROM canonical_coverage_work w
          WHERE w.person_id = pt.person_id
            AND w.territory_id = pt.territory_id
            AND w.effective_from = pt.effective_from
        );
        IF unmapped IS NOT NULL THEN
          RAISE EXCEPTION 'canonical coverage migration has unmapped legacy rows: %', unmapped;
        END IF;
      END $$;

      -- Approved crosswalks may only land a person under a head that is
      -- represented by that leaf's register evidence. This specifically stops
      -- a West U.P Anuj team member being placed in Anant's UP ( A ) leaf.
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM canonical_coverage_work w
          JOIN person h ON h.person_id = w.state_head_person_id
          WHERE w.legacy_territory IN ('CHATTISGARH', 'East U.P', 'West U.P')
            AND EXISTS (
              SELECT 1 FROM sale_line sl
              WHERE sl.state_canon = w.state_canon AND sl.head_canon IS NOT NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM sale_line sl
              WHERE sl.state_canon = w.state_canon
                AND CASE sl.head_canon
                  WHEN 'Babu' THEN 'Taninki Ramesh Babu'
                  WHEN 'Pawan Sharma' THEN 'Pawan Kumar Sharma'
                  WHEN 'Syed Aqil Rizvi' THEN 'Aqil Rizvi'
                  WHEN 'Suresh Nair' THEN 'Suresh Kumar Nair'
                  ELSE sl.head_canon
                END = h.name
            )
        ) THEN
          RAISE EXCEPTION 'canonical coverage migration mapped a state head to a leaf without matching register evidence';
        END IF;
      END $$;

      INSERT INTO person_state_coverage
        (person_id, state_canon, state_head_person_id, effective_from, effective_to, source)
      SELECT person_id, state_canon, state_head_person_id, effective_from, effective_to, 'migration'
      FROM canonical_coverage_work
      ON CONFLICT (person_id, state_canon, state_head_person_id, effective_from)
      DO UPDATE SET effective_to = EXCLUDED.effective_to;

      INSERT INTO person_state_coverage_mapping
        (legacy_person_id, state_head_person_id, legacy_territory_id, legacy_territory,
         state_canon, effective_from, effective_to, mapping_rule, coverage_id)
      SELECT w.person_id, w.state_head_person_id, w.territory_id, w.legacy_territory,
             w.state_canon, w.effective_from, w.effective_to, w.mapping_rule, c.coverage_id
      FROM canonical_coverage_work w
      JOIN person_state_coverage c
        ON c.person_id = w.person_id
       AND c.state_canon = w.state_canon
       AND c.state_head_person_id = w.state_head_person_id
       AND c.effective_from = w.effective_from
      ON CONFLICT (legacy_person_id, legacy_territory_id, state_canon, effective_from)
      DO NOTHING;

      -- Named-state/no-head register exceptions are coverage, never a missing
      -- row and never attributed to a real employee.
      INSERT INTO person_state_coverage
        (person_id, state_canon, state_head_person_id, effective_from, source)
      SELECT sentinel.person_id, leaf.state_canon, sentinel.person_id, DATE '2026-08-15', 'migration'
      FROM (VALUES ('GUJARAT'), ('HARYANA'), ('RAJASTHAN')) AS leaf(state_canon)
      CROSS JOIN LATERAL (
        SELECT person_id FROM person
        WHERE is_system_coverage = true AND name = 'Unassigned coverage'
        ORDER BY person_id LIMIT 1
      ) sentinel
      ON CONFLICT (person_id, state_canon, state_head_person_id, effective_from) DO NOTHING;

      -- Retire the legacy assignment source after archival.  Customer territory
      -- references remain intact; only organisation coverage stops using it.
      DELETE FROM person_territory;

      -- The title-case parent rows are inert case duplicates.  HARYANA is the
      -- authoritative customer compatibility row; move its one Haryana customer
      -- before deleting the empty duplicate.
      UPDATE customer c
      SET territory_id = canonical.territory_id
      FROM territory duplicate
      JOIN territory canonical ON canonical.name = 'HARYANA'
      WHERE duplicate.name = 'Haryana' AND c.territory_id = duplicate.territory_id;
      UPDATE customer_review_queue q
      SET proposed_territory_id = canonical.territory_id
      FROM territory duplicate
      JOIN territory canonical ON canonical.name = 'HARYANA'
      WHERE duplicate.name = 'Haryana' AND q.proposed_territory_id = duplicate.territory_id;
      UPDATE territory child
      SET parent_territory_id = NULL
      FROM territory parent
      WHERE child.parent_territory_id = parent.territory_id
        AND parent.name IN ('Andhra Pradesh','Karnataka','Rajasthan','Tamil Nadu','Jammu and Kashmir','Delhi');
      DELETE FROM territory
      WHERE name IN ('Andhra Pradesh','Karnataka','Rajasthan','Tamil Nadu','Jammu and Kashmir','Delhi','Haryana');

      -- Capture the after snapshot and stop if the coverage-only migration has
      -- somehow changed any FY2025-26 sales amount or head bucket.
      INSERT INTO canonical_coverage_sales_snapshot (snapshot_stage, fy, head_canon, net_amount)
      SELECT 'after', '2025-26', COALESCE(head_canon, '__UNASSIGNED__'), SUM(amount)
      FROM sale_line
      WHERE fy = '2025-26'
      GROUP BY COALESCE(head_canon, '__UNASSIGNED__')
      ON CONFLICT (snapshot_stage, fy, head_canon) DO UPDATE
        SET net_amount = EXCLUDED.net_amount, captured_at = now();
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM canonical_coverage_sales_snapshot b
          FULL OUTER JOIN canonical_coverage_sales_snapshot a
            ON a.fy = b.fy
           AND a.head_canon = b.head_canon
           AND a.snapshot_stage = 'after'
          WHERE b.snapshot_stage = 'before'
            AND COALESCE(a.net_amount, 0) <> COALESCE(b.net_amount, 0)
        ) THEN
          RAISE EXCEPTION 'canonical coverage migration changed FY2025-26 sales total or a head bucket';
        END IF;
      END $$;
    `,
  },
  {
    // Kept separate so installations that already applied the data migration
    // receive the same write-time protection.
    id: "056_canonical_state_coverage_guards",
    sql: `
      CREATE OR REPLACE FUNCTION guard_person_state_coverage()
      RETURNS TRIGGER AS $$
      DECLARE
        leaf_assignable BOOLEAN;
        coverage_is_system BOOLEAN;
        head_is_system BOOLEAN;
        head_is_state_head BOOLEAN;
      BEGIN
        SELECT picker_visible INTO leaf_assignable
        FROM state_hierarchy WHERE state_canon = NEW.state_canon;
        IF COALESCE(leaf_assignable, false) = false THEN
          RAISE EXCEPTION 'state % is not an assignable hierarchy leaf', NEW.state_canon;
        END IF;
        SELECT is_system_coverage INTO coverage_is_system
        FROM person WHERE person_id = NEW.person_id;
        SELECT is_system_coverage, is_state_head
          INTO head_is_system, head_is_state_head
        FROM person WHERE person_id = NEW.state_head_person_id;
        IF coverage_is_system OR head_is_system THEN
          IF NOT (coverage_is_system AND head_is_system AND NEW.person_id = NEW.state_head_person_id) THEN
            RAISE EXCEPTION 'system coverage may only be the explicit unassigned self-coverage record';
          END IF;
        ELSIF COALESCE(head_is_state_head, false) = false THEN
          RAISE EXCEPTION 'responsible person % is not a state head', NEW.state_head_person_id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS person_state_coverage_guard ON person_state_coverage;
      CREATE TRIGGER person_state_coverage_guard
        BEFORE INSERT OR UPDATE ON person_state_coverage
        FOR EACH ROW EXECUTE FUNCTION guard_person_state_coverage();
    `,
  },
  {
    id: "057_tamil_nadu_coverage_handover",
    sql: `
      -- The approved HR evidence identifies register "Babu" as Taninki Ramesh
      -- Babu, an executive under Sandeep—not a state head.  Preserve the clean
      -- register handover as effective-dated coverage rather than incorrectly
      -- treating those two sales labels as concurrent heads.
      INSERT INTO person_state_coverage
        (person_id, state_canon, state_head_person_id, effective_from, effective_to, source)
      SELECT babu.person_id, 'TAMIL NADU', sandeep.person_id,
             DATE '2024-04-01', DATE '2025-03-31', 'migration'
      FROM person babu
      CROSS JOIN person sandeep
      WHERE babu.name = 'Taninki Ramesh Babu'
        AND sandeep.name = 'Sandeep Dadheech'
      ON CONFLICT (person_id, state_canon, state_head_person_id, effective_from)
      DO UPDATE SET effective_to = EXCLUDED.effective_to;

      INSERT INTO person_state_coverage
        (person_id, state_canon, state_head_person_id, effective_from, source)
      SELECT sandeep.person_id, 'TAMIL NADU', sandeep.person_id,
             DATE '2025-04-01', 'migration'
      FROM person sandeep
      WHERE sandeep.name = 'Sandeep Dadheech'
      ON CONFLICT (person_id, state_canon, state_head_person_id, effective_from)
      DO NOTHING;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM person_state_coverage c
          JOIN person p ON p.person_id = c.person_id
          WHERE p.name = 'Taninki Ramesh Babu'
            AND c.state_canon = 'TAMIL NADU'
            AND c.effective_from = DATE '2024-04-01'
            AND c.effective_to = DATE '2025-03-31'
        ) THEN
          RAISE EXCEPTION 'Tamil Nadu historical Babu coverage could not be recorded';
        END IF;
      END $$;
    `,
  },
  {
    id: "058_register_evidenced_coverage",
    sql: `
      -- Register-derived coverage is deliberately labelled and auditable.  It
      -- is valid only where a customer has one register head in a leaf/FY.
      ALTER TABLE person_state_coverage
        ADD COLUMN IF NOT EXISTS fiscal_year TEXT,
        ADD COLUMN IF NOT EXISTS evidence_customer_count INTEGER,
        ADD COLUMN IF NOT EXISTS evidence_net_amount NUMERIC,
        ADD COLUMN IF NOT EXISTS evidence_source TEXT;
      ALTER TABLE person_state_coverage DROP CONSTRAINT IF EXISTS person_state_coverage_source_check;
      ALTER TABLE person_state_coverage ADD CONSTRAINT person_state_coverage_source_check
        CHECK (source IN ('migration','seed_import','master_import','manual','derived_register'));
      CREATE UNIQUE INDEX IF NOT EXISTS uq_person_state_coverage_derived_fy
        ON person_state_coverage (person_id, state_canon, state_head_person_id, fiscal_year)
        WHERE source = 'derived_register';

      CREATE TABLE IF NOT EXISTS person_state_coverage_customer_evidence (
        coverage_id BIGINT NOT NULL REFERENCES person_state_coverage(coverage_id) ON DELETE CASCADE,
        fiscal_year TEXT NOT NULL,
        customer_name TEXT NOT NULL,
        register_head_canon TEXT NOT NULL,
        net_amount NUMERIC NOT NULL,
        first_invoice_date DATE,
        last_invoice_date DATE,
        PRIMARY KEY (coverage_id, customer_name)
      );
      CREATE TABLE IF NOT EXISTS canonical_coverage_uncovered_gap (
        state_canon TEXT NOT NULL,
        fiscal_year TEXT NOT NULL,
        customer_count INTEGER NOT NULL,
        net_amount NUMERIC NOT NULL,
        reason TEXT NOT NULL,
        PRIMARY KEY (state_canon, fiscal_year)
      );

      -- The HR registry records Suresh Kumar Nair as a departed employee under
      -- Sandeep.  Create the historical person only when the people master does
      -- not already have it; do not promote him to a state head.
      INSERT INTO person
        (name, reports_to_person_id, state_head_person_id, is_state_head, is_active, source)
      SELECT 'Suresh Kumar Nair', s.person_id, s.person_id, false, false, 'departed_import'
      FROM person s
      WHERE s.name = 'Sandeep Dadheech'
        AND NOT EXISTS (SELECT 1 FROM person WHERE name = 'Suresh Kumar Nair');

      -- Never assign a customer to coverage unless its complete register
      -- history within the leaf/FY has exactly one resolved, non-system head.
      -- Invalid buckets remain visible as uncovered evidence below; they must
      -- not make a successful application deployment impossible.
      CREATE TEMP TABLE register_coverage_eligible_customer (
        state_canon TEXT NOT NULL,
        fiscal_year TEXT NOT NULL,
        customer_name TEXT NOT NULL,
        register_head_canon TEXT NOT NULL,
        PRIMARY KEY (state_canon, fiscal_year, customer_name)
      ) ON COMMIT DROP;

      INSERT INTO register_coverage_eligible_customer
        (state_canon, fiscal_year, customer_name, register_head_canon)
      SELECT
        sl.state_canon,
        sl.fy,
        sl.customer,
        MAX(sl.head_canon)
      FROM sale_line sl
      LEFT JOIN person p
        ON p.name = CASE sl.head_canon
          WHEN 'Babu' THEN 'Taninki Ramesh Babu'
          WHEN 'Pawan Sharma' THEN 'Pawan Kumar Sharma'
          WHEN 'Syed Aqil Rizvi' THEN 'Aqil Rizvi'
          WHEN 'Suresh Nair' THEN 'Suresh Kumar Nair'
          ELSE sl.head_canon
        END
      WHERE sl.state_canon IN ('AP','HIMACHAL PRADESH','MAHARASHTRA','TAMIL NADU','TELANGANA')
         OR (sl.state_canon = 'PUNJAB' AND sl.fy <> '2023-24')
      GROUP BY sl.state_canon, sl.fy, sl.customer
      HAVING COUNT(DISTINCT COALESCE(sl.head_canon, '__NULL__')) = 1
         AND BOOL_AND(sl.head_canon IS NOT NULL AND p.person_id IS NOT NULL AND NOT p.is_system_coverage);

      CREATE TEMP TABLE register_coverage_work (
        state_canon TEXT NOT NULL,
        fiscal_year TEXT NOT NULL,
        register_head_canon TEXT NOT NULL,
        person_name TEXT NOT NULL,
        effective_from DATE NOT NULL,
        effective_to DATE NOT NULL,
        customer_count INTEGER NOT NULL,
        net_amount NUMERIC NOT NULL
      ) ON COMMIT DROP;

      INSERT INTO register_coverage_work
      SELECT
        sl.state_canon,
        sl.fy,
        sl.head_canon,
        CASE sl.head_canon
          WHEN 'Babu' THEN 'Taninki Ramesh Babu'
          WHEN 'Pawan Sharma' THEN 'Pawan Kumar Sharma'
          WHEN 'Syed Aqil Rizvi' THEN 'Aqil Rizvi'
          WHEN 'Suresh Nair' THEN 'Suresh Kumar Nair'
          ELSE sl.head_canon
        END,
        -- Historical register tabs legitimately have NULL invoice dates.  Their
        -- Month label is the approved calendar fallback used elsewhere in the
        -- register pipeline, and is sufficient for coverage effective dates.
        MIN(COALESCE(sl.invoice_date, TO_DATE(sl.month_label, 'Mon-YY')))::date,
        MAX(COALESCE(sl.invoice_date, TO_DATE(sl.month_label, 'Mon-YY')))::date,
        COUNT(DISTINCT sl.customer)::integer,
        SUM(sl.amount)
      FROM sale_line sl
      JOIN register_coverage_eligible_customer eligible
        ON eligible.state_canon = sl.state_canon
       AND eligible.fiscal_year = sl.fy
       AND eligible.customer_name = sl.customer
      GROUP BY sl.state_canon, sl.fy, sl.head_canon;

      -- Record every rejected bucket so operators can review it.  This is
      -- intentionally an uncovered gap, never an inferred person assignment.
      INSERT INTO canonical_coverage_uncovered_gap
        (state_canon, fiscal_year, customer_count, net_amount, reason)
      SELECT sl.state_canon, sl.fy, COUNT(DISTINCT sl.customer)::integer, SUM(sl.amount),
             'mixed, unassigned, system, or unresolved customer attribution'
      FROM sale_line sl
      LEFT JOIN register_coverage_eligible_customer eligible
        ON eligible.state_canon = sl.state_canon
       AND eligible.fiscal_year = sl.fy
       AND eligible.customer_name = sl.customer
      WHERE eligible.customer_name IS NULL
        AND (
          sl.state_canon IN ('AP','HIMACHAL PRADESH','MAHARASHTRA','TAMIL NADU','TELANGANA')
          OR (sl.state_canon = 'PUNJAB' AND sl.fy <> '2023-24')
        )
      GROUP BY sl.state_canon, sl.fy
      ON CONFLICT (state_canon, fiscal_year) DO UPDATE
        SET customer_count = EXCLUDED.customer_count,
            net_amount = EXCLUDED.net_amount,
            reason = EXCLUDED.reason;

      DO $$
      DECLARE missing_people TEXT;
      BEGIN
        SELECT string_agg(DISTINCT w.person_name, ', ' ORDER BY w.person_name)
          INTO missing_people
        FROM register_coverage_work w
        WHERE NOT EXISTS (SELECT 1 FROM person p WHERE p.name = w.person_name);
        IF missing_people IS NOT NULL THEN
          RAISE EXCEPTION 'register coverage cannot resolve people: %', missing_people;
        END IF;
      END $$;

      INSERT INTO person_state_coverage
        (person_id, state_canon, state_head_person_id, effective_from, effective_to,
         fiscal_year, evidence_customer_count, evidence_net_amount, evidence_source, source)
      SELECT
        p.person_id,
        w.state_canon,
        COALESCE(p.state_head_person_id, p.person_id),
        w.effective_from,
        w.effective_to,
        w.fiscal_year,
        w.customer_count,
        w.net_amount,
        'sale_line.customer/head_canon',
        'derived_register'
      FROM register_coverage_work w
      JOIN person p ON p.name = w.person_name
      ON CONFLICT (person_id, state_canon, state_head_person_id, fiscal_year)
        WHERE source = 'derived_register'
      DO UPDATE SET
        effective_from = EXCLUDED.effective_from,
        effective_to = EXCLUDED.effective_to,
        evidence_customer_count = EXCLUDED.evidence_customer_count,
        evidence_net_amount = EXCLUDED.evidence_net_amount,
        evidence_source = EXCLUDED.evidence_source;

      DELETE FROM person_state_coverage_customer_evidence e
      USING person_state_coverage c
      WHERE c.coverage_id = e.coverage_id AND c.source = 'derived_register';
      INSERT INTO person_state_coverage_customer_evidence
        (coverage_id, fiscal_year, customer_name, register_head_canon, net_amount,
         first_invoice_date, last_invoice_date)
      SELECT
        c.coverage_id, w.fiscal_year, sl.customer, w.register_head_canon,
        SUM(sl.amount),
        MIN(COALESCE(sl.invoice_date, TO_DATE(sl.month_label, 'Mon-YY')))::date,
        MAX(COALESCE(sl.invoice_date, TO_DATE(sl.month_label, 'Mon-YY')))::date
      FROM register_coverage_work w
      JOIN person p ON p.name = w.person_name
      JOIN person_state_coverage c
        ON c.person_id = p.person_id
       AND c.state_canon = w.state_canon
       AND c.fiscal_year = w.fiscal_year
       AND c.source = 'derived_register'
      JOIN sale_line sl
        ON sl.state_canon = w.state_canon
       AND sl.fy = w.fiscal_year
       AND sl.head_canon = w.register_head_canon
      GROUP BY c.coverage_id, w.fiscal_year, sl.customer, w.register_head_canon;

      -- Punjab FY2023-24 is deliberately not derived: eight customers cross
      -- real/unassigned/project register buckets in the closed period.
      INSERT INTO canonical_coverage_uncovered_gap
        (state_canon, fiscal_year, customer_count, net_amount, reason)
      SELECT 'PUNJAB', '2023-24', COUNT(DISTINCT customer)::integer, SUM(amount),
             'customer appears under Pawan and unassigned/project register buckets'
      FROM sale_line
      WHERE state_canon = 'PUNJAB' AND fy = '2023-24'
      ON CONFLICT (state_canon, fiscal_year) DO UPDATE
        SET customer_count = EXCLUDED.customer_count,
            net_amount = EXCLUDED.net_amount,
            reason = EXCLUDED.reason;
    `,
  },
  {
    id: "059_normalize_derived_coverage_month_bounds",
    sql: `
      -- Coverage is effective for register months, not only the date of a
      -- particular invoice.  Normalize the audited derived rows to the first
      -- day of their first month and the last day of their last month.
      -- Migration 057 supplied a provisional Tamil handover while customer
      -- evidence was pending.  The derived FY rows now supersede only those
      -- two provisional rows; retain the independent legacy-mapped coverage.
      DELETE FROM person_state_coverage c
      USING person p
      WHERE c.person_id = p.person_id
        AND c.source = 'migration'
        AND c.state_canon = 'TAMIL NADU'
        AND (
          (p.name = 'Taninki Ramesh Babu' AND c.effective_from = DATE '2024-04-01')
          OR (p.name = 'Sandeep Dadheech' AND c.effective_from = DATE '2025-04-01')
        );

      WITH eligible_customer AS (
        SELECT sl.state_canon, sl.fy, sl.customer
        FROM sale_line sl
        LEFT JOIN person p
          ON p.name = CASE sl.head_canon
            WHEN 'Babu' THEN 'Taninki Ramesh Babu'
            WHEN 'Pawan Sharma' THEN 'Pawan Kumar Sharma'
            WHEN 'Syed Aqil Rizvi' THEN 'Aqil Rizvi'
            WHEN 'Suresh Nair' THEN 'Suresh Kumar Nair'
            ELSE sl.head_canon
          END
        WHERE sl.state_canon IN ('AP','HIMACHAL PRADESH','MAHARASHTRA','TAMIL NADU','TELANGANA')
           OR (sl.state_canon = 'PUNJAB' AND sl.fy <> '2023-24')
        GROUP BY sl.state_canon, sl.fy, sl.customer
        HAVING COUNT(DISTINCT COALESCE(sl.head_canon, '__NULL__')) = 1
           AND BOOL_AND(sl.head_canon IS NOT NULL AND p.person_id IS NOT NULL AND NOT p.is_system_coverage)
      ), register_bounds AS (
        SELECT
          sl.state_canon,
          sl.fy,
          CASE sl.head_canon
            WHEN 'Babu' THEN 'Taninki Ramesh Babu'
            WHEN 'Pawan Sharma' THEN 'Pawan Kumar Sharma'
            WHEN 'Syed Aqil Rizvi' THEN 'Aqil Rizvi'
            WHEN 'Suresh Nair' THEN 'Suresh Kumar Nair'
            ELSE sl.head_canon
          END AS person_name,
          DATE_TRUNC('month', MIN(COALESCE(sl.invoice_date, TO_DATE(sl.month_label, 'Mon-YY'))))::date AS effective_from,
          (DATE_TRUNC('month', MAX(COALESCE(sl.invoice_date, TO_DATE(sl.month_label, 'Mon-YY'))))
            + INTERVAL '1 month - 1 day')::date AS effective_to
        FROM sale_line sl
        JOIN eligible_customer eligible
          ON eligible.state_canon = sl.state_canon
         AND eligible.fy = sl.fy
         AND eligible.customer = sl.customer
        GROUP BY sl.state_canon, sl.fy, sl.head_canon
      )
      UPDATE person_state_coverage c
      SET effective_from = b.effective_from,
          effective_to = b.effective_to
      FROM register_bounds b
      JOIN person p ON p.name = b.person_name
      WHERE c.source = 'derived_register'
        AND c.person_id = p.person_id
        AND c.state_canon = b.state_canon
        AND c.fiscal_year = b.fy;
    `,
  },
  {
    id: "060_validate_register_evidenced_coverage",
    sql: `
      -- Rejected register buckets may remain as uncovered gaps, but must never
      -- leak into a derived coverage row. Validate the applied write rather
      -- than aborting startup merely because uncovered source data exists.
      DO $$
      BEGIN
        IF EXISTS (
          WITH selected_lines AS (
            SELECT sl.state_canon, sl.fy, sl.customer, sl.head_canon,
                   CASE sl.head_canon
                     WHEN 'Babu' THEN 'Taninki Ramesh Babu'
                     WHEN 'Pawan Sharma' THEN 'Pawan Kumar Sharma'
                     WHEN 'Syed Aqil Rizvi' THEN 'Aqil Rizvi'
                     WHEN 'Suresh Nair' THEN 'Suresh Kumar Nair'
                     ELSE sl.head_canon
                   END AS person_name
            FROM sale_line sl
            WHERE sl.state_canon IN ('AP','HIMACHAL PRADESH','MAHARASHTRA','TAMIL NADU','TELANGANA')
               OR (sl.state_canon = 'PUNJAB' AND sl.fy <> '2023-24')
          )
          , rejected_customer AS (
            SELECT s.state_canon, s.fy, s.customer
            FROM selected_lines s
            LEFT JOIN person p ON p.name = s.person_name
            GROUP BY s.state_canon, s.fy, s.customer
            HAVING COUNT(DISTINCT COALESCE(s.head_canon, '__NULL__')) <> 1
                OR BOOL_OR(s.head_canon IS NULL OR p.person_id IS NULL OR p.is_system_coverage)
          )
          SELECT 1
          FROM person_state_coverage_customer_evidence e
          JOIN person_state_coverage c ON c.coverage_id = e.coverage_id
          JOIN rejected_customer r
            ON r.state_canon = c.state_canon
           AND r.fy = c.fiscal_year
           AND r.customer = e.customer_name
          WHERE c.source = 'derived_register'
        ) THEN
          RAISE EXCEPTION 'derived coverage includes mixed, unassigned, or unresolved customer evidence';
        END IF;
      END $$;
    `,
  },
  {
    id: "061_canonical_coverage_drift_events",
    sql: `
      -- Register updates must never rewrite organisation coverage. Each
      -- post-sync evidence check is persisted so operators can review drift
      -- before deciding whether a fresh coverage derivation is appropriate.
      CREATE TABLE IF NOT EXISTS canonical_coverage_drift_event (
        event_id       BIGSERIAL PRIMARY KEY,
        checked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        trigger_fy     TEXT NOT NULL,
        trigger_source TEXT NOT NULL,
        report_fy      TEXT,
        status         TEXT NOT NULL CHECK (status IN ('ok', 'drift', 'error')),
        detail         JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE INDEX IF NOT EXISTS idx_canonical_coverage_drift_checked
        ON canonical_coverage_drift_event (checked_at DESC);
      CREATE INDEX IF NOT EXISTS idx_canonical_coverage_drift_status
        ON canonical_coverage_drift_event (status, checked_at DESC);
    `,
  },
  {
    id: "062_repair_west_up_anuj_coverage",
    sql: `
      -- Correct the first rollout's coarse West U.P mapping. The approved
      -- crosswalk is head-specific: Anant → UP ( A ); Anuj → UP (AS).
      WITH affected_coverage AS (
        SELECT DISTINCT c.coverage_id
        FROM person_state_coverage c
        JOIN person_state_coverage_mapping m ON m.coverage_id = c.coverage_id
        JOIN person h ON h.person_id = m.state_head_person_id
        WHERE m.legacy_territory = 'West U.P'
          AND h.name = 'Anuj Sharma'
          AND m.state_canon = 'UP ( A )'
      )
      UPDATE person_state_coverage c
      SET state_canon = 'UP (AS)'
      FROM affected_coverage a
      WHERE c.coverage_id = a.coverage_id;

      UPDATE person_state_coverage_mapping m
      SET state_canon = 'UP (AS)',
          mapping_rule = 'approved West U.P state-head split: Anuj → UP (AS)'
      FROM person h
      WHERE m.legacy_territory = 'West U.P'
        AND h.person_id = m.state_head_person_id
        AND h.name = 'Anuj Sharma'
        AND m.state_canon = 'UP ( A )';

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM person_state_coverage_mapping m
          JOIN person h ON h.person_id = m.state_head_person_id
          WHERE m.legacy_territory = 'West U.P'
            AND h.name = 'Anuj Sharma'
            AND m.state_canon <> 'UP (AS)'
        ) THEN
          RAISE EXCEPTION 'West U.P Anuj coverage was not repaired to UP (AS)';
        END IF;
      END $$;
    `,
  },
  {
    id: "063_void_invalid_post_departure_assignments",
    sql: `
      -- A late master import can incorrectly attach currently-open coverage or
      -- customers to someone whose departure predates the import. Retain those
      -- source rows as audit evidence, but make their void status explicit so
      -- they cannot be treated as active geography or ownership.
      ALTER TABLE person_state_coverage
        ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS voided_by TEXT,
        ADD COLUMN IF NOT EXISTS void_reason TEXT;

      ALTER TABLE customer_assignment
        ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS voided_by TEXT,
        ADD COLUMN IF NOT EXISTS void_reason TEXT;

      DROP INDEX IF EXISTS uq_customer_assignment_open;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_assignment_open
        ON customer_assignment (customer_id)
        WHERE effective_to IS NULL AND voided_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_person_state_coverage_live
        ON person_state_coverage (person_id, state_canon, effective_from)
        WHERE voided_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_customer_assignment_live
        ON customer_assignment (customer_id, person_id, effective_from)
        WHERE effective_to IS NULL AND voided_at IS NULL;
    `,
  },
  {
    id: "064_authoritative_mrp_sync_cache",
    sql: `
      -- The old mrp_master/mrp_history remain untouched during the proving
      -- period.  Generations allow a complete external read to become visible
      -- atomically while preserving the last successful cache on a failed read.
      CREATE TABLE IF NOT EXISTS mrp_sync_generation (
        generation_id UUID PRIMARY KEY,
        source_fetched_at TIMESTAMPTZ NOT NULL,
        source_row_count INTEGER NOT NULL CHECK (source_row_count > 0),
        checksum TEXT NOT NULL,
        provenance_complete BOOLEAN NOT NULL DEFAULT FALSE,
        is_active BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS mrp_sync_one_active_generation
        ON mrp_sync_generation (is_active) WHERE is_active = TRUE;

      CREATE TABLE IF NOT EXISTS mrp_synced (
        generation_id UUID NOT NULL REFERENCES mrp_sync_generation(generation_id) ON DELETE CASCADE,
        item_code TEXT NOT NULL,
        source_product_id BIGINT NOT NULL,
        product_name TEXT,
        division_raw TEXT NOT NULL,
        series_range TEXT,
        size TEXT,
        uom TEXT,
        mrp NUMERIC,
        price_in_force_since DATE,
        previous_mrp NUMERIC,
        change_pct NUMERIC,
        status TEXT NOT NULL CHECK (status IN ('revised','unchanged','new','discontinued')),
        colour_variants TEXT[] NOT NULL DEFAULT '{}',
        source_batch_id TEXT,
        source_review_status TEXT,
        source_review_reasons TEXT[] NOT NULL DEFAULT '{}',
        synced_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (generation_id, item_code)
      );
      CREATE INDEX IF NOT EXISTS mrp_synced_active_lookup
        ON mrp_synced (item_code, generation_id);

      -- Mapping is a child relationship, never a duplicated price row.
      CREATE TABLE IF NOT EXISTS mrp_synced_division (
        generation_id UUID NOT NULL,
        item_code TEXT NOT NULL,
        source_division TEXT NOT NULL,
        app_segment TEXT,
        PRIMARY KEY (generation_id, item_code, source_division),
        FOREIGN KEY (generation_id, item_code)
          REFERENCES mrp_synced(generation_id, item_code) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS mrp_synced_division_segment
        ON mrp_synced_division (generation_id, app_segment);

      CREATE TABLE IF NOT EXISTS mrp_sync_status (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
        last_success_at TIMESTAMPTZ,
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO mrp_sync_status (singleton) VALUES (TRUE)
      ON CONFLICT (singleton) DO NOTHING;
    `,
  },
  {
    id: "065_authoritative_mrp_current_catalogue_view",
    sql: `
      -- One read model for present-day price lookups. It switches wholesale to
      -- the active source generation; legacy prices remain available only until
      -- the first complete source refresh succeeds.
      CREATE OR REPLACE VIEW mrp_current_catalogue AS
      WITH active_generation AS (
        SELECT generation_id
        FROM mrp_sync_generation
        WHERE is_active = TRUE
        LIMIT 1
      )
      SELECT DISTINCT
        s.item_code,
        d.app_segment AS segment,
        s.product_name AS item_name,
        s.mrp,
        s.price_in_force_since AS effective_from
      FROM active_generation g
      JOIN mrp_synced s ON s.generation_id = g.generation_id
      JOIN mrp_synced_division d
        ON d.generation_id = s.generation_id
       AND d.item_code = s.item_code
      WHERE d.app_segment IS NOT NULL

      UNION ALL

      SELECT
        m.item_code,
        m.segment,
        m.item_name,
        h.mrp,
        h.effective_from
      FROM mrp_master m
      LEFT JOIN mrp_history h
        ON h.item_code = m.item_code
       AND h.segment = m.segment
       AND h.is_current = TRUE
      WHERE NOT EXISTS (SELECT 1 FROM active_generation);
    `,
  },
  {
    id: "066_remove_mrp_sync_status_preview_unsafe_check",
    sql: `
      -- Replit's production schema preview incorrectly serialises
      -- CHECK (singleton) as CHECK (CHECK (singleton)). The primary key and
      -- default retain the one-status-row convention without this invalid SQL.
      ALTER TABLE mrp_sync_status
        DROP CONSTRAINT IF EXISTS mrp_sync_status_singleton_check;
    `,
  },
  {
    id: "067_sku_taxonomy_overrides",
    sql: `
      -- Manual local-taxonomy decisions for authoritative catalogue codes.
      -- These deliberately do not modify item_master: product uploads refresh
      -- that table and current product existence/MRP remains source-owned.
      CREATE TABLE IF NOT EXISTS sku_taxonomy_override (
        code              TEXT PRIMARY KEY,
        item_group        TEXT NOT NULL,
        canonical_segment TEXT NOT NULL,
        mapped_by_user_id INTEGER NOT NULL,
        mapped_by         TEXT NOT NULL,
        note              TEXT,
        mapped_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS sku_taxonomy_override_audit (
        id                     BIGSERIAL PRIMARY KEY,
        code                   TEXT NOT NULL,
        previous_item_group    TEXT,
        previous_segment       TEXT,
        item_group             TEXT NOT NULL,
        canonical_segment      TEXT NOT NULL,
        mapped_by_user_id      INTEGER NOT NULL,
        mapped_by              TEXT NOT NULL,
        note                   TEXT,
        mapped_at              TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS sku_taxonomy_override_audit_code_idx
        ON sku_taxonomy_override_audit (code, mapped_at DESC);
    `,
  },
  {
    id: "068_sku_taxonomy_override_actor",
    sql: `
      -- Migration 067 can already exist in a development database from the
      -- first queue rollout. Keep legacy rows honest (NULL actor id) while all
      -- future writes record the authenticated administrator's immutable id.
      ALTER TABLE sku_taxonomy_override
        ADD COLUMN IF NOT EXISTS mapped_by_user_id INTEGER;
      ALTER TABLE sku_taxonomy_override_audit
        ADD COLUMN IF NOT EXISTS mapped_by_user_id INTEGER;
    `,
  },
  {
    id: "069_employee_code_identity_guards",
    sql: `
      -- Numeric registry keys predate the current identity policy. Preserve
      -- them as explicit source aliases so historical secondary imports can
      -- still read them, but never use either a source alias or employee code
      -- as a person identity key.
      CREATE TABLE IF NOT EXISTS person_registry_source_alias (
        registry_id INTEGER NOT NULL REFERENCES person_registry(id) ON DELETE CASCADE,
        source_key  TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('legacy_norm_key', 'employee_code')),
        PRIMARY KEY (registry_id, source_key, source_kind)
      );
      CREATE INDEX IF NOT EXISTS pr_source_alias_key_idx
        ON person_registry_source_alias (source_key);

      INSERT INTO person_registry_source_alias (registry_id, source_key, source_kind)
      SELECT id,
             REGEXP_REPLACE(LOWER(TRIM(norm_key)), '\\s+', ' ', 'g'),
             'legacy_norm_key'
      FROM person_registry
      WHERE norm_key ~ '^[0-9]+$'
      ON CONFLICT DO NOTHING;

      INSERT INTO person_registry_source_alias (registry_id, source_key, source_kind)
      SELECT id,
             REGEXP_REPLACE(LOWER(TRIM(employee_code)), '\\s+', ' ', 'g'),
             'employee_code'
      FROM person_registry
      WHERE NULLIF(TRIM(employee_code), '') IS NOT NULL
      ON CONFLICT DO NOTHING;

      CREATE OR REPLACE FUNCTION sync_person_registry_source_alias()
      RETURNS TRIGGER AS $$
      BEGIN
        DELETE FROM person_registry_source_alias
        WHERE registry_id = NEW.id
          AND source_kind IN ('legacy_norm_key', 'employee_code');

        IF NEW.norm_key ~ '^[0-9]+$' THEN
          INSERT INTO person_registry_source_alias (registry_id, source_key, source_kind)
          VALUES (
            NEW.id,
            REGEXP_REPLACE(LOWER(TRIM(NEW.norm_key)), '\\s+', ' ', 'g'),
            'legacy_norm_key'
          )
          ON CONFLICT DO NOTHING;
        END IF;

        IF NULLIF(TRIM(NEW.employee_code), '') IS NOT NULL THEN
          INSERT INTO person_registry_source_alias (registry_id, source_key, source_kind)
          VALUES (
            NEW.id,
            REGEXP_REPLACE(LOWER(TRIM(NEW.employee_code)), '\\s+', ' ', 'g'),
            'employee_code'
          )
          ON CONFLICT DO NOTHING;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS person_registry_source_alias_sync ON person_registry;
      CREATE TRIGGER person_registry_source_alias_sync
      AFTER INSERT OR UPDATE ON person_registry
      FOR EACH ROW EXECUTE FUNCTION sync_person_registry_source_alias();
    `,
  },
  {
    // Earlier person-registry migrations populated person_id before employee
    // codes were treated as non-unique evidence. Existing databases have
    // already recorded those migrations, so repair their links forward rather
    // than relying on edits to historical migration definitions.
    id: "070_person_registry_identity_link_repair",
    sql: `
      CREATE TABLE IF NOT EXISTS person_registry_person_link_repair_audit (
        id            BIGSERIAL PRIMARY KEY,
        migration_id  TEXT NOT NULL,
        registry_id   INTEGER NOT NULL,
        old_person_id INTEGER,
        new_person_id INTEGER,
        action        TEXT NOT NULL CHECK (action IN ('cleared', 'relinked')),
        reason        TEXT NOT NULL,
        repaired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (migration_id, registry_id, action)
      );
      CREATE INDEX IF NOT EXISTS pr_link_repair_audit_registry_idx
        ON person_registry_person_link_repair_audit (registry_id, repaired_at DESC);

      -- Preserve an auditable record before clearing any legacy mapping that
      -- cannot be corroborated by one canonical-name candidate and, where
      -- present, that candidate's operational manager. Employee code is
      -- deliberately absent from this candidate search.
      WITH candidates AS (
        SELECT
          pr.id AS registry_id,
          pr.person_id AS old_person_id,
          NULLIF(REGEXP_REPLACE(pr.reporting_manager, '[^a-z0-9]', '', 'gi'), '') AS manager_key,
          COUNT(p.person_id) AS name_candidate_count,
          MIN(p.person_id) AS name_person_id,
          COUNT(p.person_id) FILTER (
            WHERE NULLIF(REGEXP_REPLACE(pr.reporting_manager, '[^a-z0-9]', '', 'gi'), '') IS NOT NULL
              AND LOWER(REGEXP_REPLACE(manager.name, '[^a-z0-9]', '', 'gi'))
                  = LOWER(REGEXP_REPLACE(pr.reporting_manager, '[^a-z0-9]', '', 'gi'))
          ) AS manager_candidate_count,
          MIN(p.person_id) FILTER (
            WHERE NULLIF(REGEXP_REPLACE(pr.reporting_manager, '[^a-z0-9]', '', 'gi'), '') IS NOT NULL
              AND LOWER(REGEXP_REPLACE(manager.name, '[^a-z0-9]', '', 'gi'))
                  = LOWER(REGEXP_REPLACE(pr.reporting_manager, '[^a-z0-9]', '', 'gi'))
          ) AS manager_person_id
        FROM person_registry pr
        LEFT JOIN person p
          ON LOWER(REGEXP_REPLACE(p.name, '[^a-z0-9]', '', 'gi'))
             = LOWER(REGEXP_REPLACE(pr.canonical_name, '[^a-z0-9]', '', 'gi'))
        LEFT JOIN person manager ON manager.person_id = p.reports_to_person_id
        WHERE pr.is_person = true
        GROUP BY pr.id, pr.person_id, pr.reporting_manager
      )
      INSERT INTO person_registry_person_link_repair_audit
        (migration_id, registry_id, old_person_id, new_person_id, action, reason)
      SELECT
        '070_person_registry_identity_link_repair',
        c.registry_id,
        c.old_person_id,
        NULL,
        'cleared',
        CASE
          WHEN c.name_candidate_count = 0 THEN 'no_name_candidate'
          WHEN c.name_candidate_count > 1 THEN 'ambiguous_name_candidates'
          WHEN c.name_person_id <> c.old_person_id THEN 'link_does_not_match_name'
          WHEN c.manager_candidate_count = 0 THEN 'manager_not_in_operational_chain'
          WHEN c.manager_candidate_count > 1 THEN 'ambiguous_manager_candidates'
          ELSE 'link_does_not_match_manager'
        END
      FROM candidates c
      WHERE c.old_person_id IS NOT NULL
        AND (
          c.name_candidate_count <> 1
          OR c.name_person_id <> c.old_person_id
          OR (
            c.manager_key IS NOT NULL
            AND (
              c.manager_candidate_count <> 1
              OR c.manager_person_id <> c.old_person_id
            )
          )
        )
      ON CONFLICT (migration_id, registry_id, action) DO NOTHING;

      UPDATE person_registry pr
      SET person_id = NULL,
          updated_at = now()
      FROM person_registry_person_link_repair_audit audit
      WHERE audit.migration_id = '070_person_registry_identity_link_repair'
        AND audit.action = 'cleared'
        AND audit.registry_id = pr.id
        AND pr.person_id = audit.old_person_id;

      -- Re-establish only an unambiguous name-and-manager link. A matching
      -- employee code may corroborate this result but cannot create it; a
      -- contradictory nonblank code is left for the review queue.
      WITH candidates AS (
        SELECT
          pr.id AS registry_id,
          NULLIF(REGEXP_REPLACE(pr.reporting_manager, '[^a-z0-9]', '', 'gi'), '') AS manager_key,
          NULLIF(REGEXP_REPLACE(pr.employee_code, '[^a-z0-9]', '', 'gi'), '') AS registry_code_key,
          COUNT(p.person_id) AS name_candidate_count,
          MIN(p.person_id) AS name_person_id,
          MIN(NULLIF(REGEXP_REPLACE(p.employee_code, '[^a-z0-9]', '', 'gi'), '')) AS person_code_key,
          COUNT(p.person_id) FILTER (
            WHERE NULLIF(REGEXP_REPLACE(pr.reporting_manager, '[^a-z0-9]', '', 'gi'), '') IS NOT NULL
              AND LOWER(REGEXP_REPLACE(manager.name, '[^a-z0-9]', '', 'gi'))
                  = LOWER(REGEXP_REPLACE(pr.reporting_manager, '[^a-z0-9]', '', 'gi'))
          ) AS manager_candidate_count,
          MIN(p.person_id) FILTER (
            WHERE NULLIF(REGEXP_REPLACE(pr.reporting_manager, '[^a-z0-9]', '', 'gi'), '') IS NOT NULL
              AND LOWER(REGEXP_REPLACE(manager.name, '[^a-z0-9]', '', 'gi'))
                  = LOWER(REGEXP_REPLACE(pr.reporting_manager, '[^a-z0-9]', '', 'gi'))
          ) AS manager_person_id
        FROM person_registry pr
        LEFT JOIN person p
          ON LOWER(REGEXP_REPLACE(p.name, '[^a-z0-9]', '', 'gi'))
             = LOWER(REGEXP_REPLACE(pr.canonical_name, '[^a-z0-9]', '', 'gi'))
        LEFT JOIN person manager ON manager.person_id = p.reports_to_person_id
        WHERE pr.is_person = true
          AND pr.person_id IS NULL
        GROUP BY pr.id, pr.reporting_manager, pr.employee_code
      ),
      relinkable AS (
        SELECT c.registry_id, c.name_person_id,
               CASE WHEN c.manager_key IS NULL
                    THEN 'unique_name_no_manager'
                    ELSE 'unique_name_and_manager' END AS reason
        FROM candidates c
        WHERE c.name_candidate_count = 1
          AND (
            c.manager_key IS NULL
            OR (
              c.manager_candidate_count = 1
              AND c.manager_person_id = c.name_person_id
            )
          )
          AND (
            c.registry_code_key IS NULL
            OR c.person_code_key IS NULL
            OR c.registry_code_key = c.person_code_key
          )
      ),
      audited AS (
        INSERT INTO person_registry_person_link_repair_audit
          (migration_id, registry_id, old_person_id, new_person_id, action, reason)
        SELECT
          '070_person_registry_identity_link_repair',
          r.registry_id,
          NULL,
          r.name_person_id,
          'relinked',
          r.reason
        FROM relinkable r
        ON CONFLICT (migration_id, registry_id, action) DO NOTHING
        RETURNING registry_id
      )
      UPDATE person_registry pr
      SET person_id = r.name_person_id,
          updated_at = now()
      FROM relinkable r
      WHERE pr.id = r.registry_id
        AND pr.person_id IS NULL;
    `,
  },
  {
    id: "071_person_registry_relationship_resolution",
    sql: `
      -- Human decisions that map an HR registry record to its canonical People
      -- record are effective-dated and append-only. The registry's person_id
      -- remains the current operational link; this table preserves every
      -- decision, including an explicit choice to leave a record unresolved.
      CREATE TABLE IF NOT EXISTS person_registry_relationship_resolution (
        resolution_id  SERIAL PRIMARY KEY,
        registry_id    INTEGER NOT NULL REFERENCES person_registry(id) ON DELETE RESTRICT,
        person_id      INTEGER REFERENCES person(person_id) ON DELETE RESTRICT,
        decision       TEXT NOT NULL CHECK (decision IN ('linked', 'unresolved')),
        effective_date DATE NOT NULL,
        reason         TEXT NOT NULL,
        changed_by     TEXT NOT NULL,
        proposal_hash  TEXT NOT NULL,
        evidence       JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        superseded_at  TIMESTAMPTZ,
        CHECK (
          (decision = 'linked' AND person_id IS NOT NULL)
          OR (decision = 'unresolved' AND person_id IS NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pr_relationship_resolution_current_idx
        ON person_registry_relationship_resolution (registry_id)
        WHERE superseded_at IS NULL;
      CREATE INDEX IF NOT EXISTS pr_relationship_resolution_registry_idx
        ON person_registry_relationship_resolution (registry_id, created_at DESC);
    `,
  },
  {
    id: "072_person_registry_manual_relationship_uniqueness",
    sql: `
      -- Imported historical registry links may legitimately predate the human
      -- review workflow. New manual decisions, however, must never make two
      -- distinct registry identities resolve to the same People record.
      CREATE UNIQUE INDEX IF NOT EXISTS pr_relationship_resolution_current_person_idx
        ON person_registry_relationship_resolution (person_id)
        WHERE superseded_at IS NULL
          AND decision = 'linked'
          AND person_id IS NOT NULL;
    `,
  },
  {
    id: "073_secondary_head_month_history",
    sql: `
      -- Keep the current dashboard table fast and familiar, while giving every
      -- row a completed source run and retaining every validated source value.
      ALTER TABLE secondary_head_month
        ADD COLUMN IF NOT EXISTS ingest_run_id INTEGER;

      CREATE TABLE IF NOT EXISTS secondary_head_month_revision (
        id                SERIAL PRIMARY KEY,
        ingest_run_id     INTEGER NOT NULL
                          REFERENCES secondary_ingest_run(id) ON DELETE RESTRICT,
        fy                TEXT NOT NULL,
        head_raw          TEXT,
        head_canon        TEXT NOT NULL,
        state_head        TEXT,
        month_label       TEXT NOT NULL,
        month_idx         INTEGER NOT NULL,
        plan_amount       NUMERIC,
        ordered_amount    NUMERIC,
        received_amount   NUMERIC,
        achievement_pct   NUMERIC,
        is_anomaly        BOOLEAN NOT NULL DEFAULT false,
        not_yet_recorded  BOOLEAN NOT NULL DEFAULT false,
        source_sheet_id   TEXT,
        recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS sec_head_month_revision_run_key_uniq
        ON secondary_head_month_revision
          (ingest_run_id, fy, head_canon, month_label);
      CREATE INDEX IF NOT EXISTS sec_head_month_revision_key_idx
        ON secondary_head_month_revision (fy, head_canon, month_label);
      CREATE INDEX IF NOT EXISTS sec_head_month_revision_run_idx
        ON secondary_head_month_revision (ingest_run_id);

      -- Existing current rows are not historical reconstructions. They are
      -- attached to one explicitly labelled baseline so current rows satisfy
      -- the provenance invariant without pretending older revisions exist.
      DO $$
      DECLARE
        baseline_id INTEGER;
      BEGIN
        IF EXISTS (
          SELECT 1 FROM secondary_head_month WHERE ingest_run_id IS NULL
        ) THEN
          INSERT INTO secondary_ingest_run (
            started_at, source, fy, rows_read, rows_inserted, rows_skipped,
            unmapped, assertions, status
          )
          SELECT
            now(),
            'legacy_baseline',
            NULL,
            COUNT(*)::INTEGER,
            COUNT(*)::INTEGER,
            0,
            '{}'::jsonb,
            '[{"name":"legacy_baseline","passed":true,"detail":"Current rows at migration time; no pre-existing revision history is claimed."}]'::jsonb,
            'ok'
          FROM secondary_head_month
          WHERE ingest_run_id IS NULL
          RETURNING id INTO baseline_id;

          INSERT INTO secondary_head_month_revision (
            ingest_run_id, fy, head_raw, head_canon, state_head, month_label,
            month_idx, plan_amount, ordered_amount, received_amount,
            achievement_pct, is_anomaly, not_yet_recorded, source_sheet_id
          )
          SELECT
            baseline_id, fy, head_raw, head_canon, state_head, month_label,
            month_idx, plan_amount, ordered_amount, received_amount,
            achievement_pct, is_anomaly, not_yet_recorded, source_sheet_id
          FROM secondary_head_month
          WHERE ingest_run_id IS NULL;

          UPDATE secondary_head_month
          SET ingest_run_id = baseline_id
          WHERE ingest_run_id IS NULL;
        END IF;
      END
      $$;

      ALTER TABLE secondary_head_month
        ALTER COLUMN ingest_run_id SET NOT NULL;
      -- The publish-time schema diff may create this FK before the application
      -- sees the custom migration ledger. Guard the named constraint so a
      -- replay applies the data provenance backfill instead of crashing startup.
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'secondary_head_month_ingest_run_fk'
            AND conrelid = 'secondary_head_month'::regclass
        ) THEN
          ALTER TABLE secondary_head_month
            ADD CONSTRAINT secondary_head_month_ingest_run_fk
            FOREIGN KEY (ingest_run_id)
            REFERENCES secondary_ingest_run(id)
            ON DELETE RESTRICT;
        END IF;
      END
      $$;

      -- Revisions are evidence, not mutable state. Prevent accidental edits
      -- through any SQL path, including an operator's broad UPDATE/DELETE.
      CREATE OR REPLACE FUNCTION prevent_secondary_head_month_revision_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'secondary_head_month_revision is append-only';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS secondary_head_month_revision_immutable
        ON secondary_head_month_revision;
      CREATE TRIGGER secondary_head_month_revision_immutable
        BEFORE UPDATE OR DELETE ON secondary_head_month_revision
        FOR EACH ROW
        EXECUTE FUNCTION prevent_secondary_head_month_revision_mutation();
    `,
  },
  {
    id: "074_secondary_sku_load_provenance",
    sql: `
      -- One durable audit row per successful protected raw-SKU load.  This is
      -- deliberately separate from secondary_sku_line: source provenance is
      -- load-level evidence, not a repeated transaction-line attribute.
      CREATE TABLE IF NOT EXISTS secondary_sku_load_provenance (
        id             SERIAL PRIMARY KEY,
        fy             TEXT NOT NULL,
        month_label    TEXT NOT NULL,
        source_note    TEXT NOT NULL,
        uploaded_by    TEXT NOT NULL,
        uploaded_at    TIMESTAMPTZ NOT NULL,
        archive_sha256 TEXT NOT NULL,
        row_count      INTEGER NOT NULL,
        net_amount     NUMERIC NOT NULL,
        source         TEXT NOT NULL DEFAULT 'pscode3_xlsx',
        recorded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS secondary_sku_load_provenance_latest_idx
        ON secondary_sku_load_provenance (fy, month_label, uploaded_at DESC);
    `,
  },
  {
    id: "075_productwise_secondary_sku_seam",
    sql: `
      -- The Product-Wise CRM is the Aug-26-onward order-register source.  Keep
      -- its stable RET#/DIST# identifiers beside legacy name-based fields; old
      -- rows intentionally stay null so no historical identity is invented.
      ALTER TABLE secondary_sku_line
        ADD COLUMN IF NOT EXISTS dealer_id TEXT,
        ADD COLUMN IF NOT EXISTS cp_code TEXT;
      CREATE INDEX IF NOT EXISTS sec_sku_line_fy_dealer_id_idx
        ON secondary_sku_line (fy, dealer_id);
      CREATE INDEX IF NOT EXISTS sec_sku_line_fy_cp_code_idx
        ON secondary_sku_line (fy, cp_code);

      -- Make the monetary basis explicit at the source seam. Existing protected
      -- PSCode 3 records retain their historic Sub Total basis by default.
      ALTER TABLE secondary_sku_load_provenance
        ADD COLUMN IF NOT EXISTS value_basis TEXT NOT NULL DEFAULT 'PSCode 3 Sub Total';
    `,
  },
  {
    id: "076_productwise_row_freeze_evidence",
    sql: `
      -- Product-Wise rows carry the same permanent freeze evidence as the
      -- shared register_month_state. Legacy rows remain nullable where their
      -- original workbook filename is not known.
      ALTER TABLE secondary_sku_line
        ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS source_file TEXT;
      CREATE INDEX IF NOT EXISTS sec_sku_line_frozen_at_idx
        ON secondary_sku_line (frozen_at);

      ALTER TABLE secondary_sku_load_provenance
        ADD COLUMN IF NOT EXISTS source_file TEXT;

      -- Backfill only the freeze evidence already established by the shared
      -- state table. Never invent a legacy source filename.
      UPDATE secondary_sku_line ssl
         SET frozen_at = rms.frozen_at
        FROM register_month_state rms
       WHERE rms.fy = ssl.fy
         AND rms.month_label = ssl.month_label
         AND rms.frozen_at IS NOT NULL
         AND ssl.frozen_at IS NULL;

      UPDATE secondary_sku_line
         SET source_file = 'Product-Wise-Secondary-Order-Report_29_6569_19-Aug-2026_1787135138176.xlsx'
       WHERE source = 'productwise_xlsx'
         AND month_label = 'Aug-26'
         AND source_file IS NULL;
      -- A database which saw migration 077 before this rebased migration
      -- already protects provenance with an append-only trigger. Temporarily
      -- pause that one trigger only for this one-time, deterministic legacy
      -- filename enrichment, then restore it before the migration commits.
      DO $$
      DECLARE
        trigger_exists BOOLEAN;
      BEGIN
        SELECT EXISTS (
          SELECT 1 FROM pg_trigger
           WHERE tgrelid = 'secondary_sku_load_provenance'::regclass
             AND tgname = 'secondary_sku_load_provenance_immutable'
             AND NOT tgisinternal
        ) INTO trigger_exists;
        IF trigger_exists THEN
          EXECUTE 'ALTER TABLE secondary_sku_load_provenance DISABLE TRIGGER secondary_sku_load_provenance_immutable';
        END IF;
        UPDATE secondary_sku_load_provenance
           SET source_file = 'Product-Wise-Secondary-Order-Report_29_6569_19-Aug-2026_1787135138176.xlsx'
         WHERE source = 'productwise_xlsx'
           AND month_label = 'Aug-26'
           AND source_file IS NULL;
        IF trigger_exists THEN
          EXECUTE 'ALTER TABLE secondary_sku_load_provenance ENABLE TRIGGER secondary_sku_load_provenance_immutable';
        END IF;
      END
      $$;
    `,
  },
  {
    id: "077_productwise_month_immutability",
    sql: `
      ALTER TABLE secondary_sku_load_provenance
        ADD COLUMN IF NOT EXISTS controls JSONB NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

      CREATE TABLE IF NOT EXISTS secondary_sku_month_state (
        fy TEXT NOT NULL, month_label TEXT NOT NULL, source TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('in_progress', 'frozen_verified')),
        source_fingerprint TEXT NOT NULL, controls JSONB NOT NULL,
        source_note TEXT NOT NULL, uploaded_by TEXT NOT NULL, uploaded_at TIMESTAMPTZ NOT NULL,
        verified_at TIMESTAMPTZ NOT NULL, closed_at TIMESTAMPTZ,
        PRIMARY KEY (fy, month_label, source)
      );

      CREATE OR REPLACE FUNCTION prevent_secondary_sku_provenance_mutation()
      RETURNS TRIGGER AS $$ BEGIN
        RAISE EXCEPTION 'secondary_sku_load_provenance is append-only';
      END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS secondary_sku_load_provenance_immutable ON secondary_sku_load_provenance;
      CREATE TRIGGER secondary_sku_load_provenance_immutable
        BEFORE UPDATE OR DELETE ON secondary_sku_load_provenance
        FOR EACH ROW EXECUTE FUNCTION prevent_secondary_sku_provenance_mutation();
    `,
  },
  {
    id: "078_remove_productwise_override_path",
    sql: `
      -- 077 was applied in development before the strict no-override policy
      -- was settled. Production receives strict 077; this cleans that earlier
      -- development-only artifact without granting any writer an exception.
      DROP TABLE IF EXISTS secondary_sku_month_override_audit;
      DROP FUNCTION IF EXISTS prevent_secondary_sku_override_audit_mutation();
    `,
  },
  {
    id: "079_seasonal_curve_history",
    sql: `
      CREATE TABLE IF NOT EXISTS seasonal_curve (
        id                  BIGSERIAL PRIMARY KEY,
        fiscal_years_used   TEXT[]      NOT NULL CHECK (cardinality(fiscal_years_used) > 0),
        month_weights       NUMERIC[]   NOT NULL CHECK (cardinality(month_weights) = 12),
        quarter_weights     NUMERIC[]   NOT NULL CHECK (cardinality(quarter_weights) = 4),
        month_share_stddev  NUMERIC[]   NOT NULL CHECK (cardinality(month_share_stddev) = 12),
        month_share_ranges  JSONB       NOT NULL,
        built_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        built_from          TEXT        NOT NULL CHECK (built_from IN ('auto_rebuild', 'manual')),
        is_active           BOOLEAN     NOT NULL DEFAULT FALSE,
        source_rows         JSONB       NOT NULL,
        source_net          JSONB       NOT NULL,
        delta               JSONB
      );

      CREATE UNIQUE INDEX IF NOT EXISTS seasonal_curve_one_active_idx
        ON seasonal_curve (is_active) WHERE is_active;

      CREATE OR REPLACE FUNCTION prevent_seasonal_curve_history_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'seasonal_curve history is append-only';
        END IF;
        IF NEW.fiscal_years_used IS DISTINCT FROM OLD.fiscal_years_used
           OR NEW.month_weights IS DISTINCT FROM OLD.month_weights
           OR NEW.quarter_weights IS DISTINCT FROM OLD.quarter_weights
           OR NEW.month_share_stddev IS DISTINCT FROM OLD.month_share_stddev
           OR NEW.month_share_ranges IS DISTINCT FROM OLD.month_share_ranges
           OR NEW.built_at IS DISTINCT FROM OLD.built_at
           OR NEW.built_from IS DISTINCT FROM OLD.built_from
           OR NEW.source_rows IS DISTINCT FROM OLD.source_rows
           OR NEW.source_net IS DISTINCT FROM OLD.source_net
           OR NEW.delta IS DISTINCT FROM OLD.delta THEN
          RAISE EXCEPTION 'seasonal_curve versions cannot be overwritten';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS seasonal_curve_history_immutable ON seasonal_curve;
      CREATE TRIGGER seasonal_curve_history_immutable
        BEFORE UPDATE OR DELETE ON seasonal_curve
        FOR EACH ROW EXECUTE FUNCTION prevent_seasonal_curve_history_mutation();
    `,
  },
  {
    id: "080_seasonal_curve_source_basis",
    sql: `
      -- The selected source can differ by frozen-register generation: a full
      -- channel classification is stronger than a legacy territory flag, while
      -- an entirely unclassified historical file must remain visible as such.
      ALTER TABLE seasonal_curve
        ADD COLUMN IF NOT EXISTS source_basis JSONB NOT NULL DEFAULT '{}'::jsonb;

      CREATE OR REPLACE FUNCTION prevent_seasonal_curve_history_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'seasonal_curve history is append-only';
        END IF;
        IF NEW.fiscal_years_used IS DISTINCT FROM OLD.fiscal_years_used
           OR NEW.month_weights IS DISTINCT FROM OLD.month_weights
           OR NEW.quarter_weights IS DISTINCT FROM OLD.quarter_weights
           OR NEW.month_share_stddev IS DISTINCT FROM OLD.month_share_stddev
           OR NEW.month_share_ranges IS DISTINCT FROM OLD.month_share_ranges
           OR NEW.built_at IS DISTINCT FROM OLD.built_at
           OR NEW.built_from IS DISTINCT FROM OLD.built_from
           OR NEW.source_rows IS DISTINCT FROM OLD.source_rows
           OR NEW.source_net IS DISTINCT FROM OLD.source_net
           OR NEW.source_basis IS DISTINCT FROM OLD.source_basis
           OR NEW.delta IS DISTINCT FROM OLD.delta THEN
          RAISE EXCEPTION 'seasonal_curve versions cannot be overwritten';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `,
  },
  {
    id: "081_frozen_drift_audit",
    sql: `
      CREATE TABLE IF NOT EXISTS frozen_drift_check (
        id SERIAL PRIMARY KEY, fy TEXT NOT NULL, month_label TEXT NOT NULL,
        checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        app_rows INTEGER NOT NULL, app_amount NUMERIC NOT NULL,
        sheet_rows INTEGER, sheet_amount NUMERIC, row_delta INTEGER, net_delta NUMERIC,
        status TEXT NOT NULL CHECK (status IN ('match', 'drift', 'sheet_unreadable')),
        evidence JSONB NOT NULL, source_fingerprint TEXT, preview_hash TEXT,
        resolution TEXT CHECK (resolution IN ('accepted', 'ignored', 'refreshed')),
        resolved_at TIMESTAMPTZ, resolved_by TEXT, resolution_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS frozen_drift_check_fy_month_checked_idx
        ON frozen_drift_check (fy, month_label, checked_at DESC);
      CREATE TABLE IF NOT EXISTS frozen_drift_archive (
        id SERIAL PRIMARY KEY, drift_check_id INTEGER NOT NULL REFERENCES frozen_drift_check(id),
        fy TEXT NOT NULL, month_label TEXT NOT NULL,
        archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        operator TEXT NOT NULL, reason TEXT NOT NULL, rows JSONB NOT NULL
      );
      CREATE OR REPLACE FUNCTION frozen_drift_evidence_immutable()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.evidence IS DISTINCT FROM OLD.evidence
           OR NEW.fy IS DISTINCT FROM OLD.fy OR NEW.month_label IS DISTINCT FROM OLD.month_label
           OR NEW.app_rows IS DISTINCT FROM OLD.app_rows OR NEW.app_amount IS DISTINCT FROM OLD.app_amount
           OR NEW.sheet_rows IS DISTINCT FROM OLD.sheet_rows OR NEW.sheet_amount IS DISTINCT FROM OLD.sheet_amount
           OR NEW.row_delta IS DISTINCT FROM OLD.row_delta OR NEW.net_delta IS DISTINCT FROM OLD.net_delta
           OR NEW.status IS DISTINCT FROM OLD.status OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
           OR NEW.preview_hash IS DISTINCT FROM OLD.preview_hash THEN
          RAISE EXCEPTION 'frozen drift evidence is immutable';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS frozen_drift_evidence_immutable ON frozen_drift_check;
      CREATE TRIGGER frozen_drift_evidence_immutable BEFORE UPDATE ON frozen_drift_check
        FOR EACH ROW EXECUTE FUNCTION frozen_drift_evidence_immutable();
    `,
  },
  {
    id: "082_frozen_drift_refreshed_resolution",
    sql: `
      ALTER TABLE frozen_drift_check
        DROP CONSTRAINT IF EXISTS frozen_drift_check_resolution_check;
      ALTER TABLE frozen_drift_check
        ADD CONSTRAINT frozen_drift_check_resolution_check
        CHECK (resolution IS NULL OR resolution IN ('accepted', 'ignored', 'refreshed'));
    `,
  },
  {
    id: "083_frozen_drift_convergence_guards",
    sql: `
      -- Drizzle may have created these tables before inline migrations ran.
      -- Reassert every integrity rule without assuming which creation path won.
      ALTER TABLE frozen_drift_check
        DROP CONSTRAINT IF EXISTS frozen_drift_check_status_check;
      ALTER TABLE frozen_drift_check
        ADD CONSTRAINT frozen_drift_check_status_check
        CHECK (status IN ('match', 'drift', 'sheet_unreadable'));
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conrelid = 'frozen_drift_archive'::regclass
             AND contype = 'f'
             AND confrelid = 'frozen_drift_check'::regclass
        ) THEN
          ALTER TABLE frozen_drift_archive
            ADD CONSTRAINT frozen_drift_archive_drift_check_fk
            FOREIGN KEY (drift_check_id) REFERENCES frozen_drift_check(id);
        END IF;
      END $$;
      CREATE OR REPLACE FUNCTION frozen_drift_evidence_immutable()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.evidence IS DISTINCT FROM OLD.evidence
           OR NEW.fy IS DISTINCT FROM OLD.fy OR NEW.month_label IS DISTINCT FROM OLD.month_label
           OR NEW.app_rows IS DISTINCT FROM OLD.app_rows OR NEW.app_amount IS DISTINCT FROM OLD.app_amount
           OR NEW.sheet_rows IS DISTINCT FROM OLD.sheet_rows OR NEW.sheet_amount IS DISTINCT FROM OLD.sheet_amount
           OR NEW.row_delta IS DISTINCT FROM OLD.row_delta OR NEW.net_delta IS DISTINCT FROM OLD.net_delta
           OR NEW.status IS DISTINCT FROM OLD.status OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
           OR NEW.preview_hash IS DISTINCT FROM OLD.preview_hash THEN
          RAISE EXCEPTION 'frozen drift evidence is immutable';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS frozen_drift_evidence_immutable ON frozen_drift_check;
      CREATE TRIGGER frozen_drift_evidence_immutable BEFORE UPDATE ON frozen_drift_check
        FOR EACH ROW EXECUTE FUNCTION frozen_drift_evidence_immutable();
    `,
  },
  {
    id: "084_user_activity_telemetry",
    sql: `
      CREATE TABLE IF NOT EXISTS user_activity_sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        auth_session_id INTEGER NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
        client_tab_id TEXT NOT NULL,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_state TEXT NOT NULL DEFAULT 'active' CHECK (last_state IN ('active', 'idle')),
        ended_at TIMESTAMPTZ,
        CONSTRAINT user_activity_sessions_user_session_tab_unique UNIQUE (user_id, auth_session_id, client_tab_id)
      );
      CREATE INDEX IF NOT EXISTS user_activity_sessions_user_seen_idx ON user_activity_sessions (user_id, last_seen_at);
      CREATE TABLE IF NOT EXISTS user_activity_daily_rollups (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        activity_date DATE NOT NULL,
        active_ms BIGINT NOT NULL DEFAULT 0,
        idle_ms BIGINT NOT NULL DEFAULT 0,
        first_seen_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ,
        page_views INTEGER NOT NULL DEFAULT 0,
        action_count INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT user_activity_daily_rollups_user_date_unique UNIQUE (user_id, activity_date)
      );
      CREATE INDEX IF NOT EXISTS user_activity_daily_rollups_date_idx ON user_activity_daily_rollups (activity_date, user_id);
      CREATE TABLE IF NOT EXISTS user_activity_events (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        activity_session_id INTEGER NOT NULL REFERENCES user_activity_sessions(id) ON DELETE CASCADE,
        client_event_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('page_view', 'heartbeat', 'action', 'session_end')),
        path TEXT,
        action TEXT,
        state TEXT CHECK (state IS NULL OR state IN ('active', 'idle')),
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT user_activity_events_session_client_event_unique UNIQUE (activity_session_id, client_event_id)
      );
      CREATE INDEX IF NOT EXISTS user_activity_events_user_occurred_idx ON user_activity_events (user_id, occurred_at);
      CREATE INDEX IF NOT EXISTS user_activity_events_session_occurred_idx ON user_activity_events (activity_session_id, occurred_at);
    `,
  },
  {
    id: "085_user_activity_effective_state",
    sql: `
      UPDATE user_activity_events SET state = 'active' WHERE state IS NULL;
      ALTER TABLE user_activity_events ALTER COLUMN state SET DEFAULT 'active';
      ALTER TABLE user_activity_events ALTER COLUMN state SET NOT NULL;
      ALTER TABLE user_activity_events DROP CONSTRAINT IF EXISTS user_activity_events_state_check;
      ALTER TABLE user_activity_events ADD CONSTRAINT user_activity_events_state_check CHECK (state IN ('active', 'idle'));
    `,
  },
  {
    id: "086_first_login_password_change",
    sql: `
      -- Existing accounts retain their current access. New accounts and
      -- password resets explicitly opt into the first-login change flow.
      ALTER TABLE auth_users
        ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
    `,
  },
  {
    id: "087_register_monthly_ingest_ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS register_monthly_ingest_ledger (
        id SERIAL PRIMARY KEY,
        run_id TEXT NOT NULL, actor TEXT NOT NULL CHECK (actor IN ('scheduler','manual')), operator TEXT, source TEXT NOT NULL,
        fy TEXT NOT NULL, month_label TEXT NOT NULL,
        attempted_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ,
        outcome TEXT NOT NULL CHECK (outcome IN ('replaced','frozen-skipped','frozen-anchored','aborted-short-read','rejected-shrink','failed')),
        write_atomicity TEXT NOT NULL CHECK (write_atomicity IN ('same-replacement-transaction','ledger-only-transaction','post-rollback')),
        rows_written INTEGER, projected_rows_written INTEGER,
        before_rows INTEGER, before_amount NUMERIC, before_fingerprint TEXT,
        source_rows INTEGER NOT NULL, source_amount NUMERIC NOT NULL, source_fingerprint TEXT NOT NULL,
        after_rows INTEGER, after_amount NUMERIC, after_fingerprint TEXT,
        source_row_delta INTEGER, source_amount_delta NUMERIC, source_shrink BOOLEAN,
        actual_row_delta INTEGER, actual_amount_delta NUMERIC, actual_shrink BOOLEAN,
        added_rows INTEGER, removed_rows INTEGER, changed_rows INTEGER,
        confidence TEXT CHECK (confidence IS NULL OR confidence = 'heuristic'), unpaired_residual_rows INTEGER,
        spreadsheet_id TEXT, source_evidence JSONB NOT NULL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS register_monthly_ingest_ledger_fy_month_attempt_idx
        ON register_monthly_ingest_ledger (fy, month_label, attempted_at);
      CREATE INDEX IF NOT EXISTS register_monthly_ingest_ledger_run_idx
        ON register_monthly_ingest_ledger (run_id);
    `,
  },
  {
    id: "088_register_anchor_after_rejection",
    sql: `
      -- Publish schema reconciliation can leave the migration ledger ahead of
      -- the physical relation. Recreate the complete 087 table contract before
      -- extending it so this migration is safe in that state.
      CREATE TABLE IF NOT EXISTS register_monthly_ingest_ledger (
        id SERIAL PRIMARY KEY,
        run_id TEXT NOT NULL, actor TEXT NOT NULL CHECK (actor IN ('scheduler','manual')), operator TEXT, source TEXT NOT NULL,
        fy TEXT NOT NULL, month_label TEXT NOT NULL,
        attempted_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ,
        outcome TEXT NOT NULL CHECK (outcome IN ('replaced','frozen-skipped','frozen-anchored','anchored-after-rejected-read','aborted-short-read','rejected-shrink','failed')),
        write_atomicity TEXT NOT NULL CHECK (write_atomicity IN ('same-replacement-transaction','ledger-only-transaction','post-rollback')),
        rows_written INTEGER, projected_rows_written INTEGER,
        before_rows INTEGER, before_amount NUMERIC, before_fingerprint TEXT,
        source_rows INTEGER NOT NULL, source_amount NUMERIC NOT NULL, source_fingerprint TEXT NOT NULL,
        after_rows INTEGER, after_amount NUMERIC, after_fingerprint TEXT,
        source_row_delta INTEGER, source_amount_delta NUMERIC, source_shrink BOOLEAN,
        actual_row_delta INTEGER, actual_amount_delta NUMERIC, actual_shrink BOOLEAN,
        added_rows INTEGER, removed_rows INTEGER, changed_rows INTEGER,
        confidence TEXT CHECK (confidence IS NULL OR confidence = 'heuristic'), unpaired_residual_rows INTEGER,
        spreadsheet_id TEXT, source_evidence JSONB NOT NULL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS register_monthly_ingest_ledger_fy_month_attempt_idx
        ON register_monthly_ingest_ledger (fy, month_label, attempted_at);
      CREATE INDEX IF NOT EXISTS register_monthly_ingest_ledger_run_idx
        ON register_monthly_ingest_ledger (run_id);
      ALTER TABLE register_monthly_ingest_ledger
        DROP CONSTRAINT IF EXISTS register_monthly_ingest_ledger_outcome_check;
      ALTER TABLE register_monthly_ingest_ledger
        ADD CONSTRAINT register_monthly_ingest_ledger_outcome_check
        CHECK (outcome IN (
          'replaced',
          'frozen-skipped',
          'frozen-anchored',
          'anchored-after-rejected-read',
          'aborted-short-read',
          'rejected-shrink',
          'failed'
        ));
    `,
  },
  {
    id: "089_align_scheme_reward_slab_generated_names",
    sql: `
      -- Development originally created the final-shape table as scheme_slab,
      -- then migration 019 renamed only the table and explicit business index.
      -- Preserve the generated sequence and primary key while aligning their
      -- historical names with databases that created scheme_reward_slab directly.
      DO $do$
      BEGIN
        IF to_regclass('public.scheme_slab_id_seq') IS NOT NULL
           AND to_regclass('public.scheme_reward_slab_id_seq') IS NULL THEN
          ALTER SEQUENCE scheme_slab_id_seq
            RENAME TO scheme_reward_slab_id_seq;
        END IF;

        IF to_regclass('public.scheme_reward_slab') IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM pg_constraint
             WHERE conrelid = 'public.scheme_reward_slab'::regclass
               AND conname = 'scheme_slab_pkey'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM pg_constraint
             WHERE conrelid = 'public.scheme_reward_slab'::regclass
               AND conname = 'scheme_reward_slab_pkey'
           ) THEN
          ALTER TABLE scheme_reward_slab
            RENAME CONSTRAINT scheme_slab_pkey TO scheme_reward_slab_pkey;
        END IF;
      END
      $do$;
    `,
  },
  {
    id: "090_register_premature_freeze_reconciliation_outcome",
    sql: `
      ALTER TABLE register_monthly_ingest_ledger
        DROP CONSTRAINT IF EXISTS register_monthly_ingest_ledger_outcome_check;
      ALTER TABLE register_monthly_ingest_ledger
        ADD CONSTRAINT register_monthly_ingest_ledger_outcome_check
        CHECK (outcome IN (
          'replaced',
          'frozen-skipped',
          'frozen-anchored',
          'anchored-after-rejected-read',
          'premature-freeze-reconciled',
          'aborted-short-read',
          'rejected-shrink',
          'failed'
        ));
    `,
  },
  {
    id: "091_frozen_drift_premature_freeze_resolution",
    sql: `
      ALTER TABLE frozen_drift_check
        DROP CONSTRAINT IF EXISTS frozen_drift_check_resolution_check;
      ALTER TABLE frozen_drift_check
        ADD CONSTRAINT frozen_drift_check_resolution_check
        CHECK (
          resolution IS NULL OR resolution IN (
            'accepted',
            'ignored',
            'refreshed',
            'premature-freeze-reconciled'
          )
        );
    `,
  },
  {
    id: "092_hourly_register_sync_scheduler_state",
    sql: `
      CREATE TABLE IF NOT EXISTS register_sync_scheduler_state (
        job_name TEXT PRIMARY KEY,
        last_successful_run_key TEXT,
        last_attempted_run_key TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        drive_requests INTEGER,
        elapsed_ms INTEGER,
        rows_scanned INTEGER,
        months_touched INTEGER,
        detail TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT register_sync_scheduler_state_status_check
          CHECK (status IN ('idle', 'running', 'succeeded', 'failed'))
      );
      ALTER TABLE register_sync_scheduler_state
        ADD COLUMN IF NOT EXISTS last_successful_run_key TEXT,
        ADD COLUMN IF NOT EXISTS last_attempted_run_key TEXT,
        ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'idle',
        ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS drive_requests INTEGER,
        ADD COLUMN IF NOT EXISTS elapsed_ms INTEGER,
        ADD COLUMN IF NOT EXISTS rows_scanned INTEGER,
        ADD COLUMN IF NOT EXISTS months_touched INTEGER,
        ADD COLUMN IF NOT EXISTS detail TEXT,
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
      ALTER TABLE register_sync_scheduler_state
        DROP CONSTRAINT IF EXISTS register_sync_scheduler_state_status_check;
      ALTER TABLE register_sync_scheduler_state
        ADD CONSTRAINT register_sync_scheduler_state_status_check
        CHECK (status IN ('idle', 'running', 'succeeded', 'failed'));
    `,
  },
  {
    id: "093_canonical_item_category_registry",
    sql: `
      CREATE TABLE IF NOT EXISTS canonical_item_category_registry (
        id BIGSERIAL PRIMARY KEY,
        item_code TEXT NOT NULL,
        canonical_category TEXT NOT NULL,
        effective_from DATE,
        effective_to DATE,
        source_vocabulary TEXT NOT NULL,
        source_value TEXT NOT NULL,
        review_status TEXT NOT NULL DEFAULT 'seeded',
        set_by TEXT NOT NULL,
        set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT canonical_item_category_registry_category_check CHECK (
          canonical_category IN (
            'WATER TANK', 'AGRI', 'UPVC', 'CPVC', 'SWR', 'PPR', 'HDPE',
            'Garden Pipe', 'COLUMN', 'Corrugated Pipe', 'PTMT / Faucets',
            'CISTERN', 'CP (Chrome-Plated)', 'Sink', 'Sanitaryware',
            'Connection / Waste', 'Hardware'
          )
        ),
        CONSTRAINT canonical_item_category_registry_review_check CHECK (
          review_status IN ('seeded', 'confirmed', 'needs-review')
        ),
        CONSTRAINT canonical_item_category_registry_dates_check CHECK (
          effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from
        ),
        CONSTRAINT canonical_item_category_registry_assignment_uq UNIQUE NULLS NOT DISTINCT (
          item_code, canonical_category, effective_from
        )
      );

      CREATE INDEX IF NOT EXISTS canonical_item_category_registry_code_idx
        ON canonical_item_category_registry (item_code);
      CREATE INDEX IF NOT EXISTS canonical_item_category_registry_category_idx
        ON canonical_item_category_registry (canonical_category);
      CREATE INDEX IF NOT EXISTS canonical_item_category_registry_effective_idx
        ON canonical_item_category_registry (item_code, effective_from, effective_to);

      CREATE TABLE IF NOT EXISTS canonical_item_category_source (
        item_code TEXT NOT NULL,
        registry_id BIGINT REFERENCES canonical_item_category_registry(id) ON DELETE SET NULL,
        source_vocabulary TEXT NOT NULL,
        source_value TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT canonical_item_category_source_uq UNIQUE (
          item_code, source_vocabulary, source_value
        )
      );

      CREATE INDEX IF NOT EXISTS canonical_item_category_source_vocabulary_idx
        ON canonical_item_category_source (source_vocabulary, source_value);
      CREATE INDEX IF NOT EXISTS canonical_item_category_source_code_idx
        ON canonical_item_category_source (item_code);

      -- The primary register is authoritative. Seed FY2026-27, whose sold-code
      -- coverage was the approved foundation for this registry.
      WITH primary_candidates AS (
        SELECT DISTINCT ON (UPPER(BTRIM(code)))
          UPPER(BTRIM(code)) AS item_code,
          group_canon AS canonical_category,
          group_canon AS source_value
        FROM sale_line_all
        WHERE version_status = 'current'
          AND fy = '2026-27'
          AND NULLIF(BTRIM(code), '') IS NOT NULL
          AND group_canon IN (
            'WATER TANK', 'AGRI', 'UPVC', 'CPVC', 'SWR', 'PPR', 'HDPE',
            'Garden Pipe', 'COLUMN', 'Corrugated Pipe', 'PTMT / Faucets',
            'CISTERN', 'CP (Chrome-Plated)', 'Sink', 'Sanitaryware',
            'Connection / Waste', 'Hardware'
          )
        ORDER BY UPPER(BTRIM(code)), group_canon
      )
      INSERT INTO canonical_item_category_registry (
        item_code, canonical_category, effective_from, effective_to,
        source_vocabulary, source_value, review_status, set_by
      )
      SELECT
        item_code, canonical_category, NULL, NULL,
        'group_canon', source_value, 'seeded',
        'migration:093_canonical_item_category_registry'
      FROM primary_candidates
      ON CONFLICT (item_code, canonical_category, effective_from) DO NOTHING;

      -- Keep older sold codes covered without letting historical relabelling
      -- create extra current assignments. FY2026-27 remains authoritative;
      -- only codes absent from that seed receive their latest historical label.
      WITH historical_candidates AS (
        SELECT DISTINCT ON (UPPER(BTRIM(code)))
          UPPER(BTRIM(code)) AS item_code,
          group_canon AS canonical_category
        FROM sale_line_all
        WHERE version_status = 'current'
          AND NULLIF(BTRIM(code), '') IS NOT NULL
          AND group_canon IN (
            'WATER TANK', 'AGRI', 'UPVC', 'CPVC', 'SWR', 'PPR', 'HDPE',
            'Garden Pipe', 'COLUMN', 'Corrugated Pipe', 'PTMT / Faucets',
            'CISTERN', 'CP (Chrome-Plated)', 'Sink', 'Sanitaryware',
            'Connection / Waste', 'Hardware'
          )
        ORDER BY
          UPPER(BTRIM(code)),
          CASE fy
            WHEN '2026-27' THEN 4
            WHEN '2025-26' THEN 3
            WHEN '2024-25' THEN 2
            WHEN '2023-24' THEN 1
            ELSE 0
          END DESC,
          group_canon
      ),
      uncovered_historical AS (
        SELECT h.*
        FROM historical_candidates h
        WHERE NOT EXISTS (
          SELECT 1
          FROM canonical_item_category_registry r
          WHERE r.item_code = h.item_code
            AND r.effective_from IS NULL
        )
      )
      INSERT INTO canonical_item_category_registry (
        item_code, canonical_category, effective_from, effective_to,
        source_vocabulary, source_value, review_status, set_by
      )
      SELECT
        item_code, canonical_category, NULL, NULL,
        'group_canon', canonical_category, 'seeded',
        'migration:093_canonical_item_category_registry'
      FROM uncovered_historical
      ON CONFLICT (item_code, canonical_category, effective_from) DO NOTHING;

      -- Collect every approved source vocabulary as provenance. Exact aliases use
      -- the same 17-category vocabulary; broad MRP members are handled below.
      WITH source_values AS (
        SELECT UPPER(BTRIM(code)) AS item_code, 'group_canon'::text AS source_vocabulary,
               group_canon AS source_value, group_canon AS canonical_category, 1 AS source_priority
        FROM sale_line_all
        WHERE version_status = 'current' AND fy = '2026-27'
        UNION ALL
        SELECT UPPER(BTRIM(code)), 'item_master.item_group', item_group,
          CASE UPPER(BTRIM(item_group))
            WHEN 'WATER TANK' THEN 'WATER TANK' WHEN 'WT LID' THEN 'WATER TANK' WHEN 'WATER TANKS' THEN 'WATER TANK'
            WHEN 'AGRI' THEN 'AGRI' WHEN 'AGRITEC' THEN 'AGRI' WHEN 'AGRI AGRITEC' THEN 'AGRI'
            WHEN 'UPVC' THEN 'UPVC' WHEN 'UPVC PIPE' THEN 'UPVC' WHEN 'OPVC' THEN 'UPVC' WHEN 'UPVC AQUAFRESH' THEN 'UPVC'
            WHEN 'CPVC' THEN 'CPVC' WHEN 'CPVC PIPE' THEN 'CPVC' WHEN 'CPVC DURALIFE' THEN 'CPVC'
            WHEN 'SWR' THEN 'SWR' WHEN 'SWR DRAINTECH' THEN 'SWR'
            WHEN 'PPR' THEN 'PPR' WHEN 'HDPE PIPE' THEN 'HDPE'
            WHEN 'GARDEN PIPE' THEN 'Garden Pipe' WHEN 'P.V.C. GARDEN PIPE' THEN 'Garden Pipe'
            WHEN 'COLUMN' THEN 'COLUMN' WHEN 'COLUMN PIPE' THEN 'COLUMN'
            WHEN 'CORRUGATED PIPE' THEN 'Corrugated Pipe'
            WHEN 'PTMT' THEN 'PTMT / Faucets' WHEN 'SEAT COVER' THEN 'PTMT / Faucets'
            WHEN 'P.T.M.T. SYMET' THEN 'PTMT / Faucets' WHEN 'VIGNETTE' THEN 'PTMT / Faucets'
            WHEN 'CISTERN' THEN 'CISTERN' WHEN 'CISTERNS & SEAT COVERS' THEN 'CISTERN'
            WHEN 'C P' THEN 'CP (Chrome-Plated)' WHEN 'CP' THEN 'CP (Chrome-Plated)'
            WHEN 'CP ACCESSORIES' THEN 'CP (Chrome-Plated)' WHEN 'CP ALLIED' THEN 'CP (Chrome-Plated)'
            WHEN 'C.P-CDA' THEN 'CP (Chrome-Plated)' WHEN 'C.P. 5000 SERIES' THEN 'CP (Chrome-Plated)'
            WHEN 'C.P. 6000 SERIES' THEN 'CP (Chrome-Plated)' WHEN 'C.P. 7000 SERIES' THEN 'CP (Chrome-Plated)'
            WHEN 'C.P. 8000 SERIES' THEN 'CP (Chrome-Plated)' WHEN 'C.P. 9000 SERIES' THEN 'CP (Chrome-Plated)'
            WHEN 'SINK' THEN 'Sink' WHEN 'PLATE RACK' THEN 'Sink' WHEN 'CABINET' THEN 'Sink'
            WHEN 'GLASS' THEN 'Sink' WHEN 'S.STEEL SINK' THEN 'Sink'
            WHEN 'SANITARYWARE' THEN 'Sanitaryware' WHEN 'GEYSER' THEN 'Sanitaryware' WHEN 'WATER HEATER' THEN 'Sanitaryware'
            WHEN 'WASTE PIPE' THEN 'Connection / Waste' WHEN 'CONNECTION' THEN 'Connection / Waste'
            WHEN 'CONECTION' THEN 'Connection / Waste' WHEN 'FLOOR TRAP' THEN 'Connection / Waste'
            WHEN 'COCKROACH TRAPS & GRATINGS' THEN 'Connection / Waste' WHEN 'MANHOLE COVER' THEN 'Connection / Waste'
            WHEN 'HARDWARE' THEN 'Hardware' WHEN 'TEFELON TAPE' THEN 'Hardware'
            WHEN 'QUAA' THEN 'Hardware' WHEN 'OTHER' THEN 'Hardware'
          END, 2
        FROM item_master
        WHERE NULLIF(BTRIM(code), '') IS NOT NULL AND NULLIF(BTRIM(item_group), '') IS NOT NULL
        UNION ALL
        SELECT UPPER(BTRIM(code)), 'item_master.segment_canon', segment_canon,
          CASE
            WHEN segment_canon IN (
              'WATER TANK', 'AGRI', 'UPVC', 'CPVC', 'SWR', 'PPR', 'HDPE',
              'Garden Pipe', 'COLUMN', 'Corrugated Pipe', 'PTMT / Faucets',
              'CISTERN', 'CP (Chrome-Plated)', 'Sink', 'Sanitaryware',
              'Connection / Waste', 'Hardware'
            ) THEN segment_canon
          END, 3
        FROM item_master
        WHERE NULLIF(BTRIM(code), '') IS NOT NULL AND NULLIF(BTRIM(segment_canon), '') IS NOT NULL
        UNION ALL
        SELECT UPPER(BTRIM(item_code)), 'secondary_sku_line.segment_canon', segment_canon,
          CASE
            WHEN segment_canon IN (
              'WATER TANK', 'AGRI', 'UPVC', 'CPVC', 'SWR', 'PPR', 'HDPE',
              'Garden Pipe', 'COLUMN', 'Corrugated Pipe', 'PTMT / Faucets',
              'CISTERN', 'CP (Chrome-Plated)', 'Sink', 'Sanitaryware',
              'Connection / Waste', 'Hardware'
            ) THEN segment_canon
          END, 4
        FROM secondary_sku_line
        WHERE NULLIF(BTRIM(item_code), '') IS NOT NULL AND NULLIF(BTRIM(segment_canon), '') IS NOT NULL
        UNION ALL
        SELECT UPPER(BTRIM(product_code)), 'secondary_order_line.category_name', category_name,
          CASE UPPER(BTRIM(category_name))
            WHEN 'WATER TANK' THEN 'WATER TANK' WHEN 'WT LID' THEN 'WATER TANK' WHEN 'WATER TANKS' THEN 'WATER TANK'
            WHEN 'AGRI' THEN 'AGRI' WHEN 'AGRITEC' THEN 'AGRI' WHEN 'AGRI AGRITEC' THEN 'AGRI'
            WHEN 'UPVC' THEN 'UPVC' WHEN 'UPVC PIPE' THEN 'UPVC' WHEN 'OPVC' THEN 'UPVC' WHEN 'UPVC AQUAFRESH' THEN 'UPVC'
            WHEN 'CPVC' THEN 'CPVC' WHEN 'CPVC PIPE' THEN 'CPVC' WHEN 'CPVC DURALIFE' THEN 'CPVC'
            WHEN 'SWR' THEN 'SWR' WHEN 'SWR DRAINTECH' THEN 'SWR'
            WHEN 'PPR' THEN 'PPR' WHEN 'HDPE PIPE' THEN 'HDPE'
            WHEN 'GARDEN PIPE' THEN 'Garden Pipe' WHEN 'P.V.C. GARDEN PIPE' THEN 'Garden Pipe'
            WHEN 'COLUMN' THEN 'COLUMN' WHEN 'COLUMN PIPE' THEN 'COLUMN'
            WHEN 'CORRUGATED PIPE' THEN 'Corrugated Pipe'
            WHEN 'PTMT' THEN 'PTMT / Faucets' WHEN 'SEAT COVER' THEN 'PTMT / Faucets'
            WHEN 'P.T.M.T. SYMET' THEN 'PTMT / Faucets' WHEN 'VIGNETTE' THEN 'PTMT / Faucets'
            WHEN 'CISTERN' THEN 'CISTERN' WHEN 'CISTERNS & SEAT COVERS' THEN 'CISTERN'
            WHEN 'C P' THEN 'CP (Chrome-Plated)' WHEN 'CP' THEN 'CP (Chrome-Plated)'
            WHEN 'CP ACCESSORIES' THEN 'CP (Chrome-Plated)' WHEN 'CP ALLIED' THEN 'CP (Chrome-Plated)'
            WHEN 'C.P-CDA' THEN 'CP (Chrome-Plated)' WHEN 'C.P. 5000 SERIES' THEN 'CP (Chrome-Plated)'
            WHEN 'C.P. 6000 SERIES' THEN 'CP (Chrome-Plated)' WHEN 'C.P. 7000 SERIES' THEN 'CP (Chrome-Plated)'
            WHEN 'C.P. 8000 SERIES' THEN 'CP (Chrome-Plated)' WHEN 'C.P. 9000 SERIES' THEN 'CP (Chrome-Plated)'
            WHEN 'SINK' THEN 'Sink' WHEN 'PLATE RACK' THEN 'Sink' WHEN 'CABINET' THEN 'Sink'
            WHEN 'GLASS' THEN 'Sink' WHEN 'S.STEEL SINK' THEN 'Sink'
            WHEN 'SANITARYWARE' THEN 'Sanitaryware' WHEN 'GEYSER' THEN 'Sanitaryware'
            WHEN 'WATER HEATER' THEN 'Sanitaryware'
            WHEN 'WASTE PIPE' THEN 'Connection / Waste' WHEN 'CONNECTION' THEN 'Connection / Waste'
            WHEN 'CONECTION' THEN 'Connection / Waste' WHEN 'FLOOR TRAP' THEN 'Connection / Waste'
            WHEN 'COCKROACH TRAPS & GRATINGS' THEN 'Connection / Waste'
            WHEN 'MANHOLE COVER' THEN 'Connection / Waste'
            WHEN 'HARDWARE' THEN 'Hardware' WHEN 'TEFELON TAPE' THEN 'Hardware'
            WHEN 'QUAA' THEN 'Hardware' WHEN 'OTHER' THEN 'Hardware'
          END, 5
        FROM secondary_order_line
        WHERE NULLIF(BTRIM(product_code), '') IS NOT NULL AND NULLIF(BTRIM(category_name), '') IS NOT NULL
      ),
      mapped AS (
        SELECT DISTINCT ON (item_code)
          item_code, source_vocabulary, source_value, canonical_category
        FROM source_values
        WHERE NULLIF(item_code, '') IS NOT NULL
          AND canonical_category IS NOT NULL
        ORDER BY item_code, source_priority, source_vocabulary, source_value
      ),
      uncovered AS (
        SELECT m.*
        FROM mapped m
        WHERE NOT EXISTS (
          SELECT 1
          FROM canonical_item_category_registry r
          WHERE r.item_code = m.item_code
            AND r.effective_from IS NULL
        )
      )
      INSERT INTO canonical_item_category_registry (
        item_code, canonical_category, effective_from, effective_to,
        source_vocabulary, source_value, review_status, set_by
      )
      SELECT
        item_code, canonical_category, NULL, NULL,
        source_vocabulary, source_value, 'seeded',
        'migration:093_canonical_item_category_registry'
      FROM uncovered
      ON CONFLICT (item_code, canonical_category, effective_from) DO NOTHING;

      -- Unambiguous non-composite MRP divisions may classify catalogue-only
      -- codes, but never override a primary/other-source assignment. The broad
      -- Pipes & Fittings division has no one-to-one canonical equivalent.
      WITH active_generation AS (
        SELECT generation_id
        FROM mrp_sync_generation
        WHERE is_active = true
        ORDER BY source_fetched_at DESC
        LIMIT 1
      ),
      mrp_single_candidates AS (
        SELECT DISTINCT ON (UPPER(BTRIM(d.item_code)))
          UPPER(BTRIM(d.item_code)) AS item_code,
          d.source_division AS source_value,
          CASE d.app_segment
            WHEN 'CP' THEN 'CP (Chrome-Plated)'
            WHEN 'PTMT' THEN 'PTMT / Faucets'
            WHEN 'Sanitaryware' THEN 'Sanitaryware'
            WHEN 'Hardware' THEN 'Hardware'
            WHEN 'QUAA & FERN' THEN 'Hardware'
          END AS canonical_category
        FROM mrp_synced_division d
        JOIN active_generation g USING (generation_id)
        JOIN mrp_synced s
          ON s.generation_id = d.generation_id
         AND s.item_code = d.item_code
        WHERE s.division_raw NOT LIKE '%|%'
        ORDER BY UPPER(BTRIM(d.item_code)), d.source_division
      ),
      uncovered_mrp AS (
        SELECT m.*
        FROM mrp_single_candidates m
        WHERE m.canonical_category IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM canonical_item_category_registry r
            WHERE r.item_code = m.item_code
              AND r.effective_from IS NULL
          )
      )
      INSERT INTO canonical_item_category_registry (
        item_code, canonical_category, effective_from, effective_to,
        source_vocabulary, source_value, review_status, set_by
      )
      SELECT
        item_code, canonical_category, NULL, NULL,
        'mrp_synced.division_raw', source_value, 'seeded',
        'migration:093_canonical_item_category_registry'
      FROM uncovered_mrp
      ON CONFLICT (item_code, canonical_category, effective_from) DO NOTHING;

      -- Only pipe-separated MRP composites create multiple assignments.
      -- Pipes & Fittings is deliberately not collapsed to one category; a
      -- code's specific primary/item source supplies its pipe category.
      WITH active_generation AS (
        SELECT generation_id
        FROM mrp_sync_generation
        WHERE is_active = true
        ORDER BY source_fetched_at DESC
        LIMIT 1
      ),
      mrp_mapped AS (
        SELECT DISTINCT
          UPPER(BTRIM(d.item_code)) AS item_code,
          d.source_division AS source_value,
          CASE d.app_segment
            WHEN 'CP' THEN 'CP (Chrome-Plated)'
            WHEN 'PTMT' THEN 'PTMT / Faucets'
            WHEN 'Sanitaryware' THEN 'Sanitaryware'
            WHEN 'Hardware' THEN 'Hardware'
            WHEN 'QUAA & FERN' THEN 'Hardware'
          END AS canonical_category
        FROM mrp_synced_division d
        JOIN active_generation g USING (generation_id)
        JOIN mrp_synced s
          ON s.generation_id = d.generation_id
         AND s.item_code = d.item_code
         AND s.division_raw IN (
           'Ceramic Sanitaryware | PTMT & Plastic Fittings',
           'CP Fittings / Faucets | PTMT & Plastic Fittings | Pipes & Fittings',
           'CP Fittings / Faucets | Ceramic Sanitaryware',
           'CP Fittings / Faucets | PTMT & Plastic Fittings'
         )
      )
      INSERT INTO canonical_item_category_registry (
        item_code, canonical_category, effective_from, effective_to,
        source_vocabulary, source_value, review_status, set_by
      )
      SELECT
        item_code, canonical_category, NULL, NULL,
        'mrp_synced.division_raw', source_value, 'seeded',
        'migration:093_canonical_item_category_registry'
      FROM mrp_mapped
      WHERE canonical_category IS NOT NULL
      ON CONFLICT (item_code, canonical_category, effective_from) DO NOTHING;

      -- Preserve every source observation for an assignment even when the
      -- authoritative group_canon row already occupied the assignment key.
      WITH evidence AS (
        SELECT DISTINCT
          r.item_code,
          r.canonical_category,
          r.source_vocabulary,
          r.source_value
        FROM canonical_item_category_registry r
        UNION ALL
        SELECT DISTINCT
          UPPER(BTRIM(sl.code)) AS item_code,
          sl.group_canon AS canonical_category,
          'group_canon'::text AS source_vocabulary,
          sl.group_canon AS source_value
        FROM sale_line_all sl
        WHERE sl.version_status = 'current'
          AND sl.fy = '2026-27'
          AND sl.group_canon IS NOT NULL
        UNION ALL
        SELECT DISTINCT
          UPPER(BTRIM(d.item_code)),
          CASE d.app_segment
            WHEN 'CP' THEN 'CP (Chrome-Plated)'
            WHEN 'PTMT' THEN 'PTMT / Faucets'
            WHEN 'Sanitaryware' THEN 'Sanitaryware'
            WHEN 'Hardware' THEN 'Hardware'
            WHEN 'QUAA & FERN' THEN 'Hardware'
          END,
          'mrp_synced.division_raw',
          d.source_division
        FROM mrp_synced_division d
        JOIN mrp_sync_generation g ON g.generation_id = d.generation_id AND g.is_active = true
        JOIN mrp_synced s
          ON s.generation_id = d.generation_id
         AND s.item_code = d.item_code
         AND s.division_raw IN (
           'Ceramic Sanitaryware | PTMT & Plastic Fittings',
           'CP Fittings / Faucets | PTMT & Plastic Fittings | Pipes & Fittings',
           'CP Fittings / Faucets | Ceramic Sanitaryware',
           'CP Fittings / Faucets | PTMT & Plastic Fittings'
         )
      )
      INSERT INTO canonical_item_category_source (
        item_code, registry_id, source_vocabulary, source_value
      )
      SELECT e.item_code, r.id, e.source_vocabulary, e.source_value
      FROM evidence e
      JOIN canonical_item_category_registry r
        ON r.item_code = e.item_code
       AND r.canonical_category = e.canonical_category
       AND r.effective_from IS NULL
      WHERE e.canonical_category IS NOT NULL
      ON CONFLICT (item_code, source_vocabulary, source_value) DO NOTHING;

      -- Retain every raw observation from each approved source vocabulary,
      -- including values that cannot yet be translated to one of the 17
      -- categories. Unambiguous one-category codes link directly to the
      -- assignment; ambiguous/composite codes retain item-level provenance.
      WITH raw_evidence AS (
        SELECT DISTINCT UPPER(BTRIM(code)) AS item_code,
          'group_canon'::text AS source_vocabulary, group_canon AS source_value
        FROM sale_line_all
        WHERE version_status = 'current' AND NULLIF(BTRIM(code), '') IS NOT NULL
          AND NULLIF(BTRIM(group_canon), '') IS NOT NULL
        UNION
        SELECT DISTINCT UPPER(BTRIM(code)), 'item_master.item_group', item_group
        FROM item_master
        WHERE NULLIF(BTRIM(code), '') IS NOT NULL AND NULLIF(BTRIM(item_group), '') IS NOT NULL
        UNION
        SELECT DISTINCT UPPER(BTRIM(code)), 'item_master.segment_canon', segment_canon
        FROM item_master
        WHERE NULLIF(BTRIM(code), '') IS NOT NULL AND NULLIF(BTRIM(segment_canon), '') IS NOT NULL
        UNION
        SELECT DISTINCT UPPER(BTRIM(item_code)), 'secondary_sku_line.segment_canon', segment_canon
        FROM secondary_sku_line
        WHERE NULLIF(BTRIM(item_code), '') IS NOT NULL AND NULLIF(BTRIM(segment_canon), '') IS NOT NULL
        UNION
        SELECT DISTINCT UPPER(BTRIM(product_code)), 'secondary_order_line.category_name', category_name
        FROM secondary_order_line
        WHERE NULLIF(BTRIM(product_code), '') IS NOT NULL AND NULLIF(BTRIM(category_name), '') IS NOT NULL
        UNION
        SELECT DISTINCT UPPER(BTRIM(s.item_code)), 'mrp_synced.division_raw', s.division_raw
        FROM mrp_synced s
        JOIN mrp_sync_generation g
          ON g.generation_id = s.generation_id AND g.is_active = true
        WHERE NULLIF(BTRIM(s.item_code), '') IS NOT NULL
          AND NULLIF(BTRIM(s.division_raw), '') IS NOT NULL
      ),
      assignment_counts AS (
        SELECT item_code, MIN(id) AS registry_id, COUNT(*) AS assignment_count
        FROM canonical_item_category_registry
        WHERE effective_from IS NULL
        GROUP BY item_code
      )
      INSERT INTO canonical_item_category_source (
        item_code, registry_id, source_vocabulary, source_value
      )
      SELECT
        e.item_code,
        CASE WHEN a.assignment_count = 1 THEN a.registry_id END,
        e.source_vocabulary,
        e.source_value
      FROM raw_evidence e
      LEFT JOIN assignment_counts a ON a.item_code = e.item_code
      ON CONFLICT (item_code, source_vocabulary, source_value) DO NOTHING;

      -- Fail the whole migration rather than silently committing a partial
      -- registry when any current sale-line code is uncovered.
      DO $coverage$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM sale_line_all sl
          LEFT JOIN canonical_item_category_registry r
            ON r.item_code = UPPER(BTRIM(sl.code))
          WHERE sl.version_status = 'current'
            AND NULLIF(BTRIM(sl.code), '') IS NOT NULL
            AND r.id IS NULL
        ) THEN
          RAISE EXCEPTION 'canonical category registry has uncovered current sale_line codes';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM mrp_synced s
          JOIN mrp_sync_generation g
            ON g.generation_id = s.generation_id AND g.is_active = true
          WHERE s.division_raw LIKE '%|%'
            AND s.division_raw NOT IN (
              'Ceramic Sanitaryware | PTMT & Plastic Fittings',
              'CP Fittings / Faucets | PTMT & Plastic Fittings | Pipes & Fittings',
              'CP Fittings / Faucets | Ceramic Sanitaryware',
              'CP Fittings / Faucets | PTMT & Plastic Fittings'
            )
        ) THEN
          RAISE EXCEPTION 'unapproved composite MRP Division requires explicit review';
        END IF;
      END
      $coverage$;
    `,
  },
  {
    id: "094_canonical_item_category_null_safe_uniqueness",
    sql: `
      -- Publish reconciliation does not preserve PostgreSQL's
      -- UNIQUE NULLS NOT DISTINCT constraint flag. Replace that fragile
      -- representation with equivalent partial unique indexes, a construct
      -- whose predicates Publish preserves.
      WITH assignment_keeper AS (
        SELECT
          id,
          MIN(id) OVER (
            PARTITION BY item_code, canonical_category, effective_from
          ) AS keeper_id
        FROM canonical_item_category_registry
      )
      UPDATE canonical_item_category_source s
      SET registry_id = k.keeper_id
      FROM assignment_keeper k
      WHERE s.registry_id = k.id
        AND k.id <> k.keeper_id;

      WITH ranked_assignments AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY item_code, canonical_category, effective_from
            ORDER BY id
          ) AS duplicate_rank
        FROM canonical_item_category_registry
      )
      DELETE FROM canonical_item_category_registry r
      USING ranked_assignments d
      WHERE r.id = d.id
        AND d.duplicate_rank > 1;

      ALTER TABLE canonical_item_category_registry
        DROP CONSTRAINT IF EXISTS canonical_item_category_registry_assignment_uq;

      CREATE UNIQUE INDEX IF NOT EXISTS canonical_item_category_registry_open_assignment_uq
        ON canonical_item_category_registry (item_code, canonical_category)
        WHERE effective_from IS NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS canonical_item_category_registry_dated_assignment_uq
        ON canonical_item_category_registry (item_code, canonical_category, effective_from)
        WHERE effective_from IS NOT NULL;

      DO $invariant$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM canonical_item_category_registry
          GROUP BY item_code, canonical_category, effective_from
          HAVING COUNT(*) > 1
        ) THEN
          RAISE EXCEPTION 'canonical category registry still has duplicate assignments';
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'canonical_item_category_registry_open_assignment_uq'
            AND indexdef LIKE '%UNIQUE INDEX%'
            AND indexdef LIKE '%WHERE (effective_from IS NULL)%'
        ) OR NOT EXISTS (
          SELECT 1
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'canonical_item_category_registry_dated_assignment_uq'
            AND indexdef LIKE '%UNIQUE INDEX%'
            AND indexdef LIKE '%WHERE (effective_from IS NOT NULL)%'
        ) THEN
          RAISE EXCEPTION 'canonical category registry null-safe uniqueness indexes are missing';
        END IF;
      END
      $invariant$;
    `,
  },
  {
    id: "095_aug26_order_booking_replacement_guard",
    sql: `
      ALTER TABLE secondary_order_line ADD COLUMN IF NOT EXISTS employee_id TEXT;
      ALTER TABLE secondary_order_line ADD COLUMN IF NOT EXISTS reporting_manager TEXT;
      ALTER TABLE secondary_order_line ADD COLUMN IF NOT EXISTS gst_type TEXT;

      -- The archive is append-only evidence.  Store the complete old row rather
      -- than a lossy projection so a replacement can always be independently
      -- reconstructed.
      CREATE TABLE IF NOT EXISTS secondary_order_line_archive (
        archive_id BIGSERIAL PRIMARY KEY,
        replacement_id UUID NOT NULL,
        original_id INTEGER NOT NULL,
        archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        reason TEXT NOT NULL,
        old_row JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sola_replacement_idx
        ON secondary_order_line_archive (replacement_id);
      CREATE UNIQUE INDEX IF NOT EXISTS sola_replacement_original_uq
        ON secondary_order_line_archive (replacement_id, original_id);

      CREATE OR REPLACE FUNCTION reject_secondary_order_archive_change()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'secondary_order_line_archive is immutable'; END $$;
      DROP TRIGGER IF EXISTS secondary_order_archive_immutable ON secondary_order_line_archive;
      CREATE TRIGGER secondary_order_archive_immutable
        BEFORE UPDATE OR DELETE ON secondary_order_line_archive
        FOR EACH ROW EXECUTE FUNCTION reject_secondary_order_archive_change();
      DROP TRIGGER IF EXISTS secondary_order_archive_no_truncate ON secondary_order_line_archive;
      CREATE TRIGGER secondary_order_archive_no_truncate
        BEFORE TRUNCATE ON secondary_order_line_archive
        FOR EACH STATEMENT EXECUTE FUNCTION reject_secondary_order_archive_change();

      CREATE TABLE IF NOT EXISTS secondary_order_replacement_run (
        replacement_id UUID PRIMARY KEY,
        source_file TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        source_bytes BIGINT NOT NULL,
        preview_hash TEXT NOT NULL,
        source_era TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        fiscal_year TEXT NOT NULL,
        period_completeness TEXT NOT NULL,
        controls JSONB NOT NULL,
        protected_before JSONB NOT NULL,
        protected_after JSONB NOT NULL,
        old_fingerprint TEXT NOT NULL,
        incoming_fingerprint TEXT NOT NULL,
        new_fingerprint TEXT NOT NULL,
        removed_lines JSONB NOT NULL,
        confirmation JSONB NOT NULL,
        reason TEXT NOT NULL,
        applied_at TIMESTAMPTZ,
        previewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 minutes'),
        status TEXT NOT NULL DEFAULT 'pending',
        operator_id TEXT,
        source_timestamp TIMESTAMPTZ,
        entry_point TEXT,
        supersedes_note TEXT
      );
      ALTER TABLE secondary_order_replacement_run ADD COLUMN IF NOT EXISTS source_bytes BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE secondary_order_replacement_run ADD COLUMN IF NOT EXISTS incoming_fingerprint TEXT NOT NULL DEFAULT '';
      ALTER TABLE secondary_order_replacement_run ADD COLUMN IF NOT EXISTS previewed_at TIMESTAMPTZ NOT NULL DEFAULT now();
      ALTER TABLE secondary_order_replacement_run ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 minutes');
      ALTER TABLE secondary_order_replacement_run ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE secondary_order_replacement_run ADD COLUMN IF NOT EXISTS operator_id TEXT;
      ALTER TABLE secondary_order_replacement_run ADD COLUMN IF NOT EXISTS source_timestamp TIMESTAMPTZ;
      ALTER TABLE secondary_order_replacement_run ADD COLUMN IF NOT EXISTS entry_point TEXT;
      ALTER TABLE secondary_order_replacement_run ADD COLUMN IF NOT EXISTS supersedes_note TEXT;

      CREATE OR REPLACE FUNCTION guard_secondary_order_replacement_run()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
          RAISE EXCEPTION 'secondary_order_replacement_run is immutable';
        END IF;
        IF OLD.status <> 'pending' OR NEW.status <> 'complete' THEN
          RAISE EXCEPTION 'secondary_order_replacement_run only permits pending-to-complete';
        END IF;
        IF NEW.replacement_id IS DISTINCT FROM OLD.replacement_id
          OR NEW.source_file IS DISTINCT FROM OLD.source_file
          OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
          OR NEW.source_bytes IS DISTINCT FROM OLD.source_bytes
          OR NEW.preview_hash IS DISTINCT FROM OLD.preview_hash
          OR NEW.source_era IS DISTINCT FROM OLD.source_era
          OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
          OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year
          OR NEW.period_completeness IS DISTINCT FROM OLD.period_completeness
          OR NEW.controls IS DISTINCT FROM OLD.controls
          OR NEW.protected_before IS DISTINCT FROM OLD.protected_before
          OR NEW.old_fingerprint IS DISTINCT FROM OLD.old_fingerprint
          OR NEW.incoming_fingerprint IS DISTINCT FROM OLD.incoming_fingerprint
          OR NEW.removed_lines IS DISTINCT FROM OLD.removed_lines
          OR NEW.reason IS DISTINCT FROM OLD.reason
          OR NEW.previewed_at IS DISTINCT FROM OLD.previewed_at
          OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
          OR NEW.entry_point IS DISTINCT FROM OLD.entry_point
          OR NEW.supersedes_note IS DISTINCT FROM OLD.supersedes_note
        THEN
          RAISE EXCEPTION 'secondary_order_replacement_run evidence fields are immutable';
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS secondary_order_replacement_run_guard ON secondary_order_replacement_run;
      CREATE TRIGGER secondary_order_replacement_run_guard
        BEFORE UPDATE OR DELETE ON secondary_order_replacement_run
        FOR EACH ROW EXECUTE FUNCTION guard_secondary_order_replacement_run();
      DROP TRIGGER IF EXISTS secondary_order_replacement_run_no_truncate ON secondary_order_replacement_run;
      CREATE TRIGGER secondary_order_replacement_run_no_truncate
        BEFORE TRUNCATE ON secondary_order_replacement_run
        FOR EACH STATEMENT EXECUTE FUNCTION guard_secondary_order_replacement_run();
    `,
  },
  {
    id: "096_prompt68_master_category_registry",
    sql: `
      ALTER TABLE canonical_item_category_registry
        ADD COLUMN IF NOT EXISTS master_category TEXT;
      ALTER TABLE canonical_item_category_registry
        DROP CONSTRAINT IF EXISTS canonical_item_category_registry_category_check;
      ALTER TABLE canonical_item_category_registry
        DROP CONSTRAINT IF EXISTS canonical_item_category_registry_subcategory_check;
      ALTER TABLE canonical_item_category_registry
        ADD CONSTRAINT canonical_item_category_registry_subcategory_check CHECK (
          COALESCE(master_category || ':' || canonical_category, 'LEGACY') ~
          '^(LEGACY|[^:]+:(PTMT|SANITARYWARE|SINK|C P|CP ACCESSORIES|HARDWARE|UPVC|CPVC|CONNECTION|WASTE PIPE|CISTERN|SWR|SEAT COVER|CABINET|AGRI|QUAA|GLASS|GEYSER|FLOOR TRAP|PLATE RACK|TEFELON TAPE|OTHER|GARDEN PIPE|CP ALLIED|WATER TANK|WT LID|HDPE PIPE|COLUMN|PPR|OPVC|CORRUGATED PIPE|LPG PIPE))$'
        ) NOT VALID;
      ALTER TABLE canonical_item_category_registry
        DROP CONSTRAINT IF EXISTS canonical_item_category_registry_master_check;
      ALTER TABLE canonical_item_category_registry
        ADD CONSTRAINT canonical_item_category_registry_master_check CHECK (
          master_category ~ '^(PLUMBING|PTMT|C P|SANITARYWARE|SINK|HARDWARE)$'
        ) NOT VALID;
      CREATE INDEX IF NOT EXISTS canonical_item_category_registry_master_idx
        ON canonical_item_category_registry (master_category);
      CREATE TABLE IF NOT EXISTS canonical_category_load (
        id BIGSERIAL PRIMARY KEY,
        config_sha256 TEXT NOT NULL,
        source_files JSONB NOT NULL,
        corrections JSONB NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('preview','applied','rejected')),
        preview_hash TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        applied_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS canonical_category_load_evidence (
        load_id BIGINT NOT NULL REFERENCES canonical_category_load(id),
        item_code TEXT NOT NULL,
        raw_subcategory TEXT NOT NULL,
        normalized_subcategory TEXT NOT NULL,
        master_category TEXT NOT NULL,
        source_file TEXT NOT NULL,
        correction JSONB,
        PRIMARY KEY (load_id, item_code)
      );
      CREATE INDEX IF NOT EXISTS canonical_category_load_evidence_code_idx
        ON canonical_category_load_evidence (UPPER(BTRIM(item_code)));
      CREATE UNIQUE INDEX IF NOT EXISTS canonical_category_load_applied_hash_uq
        ON canonical_category_load (config_sha256) WHERE status = 'applied';
      CREATE TABLE IF NOT EXISTS canonical_category_correction_evidence (
        load_id BIGINT NOT NULL REFERENCES canonical_category_load(id),
        source_file TEXT NOT NULL,
        raw_value TEXT NOT NULL,
        normalized_value TEXT,
        reason TEXT NOT NULL,
        PRIMARY KEY (load_id, source_file, raw_value)
      );
    `,
  },
  {
    id: "097_prompt68_publish_safe_category_checks",
    sql: `
      ALTER TABLE canonical_item_category_registry
        DROP CONSTRAINT IF EXISTS canonical_item_category_registry_master_check;
      ALTER TABLE canonical_item_category_registry
        ADD CONSTRAINT canonical_item_category_registry_master_check CHECK (
          CASE WHEN master_category IS NULL THEN true ELSE
            array_position(
              ARRAY['PLUMBING','PTMT','C P','SANITARYWARE','SINK','HARDWARE']::text[],
              master_category
            ) IS NOT NULL
          END
        ) NOT VALID;
      ALTER TABLE canonical_item_category_registry
        DROP CONSTRAINT IF EXISTS canonical_item_category_registry_subcategory_check;
      ALTER TABLE canonical_item_category_registry
        ADD CONSTRAINT canonical_item_category_registry_subcategory_check CHECK (
          CASE WHEN master_category IS NULL THEN true ELSE
            array_position(ARRAY[
              'PTMT','SANITARYWARE','SINK','C P','CP ACCESSORIES','HARDWARE',
              'UPVC','CPVC','CONNECTION','WASTE PIPE','CISTERN','SWR','SEAT COVER',
              'CABINET','AGRI','QUAA','GLASS','GEYSER','FLOOR TRAP','PLATE RACK',
              'TEFELON TAPE','OTHER','GARDEN PIPE','CP ALLIED','WATER TANK',
              'WT LID','HDPE PIPE','COLUMN','PPR','OPVC','CORRUGATED PIPE','LPG PIPE'
            ]::text[], canonical_category) IS NOT NULL
          END
        ) NOT VALID;
    `,
  },
  {
    id: "098_prompt68_publish_case_category_checks",
    sql: `
      ALTER TABLE canonical_item_category_registry
        DROP CONSTRAINT IF EXISTS canonical_item_category_registry_master_check;
      ALTER TABLE canonical_item_category_registry
        ADD CONSTRAINT canonical_item_category_registry_master_check CHECK (
          CASE WHEN master_category IS NULL THEN true ELSE
            array_position(
              ARRAY['PLUMBING','PTMT','C P','SANITARYWARE','SINK','HARDWARE']::text[],
              master_category
            ) IS NOT NULL
          END
        ) NOT VALID;
      ALTER TABLE canonical_item_category_registry
        DROP CONSTRAINT IF EXISTS canonical_item_category_registry_subcategory_check;
      ALTER TABLE canonical_item_category_registry
        ADD CONSTRAINT canonical_item_category_registry_subcategory_check CHECK (
          CASE WHEN master_category IS NULL THEN true ELSE
            array_position(ARRAY[
              'PTMT','SANITARYWARE','SINK','C P','CP ACCESSORIES','HARDWARE',
              'UPVC','CPVC','CONNECTION','WASTE PIPE','CISTERN','SWR','SEAT COVER',
              'CABINET','AGRI','QUAA','GLASS','GEYSER','FLOOR TRAP','PLATE RACK',
              'TEFELON TAPE','OTHER','GARDEN PIPE','CP ALLIED','WATER TANK',
              'WT LID','HDPE PIPE','COLUMN','PPR','OPVC','CORRUGATED PIPE','LPG PIPE'
            ]::text[], canonical_category) IS NOT NULL
          END
        ) NOT VALID;
    `,
  },
  {
    id: "099_prompt68_publish_regex_category_checks",
    sql: `
      ALTER TABLE canonical_item_category_registry
        DROP CONSTRAINT IF EXISTS canonical_item_category_registry_master_check;
      ALTER TABLE canonical_item_category_registry
        ADD CONSTRAINT canonical_item_category_registry_master_check CHECK (
          master_category ~ '^(PLUMBING|PTMT|C P|SANITARYWARE|SINK|HARDWARE)$'
        ) NOT VALID;
      ALTER TABLE canonical_item_category_registry
        DROP CONSTRAINT IF EXISTS canonical_item_category_registry_subcategory_check;
      ALTER TABLE canonical_item_category_registry
        ADD CONSTRAINT canonical_item_category_registry_subcategory_check CHECK (
          COALESCE(master_category || ':' || canonical_category, 'LEGACY') ~
          '^(LEGACY|[^:]+:(PTMT|SANITARYWARE|SINK|C P|CP ACCESSORIES|HARDWARE|UPVC|CPVC|CONNECTION|WASTE PIPE|CISTERN|SWR|SEAT COVER|CABINET|AGRI|QUAA|GLASS|GEYSER|FLOOR TRAP|PLATE RACK|TEFELON TAPE|OTHER|GARDEN PIPE|CP ALLIED|WATER TANK|WT LID|HDPE PIPE|COLUMN|PPR|OPVC|CORRUGATED PIPE|LPG PIPE))$'
        ) NOT VALID;
    `,
  },
  {
    id: "100_prompt68_validate_category_checks",
    sql: `
      ALTER TABLE canonical_item_category_registry
        VALIDATE CONSTRAINT canonical_item_category_registry_master_check;
      ALTER TABLE canonical_item_category_registry
        VALIDATE CONSTRAINT canonical_item_category_registry_subcategory_check;
    `,
  },
  {
    id: "101_prompt68_normalized_code_index",
    sql: `
      CREATE INDEX IF NOT EXISTS canonical_item_category_registry_normalized_code_idx
        ON canonical_item_category_registry (UPPER(BTRIM(item_code)));
    `,
  },
  {
    id: "102_application_auth_roles",
    sql: `
      ALTER TABLE auth_users
        DROP CONSTRAINT IF EXISTS auth_users_role_check;
      ALTER TABLE auth_users
        ADD CONSTRAINT auth_users_role_check
        CHECK (role IN ('admin', 'normal', 'sales_head', 'crm', 'business'));
    `,
  },
  {
    id: "103_verification_service_identity",
    sql: `
      ALTER TABLE api_keys
        ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'full_api';

      ALTER TABLE api_keys
        DROP CONSTRAINT IF EXISTS api_keys_scope_check;
      ALTER TABLE api_keys
        ADD CONSTRAINT api_keys_scope_check
        CHECK (scope IN ('full_api', 'verification', 'external_read'));

      CREATE INDEX IF NOT EXISTS api_keys_scope_idx ON api_keys (scope);
      CREATE UNIQUE INDEX IF NOT EXISTS api_keys_single_verification_identity_idx
        ON api_keys (scope)
        WHERE scope = 'verification';
    `,
  },
  {
    id: "104_prompt88_resolution_items",
    sql: `
      -- Prompt 88 Sections A and D: one retained register for everything
      -- waiting on an answer.  The code is the stable seed key; admin-created
      -- rows use their own code and are never overwritten by the seed below.
      CREATE TABLE IF NOT EXISTS resolution_item (
        id              SERIAL PRIMARY KEY,
        code            TEXT NOT NULL,
        type            TEXT NOT NULL,
        title           TEXT NOT NULL,
        category        TEXT NOT NULL,
        fiscal_year     TEXT,
        month           TEXT,
        scope_product   TEXT,
        scope_measure   TEXT,
        reason          TEXT NOT NULL,
        evidence        TEXT NOT NULL,
        value_at_stake  NUMERIC,
        raised_on       DATE NOT NULL,
        raised_by       TEXT NOT NULL,
        owner           TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'open',
        resolved_on     DATE,
        resolved_by     TEXT,
        resolution_note TEXT,
        blocks_api      BOOLEAN NOT NULL DEFAULT FALSE,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT resolution_item_code_uq UNIQUE (code),
        CONSTRAINT resolution_item_type_check CHECK (type IN ('HOLD', 'PENDING')),
        CONSTRAINT resolution_item_category_check CHECK (
          category IN ('data quality', 'master data', 'access', 'infrastructure', 'commercial')
        ),
        CONSTRAINT resolution_item_status_check CHECK (
          status IN ('open', 'answered', 'resolved', 'accepted-as-is')
        ),
        CONSTRAINT resolution_item_value_check CHECK (value_at_stake IS NULL OR value_at_stake >= 0),
        CONSTRAINT resolution_item_blocks_api_check CHECK (type = 'HOLD' OR blocks_api = FALSE),
        CONSTRAINT resolution_item_hold_scope_check CHECK (
          (type = 'PENDING' AND scope_measure IS NULL)
          OR (type = 'HOLD' AND scope_measure IS NOT NULL AND btrim(scope_measure) <> '')
        )
      );
      CREATE INDEX IF NOT EXISTS resolution_item_status_idx ON resolution_item (status);
      CREATE INDEX IF NOT EXISTS resolution_item_type_idx ON resolution_item (type);
      CREATE INDEX IF NOT EXISTS resolution_item_owner_idx ON resolution_item (owner);
      -- Drizzle may have created the table during provisioning without these
      -- business checks. Recreate the named checks so both paths converge.
      ALTER TABLE resolution_item
        DROP CONSTRAINT IF EXISTS resolution_item_type_check,
        DROP CONSTRAINT IF EXISTS resolution_item_category_check,
        DROP CONSTRAINT IF EXISTS resolution_item_status_check,
        DROP CONSTRAINT IF EXISTS resolution_item_value_check,
        DROP CONSTRAINT IF EXISTS resolution_item_blocks_api_check,
        DROP CONSTRAINT IF EXISTS resolution_item_hold_scope_check;
      ALTER TABLE resolution_item
        ADD CONSTRAINT resolution_item_type_check
          CHECK (type IN ('HOLD', 'PENDING')),
        ADD CONSTRAINT resolution_item_category_check
          CHECK (category IN ('data quality', 'master data', 'access', 'infrastructure', 'commercial')),
        ADD CONSTRAINT resolution_item_status_check
          CHECK (status IN ('open', 'answered', 'resolved', 'accepted-as-is')),
        ADD CONSTRAINT resolution_item_value_check
          CHECK (value_at_stake IS NULL OR value_at_stake >= 0),
        ADD CONSTRAINT resolution_item_blocks_api_check
          CHECK (type = 'HOLD' OR blocks_api = FALSE),
        ADD CONSTRAINT resolution_item_hold_scope_check
          CHECK (
            (type = 'PENDING' AND scope_measure IS NULL)
            OR (type = 'HOLD' AND scope_measure IS NOT NULL AND btrim(scope_measure) <> '')
          );

      -- Publish can materialise the current schema before replaying this
      -- migration ledger. Migration 105 recreates this constraint after the
      -- intentionally closed seed rows have their resolution metadata.
      ALTER TABLE resolution_item
        DROP CONSTRAINT IF EXISTS resolution_item_closed_metadata_check;

      -- Seed only the entries printed in Prompt 88 Section D.  ON CONFLICT
      -- DO NOTHING makes restarts and migration replay safe, and deliberately
      -- preserves any later admin edit or resolution.
      INSERT INTO resolution_item
        (code, type, title, category, fiscal_year, month, scope_product,
         scope_measure, reason, evidence, value_at_stake, raised_on, raised_by,
         owner, status, blocks_api)
      VALUES
        ('H1', 'HOLD', 'PTMT MARGIN, JAN-APR 2026', 'data quality', NULL, 'Jan-Apr 2026',
         'PTMT master category', 'margin, gross contribution, BOM cost',
         'Factory cost at ~40% of true level. Median BOM on 191 common codes: Nov-25 Rs 32.16, Dec-25 Rs 30.98, Jan Rs 12.92, Feb Rs 12.72, Mar Rs 13.49, Apr Rs 14.82, May Rs 34.85, Jun Rs 39.66. 2.55x understated.',
         '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] FY2026-27 April PTMT margin 86.47% vs corrected ~65.5%. FY2025-26 April 76.17%. May-26 68.50%, Jun-26 69.19%.',
         NULL, '2026-09-14', 'Prompt 88 extended', 'Prayag - Deepak J', 'open', TRUE),
        ('H2', 'HOLD', 'AUGUST 2026 SECONDARY SKU', 'data quality', '2026-27', 'Aug-26',
         'secondary SKU', 'secondary SKU, retailer-level secondary analysis, item-level secondary analysis',
         'Export not received. Production zero rows. Month open until 1 December 2026.',
         '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] Export not received. Production zero rows. Month open until 1 December 2026.',
         NULL, '2026-09-14', 'Prompt 88 extended', 'Prayag', 'open', TRUE),
        ('H3', 'HOLD', 'FY2024-25 MONTHLY ATTRIBUTION', 'data quality', '2024-25', 'FY2024-25',
         NULL, 'monthly figures, quarterly figures',
         '28,613 rows retain reversed day and month after Prayag''s partial correction. Annual total correct at Rs 216.00 Cr.',
         '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] Q4 overstated 13.2%, Q1 understated 12.6%, April out 30.7%.',
         NULL, '2026-09-14', 'Prompt 88 extended', 'Prayag', 'open', TRUE),
        ('P1', 'PENDING', '34 existing DIST# codes need confirmation', 'master data', NULL, NULL, NULL, NULL,
         '34 existing DIST# codes need confirmation.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] 34 existing DIST# codes need confirmation.', NULL,
         '2026-09-14', 'Prompt 88 extended', 'Prayag', 'open', FALSE),
        ('P2', 'PENDING', 'Rs 6.52 Cr of distributor sales with no DIST# code', 'data quality', NULL, NULL, NULL, NULL,
         'Distributor sales have no DIST# code.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] Rs 6.52 Cr of distributor sales with no DIST# code.', 65200000,
         '2026-09-14', 'Prompt 88 extended', 'Prayag', 'open', FALSE),
        ('P3', 'PENDING', '780 sold codes with no MRP master record', 'master data', NULL, NULL, NULL, NULL,
         '780 sold codes have no MRP master record.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] 780 sold codes with no MRP master record; value Rs 9.64 Cr.', 96400000,
         '2026-09-14', 'Prompt 88 extended', 'Prayag', 'open', FALSE),
        ('P4', 'PENDING', '3 WCT codes with no MRP - WCT-3LL-05, -07, -10', 'master data', NULL, NULL, NULL, NULL,
         'Three WCT codes have no MRP.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] 3 WCT codes with no MRP - WCT-3LL-05, -07, -10; value Rs 1.17 Cr.', 11700000,
         '2026-09-14', 'Prompt 88 extended', 'Prayag', 'open', FALSE),
        ('P5', 'PENDING', '15 -VB codes in excluded_do_not_load, no price or date', 'master data', NULL, NULL, NULL, NULL,
         '15 -VB codes are in excluded_do_not_load with no price or date.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] 15 -VB codes in excluded_do_not_load, no price or date.', NULL,
         '2026-09-14', 'Prompt 88 extended', 'Prayag', 'open', FALSE),
        ('P6', 'PENDING', 'Large v2 price moves need confirmation', 'commercial', NULL, NULL, NULL, NULL,
         'Confirm whether the listed v2 price moves are intended.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] P20A05 -67.4%, P20A06 -64.7%, P10G12 +46.0% - confirm intended.', NULL,
         '2026-09-14', 'Prompt 88 extended', 'Prayag', 'open', FALSE),
        ('P7', 'PENDING', '70 discontinued codes still selling', 'master data', NULL, NULL, NULL, NULL,
         'Discontinued codes are still selling.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] 70 discontinued codes still selling; value Rs 0.20 Cr.', 2000000,
         '2026-09-14', 'Prompt 88 extended', 'Prayag', 'open', FALSE),
        ('P8', 'PENDING', 'September 2026 SAP - 604 invoices vs ~700 derived', 'data quality', '2026-27', 'Sep-26', NULL, NULL,
         'SAP invoice count differs from the derived count.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] September 2026 SAP - 604 invoices vs ~700 derived.', NULL,
         '2026-09-14', 'Prompt 88 extended', 'Prayag', 'open', FALSE),
        ('P9', 'PENDING', '4 rows and Rs 5,595 missing from FY2024-25 - variance accepted', 'data quality', '2024-25', NULL, NULL, NULL,
         'Variance accepted and recorded for completeness.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] 4 rows and Rs 5,595 missing from FY2024-25 - variance accepted, recorded for completeness.', 5595,
         '2026-09-14', 'Prompt 88 extended', 'Prayag', 'answered', FALSE),
        ('P10', 'PENDING', 'Master_and_Sub_category.xlsx cleanup', 'master data', NULL, NULL, NULL, NULL,
         'Merge CP into C P, remove the leaked header row, and fix CONECTION spelling.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] Master_and_Sub_category.xlsx - merge CP into C P, remove the leaked header row, fix CONECTION spelling.', NULL,
         '2026-09-14', 'Prompt 88 extended', 'Prayag', 'open', FALSE),
        ('P11', 'PENDING', 'Sunil Mohanty has no HR or registry record', 'master data', NULL, NULL, NULL, NULL,
         'No HR record, no registry record, blank alert number, and zero people in scope.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] Sunil Mohanty - no HR record, no registry record, blank alert number, zero people in scope.', NULL,
         '2026-09-14', 'Prompt 88 extended', 'Prayag', 'open', FALSE),
        ('P12', 'PENDING', 'Pawan Sharma roster and HR status disagree', 'master data', NULL, NULL, NULL, NULL,
         'HR marks Pawan Sharma Deactive while the roster uses him as an active head with 16 people; two different mobile numbers exist.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] Pawan Sharma - HR marks Deactive, roster uses him as an active head with 16 people. Two different mobile numbers.', NULL,
         '2026-09-14', 'Prompt 88 extended', 'Prayag', 'open', FALSE),
        ('P13', 'PENDING', 'Prashant Onam Naik has no alert route', 'access', NULL, NULL, NULL, NULL,
         'Active head has no alert route configured.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] Prashant Onam Naik - active head, no alert route configured.', NULL,
         '2026-09-14', 'Prompt 88 extended', 'Prayag', 'open', FALSE),
        ('P14', 'PENDING', '7 roster members with no HR record', 'master data', NULL, NULL, NULL, NULL,
         'Roster members are missing corresponding HR records.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] 7 roster members with no HR record.', NULL,
         '2026-09-14', 'Prompt 88 extended', 'Prayag', 'open', FALSE),
        ('P15', 'PENDING', 'SMTP or Resend credentials', 'infrastructure', NULL, NULL, NULL, NULL,
         'Delivery credentials are not configured.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] SMTP or Resend credentials - 524 delivery attempts, zero delivered.', NULL,
         '2026-09-14', 'Prompt 88 extended', 'IT', 'open', FALSE),
        ('P16', 'PENDING', 'WhatsApp provider decision', 'infrastructure', NULL, NULL, NULL, NULL,
         'No WhatsApp provider is configured.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] WhatsApp provider decision - no provider configured.', NULL,
         '2026-09-14', 'Prompt 88 extended', 'internal', 'open', FALSE),
        ('P17', 'PENDING', 'Alert state-head routing entity keys', 'access', NULL, NULL, NULL, NULL,
         'Entity keys do not resolve for Aqil Rizvi and Narendra Kumar Sharma.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] Alert state-head routing - entity keys do not resolve for Aqil Rizvi and Narendra Kumar Sharma.', NULL,
         '2026-09-14', 'Prompt 88 extended', 'internal', 'open', FALSE),
        ('P18', 'PENDING', 'PSCode3 brand mirror never generated', 'data quality', NULL, NULL, NULL, NULL,
         'The brand mirror was never generated for the listed fiscal years.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] PSCode3 brand mirror never generated for FY2023-24 to FY2025-26.', NULL,
         '2026-09-14', 'Prompt 88 extended', 'internal', 'accepted-as-is', FALSE),
        ('P19', 'PENDING', 'Whether state heads should receive email as well as WhatsApp', 'access', NULL, NULL, NULL, NULL,
         'No email routes exist.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] Whether state heads should receive email as well as WhatsApp - no email routes exist.', NULL,
         '2026-09-14', 'Prompt 88 extended', 'internal', 'open', FALSE),
        ('P20', 'PENDING', 'The 22-query pack, unsent since 31 August', 'data quality', NULL, '31-Aug-2026', NULL, NULL,
         'The query pack has not been sent.', '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] The 22-query pack, unsent since 31 August.', NULL,
         '2026-08-31', 'Prompt 88 extended', 'internal', 'open', FALSE)
      ON CONFLICT (code) DO NOTHING;

      -- P9 and P18 are intentionally closed in the source prompt. Retain the
      -- rows and their explicit outcome so days-open can stop at raised_on.
      UPDATE resolution_item
      SET resolved_on = raised_on,
          resolved_by = 'Prompt 88 extended',
          resolution_note = CASE code
            WHEN 'P9' THEN 'Answered: variance accepted and recorded for completeness.'
            WHEN 'P18' THEN 'Accepted as-is: the PSCode3 brand mirror was not generated.'
          END,
          updated_at = now()
      WHERE code IN ('P9', 'P18')
        AND status IN ('answered', 'accepted-as-is')
        AND (
          resolved_on IS NULL
          OR btrim(COALESCE(resolved_by, '')) = ''
          OR btrim(COALESCE(resolution_note, '')) = ''
        );
    `,
  },
  {
    id: "105_prompt88_resolution_integrity",
    sql: `
      -- The original seed had two integrity gaps: H1 used a comma-separated
      -- fiscal-year value that no period matcher can interpret, and the two
      -- intentionally closed rows did not carry their resolution metadata.
      -- H1's explicit month range is authoritative, so fiscal_year is left
      -- NULL rather than duplicating or inventing a fiscal-year range.
      UPDATE resolution_item
      SET fiscal_year = NULL, updated_at = now()
      WHERE code = 'H1' AND type = 'HOLD';

      UPDATE resolution_item
      SET resolved_on = raised_on,
          resolved_by = 'Prompt 88 extended',
          resolution_note = CASE code
            WHEN 'P9' THEN 'Answered: variance accepted and recorded for completeness.'
            WHEN 'P18' THEN 'Accepted as-is: the PSCode3 brand mirror was not generated.'
          END,
          updated_at = now()
      WHERE code IN ('P9', 'P18')
        AND status IN ('answered', 'accepted-as-is')
        AND (
          resolved_on IS NULL
          OR btrim(COALESCE(resolved_by, '')) = ''
          OR btrim(COALESCE(resolution_note, '')) = ''
        );

      ALTER TABLE resolution_item
        DROP CONSTRAINT IF EXISTS resolution_item_closed_metadata_check;
      ALTER TABLE resolution_item
        ADD CONSTRAINT resolution_item_closed_metadata_check
          CHECK (
            status = 'open'
            OR (
              resolved_on IS NOT NULL
              AND btrim(COALESCE(resolved_by, '')) <> ''
              AND btrim(COALESCE(resolution_note, '')) <> ''
            )
          );
    `,
  },
  {
    id: "106_prompt88_h2_secondary_measure",
    sql: `
      -- Migration 104 seeded H2 before the canonical secondary-SKU measure
      -- was added. Preserve the prompt's human scope labels while making the
      -- machine-facing measure explicit for already-migrated databases.
      UPDATE resolution_item
      SET scope_measure = 'secondary SKU, retailer-level secondary analysis, item-level secondary analysis',
          updated_at = now()
      WHERE code = 'H2'
        AND type = 'HOLD'
        AND scope_measure = 'retailer-level secondary analysis, item-level secondary analysis';
    `,
  },
  {
    id: "107_external_read_api_rate_limit",
    sql: `
      -- Keep this migration safe when deployment provisioning materialises the
      -- current Drizzle schema before replaying schema_migrations.  The
      -- constraint is recreated here as well as in migration 103 so a fresh
      -- schema cannot accidentally retain the pre-external-read constraint.
      ALTER TABLE api_keys
        ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'full_api';
      ALTER TABLE api_keys
        DROP CONSTRAINT IF EXISTS api_keys_scope_check;
      ALTER TABLE api_keys
        ADD CONSTRAINT api_keys_scope_check
          CHECK (scope IN ('full_api', 'verification', 'external_read'));
      CREATE INDEX IF NOT EXISTS api_keys_scope_idx ON api_keys (scope);
      CREATE UNIQUE INDEX IF NOT EXISTS api_keys_single_verification_identity_idx
        ON api_keys (scope)
        WHERE scope = 'verification';

      -- A single row per API key makes the upsert below atomic under
      -- concurrent requests.  No key data is changed or removed here, and
      -- the FK cleanup follows key revocation/deletion safely.
      CREATE TABLE IF NOT EXISTS api_key_rate_limit (
        api_key_id       INTEGER PRIMARY KEY
          REFERENCES api_keys(id) ON DELETE CASCADE,
        window_started   TIMESTAMPTZ NOT NULL,
        request_count    INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT api_key_rate_limit_request_count_check
          CHECK (request_count >= 0)
      );
      CREATE INDEX IF NOT EXISTS api_key_rate_limit_window_idx
        ON api_key_rate_limit (window_started);
    `,
  },
  {
    id: "108_external_source_revision",
    sql: `
      -- Durable, loader-maintained revisions let external pagination detect
      -- changes without hashing or transferring source rows.  Existing rows
      -- start at revision zero; their source contents are preserved.
      CREATE TABLE IF NOT EXISTS external_source_revision (
        source       TEXT        NOT NULL,
        fy           TEXT        NOT NULL,
        month_label  TEXT        NOT NULL,
        revision     BIGINT      NOT NULL DEFAULT 0,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (source, fy, month_label)
      );

      DO $do$
      BEGIN
        IF to_regclass('public.sale_line_all') IS NOT NULL THEN
          INSERT INTO external_source_revision (source, fy, month_label, revision)
          SELECT 'sales', fy, month_label, 0
            FROM sale_line_all
           WHERE fy IS NOT NULL AND month_label IS NOT NULL
           GROUP BY fy, month_label
          ON CONFLICT (source, fy, month_label) DO NOTHING;
        END IF;
        IF to_regclass('public.margin_fact') IS NOT NULL THEN
          INSERT INTO external_source_revision (source, fy, month_label, revision)
          SELECT 'margin', fy, month_label, 0
            FROM margin_fact
           WHERE fy IS NOT NULL AND month_label IS NOT NULL
           GROUP BY fy, month_label
          ON CONFLICT (source, fy, month_label) DO NOTHING;
        END IF;
      END
      $do$;

      CREATE OR REPLACE FUNCTION bump_external_sales_revision_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      BEGIN
        INSERT INTO external_source_revision (source, fy, month_label, revision)
        SELECT 'sales', n.fy, n.month_label, 1
          FROM new_rows n
         WHERE n.fy IS NOT NULL AND n.month_label IS NOT NULL
         GROUP BY n.fy, n.month_label
        ON CONFLICT (source, fy, month_label) DO UPDATE
          SET revision = external_source_revision.revision + 1,
              updated_at = now();
        RETURN NULL;
      END
      $fn$;

      CREATE OR REPLACE FUNCTION bump_external_sales_revision_delete()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      BEGIN
        INSERT INTO external_source_revision (source, fy, month_label, revision)
        SELECT 'sales', o.fy, o.month_label, 1
          FROM old_rows o
         WHERE o.fy IS NOT NULL AND o.month_label IS NOT NULL
         GROUP BY o.fy, o.month_label
        ON CONFLICT (source, fy, month_label) DO UPDATE
          SET revision = external_source_revision.revision + 1,
              updated_at = now();
        RETURN NULL;
      END
      $fn$;

      CREATE OR REPLACE FUNCTION bump_external_sales_revision_update()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      BEGIN
        INSERT INTO external_source_revision (source, fy, month_label, revision)
        SELECT 'sales', affected.fy, affected.month_label, 1
          FROM (
            SELECT fy, month_label FROM old_rows
            UNION
            SELECT fy, month_label FROM new_rows
          ) affected
         WHERE affected.fy IS NOT NULL AND affected.month_label IS NOT NULL
         GROUP BY affected.fy, affected.month_label
        ON CONFLICT (source, fy, month_label) DO UPDATE
          SET revision = external_source_revision.revision + 1,
              updated_at = now();
        RETURN NULL;
      END
      $fn$;

      CREATE OR REPLACE FUNCTION bump_external_margin_revision_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      BEGIN
        INSERT INTO external_source_revision (source, fy, month_label, revision)
        SELECT 'margin', n.fy, n.month_label, 1
          FROM new_rows n
         WHERE n.fy IS NOT NULL AND n.month_label IS NOT NULL
         GROUP BY n.fy, n.month_label
        ON CONFLICT (source, fy, month_label) DO UPDATE
          SET revision = external_source_revision.revision + 1,
              updated_at = now();
        RETURN NULL;
      END
      $fn$;

      CREATE OR REPLACE FUNCTION bump_external_margin_revision_delete()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      BEGIN
        INSERT INTO external_source_revision (source, fy, month_label, revision)
        SELECT 'margin', o.fy, o.month_label, 1
          FROM old_rows o
         WHERE o.fy IS NOT NULL AND o.month_label IS NOT NULL
         GROUP BY o.fy, o.month_label
        ON CONFLICT (source, fy, month_label) DO UPDATE
          SET revision = external_source_revision.revision + 1,
              updated_at = now();
        RETURN NULL;
      END
      $fn$;

      CREATE OR REPLACE FUNCTION bump_external_margin_revision_update()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      BEGIN
        INSERT INTO external_source_revision (source, fy, month_label, revision)
        SELECT 'margin', affected.fy, affected.month_label, 1
          FROM (
            SELECT fy, month_label FROM old_rows
            UNION
            SELECT fy, month_label FROM new_rows
          ) affected
         WHERE affected.fy IS NOT NULL AND affected.month_label IS NOT NULL
         GROUP BY affected.fy, affected.month_label
        ON CONFLICT (source, fy, month_label) DO UPDATE
          SET revision = external_source_revision.revision + 1,
              updated_at = now();
        RETURN NULL;
      END
      $fn$;

      DO $do$
      BEGIN
        IF to_regclass('public.sale_line_all') IS NOT NULL THEN
          DROP TRIGGER IF EXISTS external_sales_revision_insert ON sale_line_all;
          DROP TRIGGER IF EXISTS external_sales_revision_update ON sale_line_all;
          DROP TRIGGER IF EXISTS external_sales_revision_delete ON sale_line_all;
          CREATE TRIGGER external_sales_revision_insert
            AFTER INSERT ON sale_line_all
            REFERENCING NEW TABLE AS new_rows
            FOR EACH STATEMENT
            EXECUTE FUNCTION bump_external_sales_revision_insert();
          CREATE TRIGGER external_sales_revision_update
            AFTER UPDATE ON sale_line_all
            REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
            FOR EACH STATEMENT
            EXECUTE FUNCTION bump_external_sales_revision_update();
          CREATE TRIGGER external_sales_revision_delete
            AFTER DELETE ON sale_line_all
            REFERENCING OLD TABLE AS old_rows
            FOR EACH STATEMENT
            EXECUTE FUNCTION bump_external_sales_revision_delete();
        END IF;
        IF to_regclass('public.margin_fact') IS NOT NULL THEN
          DROP TRIGGER IF EXISTS external_margin_revision_insert ON margin_fact;
          DROP TRIGGER IF EXISTS external_margin_revision_update ON margin_fact;
          DROP TRIGGER IF EXISTS external_margin_revision_delete ON margin_fact;
          CREATE TRIGGER external_margin_revision_insert
            AFTER INSERT ON margin_fact
            REFERENCING NEW TABLE AS new_rows
            FOR EACH STATEMENT
            EXECUTE FUNCTION bump_external_margin_revision_insert();
          CREATE TRIGGER external_margin_revision_update
            AFTER UPDATE ON margin_fact
            REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
            FOR EACH STATEMENT
            EXECUTE FUNCTION bump_external_margin_revision_update();
          CREATE TRIGGER external_margin_revision_delete
            AFTER DELETE ON margin_fact
            REFERENCING OLD TABLE AS old_rows
            FOR EACH STATEMENT
            EXECUTE FUNCTION bump_external_margin_revision_delete();
        END IF;
      END
      $do$;
    `,
  },
  {
    id: "109_resolution_priority_relationships_p21_p42",
    sql: `
      DO $do$
      BEGIN
        CREATE TYPE resolution_priority AS ENUM ('urgent', 'high', 'medium', 'low');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END
      $do$;
      DO $do$
      BEGIN
        CREATE TYPE resolution_relation_type AS ENUM ('derived-from', 'ask-supported-by', 'question-for-gap');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END
      $do$;

      ALTER TABLE resolution_item
        ADD COLUMN IF NOT EXISTS priority resolution_priority;
      CREATE INDEX IF NOT EXISTS resolution_item_priority_idx ON resolution_item (priority);

      CREATE TABLE IF NOT EXISTS resolution_item_relationship (
        id          SERIAL PRIMARY KEY,
        source_code TEXT NOT NULL REFERENCES resolution_item(code) ON DELETE CASCADE,
        target_code TEXT NOT NULL REFERENCES resolution_item(code) ON DELETE CASCADE,
        relation    resolution_relation_type NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT resolution_item_relationship_uq UNIQUE (source_code, target_code, relation)
      );
      CREATE INDEX IF NOT EXISTS resolution_item_relationship_source_idx
        ON resolution_item_relationship (source_code);
      CREATE INDEX IF NOT EXISTS resolution_item_relationship_target_idx
        ON resolution_item_relationship (target_code);

      INSERT INTO resolution_item
        (code, type, title, category, reason, evidence, value_at_stake, raised_on,
         raised_by, owner, priority, status, resolved_on, resolved_by, resolution_note, blocks_api)
      VALUES
        ('P21','PENDING','Item codes 20, 25 and 32 — on the website or not?','master data',
         'Confirm whether item codes 20, 25 and 32 belong in the authoritative website catalogue.',
         '[Source: Resolution register P21 onward, 14 September 2026] Three unreviewed priced codes were excluded from the reviewed catalogue denominator.',NULL,'2026-09-14','Resolution register P21 onward','Prayag price team','high','open',NULL,NULL,NULL,FALSE),
        ('P22','PENDING','When do the September prices actually go live?','master data',
         'Confirm the effective date for the September price generation.',
         '[Source: Resolution register P21 onward, 14 September 2026] The commercial go-live date is not recorded.',NULL,'2026-09-14','Resolution register P21 onward','Prayag price team','high','open',NULL,NULL,NULL,FALSE),
        ('P23','PENDING','The 64 PEA brass fittings — 1 February or 10 August 2026?','master data',
         'Confirm which effective date applies to the 64 PEA brass-fitting prices.',
         '[Source: Resolution register P21 onward, 14 September 2026] Qualitative exposure affects every discount using these codes since 1 February 2026; no defensible single rupee value is available.',NULL,'2026-09-14','Resolution register P21 onward','Prayag price team','urgent','open',NULL,NULL,NULL,FALSE),
        ('P24','PENDING','What does “Unchanged — carried forward” mean?','master data',
         'Define whether carried-forward prices remain approved current prices or require fresh review.',
         '[Source: Resolution register P21 onward, 14 September 2026] The source label is operationally ambiguous.',NULL,'2026-09-14','Resolution register P21 onward','Prayag price team','medium','open',NULL,NULL,NULL,FALSE),
        ('P25','PENDING','Is 1 September correct for TTS-01, TTS-02 and TTS-03?','master data',
         'Confirm the effective date for TTS-01, TTS-02 and TTS-03.',
         '[Source: Resolution register P21 onward, 14 September 2026] The listed date requires price-team confirmation.',NULL,'2026-09-14','Resolution register P21 onward','Prayag price team','medium','open',NULL,NULL,NULL,FALSE),
        ('P26','PENDING','Should colour-wise prices be added to the website?','master data',
         'Confirm whether colour variants require separately published website prices.',
         '[Source: Resolution register P21 onward, 14 September 2026] Colour-specific pricing policy is not recorded.',NULL,'2026-09-14','Resolution register P21 onward','Prayag price team','medium','open',NULL,NULL,NULL,FALSE),
        ('P27','PENDING','The 1 September change is described as Hardware, but is mostly PTMT','master data',
         'Confirm the correct category label for the 1 September price change.',
         '[Source: Resolution register P21 onward, 14 September 2026] The source description says Hardware while the affected products are mainly PTMT.',NULL,'2026-09-14','Resolution register P21 onward','Prayag price team','low','open',NULL,NULL,NULL,FALSE),
        ('P28','PENDING','Eight new WT water-tank prices — real or placeholder, and why backdated?','master data',
         'Confirm whether the eight WT prices are approved and explain their backdated effective dates.',
         '[Source: Resolution register P21 onward, 14 September 2026] The entries may be real or placeholder prices.',NULL,'2026-09-14','Resolution register P21 onward','Prayag price team','high','open',NULL,NULL,NULL,FALSE),
        ('P29','PENDING','Are these eight PS codes discontinued?','master data',
         'Confirm whether the eight listed PS codes are discontinued.',
         '[Source: Resolution register P21 onward, 14 September 2026] Product lifecycle status is not authoritative.',NULL,'2026-09-14','Resolution register P21 onward','Prayag price team','low','open',NULL,NULL,NULL,FALSE),
        ('P30','PENDING','Confirm 34 existing distributor codes and create codes for the rest','master data',
         'Confirm the 34 existing DIST# matches and assign stable codes to remaining distributors.',
         '[Source: Resolution register P21 onward, 14 September 2026] P1 records the confirmation set and P2 records Rs 6.52 Cr of unattributed distributor sales.',65200000,'2026-09-14','Resolution register P21 onward','Prayag sales / master data','high','open',NULL,NULL,NULL,FALSE),
        ('P31','PENDING','Is VIKRAM TRADERS (JAMMU) an active distributor?','master data',
         'Confirm the active status and distributor identity for VIKRAM TRADERS (JAMMU).',
         '[Source: Resolution register P21 onward, 14 September 2026] Current distributor status is not confirmed.',NULL,'2026-09-14','Resolution register P21 onward','Prayag sales / master data','medium','open',NULL,NULL,NULL,FALSE),
        ('P32','PENDING','Do Chandigarh, Delhi NCR, Himachal Pradesh and J&K have distributors?','master data',
         'Confirm distributor coverage for Chandigarh, Delhi NCR, Himachal Pradesh and Jammu and Kashmir.',
         '[Source: Resolution register P21 onward, 14 September 2026] No authoritative coverage answer is recorded.',NULL,'2026-09-14','Resolution register P21 onward','Prayag sales / master data','medium','open',NULL,NULL,NULL,FALSE),
        ('P33','PENDING','Who heads West U.P and Rajasthan, and is Sunil Mohanty a new joiner?','master data',
         'Confirm the current heads for West U.P and Rajasthan and Sunil Mohanty''s employment status.',
         '[Source: Resolution register P21 onward, 14 September 2026] P11 records that Sunil Mohanty has no HR or registry record.',NULL,'2026-09-14','Resolution register P21 onward','Prayag HR / sales management','high','open',NULL,NULL,NULL,FALSE),
        ('P34','PENDING','Who owns Rajasthan, and who takes the 354 unassigned customers?','master data',
         'Confirm Rajasthan ownership and the assignee for 354 currently unassigned customers.',
         '[Source: Resolution register P21 onward, 14 September 2026] Ownership cannot be inferred safely from current master data.',NULL,'2026-09-14','Resolution register P21 onward','Prayag HR / sales management','high','open',NULL,NULL,NULL,FALSE),
        ('P35','PENDING','Who owns distributors in Karnataka and Maharashtra? Is Prashant a head or member?','master data',
         'Confirm distributor ownership in Karnataka and Maharashtra and Prashant''s organisation role.',
         '[Source: Resolution register P21 onward, 14 September 2026] Current hierarchy evidence is ambiguous.',NULL,'2026-09-14','Resolution register P21 onward','Prayag HR / sales management','high','open',NULL,NULL,NULL,FALSE),
        ('P36','PENDING','How many Maharashtra territories — two, three, or none?','master data',
         'Confirm the authoritative Maharashtra territory structure.',
         '[Source: Resolution register P21 onward, 14 September 2026] Available sources imply two, three, or no explicit territories.',NULL,'2026-09-14','Resolution register P21 onward','Prayag HR / sales management','medium','open',NULL,NULL,NULL,FALSE),
        ('P37','PENDING','Are these six State Head folders former heads or a different structure?','master data',
         'Classify the six State Head folders as former-head history or another organisation structure.',
         '[Source: Resolution register P21 onward, 14 September 2026] Folder names alone are insufficient to classify the people.',NULL,'2026-09-14','Resolution register P21 onward','Prayag HR / sales management','medium','open',NULL,NULL,NULL,FALSE),
        ('P38','PENDING','Are monthly PLAN cells typed in, or linked to each PLAN 26-27 file?','data quality',
         'Confirm whether monthly PLAN cells are manually entered or linked to individual PLAN 26-27 files.',
         '[Source: Resolution register P21 onward, 14 September 2026] Target lineage is not explicit.',NULL,'2026-09-14','Resolution register P21 onward','Prayag sales management','high','open',NULL,NULL,NULL,FALSE),
        ('P39','PENDING','Should Ravi Upadhyay and Shiv Kumar have monthly rows at all?','data quality',
         'Confirm whether Ravi Upadhyay and Shiv Kumar should carry monthly planning rows.',
         '[Source: Resolution register P21 onward, 14 September 2026] Their intended planning scope is unresolved.',NULL,'2026-09-14','Resolution register P21 onward','Prayag sales management','medium','open',NULL,NULL,NULL,FALSE),
        ('P40','PENDING','Which of the 58 names are former employees, and how is off-roll staff handled?','master data',
         'Classify the 58 historical or off-roll names and define their treatment.',
         '[Source: Resolution register P21 onward, 14 September 2026] This population is 58 historical/off-roll names carrying 25,575 FY2025-26 order-booking rows worth Rs 13.51 Cr. It is distinct from P14, which covers seven current roster members with no HR record; the two populations must remain separate.',135100000,'2026-09-14','Resolution register P21 onward','Prayag sales management','high','open',NULL,NULL,NULL,FALSE),
        ('P41','PENDING','Which is authoritative for visits — Dashboard Data or Visit Report?','data quality',
         'Confirm the authoritative source for visit counts.',
         '[Source: Resolution register P21 onward, 14 September 2026] Dashboard Data and Visit Report differ.',NULL,'2026-09-14','Resolution register P21 onward','Prayag sales management','medium','open',NULL,NULL,NULL,FALSE),
        ('P42','PENDING','What source holds order-booking lines for 1 April–31 July 2026?','data quality',
         'Locate and reconcile the raw order-booking source for 1 April through 31 July 2026.',
         '[Source: Resolution register P21 onward, 14 September 2026] PSCode 3 archives were located and loaded.',NULL,'2026-09-14','Resolution register P21 onward','Prayag data / IT','urgent','answered','2026-09-14','PSCode 3 archive load','PSCode 3 archives located and loaded: 123,326 rows, Rs 81.36 Cr, reconciled against secondary_sku_line with Rs 0 variance in every month.',FALSE)
      ON CONFLICT (code) DO NOTHING;

      INSERT INTO resolution_item_relationship (source_code, target_code, relation)
      SELECT 'P' || n::text, 'P20', 'derived-from'::resolution_relation_type
        FROM generate_series(21, 42) AS n
      ON CONFLICT (source_code, target_code, relation) DO NOTHING;
      INSERT INTO resolution_item_relationship (source_code, target_code, relation)
      VALUES
        ('P30', 'P1', 'ask-supported-by'),
        ('P30', 'P2', 'ask-supported-by'),
        ('P33', 'P11', 'question-for-gap')
      ON CONFLICT (source_code, target_code, relation) DO NOTHING;

      DO $do$
      BEGIN
        IF (SELECT COUNT(*) FROM resolution_item WHERE code ~ '^P(2[1-9]|3[0-9]|4[0-2])$') <> 22 THEN
          RAISE EXCEPTION 'P21-P42 seed is incomplete';
        END IF;
        IF (SELECT COUNT(*) FROM resolution_item_relationship WHERE target_code = 'P20' AND relation = 'derived-from') <> 22 THEN
          RAISE EXCEPTION 'P20 derived-from relationships are incomplete';
        END IF;
        IF EXISTS (
          SELECT 1 FROM resolution_item_relationship
           WHERE (source_code = 'P40' AND target_code = 'P14')
              OR (source_code = 'P14' AND target_code = 'P40')
        ) THEN
          RAISE EXCEPTION 'P40 and P14 must remain separate';
        END IF;
      END
      $do$;

      UPDATE resolution_item
         SET status = 'resolved',
             resolved_on = '2026-09-14',
             resolved_by = 'Resolution register P21-P42 handoff',
             resolution_note = 'Superseded by P21-P42, which record all 22 questions from the previously unsent 31 August 2026 query pack.',
             updated_at = now()
       WHERE code = 'P20' AND status = 'open';
    `,
  },
  {
    id: "110_resolution_p008_product_code_findings",
    sql: `
      UPDATE resolution_item
         SET title = '814 sold codes with no MRP master record',
             reason = '814 sold codes remain without a unique MRP master record after P008 hyphen recovery.',
             evidence = '[Source: P008 hyphen recovery, 14 September 2026] Hyphen normalisation uniquely recovered eight codes worth Rs 0.54 Cr. The remaining unresolved population is 814 codes worth Rs 9.36 Cr.',
             value_at_stake = 93600000,
             updated_at = now()
       WHERE code = 'P3';

      UPDATE resolution_item
         SET title = 'Confirm three WCT one-edit product-code candidates',
             reason = 'Confirm whether WCT-3LL-10 maps to WT-3LL-10, WCT-3LL-05 maps to WT-3LL-05, and WCT-3LL-07 maps to WT-3LL-07.',
             evidence = '[Source: P008 hyphen recovery, 14 September 2026] These are unique edit-distance-one candidates only, not automatic resolver matches. Prayag confirmation is required. Value remains Rs 1.17 Cr.',
             value_at_stake = 11700000,
             updated_at = now()
       WHERE code = 'P4';

      INSERT INTO resolution_item
        (code, type, title, category, reason, evidence, value_at_stake, raised_on,
         raised_by, owner, priority, status, blocks_api)
      VALUES
        ('P43', 'PENDING', 'Six product codes have multiple one-edit catalogue candidates', 'master data',
         'Resolve 824XD, 924XD, 824SD, HD140B, HD160B and HD200B against the authoritative catalogue.',
         '[Source: P008 hyphen recovery, 14 September 2026] Each code has multiple edit-distance-one catalogue candidates. Combined value is Rs 1.50 Cr. The mappings are ambiguous and cannot be resolved without Prayag confirmation.',
         15000000, '2026-09-14', 'P008 hyphen recovery', 'Prayag', NULL, 'open', FALSE)
      ON CONFLICT (code) DO UPDATE
        SET title = EXCLUDED.title,
            category = EXCLUDED.category,
            reason = EXCLUDED.reason,
            evidence = EXCLUDED.evidence,
            value_at_stake = EXCLUDED.value_at_stake,
            owner = EXCLUDED.owner,
            updated_at = now();

      DO $do$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM resolution_item
           WHERE code = 'P3'
             AND title = '814 sold codes with no MRP master record'
             AND value_at_stake = 93600000
        ) THEN
          RAISE EXCEPTION 'P3 P008 update is incomplete';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM resolution_item
           WHERE code = 'P4'
             AND value_at_stake = 11700000
             AND evidence LIKE '%Prayag confirmation is required%'
        ) THEN
          RAISE EXCEPTION 'P4 candidate update is incomplete';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM resolution_item
           WHERE code = 'P43'
             AND type = 'PENDING'
             AND status = 'open'
             AND blocks_api = FALSE
             AND value_at_stake = 15000000
        ) THEN
          RAISE EXCEPTION 'P43 ambiguity item is incomplete';
        END IF;
      END
      $do$;
    `,
  },
  {
    id: "111_resolution_p43_priority",
    sql: `
      UPDATE resolution_item
         SET priority = 'high'::resolution_priority,
             updated_at = now()
       WHERE code = 'P43';

      DO $do$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM resolution_item
           WHERE code = 'P43'
             AND priority = 'high'::resolution_priority
             AND value_at_stake = 15000000
             AND status = 'open'
        ) THEN
          RAISE EXCEPTION 'P43 priority update is incomplete';
        END IF;
      END
      $do$;
    `,
  },
  {
    id: "112_resolution_p14_p40_population_distinction",
    sql: `
      UPDATE resolution_item
         SET evidence = '[Source: Replit Prompt 88 extended, Section D, 14 September 2026] Seven current roster members have no HR record. This population is distinct from P40, which covers 58 historical/off-roll names carrying Rs 13.51 Cr; the two populations must remain separate.',
             updated_at = now()
       WHERE code = 'P14';

      DO $do$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM resolution_item
           WHERE code = 'P14'
             AND evidence ILIKE '%distinct from P40%'
             AND evidence ILIKE '%seven current roster members%'
             AND evidence ILIKE '%58 historical/off-roll names%'
        ) THEN
          RAISE EXCEPTION 'P14 and P40 population distinction is incomplete';
        END IF;
        IF EXISTS (
          SELECT 1
            FROM resolution_item_relationship
           WHERE (source_code = 'P14' AND target_code = 'P40')
              OR (source_code = 'P40' AND target_code = 'P14')
        ) THEN
          RAISE EXCEPTION 'P14 and P40 must remain separate without a relationship row';
        END IF;
      END
      $do$;
    `,
  },
  {
    id: "113_resolution_raised_dates_and_legacy_priorities",
    sql: `
      WITH corrections(code, raised_on, priority, date_note) AS (
        VALUES
          ('H1',  DATE '2026-09-09', 'urgent'::resolution_priority, 'Exact raised date: 9 September 2026, PTMT BOM analysis.'),
          ('H2',  DATE '2026-09-07', 'high'::resolution_priority,   'Exact raised date: 7 September 2026, when August SKU froze empty.'),
          ('H3',  DATE '2026-09-02', 'high'::resolution_priority,   'Exact raised date: 2 September 2026, FY2024-25 date finding.'),
          ('P1',  DATE '2026-09-14', 'medium'::resolution_priority, 'Source-document date used: Prompt 88 extended, 14 September 2026; exact raised date unavailable.'),
          ('P2',  DATE '2026-09-14', 'high'::resolution_priority,   'Source-document date used: Prompt 88 extended, 14 September 2026; exact raised date unavailable.'),
          ('P3',  DATE '2026-09-14', 'high'::resolution_priority,   'Source-document date used: Prompt 88 extended, 14 September 2026; exact raised date unavailable.'),
          ('P4',  DATE '2026-09-14', 'medium'::resolution_priority, 'Source-document date used: Prompt 88 extended, 14 September 2026; exact raised date unavailable.'),
          ('P5',  DATE '2026-09-08', 'medium'::resolution_priority, 'Source-document date used: Prompt 64 September readiness, 8 September 2026; exact raised date unavailable.'),
          ('P6',  DATE '2026-09-08', 'high'::resolution_priority,   'Source-document date used: Prompt 64 September readiness, 8 September 2026; exact raised date unavailable.'),
          ('P7',  DATE '2026-09-14', 'medium'::resolution_priority, 'Source-document date used: Prompt 88 extended, 14 September 2026; exact raised date unavailable.'),
          ('P8',  DATE '2026-09-14', 'high'::resolution_priority,   'Source-document date used: Prompt 88 extended, 14 September 2026; exact raised date unavailable.'),
          ('P9',  DATE '2026-09-14', 'low'::resolution_priority,    'Source-document date used: Prompt 88 extended, 14 September 2026; exact raised date unavailable.'),
          ('P10', DATE '2026-09-10', 'medium'::resolution_priority, 'Source-document date used: Prompt 68 category registry, 10 September 2026; exact raised date unavailable.'),
          ('P11', DATE '2026-09-01', 'low'::resolution_priority,    'Source-document date used: The two outstanding FY2025-26 questions, 1 September 2026; exact raised date unavailable.'),
          ('P12', DATE '2026-09-01', 'high'::resolution_priority,   'Source-document date used: The two outstanding FY2025-26 questions, 1 September 2026; exact raised date unavailable.'),
          ('P13', DATE '2026-09-01', 'medium'::resolution_priority, 'Source-document date used: Prompt 34 split-state suffixes, 1 September 2026; exact raised date unavailable.'),
          ('P14', DATE '2026-09-14', 'medium'::resolution_priority, 'Source-document date used: Prompt 88 extended, 14 September 2026; exact raised date unavailable.'),
          ('P15', DATE '2026-09-03', 'high'::resolution_priority,   'Source-document date used: Prompt 57 Red Alerts verification, 3 September 2026; exact raised date unavailable.'),
          ('P16', DATE '2026-09-03', 'medium'::resolution_priority, 'Source-document date used: Prompt 57 Red Alerts verification, 3 September 2026; exact raised date unavailable.'),
          ('P17', DATE '2026-09-03', 'medium'::resolution_priority, 'Source-document date used: Prompt 58 Red Alerts display fixes, 3 September 2026; exact raised date unavailable.'),
          ('P18', DATE '2026-09-14', 'low'::resolution_priority,    'Source-document date used: Prompt 88 extended, 14 September 2026; exact raised date unavailable.'),
          ('P19', DATE '2026-09-14', 'medium'::resolution_priority, 'Source-document date used: Prompt 88 extended, 14 September 2026; exact raised date unavailable.')
      )
      UPDATE resolution_item AS item
         SET raised_on = corrections.raised_on,
             priority = corrections.priority,
             evidence = CASE
               WHEN item.evidence LIKE '%' || corrections.date_note || '%' THEN item.evidence
               ELSE item.evidence || ' [Raised date: ' || corrections.date_note || ']'
             END,
             updated_at = now()
        FROM corrections
       WHERE item.code = corrections.code;

      UPDATE resolution_item
         SET raised_on = DATE '2026-08-31',
             evidence = CASE
               WHEN evidence LIKE '%Raised date inherited from Prayag_Data_Queries_31Aug2026%' THEN evidence
               ELSE evidence || ' [Raised date inherited from Prayag_Data_Queries_31Aug2026, the parent query-pack date.]'
             END,
             updated_at = now()
       WHERE code ~ '^P(2[1-9]|3[0-9]|4[0-2])$';

      DO $do$
      BEGIN
        IF (SELECT COUNT(*) FROM resolution_item WHERE code ~ '^P(2[1-9]|3[0-9]|4[0-2])$' AND raised_on = DATE '2026-08-31') <> 22 THEN
          RAISE EXCEPTION 'P21-P42 raised dates are incomplete';
        END IF;
        IF (SELECT COUNT(*) FROM resolution_item WHERE code ~ '^(H[1-3]|P([1-9]|1[0-9]))$' AND priority IS NOT NULL) <> 22 THEN
          RAISE EXCEPTION 'H1-P19 priorities are incomplete';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM resolution_item
           WHERE code = 'H1' AND raised_on = DATE '2026-09-09' AND priority = 'urgent'
        ) OR NOT EXISTS (
          SELECT 1 FROM resolution_item
           WHERE code = 'H2' AND raised_on = DATE '2026-09-07' AND priority = 'high'
        ) OR NOT EXISTS (
          SELECT 1 FROM resolution_item
           WHERE code = 'H3' AND raised_on = DATE '2026-09-02' AND priority = 'high'
        ) OR NOT EXISTS (
          SELECT 1 FROM resolution_item
           WHERE code = 'P15' AND raised_on = DATE '2026-09-03' AND priority = 'high'
        ) THEN
          RAISE EXCEPTION 'Mandatory hold and delivery priorities are incomplete';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM resolution_item
           WHERE code = 'P42'
             AND status = 'answered'
             AND resolved_on = DATE '2026-09-14'
        ) THEN
          RAISE EXCEPTION 'P42 closed metadata changed while correcting raised dates';
        END IF;
      END
      $do$;
    `,
  },
  {
    id: "114_api_key_last_response",
    sql: `
      ALTER TABLE api_keys
        ADD COLUMN IF NOT EXISTS last_used_method TEXT,
        ADD COLUMN IF NOT EXISTS last_used_path TEXT,
        ADD COLUMN IF NOT EXISTS last_used_status INTEGER;

      ALTER TABLE api_keys
        DROP CONSTRAINT IF EXISTS api_keys_last_used_status_check;
      ALTER TABLE api_keys
        ADD CONSTRAINT api_keys_last_used_status_check
        CHECK (last_used_status IS NULL OR last_used_status BETWEEN 100 AND 599);
    `,
  },
  {
    id: "115_prompt93_geography_resolution_items",
    sql: `
      -- Prompt 93 Section A: record the geography build hold and the related
      -- RET# coverage finding.  The stable code is the seed key; DO NOTHING
      -- deliberately preserves any later administrator edit or resolution.
      INSERT INTO resolution_item
        (code, type, title, category, fiscal_year, month, scope_product,
         scope_measure, reason, evidence, value_at_stake, raised_on, raised_by,
         owner, priority, status, blocks_api)
      VALUES
        ('H4', 'HOLD', 'CANONICAL RETAILER GEOGRAPHY INCOMPLETE', 'master data',
         NULL, NULL, 'retailer state attribution', 'peer-set construction',
         'Retailer canonical state is directly known for 33.28% of FY2025-26 active retailers and 26.12% of FY2026-27. An unambiguous distributor bridge lifts this to 58.17% and 46.27%.',
         '[Source: Replit Prompt 93 Section A, 14 September 2026] 8,898 FY2025-26 active retailers, 2,961 with direct state, 5,176 after bridge. 6,194 FY2026-27 active, 1,618 direct, 2,866 after bridge. Among directly known FY2025-26 state x size-quintile cells, 32 of 45 hold at least 30 retailers - so peers are statistically credible WHERE geography is known.',
         NULL, '2026-09-14', 'Prompt 93 Section A',
         'internal, then Prayag for source attribution', 'high', 'open', TRUE),
        ('P44', 'PENDING', 'RET# COVERAGE UNEVEN ACROSS YEARS', 'data quality',
         NULL, NULL, NULL, NULL,
         '52,515 of 379,439 FY2025-26 secondary rows carry RET#, against complete RET# on all 123,326 FY2026-27 rows. Retailer identity falls back to normalised name for the remainder, which is weaker.',
         '[Source: Replit Prompt 93 Section A, 14 September 2026] 52,515 of 379,439 FY2025-26 secondary rows carry RET#, against complete RET# on all 123,326 FY2026-27 rows. Retailer identity falls back to normalised name for the remainder, which is weaker.',
         NULL, '2026-09-14', 'Prompt 93 Section A',
         'internal', 'medium', 'open', FALSE)
      ON CONFLICT (code) DO NOTHING;

      DO $do$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM resolution_item
           WHERE code = 'H4'
             AND type = 'HOLD'
             AND status = 'open'
             AND blocks_api = TRUE
             AND priority = 'high'::resolution_priority
        ) THEN
          RAISE EXCEPTION 'H4 geography hold seed is incomplete';
        END IF;
        IF NOT EXISTS (
          SELECT 1
            FROM resolution_item
           WHERE code = 'P44'
             AND type = 'PENDING'
             AND status = 'open'
             AND blocks_api = FALSE
             AND priority = 'medium'::resolution_priority
        ) THEN
          RAISE EXCEPTION 'P44 RET# coverage finding seed is incomplete';
        END IF;
      END
      $do$;
    `,
  },
  {
    id: "116_prompt94_visit_plan_persistence",
    sql: `
      -- Prompt 94 Sections B/D.  Plans are append-only proposals: a new
      -- generation inserts a row and supersedes the prior row; it never
      -- mutates the historical target list.
      CREATE TABLE IF NOT EXISTS visit_plan (
        id                    BIGSERIAL PRIMARY KEY,
        member                TEXT NOT NULL,
        member_norm           TEXT NOT NULL,
        state_head            TEXT,
        fy                    TEXT NOT NULL,
        month                 TEXT NOT NULL,
        generated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        generated_from        TEXT NOT NULL,
        source_snapshot_hash  TEXT NOT NULL,
        source_snapshot_at    TIMESTAMPTZ NOT NULL,
        source_snapshot        JSONB NOT NULL DEFAULT '{}'::jsonb,
        capacity              INTEGER NOT NULL DEFAULT 0,
        working_days          INTEGER NOT NULL DEFAULT 0,
        maintenance_budget    INTEGER NOT NULL DEFAULT 0,
        development_budget    INTEGER NOT NULL DEFAULT 0,
        status                TEXT NOT NULL DEFAULT 'proposed',
        approved_by           TEXT,
        approved_at           TIMESTAMPTZ,
        pool_exhausted         BOOLEAN NOT NULL DEFAULT FALSE,
        excluded_count         INTEGER NOT NULL DEFAULT 0,
        excluded_reason        TEXT,
        superseded_by          BIGINT,
        created_by             TEXT,
        CONSTRAINT visit_plan_status_ck CHECK (status IN ('proposed','approved','superseded'))
      );
      CREATE INDEX IF NOT EXISTS visit_plan_member_period_idx
        ON visit_plan (member, fy, month, generated_at DESC);
      CREATE INDEX IF NOT EXISTS visit_plan_status_idx ON visit_plan (status);

      CREATE TABLE IF NOT EXISTS visit_plan_target (
        id                    BIGSERIAL PRIMARY KEY,
        plan_id               BIGINT NOT NULL REFERENCES visit_plan(id),
        retailer_identity     TEXT NOT NULL,
        retailer_name         TEXT NOT NULL,
        district               TEXT,
        distance_km           NUMERIC,
        priority_type         TEXT NOT NULL,
        priority_score        NUMERIC,
        defaulted_inputs      JSONB NOT NULL DEFAULT '[]'::jsonb,
        input_states           JSONB NOT NULL DEFAULT '{}'::jsonb,
        input_reasons          JSONB NOT NULL DEFAULT '{}'::jsonb,
        business_plan         NUMERIC,
        order_booking         NUMERIC NOT NULL DEFAULT 0,
        visits_done           INTEGER,
        visits_required       INTEGER,
        reason                TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'proposed',
        visited_on            DATE,
        order_value_after     NUMERIC,
        completion_basis      TEXT,
        baseline_total_visit  INTEGER,
        current_total_visit   INTEGER,
        baseline_observed_at   TIMESTAMPTZ,
        current_observed_at    TIMESTAMPTZ,
        evidence              JSONB NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT visit_plan_target_priority_ck CHECK (priority_type IN ('maintain','develop','reduce')),
        CONSTRAINT visit_plan_target_status_ck CHECK (status IN ('planned','visited','not_visited','superseded'))
      );
      CREATE INDEX IF NOT EXISTS visit_plan_target_plan_idx ON visit_plan_target(plan_id);
      CREATE INDEX IF NOT EXISTS visit_plan_target_identity_idx ON visit_plan_target(retailer_identity);

      CREATE TABLE IF NOT EXISTS visit_plan_audit (
        id BIGSERIAL PRIMARY KEY,
        plan_id BIGINT NOT NULL REFERENCES visit_plan(id),
        event TEXT NOT NULL,
        actor_id TEXT,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        before_state JSONB,
        after_state JSONB,
        evidence JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE INDEX IF NOT EXISTS visit_plan_audit_plan_idx ON visit_plan_audit(plan_id, occurred_at);

      -- The operating-rules surface is durable and versioned, rather than
      -- relying on a file that may not be deployed with the API.
      CREATE TABLE IF NOT EXISTS operating_rule (
        rule_key TEXT PRIMARY KEY,
        rule_text TEXT NOT NULL,
        source TEXT NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: "117_prompt94_source_authority_register",
    sql: `
      INSERT INTO operating_rule (rule_key, rule_text, source)
      VALUES (
        'visit-source-authority',
        'There is no single visit authority. Dashboard Data owns aggregate headline visits, visited-retailer coverage and working days. Member sheets own retailer-level visits, required visits and VisitPlan analytics. HR/SFA owns only its separately labelled field-activity counters.

Any published figure labelled only ''Visits'' is ambiguous unless it also identifies aggregate visits, unique visited retailers, or retailer-row visits.',
        'Replit Prompt 94 Section E, 14 September 2026'
      )
      ON CONFLICT (rule_key) DO NOTHING;

      -- P41 is a three-source authority distinction, not a single-source
      -- conflict. Only an open row is transitioned, preserving administrator
      -- edits and making reruns harmless.
      UPDATE resolution_item
         SET status = 'answered',
             resolved_on = COALESCE(resolved_on, DATE '2026-09-14'),
             resolved_by = COALESCE(resolved_by, 'Prompt 94'),
             resolution_note = COALESCE(resolution_note,
               'Dashboard Data: aggregate headline visits, visited-retailer coverage, and working days. Member sheets: retailer-level visits, required visits, and VisitPlan analytics. HR/SFA: separately labelled field-activity counters. There is no single visit authority; a figure labelled only Visits is ambiguous unless it identifies aggregate visits, unique visited retailers, or retailer-row visits.'),
             updated_at = now()
       WHERE code = 'P41' AND status = 'open';

      -- Seed only if absent: never overwrite a local P45 investigation.
      INSERT INTO resolution_item
        (code, type, title, category, reason, evidence,
         raised_on, raised_by, owner, priority, status, blocks_api)
      VALUES
        ('P45', 'PENDING', 'VISIT FIGURES LABELLED ONLY ''VISITS''',
         'data quality',
         'Aggregate visits, unique visited retailers and retailer-row visits are three different measures shown under one word in several places.',
         '[Source: Replit Prompt 94 Section E, 14 September 2026] Audit every surface showing a visit figure and label which measure it is.',
         DATE '2026-09-14', 'Prompt 94 Section E', 'internal', 'medium', 'open', FALSE)
      ON CONFLICT (code) DO NOTHING;
    `,
  },
  {
    id: "118_prompt94_revision_and_target_proposal_links",
    sql: `
      -- Proposed targets are not operational until their parent is approved.
      ALTER TABLE visit_plan_target
        DROP CONSTRAINT IF EXISTS visit_plan_target_status_ck;
      ALTER TABLE visit_plan_target
        ADD CONSTRAINT visit_plan_target_status_ck
        CHECK (status IN ('proposed','planned','visited','not_visited','superseded'));
      ALTER TABLE visit_plan_target
        ALTER COLUMN status SET DEFAULT 'proposed';
      UPDATE visit_plan_target t
         SET status = 'proposed'
        FROM visit_plan p
       WHERE t.plan_id = p.id
         AND p.status = 'proposed'
         AND t.status = 'planned';

      ALTER TABLE visit_plan
        ADD COLUMN IF NOT EXISTS supersedes_plan_id BIGINT REFERENCES visit_plan(id);
      ALTER TABLE visit_plan_target
        ADD COLUMN IF NOT EXISTS supersedes_target_id BIGINT REFERENCES visit_plan_target(id),
        ADD COLUMN IF NOT EXISTS superseded_by_target_id BIGINT REFERENCES visit_plan_target(id),
        ADD COLUMN IF NOT EXISTS baseline_order_booking NUMERIC,
        ADD COLUMN IF NOT EXISTS current_order_booking NUMERIC;
      CREATE INDEX IF NOT EXISTS visit_plan_supersedes_idx ON visit_plan(supersedes_plan_id);
      CREATE INDEX IF NOT EXISTS visit_plan_target_supersedes_idx
        ON visit_plan_target(supersedes_target_id, superseded_by_target_id);
    `,
  },
  {
    id: "119_prompt94_current_revision_uniqueness",
    sql: `
      -- Repair legacy duplicate current revisions before enforcing the
      -- invariant. Newest generated_at wins; id breaks exact timestamp ties.
      CREATE TEMP TABLE prompt94_duplicate_revisions ON COMMIT DROP AS
      WITH ranked AS (
        SELECT id, member, fy, month,
               ROW_NUMBER() OVER (
                 PARTITION BY lower(regexp_replace(member, '[^a-zA-Z0-9]', '', 'g')), fy, month
                 ORDER BY generated_at DESC, id DESC
               ) AS revision_rank
          FROM visit_plan
         WHERE status <> 'superseded'
      ), duplicate_map AS (
        SELECT old.id AS old_id, keep.id AS keep_id
          FROM ranked old
          JOIN ranked keep
            ON lower(regexp_replace(keep.member, '[^a-zA-Z0-9]', '', 'g')) =
               lower(regexp_replace(old.member, '[^a-zA-Z0-9]', '', 'g'))
           AND keep.fy = old.fy
           AND keep.month = old.month
           AND keep.revision_rank = 1
         WHERE old.revision_rank > 1
      )
      SELECT old_id, keep_id FROM duplicate_map;

      -- Link pending duplicate targets to matching pending targets on the
      -- retained revision. Completed outcomes are intentionally untouched.
      UPDATE visit_plan_target old_target
         SET status = 'superseded',
             superseded_by_target_id = new_target.id
         FROM prompt94_duplicate_revisions duplicate_map,
              visit_plan_target new_target
       WHERE old_target.plan_id = duplicate_map.old_id
          AND new_target.plan_id = duplicate_map.keep_id
          AND new_target.retailer_identity = old_target.retailer_identity
          AND new_target.status IN ('proposed','planned')
         AND old_target.status IN ('proposed','planned');

      UPDATE visit_plan_target old_target
         SET status = 'superseded'
        FROM prompt94_duplicate_revisions duplicate_map
       WHERE old_target.plan_id = duplicate_map.old_id
         AND old_target.status IN ('proposed','planned');

      UPDATE visit_plan old
         SET status = 'superseded',
             superseded_by = duplicate_map.keep_id
        FROM prompt94_duplicate_revisions duplicate_map
       WHERE old.id = duplicate_map.old_id
         AND old.status <> 'superseded';

      UPDATE visit_plan keep
         SET supersedes_plan_id = links.old_id
        FROM (
          SELECT keep_id, MAX(old_id) AS old_id
            FROM prompt94_duplicate_revisions
           GROUP BY keep_id
        ) links
       WHERE keep.id = links.keep_id
         AND keep.supersedes_plan_id IS NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS visit_plan_current_revision_normalized_uidx
        ON visit_plan (member_norm, fy, month)
        WHERE status <> 'superseded';
    `,
  },
  {
    id: "120_prompt94_publish_safe_member_norm_index",
    sql: `
      -- Replit Publish cannot safely serialize the prior regexp_replace
      -- expression index. Store the normalized key explicitly so the
      -- development-to-production schema diff remains valid PostgreSQL.
      ALTER TABLE visit_plan
        ADD COLUMN IF NOT EXISTS member_norm TEXT;
      UPDATE visit_plan
         SET member_norm = lower(regexp_replace(member, '[^a-zA-Z0-9]', '', 'g'))
       WHERE member_norm IS NULL;
      ALTER TABLE visit_plan
        ALTER COLUMN member_norm SET NOT NULL;
      DROP INDEX IF EXISTS visit_plan_current_revision_normalized_uidx;
      CREATE UNIQUE INDEX visit_plan_current_revision_normalized_uidx
        ON visit_plan (member_norm, fy, month)
        WHERE status <> 'superseded';
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
