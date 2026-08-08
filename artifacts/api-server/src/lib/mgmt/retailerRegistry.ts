// Retailer identity registry — extends the identity-registry approach
// (identityRegistry.ts, members) to RETAILERS.
//
// Global rules (identity spec, Aug 2026):
//  - RET# is the key. Names are display only.
//  - Two different RET# are two different retailers, ALWAYS — even with
//    identical names. One RET# with several spellings is ONE retailer.
//  - Rows with no RET# use the name+geography fallback (name + distributor).
//  - NEVER auto-merge on similarity. An ambiguous lookup returns every
//    candidate with its distinguishing field — never the first match.
//  - Same-spelling names under multiple RET#s are RESOLVED-DIFFERENT by ID;
//    they are reported, not merged.
//
// Built from secondary_sku_line (the only table carrying retailer_id).
// FY2026-27 has RET# on 100% of rows; historical FYs gain coverage after the
// RET# backfill (skuLoader carry-forward + re-ingest).

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RetailerRecord = {
  /** RET#NNNN — the stable identity. */
  retId: string;
  /** All observed name spellings (display forms), most-billed first. */
  spellings: string[];
  /** Distributors this RET# has transacted under. */
  distributors: string[];
  /** Fiscal years with transactions. */
  fys: string[];
  /** Total NET across all rows (for candidate reports). */
  net: number;
};

export type RetailerResolveResult =
  | { kind: "found"; retId: string; record: RetailerRecord }
  | {
      kind: "ambiguous";
      candidates: RetailerRecord[];
      message: string;
    }
  | {
      /** No RET# evidence for this name — identity is name+geography. */
      kind: "fallback";
      fallbackKey: string; // normName + "|" + normDistributor
    };

export type RetailerIdentityReport = {
  builtAt: string;
  /** distinct RET# per fiscal year */
  distinctRetIdsByFy: Record<string, number>;
  /** rows with no RET# per fiscal year (need name+geography fallback) */
  rowsWithoutRetIdByFy: Record<string, number>;
  /** RET#s carrying more than one name spelling (ONE retailer each) */
  multiSpellingRetIds: Array<{ retId: string; spellings: string[]; distributors: string[] }>;
  multiSpellingCount: number;
  /**
   * Same normalised spelling under multiple RET#s. Different IDs prove
   * DIFFERENT retailers (RESOLVED-DIFFERENT) — reported so name-keyed
   * queries know these names are unsafe, never merged.
   */
  resolvedDifferentNames: Array<{
    name: string;
    retIds: string[];
    candidates: Array<{ retId: string; distributors: string[]; fys: string[]; net: number }>;
  }>;
  resolvedDifferentCount: number;
};

// ── Normalisation ─────────────────────────────────────────────────────────────

