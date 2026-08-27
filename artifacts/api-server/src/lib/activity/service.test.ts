import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import {
  IDLE_THRESHOLD_MS,
  buildDailyActivityRollup,
  elapsedContribution,
  ingestActivity,
  retentionCutoff,
  validateActivityBatch,
  validateDateRange,
} from "./service";

const CONCURRENT_TEST_USER_ID = 9_990_427;

beforeAll(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_activity_sessions (
      id serial PRIMARY KEY,
      user_id integer NOT NULL,
      auth_session_id integer NOT NULL,
      client_tab_id text NOT NULL,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      last_state text NOT NULL DEFAULT 'active',
      ended_at timestamptz,
      UNIQUE (user_id, auth_session_id, client_tab_id)
    );
    CREATE TABLE IF NOT EXISTS user_activity_events (
      id serial PRIMARY KEY,
      user_id integer NOT NULL,
      activity_session_id integer NOT NULL,
      client_event_id text NOT NULL,
      kind text NOT NULL,
      path text,
      action text,
      state text NOT NULL DEFAULT 'active',
      occurred_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (activity_session_id, client_event_id)
    );
    CREATE TABLE IF NOT EXISTS user_activity_daily_rollups (
      id serial PRIMARY KEY,
      user_id integer NOT NULL,
      activity_date date NOT NULL,
      active_ms bigint NOT NULL DEFAULT 0,
      idle_ms bigint NOT NULL DEFAULT 0,
      first_seen_at timestamptz,
      last_seen_at timestamptz,
      page_views integer NOT NULL DEFAULT 0,
      action_count integer NOT NULL DEFAULT 0,
      UNIQUE (user_id, activity_date)
    );
  `);
  await pool.query(`DELETE FROM user_activity_events WHERE user_id=$1`, [CONCURRENT_TEST_USER_ID]);
  await pool.query(`DELETE FROM user_activity_sessions WHERE user_id=$1`, [CONCURRENT_TEST_USER_ID]);
  await pool.query(`DELETE FROM user_activity_daily_rollups WHERE user_id=$1`, [CONCURRENT_TEST_USER_ID]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM user_activity_events WHERE user_id=$1`, [CONCURRENT_TEST_USER_ID]);
  await pool.query(`DELETE FROM user_activity_sessions WHERE user_id=$1`, [CONCURRENT_TEST_USER_ID]);
  await pool.query(`DELETE FROM user_activity_daily_rollups WHERE user_id=$1`, [CONCURRENT_TEST_USER_ID]);
});

describe("activity telemetry validation", () => {
  it("rejects URL query/hash metadata and duplicate client event IDs", () => {
    expect(() => validateActivityBatch({
      clientTabId: "tab_1",
      events: [{ clientEventId: "a", kind: "page_view", path: "/dashboard?email=x" }],
    })).toThrow("Invalid page path");
    expect(() => validateActivityBatch({
      clientTabId: "tab_1",
      events: [
        { clientEventId: "a", kind: "heartbeat" },
        { clientEventId: "a", kind: "heartbeat" },
      ],
    })).toThrow("Invalid activity event");
    expect(() => validateActivityBatch({
      clientTabId: "tab_1",
      events: [{ clientEventId: "b", kind: "action", action: "User selected: Jane Doe" }],
    })).toThrow("Invalid action");
  });

  it("does not turn missing or late heartbeats into activity", () => {
    const then = new Date("2026-01-01T00:00:00Z");
    expect(elapsedContribution(then, new Date(then.getTime() + IDLE_THRESHOLD_MS), "active")).toEqual({
      activeMs: IDLE_THRESHOLD_MS, idleMs: 0,
    });
    expect(elapsedContribution(then, new Date(then.getTime() + IDLE_THRESHOLD_MS + 1), "active")).toEqual({
      activeMs: 0, idleMs: 0,
    });
  });

  it("unions overlapping tabs, rather than summing their active minute", () => {
    const at = new Date("2026-01-01T06:30:00Z"); // noon in India
    const events = [1, 2].flatMap((activity_session_id) => [
      { activity_session_id, occurred_at: at, state: "active" as const, kind: "heartbeat" as const },
      { activity_session_id, occurred_at: new Date(at.getTime() + 60_000), state: "active" as const, kind: "heartbeat" as const },
    ]);
    expect(buildDailyActivityRollup(events, "2026-01-01").activeMs).toBe(60_000);
  });

  it("does not project an open event into unconfirmed activity", () => {
    const event = {
      activity_session_id: 1,
      occurred_at: new Date("2026-01-01T06:30:00Z"),
      state: "active" as const,
      kind: "page_view" as const,
    };
    expect(buildDailyActivityRollup([event], "2026-01-01").activeMs).toBe(0);
  });

  it("splits state intervals at Asia/Kolkata midnight", () => {
    const event = { activity_session_id: 1, occurred_at: new Date("2026-01-01T18:29:00Z"), state: "active" as const, kind: "heartbeat" as const };
    const next = { ...event, occurred_at: new Date("2026-01-01T18:34:00Z") };
    expect(buildDailyActivityRollup([event, next], "2026-01-01").activeMs).toBe(60_000);
    expect(buildDailyActivityRollup([event, next], "2026-01-02").activeMs).toBe(4 * 60_000);
  });

  it("keeps exactly ninety India-calendar dates at the retention cutoff", () => {
    const cutoff = retentionCutoff(new Date("2026-04-10T12:00:00Z"));
    expect(cutoff.date).toBe("2026-01-11");
    expect(cutoff.instant.toISOString()).toBe("2026-01-10T18:30:00.000Z");
  });

  it("keeps both tabs' page and action counts when they ingest concurrently", async () => {
    const tab = (clientTabId: string, suffix: string) => ({
      clientTabId,
      events: [
        { clientEventId: `page-${suffix}`, kind: "page_view" as const, path: "/org/users", state: "active" as const },
        { clientEventId: `action-${suffix}`, kind: "action" as const, action: "navigate.org-users", state: "active" as const },
      ],
    });
    await Promise.all([
      ingestActivity(CONCURRENT_TEST_USER_ID, 1, tab("tab_a", "a")),
      ingestActivity(CONCURRENT_TEST_USER_ID, 1, tab("tab_b", "b")),
    ]);
    const { rows } = await pool.query<{ page_views: number; action_count: number }>(
      `SELECT page_views, action_count FROM user_activity_daily_rollups WHERE user_id=$1`,
      [CONCURRENT_TEST_USER_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ page_views: 2, action_count: 2 });
  });

  it("enforces a real, bounded inclusive date filter", () => {
    expect(validateDateRange("2026-02-01", "2026-02-28")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(() => validateDateRange("2026-02-30", "2026-03-01")).toThrow();
    expect(() => validateDateRange("2026-01-01", "2026-02-01")).toThrow("Date range");
  });
});