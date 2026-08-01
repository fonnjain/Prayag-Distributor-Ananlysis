// Orchestrates building and persisting dashboard snapshots.
import { and, desc, eq, sql } from "drizzle-orm";
import { db, dashboardSnapshots, saleLines, type DashboardSnapshot } from "@workspace/db";
import { logger } from "../logger.js";
import { fetchWorkbook } from "../sheets.js";
import {
  buildFy2425,
  buildFromOrders,
  buildResources,
  isMonthlyTabTitle,
} from "./transform.js";
import { seed } from "./seed.js";
import {
  checkRegisterGuard,
  isSnapshotStale,
  type RegisterGuardResult,
} from "./registerGuard.js";
import { readVerifyAnchors } from "../config/verifyAnchors.js";

// Live source workbooks (see manifest.primary_sources).
const ITEMWISE_SALES_FY2425 = "1HgWelwHy73Ybc-1fBQMXhKxo2ctJToxgZLDWwJPmqz8";
const ORDER_BOOK_FY2627 = "1HFBAtvbAskejVkjuO8zHoEsE-pBAFij2ERMKFEvt64A";
const RETAILER_DISTRIBUTOR_ROSTER = "1EbWoXm-LC9L_nsh4JUzMU7v0H6Q3Lq8FEmKgFT9FXHc";
const STATE_HEAD_DASHBOARD_FY2627 = "1E1jEY_yO8LmpqBDpcesS_fu2SBPEQ0eKO5xN29XyTEM";

export interface DashboardPayload {
  data: Record<string, unknown>;
  manifest: Record<string, unknown>;
}

