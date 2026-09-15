import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "../logger.js";
import type { RetailerRow, MemberSheetResult } from "./memberSheet.js";

type PoolClientLike = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
  release: () => void;
};

export type VisitCompletion = {
  status: "visited" | "not_visited" | "planned";
  visitedOn: string | null;
  orderValueAfter: number | null;
  completionBasis: "inferred_total_visit_increase" | null;
  evidence: {
    identity: string;
    baselineTotalVisit: number | null;
    currentTotalVisit: number | null;
    baselineObservedAt: string | null;
    currentObservedAt: string | null;
    totalVisitDelta: number | null;
    baselineOrderBooking: number | null;
    currentOrderBooking: number | null;
    orderValueDelta: number | null;
    inferenceLabel: "inferred" | "not_inferred";
  };
};

function planMonthClosed(month: string | null | undefined, observedAt: string): boolean {
  if (!month) return false;
  const match = month.match(/^([A-Za-z]{3})\s+(\d{2})$/);
  if (!match) return false;
  const index = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    .findIndex((name) => name.toLowerCase() === match[1]!.toLowerCase());
  if (index < 0) return false;
  const year = 2000 + Number(match[2]);
  const close = Date.UTC(year, index + 1, 0, 23, 59, 59, 999);
  return new Date(observedAt).getTime() > close;
}

