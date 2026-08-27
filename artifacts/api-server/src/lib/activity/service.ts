import { pool as databasePool } from "@workspace/db";
import { logger } from "../logger.js";

export const ACTIVITY_TIMEZONE = "Asia/Kolkata";
export const IDLE_THRESHOLD_MS = 5 * 60 * 1_000;
const MAX_EVENTS = 50;
const PATH_MAX = 200;
const ACTION_MAX = 100;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ACTION_RE = /^[a-z][a-z0-9_.:-]{0,99}$/;

export type ActivityKind = "page_view" | "heartbeat" | "action" | "session_end";
export type ActivityState = "active" | "idle";
export interface ActivityEvent { clientEventId: string; kind: ActivityKind; path?: string; action?: string; state?: ActivityState }
export interface ActivityBatch { clientTabId: string; events: ActivityEvent[] }
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
type ActivityClient = Queryable & { release: () => void };
type ActivityPool = { connect: () => Promise<ActivityClient>; query: Queryable["query"] };

export function canonicalPath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.startsWith("/") || value.length > PATH_MAX || value.includes("?") || value.includes("#") || /[\u0000-\u001f]/.test(value)) {
    throw new Error("Invalid page path");
  }
  return value;
}

export function validateActivityBatch(value: unknown): ActivityBatch {
  const body = value as Record<string, unknown>;
  if (!body || typeof body !== "object" || !ID_RE.test(String(body.clientTabId ?? "")) || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > MAX_EVENTS) {
    throw new Error("Invalid activity batch");
  }
  const ids = new Set<string>();
  const events = body.events.map((raw): ActivityEvent => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid activity event");
    const event = raw as Record<string, unknown>;
    const clientEventId = typeof event.clientEventId === "string" ? event.clientEventId : "";
    const kind = event.kind;
    if (!ID_RE.test(clientEventId) || ids.has(clientEventId) || !["page_view", "heartbeat", "action", "session_end"].includes(String(kind))) throw new Error("Invalid activity event");
    ids.add(clientEventId);
    const path = canonicalPath(event.path);
    const action = event.action === undefined ? undefined : typeof event.action === "string" && event.action.length > 0 && event.action.length <= ACTION_MAX && ACTION_RE.test(event.action) ? event.action : (() => { throw new Error("Invalid action"); })();
    const state = event.state;
    if (state !== undefined && state !== "active" && state !== "idle") throw new Error("Invalid activity state");
    if (kind === "page_view" && !path) throw new Error("Page views require a path");
    if (kind === "action" && !action) throw new Error("Actions require an action");
    return { clientEventId, kind: kind as ActivityKind, path, action, state: state as ActivityState | undefined };
  });
  return { clientTabId: body.clientTabId as string, events };
}

export function elapsedContribution(lastSeenAt: Date, now: Date, previousState: ActivityState): { activeMs: number; idleMs: number } {
  const elapsed = now.getTime() - lastSeenAt.getTime();
  // Clock movement and missing/late heartbeats never inflate activity.
  if (elapsed <= 0 || elapsed > IDLE_THRESHOLD_MS) return { activeMs: 0, idleMs: 0 };
  return previousState === "active" ? { activeMs: elapsed, idleMs: 0 } : { activeMs: 0, idleMs: elapsed };
}

export function indiaDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ACTIVITY_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface StoredActivityEvent { activity_session_id: number; occurred_at: Date; state: ActivityState; kind: ActivityKind }
export interface DailyActivityRollup { date: string; activeMs: number; idleMs: number; firstSeenAt: Date | null; lastSeenAt: Date | null; pageViews: number; actionCount: number }

function indiaMidnight(date: string): Date { return new Date(`${date}T00:00:00+05:30`); }
function nextIndiaDate(date: string): string { return indiaDate(new Date(indiaMidnight(date).getTime() + 24 * 60 * 60_000)); }
function previousIndiaDate(date: string): string { return indiaDate(new Date(indiaMidnight(date).getTime() - 1)); }
export function retentionCutoff(now: Date): { date: string; instant: Date } {
  let date = indiaDate(now);
  for (let i = 0; i < 89; i++) date = previousIndiaDate(date);
  return { date, instant: indiaMidnight(date) };
}

/** Deletes every activity record before the earliest of the 90 retained India dates. */
export async function cleanupActivityRetention(now = new Date(), db: Pick<ActivityPool, "query"> = databasePool): Promise<void> {
  const cutoff = retentionCutoff(now);
  await db.query(`DELETE FROM user_activity_events WHERE occurred_at < $1`, [cutoff.instant]);
  await db.query(`DELETE FROM user_activity_sessions WHERE last_seen_at < $1`, [cutoff.instant]);
  await db.query(`DELETE FROM user_activity_daily_rollups WHERE activity_date < $1::date`, [cutoff.date]);
}

