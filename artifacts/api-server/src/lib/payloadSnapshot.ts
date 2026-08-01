// Generic cold-start snapshot layer for heavy read-only routes.
//
// Same pattern as the GET /api/mgmt/data snapshot (routes/mgmt.ts), factored
// out so any heavy route can adopt it:
//
//   - Warm in-process cache → serve instantly (no meta injected).
//   - Cold cache but a persisted snapshot exists → serve it instantly with
//     meta.snapshotSavedAt (unix ms) + meta.refreshing: true, and rebuild
//     from live sources in the background (in-flight deduped per key).
//   - No snapshot at all (first ever request) → block on the live build.
//
// After every successful live build the payload is written to the in-process
// cache and upserted into route_payload_snapshot. Errors from the build are
// never snapshotted.
//
// The frontend side is shared too: SnapshotBanner + useSnapshotRefresh in
// artifacts/prayag/src/components/dashboard/snapshotRefresh.tsx poll until
// meta.refreshing disappears and swap the fresh figures in silently.
import { db, routePayloadSnapshots } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

type AnyPayload = Record<string, unknown>;

const _cache = new Map<string, { payload: AnyPayload; expiresAt: number }>();
const _inFlight = new Map<string, Promise<AnyPayload>>();

async function saveSnapshot(key: string, payload: AnyPayload): Promise<void> {
  try {
    await db
      .insert(routePayloadSnapshots)
      .values({ key, payload })
      .onConflictDoUpdate({
        target: routePayloadSnapshots.key,
        set: { payload, savedAt: new Date() },
      });
  } catch (err) {
    logger.warn({ err, key }, "payload snapshot: save failed");
  }
}

async function loadSnapshot(
  key: string,
): Promise<{ payload: AnyPayload; savedAt: Date } | null> {
  try {
    const rows = await db
      .select()
      .from(routePayloadSnapshots)
      .where(eq(routePayloadSnapshots.key, key))
      .limit(1);
    if (rows.length === 0) return null;
    return { payload: rows[0].payload as AnyPayload, savedAt: rows[0].savedAt };
  } catch (err) {
    logger.warn({ err, key }, "payload snapshot: load failed, falling back to live build");
    return null;
  }
}

// Runs the live build once (deduped across concurrent callers), then writes
// the in-process cache and persists the DB snapshot.
function buildAndCache<T extends AnyPayload>(
  key: string,
  ttlMs: number,
  build: () => Promise<T>,
): Promise<T> {
  const pending = _inFlight.get(key);
  if (pending) return pending as Promise<T>;
  const p = (async () => {
    const payload = await build();
    _cache.set(key, { payload, expiresAt: Date.now() + ttlMs });
    void saveSnapshot(key, payload);
    return payload;
  })().finally(() => _inFlight.delete(key));
  _inFlight.set(key, p);
  return p;
}

/**
 * Serve a heavy route payload snapshot-first.
 *
 * Returns the payload to send as JSON. When it came from a persisted
 * snapshot, `meta.snapshotSavedAt` + `meta.refreshing: true` are merged into
 * (or added to) the payload's `meta` field and a background rebuild is
 * kicked off. Build errors on the blocking path propagate to the caller.
 */
export async function serveWithSnapshot<T extends AnyPayload>(opts: {
  key: string;
  ttlMs: number;
  build: () => Promise<T>;
  log?: { info: (obj: unknown, msg?: string) => void };
}): Promise<T> {
  const { key, ttlMs, build } = opts;

  const cached = _cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.payload as T;

  const snap = await loadSnapshot(key);
  if (snap) {
    buildAndCache(key, ttlMs, build).catch((err) =>
      logger.warn({ err, key }, "payload snapshot: background refresh failed"),
    );
    opts.log?.info(
      { key, snapshotSavedAt: snap.savedAt.toISOString() },
      "payload snapshot: serving DB snapshot, refreshing in background",
    );
    const prevMeta =
      snap.payload.meta && typeof snap.payload.meta === "object"
        ? (snap.payload.meta as Record<string, unknown>)
        : {};
    return {
      ...snap.payload,
      meta: {
        ...prevMeta,
        snapshotSavedAt: snap.savedAt.getTime(),
        refreshing: true,
      },
    } as unknown as T;
  }

  // First ever request for this key — nothing to serve early, block on build.
  return buildAndCache(key, ttlMs, build);
}

/** Typed error a build function can throw to control the HTTP response. */
export class SnapshotHttpError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}