/** Stable retailer identity for matching across sheet refreshes. */
export function retailerIdentity(name: string, district?: string | null): string {
  return `${String(name).toLowerCase().replace(/[^a-z0-9]/g, "")}|${String(district ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

/**
 * A null visit count is unavailable, not zero. Completion is inferred only
 * from a cumulative increase observed on the same stable retailer identity.
 */
export function inferVisitCompletion(
  target: {
    retailerIdentity: string;
    baselineTotalVisit: number | null;
    baselineObservedAt?: string | null;
    baselineOrderBooking?: number | null;
    baselineSourceSnapshotHash?: string | null;
  },
  current: RetailerRow | null,
  observedAt: string,
  visitedOn: string,
  currentSourceSnapshotHash?: string | null,
  planMonth?: string | null,
): VisitCompletion {
  const currentTotalVisit = current?.totalVisit ?? null;
  const timestampIsNewer = !target.baselineObservedAt
    || new Date(observedAt).getTime() > new Date(target.baselineObservedAt).getTime();
  const contentIsNewer = !target.baselineSourceSnapshotHash
    || !currentSourceSnapshotHash
    || target.baselineSourceSnapshotHash !== currentSourceSnapshotHash;
  const sourceIsNewer = timestampIsNewer && contentIsNewer;
  const delta = target.baselineTotalVisit !== null && currentTotalVisit !== null && sourceIsNewer
    ? currentTotalVisit - target.baselineTotalVisit
    : null;
  const currentOrderBooking = current?.orderBooking ?? null;
  const orderValueDelta = target.baselineOrderBooking !== null && target.baselineOrderBooking !== undefined && currentOrderBooking !== null
    ? Math.max(0, currentOrderBooking - target.baselineOrderBooking)
    : null;
  const inferred = sourceIsNewer && delta !== null && delta > 0;
  // A non-increase is deliberately non-terminal. Without a closed-period
  // authoritative observation, a later refresh may still prove completion.
  const status = inferred
    ? "visited"
    : (sourceIsNewer && delta !== null && planMonthClosed(planMonth, observedAt)
      ? "not_visited"
      : "planned");
  return {
    status,
    visitedOn: inferred ? visitedOn : null,
    orderValueAfter: inferred ? orderValueDelta : null,
    completionBasis: inferred ? "inferred_total_visit_increase" : null,
    evidence: {
      identity: target.retailerIdentity,
      baselineTotalVisit: target.baselineTotalVisit,
      currentTotalVisit,
      baselineObservedAt: target.baselineObservedAt ?? null,
      currentObservedAt: observedAt,
      totalVisitDelta: delta,
      baselineOrderBooking: target.baselineOrderBooking ?? null,
      currentOrderBooking,
      orderValueDelta,
      inferenceLabel: inferred ? "inferred" : "not_inferred",
    },
  };
}

export function sourceSnapshotForMember(
  member: string,
  fy: string,
  data: MemberSheetResult,
  observedAt: string,
): Record<string, unknown> {
  const capacity = { ...data.visitPlan.capacity };
  if (capacity.demonstratedRateDenominatorAuthority === "Dashboard AG") {
    delete (capacity as Record<string, unknown>).dataCutoffWorkingDays;
  }
  return {
    member,
    fy,
    observedAt,
    tabName: data.tabName,
    rows: data.rows,
    pattern: data.visitPlan.pattern,
    capacity,
    unavailableCounts: data.visitPlan.unavailableCounts,
  };
}

export function sourceSnapshotHash(snapshot: Record<string, unknown>): string {
  // Observation time is metadata, not source content. Hash only authoritative
  // member rows so an identical cache refresh cannot masquerade as new data.
  const content = snapshot.rows
    ? { member: snapshot.member, fy: snapshot.fy, rows: snapshot.rows }
    : snapshot;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export function sourceRowsHash(member: string, fy: string, rows: RetailerRow[]): string {
  return sourceSnapshotHash({ member, fy, rows });
}

/**
 * Member-sheet refresh hook. This is deliberately best-effort for the sheet
 * loader: a database outage must not turn an otherwise readable source sheet
 * into an error. Completion remains inferred and never claims attendance.
 */
export async function reconcileApprovedPlansForMember(
  member: string,
  fy: string,
  rows: RetailerRow[],
  observedAt: string,
): Promise<number> {
  let client: PoolClientLike | null = null;
  let visited = 0;
  try {
    client = await pool.connect();
    if (!client) throw new Error("Unable to acquire database client");
    await client.query("BEGIN");
    const plans = await client.query(
      `SELECT id, month FROM visit_plan
        WHERE member_norm = lower(regexp_replace($1, '[^a-zA-Z0-9]', '', 'g'))
          AND fy = $2 AND status = 'approved'
        FOR UPDATE`,
      [member, fy],
    );
    const current = new Map(rows.map((row) => [retailerIdentity(row.name, row.district), row]));
    const currentSourceHash = sourceRowsHash(member, fy, rows);
    for (const plan of plans.rows) {
      const targets = await client.query(
        `SELECT * FROM visit_plan_target
          WHERE plan_id = $1 AND status = 'planned'
          FOR UPDATE`,
        [plan.id],
      );
      for (const target of targets.rows) {
        const completion = inferVisitCompletion(
          {
            retailerIdentity: target.retailer_identity,
            baselineTotalVisit: target.baseline_total_visit,
            baselineObservedAt: target.baseline_observed_at,
            baselineOrderBooking: target.baseline_order_booking,
            baselineSourceSnapshotHash: target.evidence?.sourceSnapshotHash ?? null,
          },
          current.get(target.retailer_identity) ?? null,
          observedAt,
          observedAt.slice(0, 10),
          currentSourceHash,
          plan.month,
        );
        if (completion.status === "visited") {
          visited++;
          await client.query(
            `UPDATE visit_plan_target
                SET status='visited', visited_on=$2, order_value_after=$3,
                    completion_basis=$4, current_total_visit=$5,
                    current_order_booking=$6, current_observed_at=$7,
                    evidence=$8::jsonb
              WHERE id=$1 AND status='planned'`,
            [target.id, completion.visitedOn, completion.orderValueAfter,
             completion.completionBasis, completion.evidence.currentTotalVisit,
             completion.evidence.currentOrderBooking, observedAt,
             JSON.stringify({ ...completion.evidence, sourceSnapshotHash: currentSourceHash })],
          );
        } else if (completion.status === "not_visited") {
          await client.query(
            `UPDATE visit_plan_target
                SET status='not_visited', current_total_visit=$2,
                    current_order_booking=$3, current_observed_at=$4,
                    evidence=$5::jsonb
              WHERE id=$1 AND status='planned'`,
            [target.id, completion.evidence.currentTotalVisit,
             completion.evidence.currentOrderBooking, observedAt,
             JSON.stringify({ ...completion.evidence, sourceSnapshotHash: currentSourceHash })],
          );
        } else {
          // Keep planned when this refresh is unavailable or is not strictly
          // newer, but retain the observation evidence for auditability.
          await client.query(
            `UPDATE visit_plan_target
                SET current_total_visit=$2, current_order_booking=$3,
                    current_observed_at=$4, evidence=$5::jsonb
              WHERE id=$1 AND status='planned'`,
            [target.id, completion.evidence.currentTotalVisit,
             completion.evidence.currentOrderBooking, observedAt,
             JSON.stringify({ ...completion.evidence, sourceSnapshotHash: currentSourceHash })],
          );
        }
      }
      await client.query(
        `INSERT INTO visit_plan_audit (plan_id, event, actor_id, evidence)
         VALUES ($1, 'auto_reconciled_from_member_sheet', NULL, $2::jsonb)`,
        [plan.id, JSON.stringify({
          observedAt,
          visited,
          inference: "stable retailer identity + strictly newer cumulative totalVisit increase; not confirmed attendance",
        })],
      );
    }
    await client.query("COMMIT");
    return visited;
  } catch (err) {
    await client?.query("ROLLBACK").catch(() => undefined);
    logger.warn({ err, member, fy }, "visit plan auto-reconciliation skipped");
    return 0;
  } finally {
    client?.release();
  }
}
