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
import { eq, like } from "drizzle-orm";
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
 * Invalidate every snapshot whose key starts with `prefix`: drops the warm
 * in-process cache entries synchronously and deletes the persisted
 * route_payload_snapshot rows fire-and-forget (the next live build re-creates
 * them). Use a prefix ending in the key separator (e.g. "mgmt-data|2026-27|")
 * to avoid matching unrelated keys.
 */
export function invalidateSnapshots(prefix: string): void {
  for (const key of _cache.keys()) {
    if (key.startsWith(prefix)) _cache.delete(key);
  }
  void db
    .delete(routePayloadSnapshots)
    .where(like(routePayloadSnapshots.key, `${prefix.replace(/[%_\\]/g, "\\$&")}%`))
    .catch((err: unknown) =>
      logger.warn({ err, prefix }, "payload snapshot: invalidation failed"),
    );
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
  /**
   * When true (closed/frozen fiscal years or fully locked month ranges whose
   * source data never changes), an existing persisted snapshot is served as
   * final: no background rebuild, no meta.refreshing flag. Only the
   * first-ever request runs the live build.
   */
  frozen?: boolean;
  /**
   * Unix ms of the moment the underlying data froze. A snapshot saved BEFORE
   * this instant may predate final corrections made inside the edit window,
   * so it gets one normal serve-and-refresh cycle; once a snapshot saved
   * after the freeze exists, it is served as final.
   */
  frozenSince?: number;
}): Promise<T> {
  const { key, ttlMs, build } = opts;

  const cached = _cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.payload as T;

  const snap = await loadSnapshot(key);
  if (snap) {
    if (opts.frozen && (opts.frozenSince === undefined || snap.savedAt.getTime() >= opts.frozenSince)) {
      // Frozen source data: the snapshot is authoritative. Re-warm the
      // in-process cache from it and skip the live re-read entirely.
      _cache.set(key, { payload: snap.payload, expiresAt: Date.now() + ttlMs });
      opts.log?.info({ key }, "payload snapshot: frozen FY, serving snapshot as final");
      return snap.payload as T;
    }
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

/**
 * Pre-warm a snapshot key: if a persisted snapshot already exists, do nothing
 * (the next request will serve it instantly and refresh in the background).
 * Only when no snapshot exists at all is the live build run — so a startup
 * pre-warm loop never re-builds keys that are already covered, and the first
 * ever request for a key never has to block.
 */
export async function prewarmSnapshot<T extends AnyPayload>(opts: {
  key: string;
  ttlMs: number;
  build: () => Promise<T>;
}): Promise<"exists" | "built"> {
  const existing = await loadSnapshot(opts.key);
  if (existing) return "exists";
  await buildAndCache(opts.key, opts.ttlMs, opts.build);
  return "built";
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