// Builds the aggregate dashboard payload entirely from the live Google Sheets.
export async function buildSnapshot(): Promise<DashboardPayload> {
  // Each workbook fetch pulls only the tabs the transforms read; anything
  // more burns through the Sheets API per-minute read quota.
  const [itemwiseWb, orderWb, rosterWb, headDashWb] = await Promise.all([
    fetchWorkbook(ITEMWISE_SALES_FY2425, (t) => t.trim() === "SALE"),
    fetchWorkbook(ORDER_BOOK_FY2627, isMonthlyTabTitle),
    fetchWorkbook(RETAILER_DISTRIBUTOR_ROSTER, (t) =>
      /^(retailer|distributor)$/i.test(t.trim()),
    ),
    fetchWorkbook(
      STATE_HEAD_DASHBOARD_FY2627,
      (t) =>
        t.trim() === "Data" ||
        t.trim().toUpperCase().startsWith("SECONDARY ORDER BOOKING REPORT"),
    ),
  ]);

  const fy2425 = buildFy2425(itemwiseWb);
  const orders = buildFromOrders(orderWb);
  const resources = buildResources(rosterWb, headDashWb);

  // FY2024-25 primary dispatch total — sourced from the invoice-line register
  // (sale_line_all WHERE fy = '2024-25') rather than the item-wise SALE tab in the
  // dashboard workbook.  Two independent sources (sale_line_all and the State Head
  // Sale 2025-26 sheet filtered on FY-2024-25) both return Rs.341.14 Cr; the
  // SALE tab returns Rs.341.73 Cr (+Rs.0.59 Cr) and is the odd one out.
  //
  // COMPLETENESS GUARD: a non-null DB sum is not sufficient — a partial register
  // will produce a non-null sum that is silently wrong even with all 12 months
  // present (rows missing across months, not whole months absent).  Three
  // independent checks are required before the DB figure is trusted:
  //   1. Month count — all 12 months present.
  //   2. Magnitude — deviation from SALE tab control <= 2%.
  //   3. Row count — at least the verified minimum rows from verify_anchors.json.
  // Any failure falls back to the SALE tab total and logs at error level.
  // The ?? operator is intentionally NOT used here; this is a completeness
  // check, not a null check.
  //
  // Wrapped in try-catch so a DB error (e.g. table not in schema search_path
  // during integration tests) degrades gracefully to the SALE tab fallback
  // rather than crashing the entire snapshot build.
  const fy2425MinRowCount =
    readVerifyAnchors<{ register_row_anchors?: { "2024-25"?: { minRowCount?: number } } }>()
      .register_row_anchors?.["2024-25"]?.minRowCount ?? 0;

  let fy2425GuardResult: RegisterGuardResult | null = null;
  try {
    const [fy2425DbRow] = await db
      .select({
        total: sql<string>`coalesce(sum(amount), 0)`,
        distinct_months: sql<number>`count(distinct month_label)::int`,
        row_count: sql<number>`count(*)::int`,
      })
      .from(saleLines)
      .where(and(eq(saleLines.fy, "2024-25"), eq(saleLines.versionStatus, "current")));
    fy2425GuardResult = checkRegisterGuard({
      fy: "2024-25",
      dbTotalInr: Number(fy2425DbRow?.total ?? 0),
      rowCount: fy2425DbRow?.row_count ?? 0,
      monthCount: fy2425DbRow?.distinct_months ?? 0,
      sheetTotalInr: fy2425.grand_total,
      minRowCount: fy2425MinRowCount,
    });
  } catch (err) {
    logger.error(
      { err, db_total_inr: null, sheet_total_inr: fy2425.grand_total },
      "sale_line_all query failed for FY2024-25 — DB total unavailable, falling back to SALE tab total %d",
      fy2425.grand_total,
    );
  }

  let fy2425SalesInr: number;
  if (fy2425GuardResult?.passed === true) {
    fy2425SalesInr = fy2425GuardResult.dbTotalInr;
  } else {
    if (fy2425GuardResult != null && !fy2425GuardResult.passed) {
      logger.error(
        {
          fy: "2024-25",
          rejection_reason: fy2425GuardResult.rejectionReason,
          month_count: fy2425GuardResult.monthCount,
          row_count: fy2425GuardResult.rowCount,
          db_total_inr: fy2425GuardResult.dbTotalInr,
          sheet_total_inr: fy2425GuardResult.sheetTotalInr,
          deviation_pct: fy2425GuardResult.deviationPct.toFixed(1),
        },
        "register completeness guard rejected FY2024-25 DB figure — %s; falling back to SALE tab total",
        fy2425GuardResult.rejectionReason,
      );
    }
    fy2425SalesInr = fy2425.grand_total;
  }

  const data = {
    fy2425,
    orders_fy2627: orders.orders_fy2627,
    by_state: orders.by_state,
    heads_retail: orders.heads_retail,
    heads_resources: resources.heads_resources,
    coverage: resources.coverage,
    coverage_totals: resources.coverage_totals,
    top_retailers: orders.top_retailers,
    totals: {
      state_heads: resources.state_heads,
      distributors: resources.distributors,
      dealers: resources.dealers,
      channel_partners: resources.channel_partners,
      secondary_retail_reach: resources.secondary_retail_reach,
      retailers: resources.retailers,
      retailer_sales_inr: resources.retailer_sales_inr,
      fy2425_sales_inr: fy2425SalesInr,
      orders_fy2627_ytd_cr: orders.orders_ytd_cr,
    },
  };

  const seedManifest = seed.manifest as Record<string, unknown>;
  const manifest = {
    ...seedManifest,
    primary_sources: {
      ...(seedManifest.primary_sources as Record<string, unknown>),
      retailer_distributor_roster: {
        desc: 'Registered retailer roster ("Retailer" tab -> coverage) and distributor roster ("Distributor" tab -> distributor counts).',
        id: RETAILER_DISTRIBUTOR_ROSTER,
      },
      state_head_dashboard: {
        desc: 'Per-head team dashboard. "Data" tab -> states covered per head; "SECONDARY ORDER BOOKING REPORT" tab -> dealer network and secondary order value per head.',
        id: STATE_HEAD_DASHBOARD_FY2627,
      },
    },
    // Guard result stored so the serve path can re-validate without a rebuild.
    // source="db" means the guard passed; source="sheet" means a fallback was used.
    register_guard: {
      fy2425: fy2425GuardResult ?? { source: "sheet", passed: false, rejectionReason: "DB query error — fallback used" },
    },
    generated: new Date().toISOString(),
    data_mode: "live",
  };

  return { data, manifest };
}

export async function getLatestSnapshot(): Promise<DashboardSnapshot | null> {
  const rows = await db
    .select()
    .from(dashboardSnapshots)
    .orderBy(desc(dashboardSnapshots.id))
    .limit(1);
  return rows[0] ?? null;
}

// Checks whether a previously-built snapshot is stale by re-querying the
// current FY2024-25 row count and comparing it against the verified minimum
// in verify_anchors.json.  Returns true only when the snapshot was built using
// the DB figure (source="db") AND the current row count has since dropped
// below the anchor — the exact signature of the original partial-load fault.
// A DB error during the count query is treated as "not stale" so the serve
// path never blocks on an inaccessible table.
export async function checkSnapshotStaleness(
  snapshot: DashboardSnapshot,
): Promise<boolean> {
  const storedGuard = (
    snapshot.manifest as unknown as {
      register_guard?: { fy2425?: RegisterGuardResult };
    }
  ).register_guard?.fy2425;

  if (!storedGuard || storedGuard.source !== "db") return false;

  const minRowCount =
    readVerifyAnchors<{ register_row_anchors?: { "2024-25"?: { minRowCount?: number } } }>()
      .register_row_anchors?.["2024-25"]?.minRowCount;
  if (!minRowCount) return false;

  let currentRowCount: number;
  try {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(saleLines)
      .where(and(eq(saleLines.fy, "2024-25"), eq(saleLines.versionStatus, "current")));
    currentRowCount = row?.n ?? 0;
  } catch {
    return false;
  }

  const stale = isSnapshotStale(storedGuard, currentRowCount, minRowCount);
  if (stale) {
    logger.error(
      {
        current_row_count: currentRowCount,
        min_row_count: minRowCount,
        stored_row_count: storedGuard.rowCount,
        fy: "2024-25",
      },
      "stale snapshot detected: FY2024-25 row count %d is below anchor %d — triggering rebuild",
      currentRowCount,
      minRowCount,
    );
  }
  return stale;
}

