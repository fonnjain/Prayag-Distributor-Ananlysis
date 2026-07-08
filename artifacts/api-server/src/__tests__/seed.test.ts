// Tests for the first-run seed path: an empty table must be seeded exactly
// once, even under concurrent calls, and ensureSeeded must keep returning the
// latest snapshot afterwards.
import { beforeEach, describe, expect, it } from "vitest";
import { db, dashboardSnapshots } from "@workspace/db";
import { truncateSnapshots, snapshotCount } from "./setup-db.js";
import { ensureSeeded, getLatestSnapshot } from "../lib/dashboard/sync.js";

beforeEach(async () => {
  await truncateSnapshots();
});

describe("ensureSeeded", () => {
  it("seeds a baseline snapshot when the table is empty", async () => {
    const snapshot = await ensureSeeded();

    expect(snapshot.sourceStatus).toBe("seed");
    expect(snapshot.data).toBeTruthy();
    const data = snapshot.data as Record<string, unknown>;
    expect(data.totals).toBeDefined();
    expect(data.fy2425).toBeDefined();
    expect(await snapshotCount()).toBe(1);
  });

  it("does not insert duplicate rows on concurrent first calls", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ensureSeeded()),
    );

    expect(await snapshotCount()).toBe(1);
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    expect(results.every((r) => r.sourceStatus === "seed")).toBe(true);
  });

  it("returns the latest snapshot instead of re-seeding when rows exist", async () => {
    await ensureSeeded();
    // Simulate a later live sync landing a newer snapshot.
    const [liveRow] = await db
      .insert(dashboardSnapshots)
      .values({
        data: { marker: "live-row" },
        manifest: { data_mode: "live" },
        sourceStatus: "live",
      })
      .returning();

    const snapshot = await ensureSeeded();

    expect(snapshot.id).toBe(liveRow.id);
    expect(snapshot.sourceStatus).toBe("live");
    expect(await snapshotCount()).toBe(2);

    const latest = await getLatestSnapshot();
    expect(latest?.id).toBe(liveRow.id);
  });
});