/** Converts state-bearing per-tab events to a per-user union; active wins overlaps. */
export function buildDailyActivityRollup(events: StoredActivityEvent[], date: string): DailyActivityRollup {
  const start = indiaMidnight(date); const end = indiaMidnight(nextIndiaDate(date));
  const grouped = new Map<number, StoredActivityEvent[]>();
  for (const event of events) grouped.set(event.activity_session_id, [...(grouped.get(event.activity_session_id) ?? []), event]);
  const segments: Array<{ start: number; end: number; state: ActivityState }> = [];
  for (const sessionEvents of grouped.values()) {
    sessionEvents.sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
    for (let i = 0; i < sessionEvents.length; i++) {
      const event = sessionEvents[i]; if (event.kind === "session_end") continue;
      const intervalStart = event.occurred_at.getTime();
      const next = sessionEvents[i + 1]?.occurred_at.getTime();
      // Never project an open event forward: until a later server-timestamped
      // heartbeat arrives, no elapsed time is proven. Long gaps are likewise
      // excluded rather than turning a hidden or abandoned tab into activity.
      if (next === undefined || next - intervalStart > IDLE_THRESHOLD_MS) continue;
      const intervalEnd = next;
      const clippedStart = Math.max(intervalStart, start.getTime()); const clippedEnd = Math.min(intervalEnd, end.getTime());
      if (clippedEnd > clippedStart) segments.push({ start: clippedStart, end: clippedEnd, state: event.state });
    }
  }
  // Sweep all boundaries; evaluating every interval avoids any cross-tab summing.
  const points = [...new Set(segments.flatMap((segment) => [segment.start, segment.end]))].sort((a, b) => a - b);
  let activeMs = 0; let idleMs = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]; const b = points[i + 1];
    const covering = segments.filter((s) => s.start <= a && s.end >= b);
    if (covering.some((s) => s.state === "active")) activeMs += b - a;
    else if (covering.length) idleMs += b - a;
  }
  const inDay = events.filter((event) => event.occurred_at >= start && event.occurred_at < end);
  return { date, activeMs, idleMs, firstSeenAt: inDay.length ? new Date(Math.min(...inDay.map((e) => e.occurred_at.getTime()))) : null, lastSeenAt: inDay.length ? new Date(Math.max(...inDay.map((e) => e.occurred_at.getTime()))) : null, pageViews: inDay.filter((e) => e.kind === "page_view").length, actionCount: inDay.filter((e) => e.kind === "action").length };
}

async function rebuildUserDay(client: Queryable, userId: number, date: string): Promise<void> {
  const start = indiaMidnight(date); const end = indiaMidnight(nextIndiaDate(date));
  const rows = await client.query(
    `SELECT activity_session_id, occurred_at, state, kind FROM user_activity_events
     WHERE user_id=$1 AND occurred_at >= $2 AND occurred_at < $3 ORDER BY activity_session_id, occurred_at, id`,
    [userId, new Date(start.getTime() - IDLE_THRESHOLD_MS), new Date(end.getTime() + IDLE_THRESHOLD_MS)],
  );
  const rollup = buildDailyActivityRollup(rows.rows as StoredActivityEvent[], date);
  if (!rollup.firstSeenAt && rollup.activeMs === 0 && rollup.idleMs === 0) {
    await client.query(`DELETE FROM user_activity_daily_rollups WHERE user_id=$1 AND activity_date=$2`, [userId, date]);
    return;
  }
  await client.query(
    `INSERT INTO user_activity_daily_rollups
       (user_id, activity_date, active_ms, idle_ms, first_seen_at, last_seen_at, page_views, action_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, activity_date) DO UPDATE SET
        active_ms = EXCLUDED.active_ms,
        idle_ms = EXCLUDED.idle_ms,
        first_seen_at = EXCLUDED.first_seen_at,
        last_seen_at = EXCLUDED.last_seen_at,
        page_views = EXCLUDED.page_views,
        action_count = EXCLUDED.action_count`,
     [userId, date, rollup.activeMs, rollup.idleMs, rollup.firstSeenAt, rollup.lastSeenAt, rollup.pageViews, rollup.actionCount],
  );
}