let syncInFlight: Promise<DashboardSnapshot> | null = null;

// Rebuilds from live sheets and persists a new snapshot. Concurrent callers
// share the same in-flight build. Throws on failure (caller decides fallback).
export function syncDashboard(): Promise<DashboardSnapshot> {
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    const started = Date.now();
    logger.info("dashboard sync started");
    const payload = await buildSnapshot();
    const [row] = await db
      .insert(dashboardSnapshots)
      .values({
        data: payload.data,
        manifest: payload.manifest,
        sourceStatus: "live",
      })
      .returning();
    logger.info({ ms: Date.now() - started }, "dashboard sync completed");
    return row;
  })();

  // Reset via a side chain that swallows the rejection; callers still receive
  // the original (rejecting) promise. Without the catch, the .finally() chain
  // itself becomes an unhandled rejection whenever a sync fails.
  syncInFlight
    .catch(() => undefined)
    .finally(() => {
      syncInFlight = null;
    });

  return syncInFlight;
}

const DEFAULT_SYNC_INTERVAL_MINUTES = 60;

// Resolves the scheduled sync interval in milliseconds from
// DASHBOARD_SYNC_INTERVAL_MINUTES. Returns null when scheduling is disabled
// (value of 0), and falls back to the default on missing/invalid values.
export function resolveSyncIntervalMs(): number | null {
  const raw = process.env["DASHBOARD_SYNC_INTERVAL_MINUTES"];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SYNC_INTERVAL_MINUTES * 60_000;
  }

  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    logger.warn(
      { value: raw, defaultMinutes: DEFAULT_SYNC_INTERVAL_MINUTES },
      "invalid DASHBOARD_SYNC_INTERVAL_MINUTES, using default",
    );
    return DEFAULT_SYNC_INTERVAL_MINUTES * 60_000;
  }

  if (minutes === 0) return null;

  return minutes * 60_000;
}

let scheduledSyncTimer: NodeJS.Timeout | null = null;

// Starts a periodic background live sync. Overlapping runs are impossible:
// syncDashboard() shares a single in-flight build across all callers, so a
// tick that fires while a sync is running just joins the existing one.
// Failures are logged and never touch persisted data (snapshots are only
// appended on success), so the last good snapshot always remains served.
export function startScheduledSync(): void {
  if (scheduledSyncTimer) return;

  const intervalMs = resolveSyncIntervalMs();
  if (intervalMs === null) {
    logger.info(
      "scheduled dashboard sync disabled (DASHBOARD_SYNC_INTERVAL_MINUTES=0)",
    );
    return;
  }

  logger.info(
    { intervalMinutes: intervalMs / 60_000 },
    "scheduled dashboard sync enabled",
  );

  scheduledSyncTimer = setInterval(() => {
    syncDashboard().catch((err: unknown) => {
      logger.error(
        { err },
        "scheduled dashboard sync failed; keeping last good snapshot",
      );
    });
  }, intervalMs);

  // Do not keep the process alive solely for the scheduler.
  scheduledSyncTimer.unref();
}

export function stopScheduledSync(): void {
  if (scheduledSyncTimer) {
    clearInterval(scheduledSyncTimer);
    scheduledSyncTimer = null;
  }
}

let seedInFlight: Promise<DashboardSnapshot> | null = null;

// Ensures at least one snapshot exists so the dashboard always has data, even
// before the first live sync. Returns the latest snapshot, seeding from the
// bundled static dataset only when the table is empty. Concurrent first-run
// callers share a single insert so no duplicate seed rows are created.
export async function ensureSeeded(): Promise<DashboardSnapshot> {
  const existing = await getLatestSnapshot();
  if (existing) return existing;

  if (!seedInFlight) {
    seedInFlight = (async () => {
      logger.info("seeding initial dashboard snapshot from bundled dataset");
      const [row] = await db
        .insert(dashboardSnapshots)
        .values({
          data: seed.data,
          manifest: { ...seed.manifest, data_mode: "seed" },
          sourceStatus: "seed",
        })
        .returning();
      return row;
    })();
    seedInFlight
      .catch(() => undefined)
      .finally(() => {
        seedInFlight = null;
      });
  }

  return seedInFlight;
}
