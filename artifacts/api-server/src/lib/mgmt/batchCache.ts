// Phase A6 — in-memory batch result cache.
//
// Keyed by: fy | stateHead | memberNormKey | reportType | payloadHash
// payloadHash is a djb2 hash of JSON.stringify(payload) — fast, no crypto dep.
// TTL: 1 hour for open FY, 24 hours for closed FY (endYear < current year).
//
// Never console.log.

// ── Hash ─────────────────────────────────────────────────────────────────────

export function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h << 5, h) + s.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(36);
}

export function hashPayload(payload: unknown): string {
  return hashString(JSON.stringify(payload));
}

// ── Cache entry ───────────────────────────────────────────────────────────────

type CacheEntry = {
  result: unknown;
  cachedAt: number;
  ttlMs: number;
};

const _cache = new Map<string, CacheEntry>();

// Infer TTL from the FY part of the cache key.
function ttlForFy(fy: string): number {
  const [startYearStr] = fy.split("-");
  const endYear = Number(startYearStr) + 1;
  const now = new Date();
  const isClosed = now.getFullYear() > endYear || (now.getFullYear() === endYear && now.getMonth() >= 3); // Apr = month 3
  return isClosed ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function makeCacheKey(
  fy: string,
  stateHead: string,
  memberNormKey: string,
  reportType: string,
  payloadHash: string,
): string {
  return `${fy}|${stateHead}|${memberNormKey}|${reportType}|${payloadHash}`;
}

export function cacheGet(key: string): unknown | null {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > entry.ttlMs) {
    _cache.delete(key);
    return null;
  }
  return entry.result;
}

export function cacheSet(key: string, result: unknown, fy: string): void {
  _cache.set(key, { result, cachedAt: Date.now(), ttlMs: ttlForFy(fy) });
  // Evict oldest entries when cache grows large.
  if (_cache.size > 2000) {
    const firstKey = _cache.keys().next().value;
    if (firstKey !== undefined) _cache.delete(firstKey);
  }
}

export function cacheStats(): { size: number; oldestMs: number | null } {
  let oldest: number | null = null;
  for (const e of _cache.values()) {
    if (oldest === null || e.cachedAt < oldest) oldest = e.cachedAt;
  }
  return { size: _cache.size, oldestMs: oldest };
}
