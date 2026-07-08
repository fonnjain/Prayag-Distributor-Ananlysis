// Orchestrates building and persisting dashboard snapshots.
import { desc } from "drizzle-orm";
import { db, dashboardSnapshots, type DashboardSnapshot } from "@workspace/db";
import { logger } from "../logger.js";
import { exportWorkbook } from "../sheets.js";
import { buildFy2425, buildFromOrders, buildResources } from "./transform.js";
import { seed } from "./seed.js";

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
  const [itemwiseWb, orderWb, rosterWb, headDashWb] = await Promise.all([
    exportWorkbook(ITEMWISE_SALES_FY2425),
    exportWorkbook(ORDER_BOOK_FY2627),
    exportWorkbook(RETAILER_DISTRIBUTOR_ROSTER),
    exportWorkbook(STATE_HEAD_DASHBOARD_FY2627),
  ]);

  const fy2425 = buildFy2425(itemwiseWb);
  const orders = buildFromOrders(orderWb);
  const resources = buildResources(rosterWb, headDashWb);

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
      retailers: resources.retailers,
      retailer_sales_inr: resources.retailer_sales_inr,
      fy2425_sales_inr: fy2425.grand_total,
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

  syncInFlight.finally(() => {
    syncInFlight = null;
  });

  return syncInFlight;
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
    seedInFlight.finally(() => {
      seedInFlight = null;
    });
  }

  return seedInFlight;
}
