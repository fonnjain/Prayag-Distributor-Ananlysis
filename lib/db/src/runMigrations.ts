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

      -- Step 3: employee-code match for punctuation-different spellings
      --   K. Suresh Kumar (reg 134) → person 89  (code 25696++21111)
      --   S. Tirumala Rao (reg 253) → person 106 (code 3418596)
      UPDATE person_registry pr
      SET person_id = p.person_id
      FROM person p
      WHERE pr.id IN (134, 253)
        AND pr.employee_code = p.employee_code
        AND pr.employee_code IS NOT NULL
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
      -- Broaden the employee-code match: fill any remaining registry rows
      -- whose code matches a person row but were missed by name normalisation.
      UPDATE person_registry pr
      SET person_id = p.person_id
      FROM person p
      WHERE pr.employee_code = p.employee_code
        AND pr.employee_code IS NOT NULL
        AND TRIM(pr.employee_code) != ''
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
          ('East U.P', 'UTTAR PRADESH', 'approved East U.P state-head split'),
          ('West U.P', 'UP ( A )', 'approved West U.P state-head split')
        ) AS v(legacy_territory, state_canon, mapping_rule)
        WHERE v.legacy_territory = t.name
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
      WHERE sl.head_canon IS NOT NULL
        AND (
          sl.state_canon IN ('AP','HIMACHAL PRADESH','MAHARASHTRA','TAMIL NADU','TELANGANA')
          OR (sl.state_canon = 'PUNJAB' AND sl.fy <> '2023-24')
        )
      GROUP BY sl.state_canon, sl.fy, sl.head_canon;

      -- Fail closed before any coverage write if a selected customer would be
      -- assigned to more than one bucket, an unassigned bucket, or an
      -- unresolved person in the same leaf and FY.
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
          SELECT 1
          FROM selected_lines s
          LEFT JOIN person p ON p.name = s.person_name
          GROUP BY s.state_canon, s.fy, s.customer
          HAVING COUNT(DISTINCT COALESCE(s.head_canon, '__NULL__')) <> 1
              OR BOOL_OR(s.head_canon IS NULL OR p.person_id IS NULL OR p.is_system_coverage)
        ) THEN
          RAISE EXCEPTION 'mixed, unassigned, or unresolved customer attribution prevents derived coverage';
        END IF;
      END $$;

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

      WITH register_bounds AS (
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
        WHERE sl.head_canon IS NOT NULL
          AND (
            sl.state_canon IN ('AP','HIMACHAL PRADESH','MAHARASHTRA','TAMIL NADU','TELANGANA')
            OR (sl.state_canon = 'PUNJAB' AND sl.fy <> '2023-24')
          )
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
      -- A coverage row must never be derived from a customer whose register
      -- history is mixed, unassigned, or unresolved.  This validates the
      -- applied derivation before the migration is marked complete.
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
          SELECT 1
          FROM selected_lines s
          LEFT JOIN person p ON p.name = s.person_name
          GROUP BY s.state_canon, s.fy, s.customer
          HAVING COUNT(DISTINCT COALESCE(s.head_canon, '__NULL__')) <> 1
              OR BOOL_OR(s.head_canon IS NULL OR p.person_id IS NULL OR p.is_system_coverage)
        ) THEN
          RAISE EXCEPTION 'mixed, unassigned, or unresolved customer attribution prevents register-derived coverage';
        END IF;
      END $$;
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