export function normRetailerName(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Fallback identity for rows/names with no RET#: name + geography. */
export function retailerFallbackKey(name: string, distributor?: string | null): string {
  return `${normRetailerName(name)}|${normRetailerName(distributor ?? "")}`;
}

// ── Registry ──────────────────────────────────────────────────────────────────

export class RetailerRegistry {
  private readonly byRetId = new Map<string, RetailerRecord>();
  private readonly byNameKey = new Map<string, Set<string>>(); // normName → retIds
  readonly builtAt: number;

  constructor(rows: Array<{ retailer_id: string; retailer: string; distributor: string | null; fy: string; net: number }>) {
    this.builtAt = Date.now();
    type Acc = { spellingNet: Map<string, { display: string; net: number }>; distributors: Set<string>; fys: Set<string>; net: number };
    const acc = new Map<string, Acc>();
    for (const r of rows) {
      const retId = r.retailer_id.trim();
      if (!retId) continue;
      let a = acc.get(retId);
      if (!a) { a = { spellingNet: new Map(), distributors: new Set(), fys: new Set(), net: 0 }; acc.set(retId, a); }
      const nk = normRetailerName(r.retailer);
      const s = a.spellingNet.get(nk) ?? { display: r.retailer.trim(), net: 0 };
      s.net += r.net;
      a.spellingNet.set(nk, s);
      if (r.distributor?.trim()) a.distributors.add(r.distributor.trim());
      a.fys.add(r.fy);
      a.net += r.net;

      const ids = this.byNameKey.get(nk) ?? new Set<string>();
      ids.add(retId);
      this.byNameKey.set(nk, ids);
    }
    for (const [retId, a] of acc) {
      this.byRetId.set(retId, {
        retId,
        spellings: [...a.spellingNet.values()].sort((x, y) => y.net - x.net).map((x) => x.display),
        distributors: [...a.distributors],
        fys: [...a.fys].sort(),
        net: a.net,
      });
    }
  }

  /**
   * Resolve a retailer name to its RET#.
   *  - one RET# for the name → found
   *  - several RET#s → try distributor context; still >1 → ambiguous
   *    (all candidates listed — never the first match)
   *  - no RET# evidence → name+geography fallback key
   */
  resolve(name: string, context?: { distributor?: string | null }): RetailerResolveResult {
    const nk = normRetailerName(name);
    if (!nk) return { kind: "fallback", fallbackKey: retailerFallbackKey(name, context?.distributor) };
    const ids = this.byNameKey.get(nk);
    if (!ids || ids.size === 0) {
      return { kind: "fallback", fallbackKey: retailerFallbackKey(name, context?.distributor) };
    }
    const records = [...ids].map((id) => this.byRetId.get(id)!).filter(Boolean);
    if (records.length === 1) return { kind: "found", retId: records[0].retId, record: records[0] };

    if (context?.distributor) {
      const dk = normRetailerName(context.distributor);
      const matched = records.filter((rec) => rec.distributors.some((d) => normRetailerName(d) === dk));
      if (matched.length === 1) return { kind: "found", retId: matched[0].retId, record: matched[0] };
    }

    const list = records
      .map((rec) => `${rec.retId} (dist: ${rec.distributors.slice(0, 2).join(", ") || "?"}; FYs: ${rec.fys.join(",")})`)
      .join("; ");
    return {
      kind: "ambiguous",
      candidates: records,
      message: `"${name}" matches ${records.length} distinct RET#s: ${list}. Provide distributor to disambiguate — never merged.`,
    };
  }

  /** Names whose spelling maps to >1 RET# (unsafe for name-keyed matching). */
  ambiguousNameKeys(): Set<string> {
    const out = new Set<string>();
    for (const [nk, ids] of this.byNameKey) if (ids.size > 1) out.add(nk);
    return out;
  }

  get retailerCount(): number { return this.byRetId.size; }

  record(retId: string): RetailerRecord | undefined { return this.byRetId.get(retId); }

  get records(): RetailerRecord[] { return [...this.byRetId.values()]; }
}

// ── Build + cache ─────────────────────────────────────────────────────────────

let cached: { registry: RetailerRegistry; at: number } | null = null;
let building: Promise<RetailerRegistry> | null = null;
const TTL_MS = 30 * 60 * 1000;

export function clearRetailerRegistry(): void {
  cached = null;
}

export async function getRetailerRegistry(): Promise<RetailerRegistry> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.registry;
  if (building) return building;
  building = (async () => {
    const res = await db.execute<{
      retailer_id: string; retailer: string; distributor: string | null; fy: string; net: string | null;
    }>(sql`
      SELECT retailer_id, retailer, distributor, fy,
             SUM(COALESCE(net_amount::float8, 0))::text AS net
      FROM secondary_sku_line
      WHERE retailer_id IS NOT NULL AND retailer_id <> ''
        AND retailer IS NOT NULL AND retailer <> ''
      GROUP BY retailer_id, retailer, distributor, fy
    `);
    const registry = new RetailerRegistry(
      res.rows.map((r) => ({ ...r, net: Number(r.net ?? 0) })),
    );
    cached = { registry, at: Date.now() };
    logger.info(
      { retailers: registry.retailerCount, ambiguousNames: registry.ambiguousNameKeys().size },
      "retailerRegistry: built",
    );
    return registry;
  })().finally(() => { building = null; });
  return building;
}

// ── Acceptance report ─────────────────────────────────────────────────────────

export async function buildRetailerIdentityReport(): Promise<RetailerIdentityReport> {
  const registry = await getRetailerRegistry();

  const perFy = await db.execute<{ fy: string; distinct_ret: string; no_id_rows: string }>(sql`
    SELECT fy,
           COUNT(DISTINCT retailer_id) FILTER (WHERE retailer_id IS NOT NULL AND retailer_id <> '')::text AS distinct_ret,
           COUNT(*) FILTER (WHERE retailer_id IS NULL OR retailer_id = '')::text AS no_id_rows
    FROM secondary_sku_line
    GROUP BY fy ORDER BY fy
  `);

  const distinctRetIdsByFy: Record<string, number> = {};
  const rowsWithoutRetIdByFy: Record<string, number> = {};
  for (const r of perFy.rows) {
    distinctRetIdsByFy[r.fy] = Number(r.distinct_ret);
    rowsWithoutRetIdByFy[r.fy] = Number(r.no_id_rows);
  }

  const multi = registry.records.filter((r) => r.spellings.length > 1);
  const multiSpellingRetIds = multi
    .sort((a, b) => b.spellings.length - a.spellings.length)
    .slice(0, 200)
    .map((r) => ({ retId: r.retId, spellings: r.spellings, distributors: r.distributors }));

  const resolvedDifferentNames: RetailerIdentityReport["resolvedDifferentNames"] = [];
  for (const nk of registry.ambiguousNameKeys()) {
    const res = registry.resolve(nk);
    if (res.kind !== "ambiguous") continue;
    resolvedDifferentNames.push({
      name: nk,
      retIds: res.candidates.map((c) => c.retId),
      candidates: res.candidates.map((c) => ({
        retId: c.retId, distributors: c.distributors, fys: c.fys, net: Math.round(c.net),
      })),
    });
  }
  resolvedDifferentNames.sort((a, b) => b.retIds.length - a.retIds.length);

  return {
    builtAt: new Date(registry.builtAt).toISOString(),
    distinctRetIdsByFy,
    rowsWithoutRetIdByFy,
    multiSpellingRetIds,
    multiSpellingCount: multi.length,
    resolvedDifferentNames: resolvedDifferentNames.slice(0, 300),
    resolvedDifferentCount: resolvedDifferentNames.length,
  };
}