export async function ingestActivity(userId: number, authSessionId: number, batch: ActivityBatch, db: Pick<ActivityPool, "connect"> = databasePool): Promise<{ accepted: number; duplicates: number }> {
  const client = await db.connect();
  let accepted = 0; let duplicates = 0;
  try {
    await client.query("BEGIN");
    // Sessions from different browser tabs use different rows, so a row lock
    // cannot protect their shared per-user rollup. Hold this transaction-scoped
    // lock through event insertion and rebuild so the later tab always sees
    // the earlier tab's committed intervals and event counts.
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [427, userId]);
    const created = await client.query(
      `INSERT INTO user_activity_sessions (user_id, auth_session_id, client_tab_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, auth_session_id, client_tab_id) DO UPDATE SET last_seen_at = user_activity_sessions.last_seen_at
       RETURNING id`, [userId, authSessionId, batch.clientTabId],
    );
    const activitySessionId = (created.rows[0] as { id: number }).id;
    for (const event of batch.events) {
      const now = new Date();
      const previous = await client.query(
        `SELECT last_seen_at, last_state FROM user_activity_sessions WHERE id = $1 FOR UPDATE`, [activitySessionId],
      );
      const row = previous.rows[0] as { last_seen_at: Date; last_state: ActivityState };
      const effectiveState = event.state ?? row.last_state;
      const inserted = await client.query(
        `INSERT INTO user_activity_events (user_id, activity_session_id, client_event_id, kind, path, action, state, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (activity_session_id, client_event_id) DO NOTHING RETURNING id`,
        [userId, activitySessionId, event.clientEventId, event.kind, event.path ?? null, event.action ?? null, effectiveState, now],
      );
      if (!inserted.rows[0]) { duplicates++; continue; }
      await client.query(
        `UPDATE user_activity_sessions SET last_seen_at=$2, last_state=$3, ended_at=CASE WHEN $4 THEN $2 ELSE ended_at END WHERE id=$1`,
        [activitySessionId, now, effectiveState, event.kind === "session_end"],
      );
      accepted++;
    }
    if (accepted) {
      const today = indiaDate(new Date());
      await rebuildUserDay(client, userId, previousIndiaDate(today));
      await rebuildUserDay(client, userId, today);
      // A final active heartbeat can contribute up to five minutes across
      // midnight, so materialize the following India date too when needed.
      await rebuildUserDay(client, userId, nextIndiaDate(today));
    }
    await client.query("COMMIT");
    return { accepted, duplicates };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    logger.error({ err, userId }, "activity ingestion failed");
    throw err;
  } finally { client.release(); }
}

export function validateDateRange(fromValue: unknown, toValue: unknown): { from: string; to: string } {
  const valid = (value: unknown) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (!valid(fromValue) || !valid(toValue) || String(fromValue) > String(toValue)) throw new Error("from and to must be YYYY-MM-DD");
  const days = (Date.parse(`${toValue}T00:00:00Z`) - Date.parse(`${fromValue}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > 31) throw new Error("Date range may not exceed 31 days");
  return { from: String(fromValue), to: String(toValue) };
}

export async function activityReport(from: string, to: string, userId?: number, db: Pick<ActivityPool, "query"> = databasePool) {
  const params: unknown[] = [from, to];
  const userClause = userId ? ` AND u.id = $3` : "";
  if (userId) params.push(userId);
  const totals = await db.query(
    `SELECT u.id AS "userId", u.display_name AS "displayName", u.email, u.role, u.is_active AS "isActive",
       COALESCE(SUM(r.active_ms),0)::bigint AS "activeMs", COALESCE(SUM(r.idle_ms),0)::bigint AS "idleMs",
       MIN(r.first_seen_at) AS "firstSeenAt", MAX(r.last_seen_at) AS "lastSeenAt",
       COALESCE(SUM(r.page_views),0)::int AS "pageViews", COALESCE(SUM(r.action_count),0)::int AS "actionCount",
       EXISTS(SELECT 1 FROM user_activity_sessions s WHERE s.user_id=u.id AND s.last_state='active' AND s.last_seen_at >= now() - interval '5 minutes' AND s.ended_at IS NULL) AS current
     FROM auth_users u LEFT JOIN user_activity_daily_rollups r ON r.user_id=u.id AND r.activity_date BETWEEN $1::date AND $2::date
     WHERE EXISTS (SELECT 1 FROM user_activity_daily_rollups x WHERE x.user_id=u.id AND x.activity_date BETWEEN $1::date AND $2::date) ${userClause}
     GROUP BY u.id ORDER BY u.display_name, u.id`, params,
  );
  const dayRows = await db.query(
    `SELECT user_id AS "userId", activity_date::text AS date, active_ms::bigint AS "activeMs", idle_ms::bigint AS "idleMs",
       first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt", page_views AS "pageViews", action_count AS "actionCount"
     FROM user_activity_daily_rollups WHERE activity_date BETWEEN $1::date AND $2::date${userId ? " AND user_id=$3" : ""} ORDER BY activity_date`, params,
  );
  const summaries = totals.rows.map((row: any) => {
    const days = dayRows.rows.filter((day: any) => day.userId === row.userId).map((day: any) => ({ ...day, totalMs: Number(day.activeMs) + Number(day.idleMs) }));
    return { ...row, activeMs: Number(row.activeMs), idleMs: Number(row.idleMs), totalMs: Number(row.activeMs) + Number(row.idleMs), days };
  });
  const report: any = { timezone: ACTIVITY_TIMEZONE, from, to, summaries };
  if (userId) {
    const pages = await db.query(
      `SELECT path, COUNT(*)::int AS views, MAX(occurred_at) AS "lastSeenAt" FROM user_activity_events
       WHERE user_id=$1 AND occurred_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata') AND occurred_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
         AND kind='page_view' GROUP BY path ORDER BY views DESC, "lastSeenAt" DESC LIMIT 100`, [userId, from, to],
    );
    const events = await db.query(
       `SELECT occurred_at AS "occurredAt", kind, path, action, state FROM user_activity_events
        WHERE user_id=$1 AND occurred_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata') AND occurred_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
          AND kind IN ('page_view', 'action')
       ORDER BY occurred_at DESC, id DESC LIMIT 200`, [userId, from, to],
    );
    report.detail = { pages: pages.rows, events: events.rows };
  }
  return report;
}